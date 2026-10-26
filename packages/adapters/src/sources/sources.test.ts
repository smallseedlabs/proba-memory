import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_INFO } from '@smallseedlabs/proba-protocol/audit';
import { buildAuditContent, buildAuditEvent, type AuditEvent, type ContentItem, type ContentPage, type EventBus, type HubContentSource } from '@smallseedlabs/proba-memory-core';
import { runHubContentSourceContract, runSourceAdapterContract } from '@smallseedlabs/proba-memory-core/testing';
import { InMemoryEventBus } from '../memory/event-bus.js';
import { AuditEventSource, convertAuditEvent, isRelevantAuditAction } from './audit-event-source.js';
import { ContentFeedSource } from './content-feed-source.js';
import { DEV_SOURCE_PREFIX, DevHubContentSource } from './dev-content-source.js';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };
const WS = 'ws-sources';

function audit(action: string, overrides: Record<string, unknown> = {}): AuditEvent {
  const category = (AUDIT_ACTION_INFO as Record<string, { category: string }>)[action]?.category ?? 'system';
  return buildAuditEvent({
    traceId: randomUUID(),
    workspaceId: WS,
    actor: { type: 'user', id: 'uid-1' },
    service: 'hub',
    action,
    category,
    outcome: 'success',
    ...overrides,
  } as Parameters<typeof buildAuditEvent>[0]) as AuditEvent;
}

describe('convertAuditEvent', () => {
  it('turns a rejection into the strongest negative signal with ids only', () => {
    const o = convertAuditEvent(
      audit('approval.rejected', { goalId: randomUUID(), target: { type: 'creative', id: 'c-1' }, details: { reasonLength: 42, text: 'secret message text', note: 'short' } })
    );
    expect(o).not.toBeNull();
    expect(o!.kind).toBe('approval.rejected');
    expect(o!.signal).toEqual({ polarity: 'negative', strength: 1 });
    expect(o!.significance).toBe('high');
    expect(o!.text).toBeNull();
    expect(o!.target).toEqual({ type: 'creative', id: 'c-1' });
    expect(o!.facts).toMatchObject({ action: 'approval.rejected', reasonLength: 42, note: 'short', targetType: 'creative' });
    expect(o!.facts).not.toHaveProperty('text');
  });

  it('gives approvals a positive signal and routine commands low significance', () => {
    expect(convertAuditEvent(audit('approval.granted'))!.signal).toMatchObject({ polarity: 'positive', strength: 0.9 });
    expect(convertAuditEvent(audit('command.received'))!.significance).toBe('low');
    expect(convertAuditEvent(audit('control.paused'))!.significance).toBe('normal');
    expect(convertAuditEvent(audit('brain.decision_made'))!.kind).toBe('brain.decision_made');
  });

  it('derives the observation id from the event id so redelivery is recognised', () => {
    const event = audit('goal.created');
    expect(convertAuditEvent(event)!.id).toBe(convertAuditEvent(structuredClone(event))!.id);
    expect(convertAuditEvent(audit('goal.created'))!.id).not.toBe(convertAuditEvent(event)!.id);
    expect(convertAuditEvent(event)!.sourceRef).toBe(`audit:${event.eventId}`);
  });

  it('ignores actions outside the families it learns from, including its own memory events', () => {
    for (const action of ['memory.ingested', 'memory.retrieved', 'system.job_run', 'metrics.ingested', 'audit.query_executed']) {
      expect(isRelevantAuditAction(action)).toBe(false);
    }
    expect(convertAuditEvent(audit('memory.ingested'))).toBeNull();
  });

  it('caps and sanitises details', () => {
    const details: Record<string, unknown> = { 'bad key!': 'x', nested: { a: 1 }, long: 'y'.repeat(500) };
    for (let i = 0; i < 40; i += 1) details[`k${i}`] = i;
    const o = convertAuditEvent(audit('goal.created', { details }))!;
    expect(Object.keys(o.facts).length).toBeLessThanOrEqual(24);
    expect(o.facts).not.toHaveProperty('nested');
    expect(String(o.facts.long)).toHaveLength(200);
  });
});

function auditHarness(bus: EventBus = new InMemoryEventBus()) {
  const topic = `proba.audit.events.${randomUUID()}`;
  const adapter = new AuditEventSource({ bus, topic, group: 'memory-test', consumer: 'c1', claimIdleMs: 10, startFrom: 'earliest', logger: silent });
  return {
    adapter,
    bus,
    topic,
    async produce(count: number) {
      for (let i = 0; i < count; i += 1) await bus.publish(topic, audit(i % 2 === 0 ? 'approval.rejected' : 'goal.created'), { key: WS });
    },
    async produceIgnored() {
      await bus.publish(topic, audit('memory.ingested'), { key: WS });
    },
  };
}

