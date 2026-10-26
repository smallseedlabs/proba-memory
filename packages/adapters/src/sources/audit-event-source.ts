import {
  deterministicUuid,
  validateAuditEvent,
  type AuditEvent,
  type BusMessage,
  type EventBus,
  type FactValue,
  type Logger,
  type Observation,
  type SourceAdapter,
  type SourceItem,
  type SourcePollOptions,
  type Subscription,
} from '@smallseedlabs/proba-memory-core';

export const AUDIT_SOURCE_NAME = 'audit';

/** Actions whose events carry conversation text in `content` (protocol 0.3.3). Without `content` they teach nothing and are ignored. */
const CONVERSATION_ACTIONS = new Set(['thread.message_received', 'brain.reply_generated', 'brain.explanation_generated', 'brain.clarification_requested']);

/** Content kinds that are conversation text. `prompt` (model input) is never used. */
const CONVERSATION_CONTENT_KINDS = new Set(['user_message', 'brain_reply', 'brain_clarification', 'explanation']);

/**
 * Audit events the memory service learns from. Everything else on the stream (including its own memory.* events) is ignored.
 * Conversation events count only when they carry text (`hasContent`).
 */
export function isRelevantAuditAction(action: string, hasContent = false): boolean {
  if (CONVERSATION_ACTIONS.has(action)) return hasContent;
  return (
    action.startsWith('approval.') ||
    action.startsWith('goal.') ||
    action.startsWith('command.') ||
    action.startsWith('control.') ||
    action === 'brain.decision_made'
  );
}

/**
 * The conversation text of an event, when it has some we may use. `content` is sensitive (raw user and
 * model text): it goes only into the observation's `text`, which the write path redacts before any model
 * or embedding call, and it is never logged or copied into `facts`.
 */
function conversationText(event: AuditEvent): { text: string; kind: string; originalLength: number; truncated: boolean } | null {
  const c = event.content;
  if (!c || !CONVERSATION_CONTENT_KINDS.has(c.kind)) return null;
  const text = c.text.trim();
  return text ? { text, kind: c.kind, originalLength: c.originalLength, truncated: c.truncated } : null;
}

/** Audit details that could hold message text are never copied: the audit contract says only ids and lengths belong there. */
const TEXT_LIKE_KEY = /^(text|content|message|body|prompt|reply|completion|transcript|query|answer)$/i;

function sanitiseDetails(details: Record<string, unknown>): Record<string, FactValue> {
  const out: Record<string, FactValue> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(details)) {
    if (kept >= 20) break;
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(key) || TEXT_LIKE_KEY.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 200);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value) && value.length <= 10 && value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      out[key] = value.map((v) => (typeof v === 'string' ? v.slice(0, 100) : v)) as (string | number | boolean)[];
    } else continue;
    kept += 1;
  }
  return out;
}

interface Rule {
  polarity: 'positive' | 'negative' | 'neutral';
  strength: number;
  significance: Observation['significance'];
}

/** What each action means as evidence. Approvals and rejections carry the strongest preference signal. */
function ruleFor(event: AuditEvent): Rule {
  switch (event.action) {
    case 'approval.rejected':
      return { polarity: 'negative', strength: 1, significance: 'high' };
    case 'approval.granted':
      return { polarity: 'positive', strength: 0.9, significance: 'high' };
    case 'goal.budget_declined':
      return { polarity: 'negative', strength: 0.85, significance: 'high' };
    case 'goal.budget_approved':
      return { polarity: 'positive', strength: 0.8, significance: 'high' };
    case 'approval.expired':
      return { polarity: 'neutral', strength: 0.3, significance: 'normal' };
    case 'approval.requested':
      return { polarity: 'neutral', strength: 0.2, significance: 'normal' };
    case 'control.emergency_stopped':
    case 'control.killed':
      return { polarity: 'negative', strength: 0.7, significance: 'high' };
    case 'control.paused':
    case 'control.resumed':
      return { polarity: 'neutral', strength: 0.4, significance: 'normal' };
    case 'brain.decision_made':
      return { polarity: 'neutral', strength: 0.3, significance: 'normal' };
    case 'thread.message_received':
      return { polarity: 'neutral', strength: 0.3, significance: 'normal' };
    case 'brain.reply_generated':
    case 'brain.explanation_generated':
    case 'brain.clarification_requested':
      return { polarity: 'neutral', strength: 0.2, significance: 'normal' };
    case 'command.rejected':
      return { polarity: 'negative', strength: 0.3, significance: 'normal' };
    case 'command.received':
    case 'command.accepted':
    case 'command.duplicate':
    case 'command.processed':
      return { polarity: 'neutral', strength: 0.1, significance: 'low' };
    default:
      return { polarity: 'neutral', strength: 0.2, significance: event.action.startsWith('goal.') ? 'normal' : 'low' };
  }
}

