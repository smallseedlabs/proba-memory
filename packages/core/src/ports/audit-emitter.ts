/**
 * AuditEmitter port: how a service records an audit event.
 *
 * emit() builds the event with the protocol builder (filling eventId, spanId,
 * occurredAt, service, workspaceId, traceId), validates it against the protocol
 * schema and hands it to a transport: straight onto the EventBus, or into an
 * outbox table inside the caller's own database transaction.
 */

import type { AuditEvent } from '../domain/audit.js';

/** What a caller must provide. Everything else is defaulted by the emitter. */
export type AuditDraft = Partial<AuditEvent> & Pick<AuditEvent, 'actor' | 'action' | 'category' | 'outcome'>;

export interface EmitOptions {
  /**
   * Transaction handle of the caller's database (for the outbox transport, for
   * example a pg PoolClient inside BEGIN..COMMIT). Ignored by the bus transport.
   */
  tx?: unknown;
}

export interface AuditEmitter {
  /**
   * Build, validate and send one event. Resolves with the event that was sent.
   * Resolves with null only when the emitter was created with
   * failureMode 'swallow' and the event was invalid or could not be sent (the
   * failure is logged as an error either way).
   */
  emit(draft: AuditDraft, options?: EmitOptions): Promise<AuditEvent | null>;
  /**
   * A view of this emitter that stamps `traceId` (and optionally `parentSpanId`)
   * on every event that does not set its own, for one command or job run.
   */
  forTrace(traceId: string, parentSpanId?: string): AuditEmitter;
}

/** Thrown by emit() when the built event fails protocol validation. */
export class AuditValidationError extends Error {
  readonly issues: { path: string; code: string; message: string }[];

  constructor(issues: { path: string; code: string; message: string }[]) {
    super(`invalid audit event: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`);
    this.name = 'AuditValidationError';
    this.issues = issues;
  }
}