runSourceAdapterContract('audit event source (in-memory bus)', async () => auditHarness());

describe('conversation text from audit event content', () => {
  const withContent = (action: string, kind: string, text: string, extra: Record<string, unknown> = {}) =>
    audit(action, { threadId: randomUUID(), content: buildAuditContent(kind, text), ...extra });

  it('uses content as the text of a user message and maps it to the same kind the Hub feed uses', () => {
    const o = convertAuditEvent(withContent('thread.message_received', 'user_message', 'I prefer short headlines, please never use exclamation marks.'))!;
    expect(o.kind).toBe('thread.message');
    expect(o.text).toBe('I prefer short headlines, please never use exclamation marks.');
    expect(o.significance).toBe('normal');
    expect(o.threadId).toBeDefined();
    expect(o.facts).toMatchObject({ action: 'thread.message_received', contentKind: 'user_message', contentLength: 61, contentTruncated: false });
  });

  it('never copies the text into facts', () => {
    const o = convertAuditEvent(withContent('thread.message_received', 'user_message', 'a distinctive sentence about launch budgets'))!;
    expect(JSON.stringify(o.facts)).not.toContain('distinctive');
  });

  it('learns from brain replies, explanations and clarifications only when they carry text', () => {
    for (const [action, kind] of [['brain.reply_generated', 'brain_reply'], ['brain.explanation_generated', 'explanation'], ['brain.clarification_requested', 'brain_clarification']] as const) {
      expect(convertAuditEvent(audit(action)), `${action} without content`).toBeNull();
      const o = convertAuditEvent(withContent(action, kind, 'Some words.'))!;
      expect(o.kind).toBe(action);
      expect(o.text).toBe('Some words.');
    }
    expect(convertAuditEvent(audit('thread.message_received'))).toBeNull();
  });

  it('adds the text of approvals and goals when the event has it, and keeps the signal', () => {
    const o = convertAuditEvent(withContent('approval.rejected', 'explanation', 'Rejected because the headline is too pushy.'))!;
    expect(o.text).toBe('Rejected because the headline is too pushy.');
    expect(o.signal).toEqual({ polarity: 'negative', strength: 1 });
  });

  it('ignores prompts (model input) and blank text', () => {
    expect(convertAuditEvent(withContent('thread.message_received', 'prompt', 'system prompt text'))).toBeNull();
    expect(convertAuditEvent(withContent('approval.granted', 'prompt', 'system prompt text'))!.text).toBeNull();
    expect(convertAuditEvent(withContent('thread.message_received', 'user_message', '   '))).toBeNull();
  });

  it('reports truncation in facts', () => {
    const o = convertAuditEvent(audit('thread.message_received', { content: buildAuditContent('user_message', 'x'.repeat(20_000)) }))!;
    expect(o.facts).toMatchObject({ contentTruncated: true, contentLength: 20_000 });
    expect(o.text!.length).toBeLessThanOrEqual(16_384);
  });

  it('does not keep a second copy of the text in the dead-letter queue', async () => {
    const h = auditHarness();
    const event = withContent('thread.message_received', 'user_message', 'secret-ish words about the quarterly plan');
    await h.bus.publish(h.topic, event, { key: WS });
    await h.bus.publish(h.topic, { ...event, eventId: 'not-a-uuid', content: { kind: 'user_message', text: 'broken event words' } }, { key: WS });
    const items = await h.adapter.poll({ max: 10, blockMs: 100 });
    expect(items).toHaveLength(1);
    await items[0].reject('test');
    const dead = await h.bus.listDeadLetters(h.topic);
    expect(dead).toHaveLength(2);
    expect(JSON.stringify(dead)).not.toContain('quarterly plan');
    expect(JSON.stringify(dead)).not.toContain('broken event words');
    await h.adapter.close();
  });
});

describe('AuditEventSource', () => {
  it('dead-letters a message that is not a valid audit event and keeps going', async () => {
    const h = auditHarness();
    await h.bus.publish(h.topic, { not: 'an audit event' });
    await h.produce(1);
    const items = await h.adapter.poll({ max: 10, blockMs: 200 });
    expect(items).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(await h.adapter.reclaim({ max: 10 })).toHaveLength(1);
    await h.adapter.close();
  });
});