/**
 * Convert one audit event into an Observation, or null when it is not relevant. `facts` hold ids,
 * outcomes and lengths only. Conversation text comes from the event's `content` when it has one (the
 * primary source of conversation text; the Hub content feed is secondary) and goes into `text`
 * only; without `content`, `text` is null. The observation id is derived from the event id, so
 * redelivery of the same event is recognised.
 */
export function convertAuditEvent(event: AuditEvent): Observation | null {
  const conversation = conversationText(event);
  if (!isRelevantAuditAction(event.action, conversation !== null)) return null;
  const rule = ruleFor(event);
  const facts: Record<string, FactValue> = {
    action: event.action,
    outcome: event.outcome,
    actorType: event.actor.type,
    service: event.service,
    ...(event.target ? { targetType: event.target.type } : {}),
    ...(event.riskLevel ? { riskLevel: event.riskLevel } : {}),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    ...(conversation ? { contentKind: conversation.kind, contentLength: conversation.originalLength, contentTruncated: conversation.truncated } : {}),
    ...sanitiseDetails(event.details),
  };
  return {
    id: deterministicUuid('observation', `${AUDIT_SOURCE_NAME}:${event.eventId}`),
    workspaceId: event.workspaceId,
    source: AUDIT_SOURCE_NAME,
    sourceRef: `audit:${event.eventId}`,
    // A user's message is the same kind of evidence whether it arrives here or through the Hub content feed.
    kind: event.action === 'thread.message_received' ? 'thread.message' : event.action,
    occurredAt: event.occurredAt,
    traceId: event.traceId,
    spanId: event.spanId,
    ...(event.goalId ? { goalId: event.goalId } : {}),
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.userId ? { userId: event.userId } : {}),
    ...(event.campaignId ? { campaignId: event.campaignId } : {}),
    actor: { type: event.actor.type, id: event.actor.id },
    ...(event.target ? { target: { type: event.target.type, id: event.target.id } } : {}),
    text: conversation?.text ?? null,
    facts,
    signal: { polarity: rule.polarity, strength: rule.strength },
    significance: rule.significance,
  };
}

export interface AuditEventSourceOptions {
  bus: EventBus;
  topic: string;
  /** The memory service's OWN consumer group: it never competes with the audit consumer. */
  group: string;
  consumer: string;
  maxDeliveries?: number;
  claimIdleMs?: number;
  startFrom?: 'earliest' | 'latest';
  logger: Logger;
}

/** SourceAdapter over the Redis stream `proba.audit.events` (or any EventBus topic of audit events). */
export class AuditEventSource implements SourceAdapter {
  readonly name = AUDIT_SOURCE_NAME;
  private subscription: Subscription | null = null;

  constructor(private readonly options: AuditEventSourceOptions) {}

  private async sub(): Promise<Subscription> {
    this.subscription ??= await this.options.bus.subscribe({
      topic: this.options.topic,
      group: this.options.group,
      consumer: this.options.consumer,
      startFrom: this.options.startFrom ?? 'earliest',
      maxDeliveries: this.options.maxDeliveries,
      claimIdleMs: this.options.claimIdleMs,
    });
    return this.subscription;
  }

  async poll(options: SourcePollOptions = {}): Promise<SourceItem[]> {
    const sub = await this.sub();
    return this.convert(sub, await sub.read({ max: options.max, blockMs: options.blockMs }));
  }

  async reclaim(options: SourcePollOptions = {}): Promise<SourceItem[]> {
    const sub = await this.sub();
    return this.convert(sub, await sub.reclaimPending({ max: options.max }));
  }

  private async convert(sub: Subscription, messages: BusMessage[]): Promise<SourceItem[]> {
    const items: SourceItem[] = [];
    const ignored: string[] = [];
    const poison: BusMessage[] = [];
    for (const message of messages) {
      const parsed = validateAuditEvent(message.payload);
      if (!parsed.success) {
        poison.push(message);
        continue;
      }
      const observation = convertAuditEvent(parsed.data as AuditEvent);
      if (!observation) {
        ignored.push(message.id);
        continue;
      }
      items.push({
        observation,
        deliveryCount: message.deliveryCount,
        ack: () => sub.ack([message.id]),
        reject: (reason: string) => sub.deadLetter([message], reason),
      });
    }
    if (ignored.length > 0) await sub.ack(ignored);
    if (poison.length > 0) {
      this.options.logger.warn('audit message is not a valid audit event; dead-lettered', { count: poison.length });
      await sub.deadLetter(poison, 'not a valid audit event');
    }
    return items;
  }

  async ping(): Promise<void> {
    await this.options.bus.ping();
  }

  async close(): Promise<void> {
    await this.subscription?.close();
    this.subscription = null;
  }
}
