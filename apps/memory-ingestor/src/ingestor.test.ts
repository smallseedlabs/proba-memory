import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryLogger,
  buildAuditContent,
  buildAuditEvent,
  deterministicUuid,
  loadConfig,
  type AuditEvent,
  type Observation,
  type PipelineResult,
  type SourceAdapter,
  type SourceItem,
} from '@smallseedlabs/proba-memory-core';
import { createRuntime, createWritePipeline, type Runtime } from '@smallseedlabs/proba-memory-adapters';
import { Ingestor, type ObservationProcessor } from './ingestor.js';

const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MEMORY_STORE: 'memory',
  VECTOR_INDEX: 'memory',
  SCORING_PROFILE_STORE: 'memory',
  RETRIEVAL_LOG_STORE: 'memory',
  JOB_RUN_STORE: 'memory',
  OUTBOX_STORE: 'memory',
  EVENT_BUS: 'memory',
  AUDIT_TRANSPORT: 'bus',
  EMBEDDER: 'hash',
  ALLOW_LOCAL_EMBEDDER: 'true',
  LLM_PROVIDER: 'scripted',
  ALLOW_SCRIPTED_LLM: 'true',
  ALLOW_DEV_CONTENT_SOURCE: 'true',
  HUB_CONTENT_SOURCE: 'dev',
  SOURCES: 'content',
  EMBEDDING_DIMENSION: '64',
};

const open: Runtime[] = [];
async function makeRuntime(extra: Record<string, string> = {}): Promise<{ runtime: Runtime; logger: MemoryLogger }> {
  const config = loadConfig({ ...ENV, ...extra }, { serviceName: 'memory-ingestor' });
  const logger = new MemoryLogger();
  const runtime = await createRuntime(config, { service: 'memory-ingestor', logger, needs: { embedder: true, llm: true } });
  open.push(runtime);
  return { runtime, logger };
}
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
});