class ListContentSource implements HubContentSource {
  readonly name = 'list';
  items: ContentItem[] = [];
  async fetch(cursor: string | null, limit: number): Promise<ContentPage> {
    const from = cursor === null ? 0 : Number(cursor);
    const items = this.items.slice(from, from + limit);
    return { items, nextCursor: items.length === 0 ? null : String(from + items.length) };
  }
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

runSourceAdapterContract('content feed source', async () => {
  const source = new ListContentSource();
  return {
    adapter: new ContentFeedSource({ source, logger: silent, claimIdleMs: 10 }),
    async produce(count: number) {
      for (let i = 0; i < count; i += 1) {
        source.items.push({
          id: randomUUID(),
          kind: i % 2 === 0 ? 'thread_message' : 'approval',
          decision: i % 2 === 0 ? undefined : 'granted',
          workspaceId: WS,
          occurredAt: new Date().toISOString(),
          text: `message ${i}`,
          sourceRef: `dev:thread/${i}`,
        });
      }
    },
  };
});

describe('ContentFeedSource', () => {
  it('pages through the whole development feed once and picks up nothing more', async () => {
    const dev = new DevHubContentSource({ workspaceId: WS, seed: 's', nodeEnv: 'test', allowDev: false });
    const feed = new ContentFeedSource({ source: dev, logger: silent });
    const seen = new Set<string>();
    for (let guard = 0; guard < 20; guard += 1) {
      const items = await feed.poll({ max: 7 });
      if (items.length === 0) break;
      for (const i of items) {
        seen.add(i.observation.id);
        await i.ack();
      }
    }
    expect(seen.size).toBe(dev.size);
    expect(await feed.poll({ max: 7 })).toEqual([]);
  });

  it('keeps the text and maps approvals to decisions with signals', async () => {
    const dev = new DevHubContentSource({ workspaceId: WS, seed: 's', nodeEnv: 'test', allowDev: false });
    const feed = new ContentFeedSource({ source: dev, logger: silent });
    const items = await feed.poll({ max: 100 });
    const rejected = items.find((i) => i.observation.kind === 'approval.rejected')!;
    expect(rejected.observation.signal).toEqual({ polarity: 'negative', strength: 1 });
    expect(rejected.observation.text).toContain('countdown timer');
    expect(rejected.observation.sourceRef.startsWith(DEV_SOURCE_PREFIX)).toBe(true);
    expect(items.find((i) => i.observation.kind === 'goal.created')).toBeDefined();
    expect(items.find((i) => i.observation.kind === 'thread.message')).toBeDefined();
  });

  it('drops an item after too many deliveries', async () => {
    const source = new ListContentSource();
    source.items.push({ id: randomUUID(), kind: 'goal', workspaceId: WS, occurredAt: new Date().toISOString(), text: 'g', sourceRef: 'dev:goal/1' });
    let now = 0;
    const feed = new ContentFeedSource({ source, logger: silent, claimIdleMs: 10, maxDeliveries: 2, now: () => now });
    await feed.poll({ max: 5 });
    now += 20;
    expect(await feed.reclaim()).toHaveLength(1);
    now += 20;
    expect(await feed.reclaim()).toHaveLength(0);
  });
});

runHubContentSourceContract('development source', async () => ({ source: new DevHubContentSource({ workspaceId: WS, seed: 'c', nodeEnv: 'test', allowDev: false }) }));

describe('DevHubContentSource', () => {
  it('refuses production unless explicitly allowed', () => {
    expect(() => new DevHubContentSource({ workspaceId: WS, seed: 's', nodeEnv: 'production', allowDev: false })).toThrow(/production/);
    expect(() => new DevHubContentSource({ workspaceId: WS, seed: 's', nodeEnv: 'production', allowDev: true })).not.toThrow();
  });

  it('is deterministic from the seed and labels every reference dev:', async () => {
    const a = await new DevHubContentSource({ workspaceId: WS, seed: 'x', nodeEnv: 'test', allowDev: false }).fetch(null, 100);
    const b = await new DevHubContentSource({ workspaceId: WS, seed: 'x', nodeEnv: 'test', allowDev: false }).fetch(null, 100);
    const c = await new DevHubContentSource({ workspaceId: WS, seed: 'y', nodeEnv: 'test', allowDev: false }).fetch(null, 100);
    expect(a.items).toEqual(b.items);
    expect(a.items[0].id).not.toBe(c.items[0].id);
    expect(a.items.every((i) => i.sourceRef.startsWith('dev:'))).toBe(true);
    expect(a.items.every((i) => i.workspaceId === WS)).toBe(true);
  });
});
