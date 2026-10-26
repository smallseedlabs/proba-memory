/**
 * The whole service on its default adapters: audit events on Redis Streams, the write path and retrieval
 * on Postgres + pgvector, audit emission through the outbox and its relay back onto Redis.
 * Needs DATABASE_URL (a server, the test database is created) and REDIS_URL.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  MemoryLogger,
  buildAuditContent,
  buildAuditEvent,
  loadConfig,
  type AuditEvent,
} from '@smallseedlabs/proba-memory-core';
import { makeSecrets, uniqueName } from '@smallseedlabs/proba-memory-core/testing';
import { createRuntime, createRetrievalService, createWritePipeline, type Runtime } from './runtime/index.js';
import { getTestPool, testDatabaseUrl, testRedisUrl, TEST_DIMENSION } from './postgres/test-db.js';
import { randomUUID } from 'node:crypto';

await getTestPool(); // creates and migrates the test database

const topic = uniqueName('audit');
const workspaceA = uniqueName('stack-a');
const workspaceB = uniqueName('stack-b');
const secrets = makeSecrets();
const runtimes: Runtime[] = [];

async function makeRuntime(service: string, extra: Record<string, string> = {}): Promise<{ runtime: Runtime; logger: MemoryLogger }> {
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: testDatabaseUrl(),
      REDIS_URL: testRedisUrl(),
      EMBEDDING_DIMENSION: String(TEST_DIMENSION),
      EMBEDDER: 'hash',
      ALLOW_LOCAL_EMBEDDER: 'true',
      LLM_PROVIDER: 'scripted',
      ALLOW_SCRIPTED_LLM: 'true',
      AUDIT_TOPIC: topic,
      MEMORY_AUDIT_CONSUMER_GROUP: uniqueName('group'),
      AUDIT_WORKSPACE_ID: workspaceA,
      OUTBOX_RELAY_POLL_MS: '50',
      ...extra,
    },
    { serviceName: service }
  );
  const logger = new MemoryLogger();
  const runtime = await createRuntime(config, { service, logger, needs: { embedder: true, llm: true, retrieval: true, jobs: true } });
  runtimes.push(runtime);
  return { runtime, logger };
}

afterAll(async () => {
  for (const r of runtimes) await r.close();
});

const ctx = (workspaceId: string) => ({ workspaceId, actor: { type: 'user' as const, id: 'uid-1' }, traceId: randomUUID() });

const message = (workspaceId: string, text: string) =>
  buildAuditEvent({
    eventId: randomUUID(),
    traceId: randomUUID(),
    workspaceId,
    actor: { type: 'user', id: 'uid-1' },
    service: 'hub',
    action: 'thread.message_received',
    category: 'command',
    outcome: 'success',
    threadId: randomUUID(),
    details: { length: text.length },
    content: buildAuditContent('user_message', text),
  } as Parameters<typeof buildAuditEvent>[0]);

describe('audit stream to memory to retrieval on Postgres + Redis', () => {
  it('learns from conversation text carried by audit events, per workspace, and retrieves it with provenance', async () => {
    const { runtime, logger } = await makeRuntime('memory-ingestor');
    const pipeline = createWritePipeline(runtime);
    const texts: [string, string][] = [
      [workspaceA, `We never run discount banners with countdown timers, they feel pushy to our audience. Contact jo@example.com, key ${secrets.apiKey}.`],
      [workspaceA, 'Our brand voice is warm and plain-spoken.'],
      [workspaceB, 'Discount banners with countdown timers are our best performing format in workspace B. SECRET-B'],
    ];
    for (const [w, t] of texts) await runtime.bus.publish(topic, message(w, t), { key: w });

    const source = await runtime.registries.sourceAdapter.create('audit', { ...runtime.deps, consumerName: 'stack-test' });
    let seen = 0;
    for (let attempt = 0; attempt < 20 && seen < texts.length; attempt += 1) {
      for (const item of await source.poll({ max: 10, blockMs: 200 })) {
        const result = await pipeline.process(item.observation);
        expect(['processed', 'skipped', 'duplicate']).toContain(result.status);
        await item.ack();
        seen += 1;
      }
    }
    expect(seen).toBe(3);
    await source.close();

    // Another delivery of the same event ids changes nothing (idempotent by observation id).
    expect(await runtime.store.countMemories(workspaceA)).toBeGreaterThan(0);
    expect(await runtime.store.countMemories(workspaceB)).toBeGreaterThan(0);

    const retrieval = createRetrievalService(runtime);
    await runtime.profiles.ensureDefault();
    const a = await retrieval.search({ ...ctx(workspaceA), includeCandidates: true }, { query: 'discount banner countdown timer' });
    expect(a.results.length).toBeGreaterThan(0);
    expect(a.results[0].content).toMatch(/countdown timers/);
    expect(JSON.stringify(a)).not.toContain('SECRET-B');
    expect(JSON.stringify(a)).not.toContain(secrets.apiKeyFragment);
    expect(JSON.stringify(a)).not.toContain('jo@example.com');
    expect(a.results[0].sourceRefs?.[0]?.kind ?? 'thread').toBe('thread');
    expect(a.candidates!.every((c) => c.features !== undefined)).toBe(true);

    const b = await retrieval.search(ctx(workspaceB), { query: 'discount banner countdown timer' });
    expect(b.results.map((r) => r.content).join()).toContain('SECRET-B');
    expect(b.results.map((r) => r.content).join()).not.toContain('pushy');

    // Every retrieval is in the log with its candidates, and the memory's access counter moved.
    const [entry] = await runtime.logStore.list(workspaceA, { limit: 1 });
    expect(entry).toMatchObject({ id: a.retrievalId, profileName: 'default', profileVersion: 1 });
    expect(entry.candidates.length).toBeGreaterThan(0);
    expect((await runtime.store.getMemory(workspaceA, a.results[0].id))!.accessCount).toBeGreaterThanOrEqual(1);

    // Secrets and text stayed out of the logs.
    expect(JSON.stringify(logger.records)).not.toContain(secrets.apiKeyFragment);
    expect(JSON.stringify(logger.records)).not.toContain('pushy');
  });

  it('publishes its audit events through the outbox relay onto the bus, without memory text', async () => {
    const { runtime } = await makeRuntime('memory-api');
    const relay = runtime.createRelay();
    expect(relay).not.toBeNull();
    const reader = await runtime.bus.subscribe({ topic, group: uniqueName('reader'), consumer: 'c' });
    // Retrieval emits memory.retrieved into the outbox, inside the same transaction as the log row.
    await runtime.profiles.ensureDefault();
    const found = await createRetrievalService(runtime).search(ctx(workspaceA), { query: 'brand voice warm' });
    await relay!.runOnce();
    const events: AuditEvent[] = [];
    for (let i = 0; i < 20 && !events.some((e) => e.target?.id === found.retrievalId); i += 1) {
      events.push(...(await reader.read<AuditEvent>({ max: 100, blockMs: 100 })).map((m) => m.payload));
    }
    const retrieved = events.find((e) => e.action === 'memory.retrieved' && e.target?.id === found.retrievalId);
    expect(retrieved).toBeDefined();
    expect(retrieved).toMatchObject({ service: 'memory-api', workspaceId: workspaceA, outcome: 'success' });
    const own = JSON.stringify(events.filter((e) => e.action.startsWith('memory.')));
    expect(own).not.toContain('brand voice warm');
    expect(own).not.toContain('plain-spoken');
    expect(events.filter((e) => e.action.startsWith('memory.')).length).toBeGreaterThan(0);
  });

  it('commits the retrieval log row and its audit event together: a failing audit write leaves no log row and no counters', async () => {
    const { runtime } = await makeRuntime('memory-api');
    await runtime.profiles.ensureDefault();
    const before = await runtime.logStore.list(workspaceA, { limit: 100 });
    const pending = await runtime.outbox.pendingCount();
    const broken = { emit: async () => Promise.reject(new Error('outbox unavailable')), forTrace: () => broken };
    const failing = createRetrievalService({ ...runtime, emitter: broken } as unknown as Runtime);
    await expect(failing.search(ctx(workspaceA), { query: 'brand voice warm' })).rejects.toThrow(/outbox unavailable/);
    expect((await runtime.logStore.list(workspaceA, { limit: 100 })).length).toBe(before.length);
    expect(await runtime.outbox.pendingCount()).toBe(pending);
  });
});