const WORKSPACE = 'seedbed';
const allMemories = async (runtime: Runtime) => {
  const out = [];
  for (let cursor: string | undefined; ; ) {
    const page = await runtime.store.listMemories({ workspaceId: WORKSPACE, filter: { statuses: ['active', 'superseded', 'tombstoned'] }, limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...page.memories);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
};
const auditEvents = async (runtime: Runtime): Promise<AuditEvent[]> => {
  const sub = await runtime.bus.subscribe({ topic: runtime.config.eventBus.auditTopic, group: 'test', consumer: 'c' });
  const messages = await sub.read<AuditEvent>({ max: 5000 });
  return messages.map((m) => m.payload);
};

describe('seeding the development content through the real write path', () => {
  it('turns 25 content items into memories, with provenance and audit events, and no raw secrets', async () => {
    const { runtime } = await makeRuntime();
    const source = await runtime.registries.sourceAdapter.create('content', runtime.deps);
    const ingestor = new Ingestor({ sources: [source], pipeline: createWritePipeline(runtime), logger: runtime.logger, concurrency: 4, reclaimIntervalMs: 60_000, retryBaseMs: 10, retryMaxMs: 100 });
    const totals = await ingestor.drain();
    expect(totals).toMatchObject({ polled: 25, failed: 0, duplicate: 0 });
    expect(totals.processed + totals.skipped).toBe(25);

    const memories = await allMemories(runtime);
    expect(memories.length).toBeGreaterThan(10);
    expect(memories.length).toBe(totals.created);
    for (const m of memories) {
      expect(m.workspaceId).toBe(WORKSPACE);
      expect(m.embeddingModel).toBe('local-hash');
      expect(m.sourceRefs.length).toBeGreaterThan(0);
      expect(m.provenance.observationIds.length).toBeGreaterThan(0);
    }

    // Redaction happened before anything was stored.
    const text = JSON.stringify(memories);
    expect(text).not.toContain('sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c');
    expect(text).not.toContain('jo.marketing@example.com');
    expect(text).not.toContain('7700 900123');

    const events = await auditEvents(runtime);
    const ingested = events.filter((e) => e.action === 'memory.ingested');
    expect(ingested.length).toBe(totals.created);
    for (const e of ingested) {
      expect(e.workspaceId).toBe(WORKSPACE);
      expect(e.actor).toEqual({ type: 'service', id: 'memory-ingestor' });
      expect(e.target?.type).toBe('memory');
    }
    // Audit events carry ids and lengths, never memory text.
    for (const m of memories) expect(JSON.stringify(events)).not.toContain(m.content);
  });

  it('is idempotent: seeding again changes nothing and emits nothing', async () => {
    const { runtime } = await makeRuntime();
    const run = async () => {
      const source = await runtime.registries.sourceAdapter.create('content', runtime.deps);
      const ingestor = new Ingestor({ sources: [source], pipeline: createWritePipeline(runtime), logger: runtime.logger, concurrency: 2, reclaimIntervalMs: 60_000, retryBaseMs: 10, retryMaxMs: 100 });
      return ingestor.drain();
    };
    const first = await run();
    const before = await allMemories(runtime);
    const eventsBefore = (await auditEvents(runtime)).length;
    const second = await run();
    expect(second).toMatchObject({ polled: 25, duplicate: first.processed + first.skipped, processed: 0, created: 0, merged: 0, failed: 0 });
    const after = await allMemories(runtime);
    expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort());
    expect(after.map((m) => m.evidenceCount)).toEqual(before.map((m) => m.evidenceCount));
    expect(eventsBefore).toBeGreaterThan(0);
    // (the first read drained the topic for this reader: anything new would show up now)
    expect((await auditEvents(runtime)).length).toBe(0);
  });

  it('is deterministic: two separate runtimes build the same memory ids', async () => {
    const ids: string[][] = [];
    for (let i = 0; i < 2; i += 1) {
      const { runtime } = await makeRuntime();
      const source = await runtime.registries.sourceAdapter.create('content', runtime.deps);
      await new Ingestor({ sources: [source], pipeline: createWritePipeline(runtime), logger: runtime.logger, concurrency: 1, reclaimIntervalMs: 60_000, retryBaseMs: 10, retryMaxMs: 100 }).drain();
      ids.push((await allMemories(runtime)).map((m) => m.id).sort());
    }
    expect(ids[0]).toEqual(ids[1]);
  });

  it('keeps memories of different workspaces apart', async () => {
    const a = await makeRuntime({ DEV_CONTENT_WORKSPACE_ID: 'workspace-a' });
    const source = await a.runtime.registries.sourceAdapter.create('content', a.runtime.deps);
    await new Ingestor({ sources: [source], pipeline: createWritePipeline(a.runtime), logger: a.runtime.logger, concurrency: 2, reclaimIntervalMs: 60_000, retryBaseMs: 10, retryMaxMs: 100 }).drain();
    expect(await a.runtime.store.countMemories('workspace-a')).toBeGreaterThan(0);
    expect(await a.runtime.store.countMemories(WORKSPACE)).toBe(0);
    expect(await a.runtime.store.listWorkspaceIds()).toEqual(['workspace-a']);
  });
});

describe('conversation text carried by audit events (protocol content)', () => {
  const publishMessage = async (runtime: Runtime, text: string, id: string) => {
    const event = buildAuditEvent({
      eventId: id,
      traceId: '5a1d9c2e-0000-4000-8000-000000000001',
      workspaceId: WORKSPACE,
      actor: { type: 'user', id: 'uid-1' },
      service: 'hub',
      action: 'thread.message_received',
      category: 'command',
      outcome: 'success',
      threadId: '5a1d9c2e-0000-4000-8000-0000000000aa',
      details: { length: text.length },
      content: buildAuditContent('user_message', text),
    } as Parameters<typeof buildAuditEvent>[0]);
    await runtime.bus.publish(runtime.config.eventBus.auditTopic, event, { key: WORKSPACE });
  };

  it('remembers what the user said, redacted, without logging or auditing the text', async () => {
    const { runtime, logger } = await makeRuntime({ SOURCES: 'audit' });
    await publishMessage(runtime, 'I prefer a warm tone for the brand. Reach me at jo.marketing@example.com, key sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c.', '5a1d9c2e-0000-4000-8000-000000000011');
    await publishMessage(runtime, 'Hello again.', '5a1d9c2e-0000-4000-8000-000000000012');
    const source = await runtime.registries.sourceAdapter.create('audit', { ...runtime.deps, consumerName: 'test-consumer' });
    const ingestor = new Ingestor({ sources: [source], pipeline: createWritePipeline(runtime), logger, concurrency: 2, reclaimIntervalMs: 60_000, retryBaseMs: 10, retryMaxMs: 100 });
    const totals = await ingestor.drain();
    expect(totals).toMatchObject({ polled: 2, failed: 0 });
    const memories = await allMemories(runtime);
    const tone = memories.find((m) => m.content.includes('warm tone'));
    expect(tone).toBeDefined();
    expect(tone!.category).toBe('semantic');
    expect(tone!.sourceRefs[0]).toMatchObject({ kind: 'thread', ref: '' + 'audit:5a1d9c2e-0000-4000-8000-000000000011' });
    expect(tone!.threadId).toBe('5a1d9c2e-0000-4000-8000-0000000000aa');
    const everything = JSON.stringify([memories, logger.records, (await auditEvents(runtime)).filter((e) => e.action.startsWith('memory.'))]);
    expect(everything).not.toContain('sk-live-4f9a');
    expect(everything).not.toContain('jo.marketing@example.com');
    expect(JSON.stringify(logger.records)).not.toContain('warm tone');
    expect(JSON.stringify(logger.records)).not.toContain('Hello again');
    const stored = await runtime.store.getObservation(WORKSPACE, memories.find((m) => m.sourceRefs[0].ref.endsWith('11'))!.provenance.observationIds[0]);
    expect(stored?.text).toContain('[REDACTED:');
    expect(JSON.stringify(stored)).not.toContain('sk-live-4f9a');
  });
});

/** A source that hands out the given observations and records acks, with the redelivery behaviour of the real ones. */
class FakeSource implements SourceAdapter {
  readonly name = 'fake';
  acked: string[] = [];
  rejected: string[] = [];
  pending: Observation[];
  deliveries = new Map<string, number>();
  pollError: Error | null = null;
  pollCalls = 0;
  constructor(observations: Observation[]) {
    this.pending = [...observations];
  }
  private item(observation: Observation): SourceItem {
    const count = (this.deliveries.get(observation.id) ?? 0) + 1;
    this.deliveries.set(observation.id, count);
    return {
      observation,
      deliveryCount: count,
      ack: async () => {
        this.acked.push(observation.id);
        this.pending = this.pending.filter((o) => o.id !== observation.id);
      },
      reject: async (reason) => {
        this.rejected.push(`${observation.id}:${reason}`);
      },
    };
  }
  private fresh = new Set<string>();
  async poll(): Promise<SourceItem[]> {
    this.pollCalls += 1;
    if (this.pollError) throw this.pollError;
    const items = this.pending.filter((o) => !this.fresh.has(o.id));
    for (const o of items) this.fresh.add(o.id);
    return items.map((o) => this.item(o));
  }
  async reclaim(): Promise<SourceItem[]> {
    return this.pending.filter((o) => this.fresh.has(o.id)).map((o) => this.item(o));
  }
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

const obs = (n: number): Observation => ({
  id: deterministicUuid('observation', `test-${n}`),
  workspaceId: WORKSPACE,
  source: 'test',
  sourceRef: `test:${n}`,
  kind: 'thread.message',
  occurredAt: '2026-10-20T10:00:00.000Z',
  text: `message ${n}`,
  facts: {},
  signal: { polarity: 'neutral', strength: 0.3 },
  significance: 'normal',
});

const result = (o: Observation, status: PipelineResult['status'] = 'processed'): PipelineResult => ({
  observationId: o.id,
  status,
  created: status === 'processed' ? [o.id] : [],
  merged: [],
  superseded: [],
  dropped: 0,
  redactions: [],
  extractionAttempts: 1,
});

const quick = { reclaimIntervalMs: 5, retryBaseMs: 1, retryMaxMs: 4, sleep: () => new Promise<void>((r) => setTimeout(r, 2)) };

describe('delivery semantics', () => {
  it('acknowledges only after the pipeline finished, and leaves a failing item pending for redelivery', async () => {
    const items = [obs(1), obs(2), obs(3)];
    const source = new FakeSource(items);
    const attempts = new Map<string, number>();
    const pipeline: ObservationProcessor = {
      async process(o) {
        attempts.set(o.id, (attempts.get(o.id) ?? 0) + 1);
        if (o.id === items[1].id && attempts.get(o.id) === 1) throw new Error('llm unavailable');
        return result(o);
      },
    };
    const logger = new MemoryLogger();
    const ingestor = new Ingestor({ sources: [source], pipeline, logger, concurrency: 2, ...quick });
    const first = await ingestor.drain();
    expect(first).toMatchObject({ polled: 3, processed: 2, failed: 1 });
    expect(source.acked.sort()).toEqual([items[0].id, items[2].id].sort());
    expect(logger.records.some((r) => r.level === 'error' && r.msg.includes('left pending'))).toBe(true);
    // The source hands the failed one out again; this time it works.
    ingestor.start();
    await waitFor(() => source.acked.includes(items[1].id));
    await ingestor.stop();
    expect(attempts.get(items[1].id)).toBe(2);
    expect(source.deliveries.get(items[1].id)).toBe(2);
  });

  it('never processes more than `concurrency` observations at once', async () => {
    const items = Array.from({ length: 12 }, (_, i) => obs(i));
    const source = new FakeSource(items);
    let running = 0;
    let peak = 0;
    const pipeline: ObservationProcessor = {
      async process(o) {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return result(o);
      },
    };
    const totals = await new Ingestor({ sources: [source], pipeline, logger: new MemoryLogger(), concurrency: 3, ...quick }).drain();
    expect(totals.processed).toBe(12);
    expect(peak).toBe(3);
  });

  it('counts duplicates and skips, and keeps going when the source itself fails (with backoff)', async () => {
    const items = [obs(1), obs(2)];
    const source = new FakeSource(items);
    const pipeline: ObservationProcessor = { process: async (o) => result(o, o.id === items[0].id ? 'duplicate' : 'skipped') };
    const sleeps: number[] = [];
    const logger = new MemoryLogger();
    const ingestor = new Ingestor({
      sources: [source],
      pipeline,
      logger,
      concurrency: 1,
      reclaimIntervalMs: 1_000_000,
      retryBaseMs: 10,
      retryMaxMs: 40,
      sleep: async (ms) => {
        sleeps.push(ms);
        await new Promise((r) => setTimeout(r, 1));
      },
    });
    source.pollError = new Error('redis down');
    ingestor.start();
    await waitFor(() => sleeps.filter((s) => s >= 10 && s < 1000).length >= 4);
    source.pollError = null;
    await waitFor(() => source.acked.length === 2);
    await ingestor.stop();
    const backoffs = sleeps.filter((s) => s >= 10 && s < 1000);
    expect(backoffs.slice(0, 4)).toEqual([10, 20, 40, 40]);
    expect(ingestor.stats).toMatchObject({ duplicate: 1, skipped: 1, failed: 0 });
    expect(logger.records.filter((r) => r.msg === 'source poll failed').length).toBeGreaterThanOrEqual(4);
  });

  it('stop() waits for work in progress and polls no more afterwards', async () => {
    const source = new FakeSource([obs(1)]);
    let finished = false;
    const pipeline: ObservationProcessor = {
      async process(o) {
        await new Promise((r) => setTimeout(r, 30));
        finished = true;
        return result(o);
      },
    };
    const ingestor = new Ingestor({ sources: [source], pipeline, logger: new MemoryLogger(), concurrency: 1, ...quick });
    ingestor.start();
    await waitFor(() => source.pollCalls > 0);
    await ingestor.stop();
    expect(finished).toBe(true);
    expect(source.acked).toHaveLength(1);
    const calls = source.pollCalls;
    await new Promise((r) => setTimeout(r, 20));
    expect(source.pollCalls).toBe(calls);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!condition()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}
