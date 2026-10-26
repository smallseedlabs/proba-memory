import { describe, expect, it } from 'vitest';
import { MemoryLogger, deterministicUuid, loadConfig, type EventBus, type Embedder, type LlmProvider } from '@smallseedlabs/proba-memory-core';
import { createDefaultRegistries } from './registries.js';
import { createRuntime } from './runtime.js';
import { createRetrievalService, createWritePipeline } from './services.js';
import { InMemoryOutcomeLinker, NoopOutcomeLinker } from '../memory/outcome-linker.js';
import type { ActionOutcomeLink } from '@smallseedlabs/proba-memory-core';

const DIM = 32;
const inMemoryEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MEMORY_STORE: 'memory',
  VECTOR_INDEX: 'memory',
  SCORING_PROFILE_STORE: 'memory',
  RETRIEVAL_LOG_STORE: 'memory',
  JOB_RUN_STORE: 'memory',
  OUTBOX_STORE: 'memory',
  EVENT_BUS: 'memory',
  JOB_SCHEDULER: 'manual',
  EMBEDDER: 'hash',
  ALLOW_LOCAL_EMBEDDER: 'true',
  LLM_PROVIDER: 'scripted',
  ALLOW_SCRIPTED_LLM: 'true',
  EMBEDDING_DIMENSION: String(DIM),
};

describe('createRuntime', () => {
  it('builds every port from config, with swapped-in adapters, and runs the write and read paths over them', async () => {
    const runtime = await createRuntime(loadConfig(inMemoryEnv, { serviceName: 'memory-test', defaultPort: 1 }), {
      service: 'memory-test',
      logger: new MemoryLogger(),
      needs: { embedder: true, llm: true, retrieval: true, jobs: true },
    });
    try {
      expect(runtime.store.constructor.name).toBe('InMemoryMemoryStore');
      expect(runtime.index.constructor.name).toBe('InMemoryVectorIndex');
      expect(runtime.bus.constructor.name).toBe('InMemoryEventBus');
      expect(runtime.embedder.dimension).toBe(DIM);
      expect(runtime.createRelay()).not.toBeNull();
      await runtime.profiles.ensureDefault();
      const pipeline = createWritePipeline(runtime);
      const result = await pipeline.process({
        id: deterministicUuid('o', 'rt-1'),
        workspaceId: 'ws',
        source: 'test',
        sourceRef: 'rt:1',
        kind: 'goal.created',
        occurredAt: '2026-10-25T10:00:00.000Z',
        text: 'Grow newsletter signups by twenty percent this quarter.',
        facts: {},
        signal: { polarity: 'neutral', strength: 0.5 },
        significance: 'normal',
      });
      expect(result.status).toBe('processed');
      const found = await createRetrievalService(runtime).search(
        { workspaceId: 'ws', actor: { type: 'user', id: 'u' }, traceId: deterministicUuid('t', '1') },
        { query: 'newsletter signups' }
      );
      expect(found.results).toHaveLength(1);
      expect(found.results[0].content).toContain('newsletter signups');
      // Audit events are in the outbox until the relay publishes them.
      expect((await runtime.outbox.claim(10, 1000)).length).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });

  it('does not create ports an app did not ask for (no embedder, no LLM, no keys)', async () => {
    const runtime = await createRuntime(loadConfig({ ...inMemoryEnv, EMBEDDER: 'openai-compatible', LLM_PROVIDER: 'deepseek' }, { serviceName: 'memory-test', defaultPort: 1 }), {
      service: 'memory-test',
      logger: new MemoryLogger(),
    });
    try {
      expect(() => runtime.embedder).toThrow(/needs.embedder/);
      expect(() => runtime.llm).toThrow(/needs.llm/);
      expect(() => runtime.profiles).toThrow(/needs.retrieval/);
      expect(() => runtime.jobRuns).toThrow(/needs.jobs/);
    } finally {
      await runtime.close();
    }
  });

  it('refuses an embedder whose vectors do not match the configured dimension', async () => {
    const config = loadConfig({ ...inMemoryEnv, EMBEDDER: 'bad-dim', EMBEDDING_DIMENSION: '48' }, { serviceName: 'memory-test', defaultPort: 1 });
    const registries = createDefaultRegistries();
    registries.embedder.register('bad-dim', ({ config: c }) => ({ ...({} as Embedder), name: 'x', model: 'x', version: '1', dimension: c.postgres.embeddingDimension + 1, embed: async () => [], close: async () => undefined }));
    await expect(createRuntime(config, { service: 't', logger: new MemoryLogger(), needs: { embedder: true }, registries })).rejects.toThrow(/EMBEDDING_DIMENSION=48/);
  });

  it('lets a new adapter be added by registering a factory and naming it in config (no other change)', async () => {
    const registries = createDefaultRegistries();
    let created = 0;
    registries.llmProvider.register('acme', () => {
      created += 1;
      return { name: 'acme', model: 'acme-1', complete: async () => ({ text: '{"memories":[]}', usage: null }), close: async () => undefined } as unknown as LlmProvider;
    });
    registries.eventBus.register('acme-bus', (deps) => registries.eventBus.create('memory', deps) as unknown as EventBus);
    const config = loadConfig({ ...inMemoryEnv, LLM_PROVIDER: 'acme', EVENT_BUS: 'acme-bus' }, { serviceName: 'memory-test', defaultPort: 1 });
    const runtime = await createRuntime(config, { service: 't', logger: new MemoryLogger(), needs: { llm: true }, registries });
    try {
      expect(runtime.llm.name).toBe('acme');
      expect(created).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it('names the valid choices when config selects an adapter that does not exist', async () => {
    const config = loadConfig({ ...inMemoryEnv, EVENT_BUS: 'carrier-pigeon' }, { serviceName: 'memory-test', defaultPort: 1 });
    await expect(createRuntime(config, { service: 't', logger: new MemoryLogger() })).rejects.toThrow(/carrier-pigeon.*memory.*redis-streams|redis-streams.*memory/s);
  });
});

describe('OutcomeLinker adapters', () => {
  const link = (over: Partial<ActionOutcomeLink> = {}): ActionOutcomeLink => ({
    workspaceId: 'ws',
    action: { kind: 'approval', id: 'a1' },
    metric: { platform: 'meta', metric: 'conversions' },
    before: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' },
    after: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z' },
    beforeMean: 10,
    afterMean: 12,
    sampleSize: { before: 7, after: 7 },
    relativeChange: 0.2,
    correlation: null,
    method: 'window-means',
    caveat: 'correlation_not_causation',
    ...over,
  });

  it('the default stores nothing and says so in the log, without failing the caller', async () => {
    const logger = new MemoryLogger();
    const linker = new NoopOutcomeLinker(logger);
    await expect(linker.record(link())).resolves.toBeUndefined();
    expect(await linker.list('ws')).toEqual([]);
    expect(linker.name).toBe('noop');
  });

  it('the in-memory linker is idempotent by action, metric and windows, and scoped to the workspace', async () => {
    const linker = new InMemoryOutcomeLinker();
    await linker.record(link());
    await linker.record(link({ afterMean: 13 }));
    await linker.record(link({ action: { kind: 'goal', id: 'g1' } }));
    await linker.record(link({ workspaceId: 'other' }));
    expect(await linker.list('ws')).toHaveLength(2);
    expect((await linker.list('ws', { kind: 'approval', id: 'a1' }))[0].afterMean).toBe(13);
    expect(await linker.list('other')).toHaveLength(1);
  });
});
