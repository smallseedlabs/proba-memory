import type { AuditEvent } from '../domain/audit.js';
import type { AuditDraft, AuditEmitter, EmitOptions } from '../ports/audit-emitter.js';
import { AuditValidationError } from '../ports/audit-emitter.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/event-bus.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Logger } from '../ports/logger.js';
import type { OutboxStore } from '../ports/outbox-store.js';
import { buildAuditEvent, validateAuditEvent } from './protocol.js';

export interface EmitterDeps {
  /** Default `service` of emitted events (a draft may override it). */
  service: string;
  /** Default `workspaceId` when a draft has none. */
  defaultWorkspaceId: string;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  /**
   * 'throw' (default): emit() rejects when the event is invalid or cannot be sent.
   * 'swallow': log the error and resolve null, for emitters that must never break
   * the caller (for example the consumer's own self-audit).
   */
  failureMode?: 'throw' | 'swallow';
}

/** Sends an already validated event somewhere durable. */
export type AuditSender = (event: AuditEvent, options: EmitOptions) => Promise<void>;

interface Scope {
  traceId?: string;
  parentSpanId?: string;
}

/** Generic emitter: build + validate here, send through `sender`. */
export function createAuditEmitter(deps: EmitterDeps, sender: AuditSender, scope: Scope = {}): AuditEmitter {
  const failureMode = deps.failureMode ?? 'throw';

  const fail = (error: Error, event: Partial<AuditEvent>): null => {
    deps.logger.error('audit event not emitted', {
      err: error,
      traceId: event.traceId,
      eventId: event.eventId,
      action: event.action,
    });
    if (failureMode === 'throw') throw error;
    return null;
  };

  return {
    async emit(draft: AuditDraft, options: EmitOptions = {}): Promise<AuditEvent | null> {
      const built = buildAuditEvent({
        ...draft,
        service: draft.service ?? deps.service,
        workspaceId: draft.workspaceId ?? deps.defaultWorkspaceId,
        traceId: draft.traceId ?? scope.traceId ?? deps.ids.uuid(),
        parentSpanId: draft.parentSpanId ?? scope.parentSpanId,
        eventId: draft.eventId ?? deps.ids.uuid(),
        spanId: draft.spanId ?? deps.ids.spanId(),
        occurredAt: draft.occurredAt ?? deps.clock.isoNow(),
      });
      // buildAuditEvent leaves an explicit `parentSpanId: undefined` in place; drop it.
      if (built.parentSpanId === undefined) delete built.parentSpanId;

      const parsed = validateAuditEvent(built);
      if (!parsed.success) {
        return fail(
          new AuditValidationError(
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message }))
          ),
          built
        );
      }
      const event = parsed.data as AuditEvent;
      try {
        await sender(event, options);
      } catch (err) {
        return fail(err instanceof Error ? err : new Error(String(err)), event);
      }
      deps.logger.debug('audit event emitted', {
        traceId: event.traceId,
        eventId: event.eventId,
        action: event.action,
        workspaceId: event.workspaceId,
      });
      return event;
    },

    forTrace(traceId: string, parentSpanId?: string): AuditEmitter {
      return createAuditEmitter(deps, sender, { traceId, parentSpanId });
    },
  };
}

export interface BusEmitterDeps extends EmitterDeps {
  bus: EventBus;
  /** Topic to publish to, for example config.eventBus.auditTopic. */
  topic: string;
}

/** Emitter that publishes straight onto the EventBus (keyed by workspace). */
export function createBusAuditEmitter(deps: BusEmitterDeps): AuditEmitter {
  return createAuditEmitter(deps, async (event) => {
    await deps.bus.publish(deps.topic, event, { key: event.workspaceId });
  });
}

export interface OutboxEmitterDeps<Tx = unknown> extends EmitterDeps {
  outbox: OutboxStore<Tx>;
}

/**
 * Emitter that writes into the outbox. Pass the service's own transaction as
 * `emit(draft, { tx })` so the event commits (or rolls back) with the business change.
 */
export function createOutboxAuditEmitter<Tx = unknown>(deps: OutboxEmitterDeps<Tx>): AuditEmitter {
  return createAuditEmitter(deps, async (event, options) => {
    await deps.outbox.enqueue([event], options.tx as Tx | undefined);
  });
}
