import {
  MemoryExtractor,
  MemoryLogger,
  MemoryResolver,
  Redactor,
  RetrievalService,
  WritePipeline,
  createBusAuditEmitter,
  loadConfig,
  type Observation,
} from '@smallseedlabs/proba-memory-core';
import {
  ApproxTokenCounter,
  HashEmbedder,
  InMemoryEventBus,
  InMemoryMemoryStore,
  InMemoryRetrievalLogStore,
  InMemoryScoringProfileStore,
  InMemoryVectorIndex,
  ManualClock,
  ScriptedLlmProvider,
  SequentialIdGenerator,
  ruleBasedResponder,
  type Responder,
} from '@smallseedlabs/proba-memory-adapters';
import type { ProfileStatus } from '@smallseedlabs/proba-memory-scoring';
import type { GoldenObservation, GoldenSet } from './golden.js';
import type { MatchableResult } from './metrics.js';
import type { ProfileSpec } from './profiles.js';

export const EVAL_DIMENSION = 64;
const TOPIC = 'proba.audit.events';

export interface ReplayStats {
  replayed: number;
  processed: number;
  skipped: number;
  duplicate: number;
  memories: number;
  superseded: number;
}

export interface EvalStack {
  clock: ManualClock;
  store: InMemoryMemoryStore;
  profiles: InMemoryScoringProfileStore;
  logStore: InMemoryRetrievalLogStore;
  tokens: ApproxTokenCounter;
  embedderName: string;
  llmName: string;
  /** Retrieval service that resolves scoring profiles of the given name (per workspace). */
  retrievalFor(profileName: string): RetrievalService;
  /** Process observations through the real write path, setting the clock to each one's time. */
  replay(observations: GoldenObservation[]): Promise<ReplayStats>;
  /** Install a profile version in each workspace under `family` and move it to `status`. Returns its version. */
  installProfile(workspaces: string[], family: string, spec: ProfileSpec, status: ProfileStatus, canaryPercent?: number): Promise<number>;
  /** Turn stored memories into matchable results (for shadow logs, which hold ids only). */
  hydrate(workspaceId: string, ids: string[]): Promise<MatchableResult[]>;
}

/**
 * The write and read path wired from in-process adapters only: hash embedder, scripted LLM, in-memory store,
 * vector index, profile store and retrieval log, manual clock, sequential ids. No network and no model: the same
 * input always gives the same ranking. The scripted LLM answers with the `extract` of the golden observation
 * (or the built-in rules when it has none).
 */
export function createEvalStack(set: GoldenSet): EvalStack {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', EMBEDDING_DIMENSION: String(EVAL_DIMENSION) });
  const clock = new ManualClock('2000-01-01T00:00:00.000Z');
  const ids = new SequentialIdGenerator();
  const logger = new MemoryLogger();
  const store = new InMemoryMemoryStore();
  const index = new InMemoryVectorIndex(store, EVAL_DIMENSION);
  const embedder = new HashEmbedder({ dimension: EVAL_DIMENSION, nodeEnv: 'test', allowLocal: false });
  const byKey = new Map(set.observations.map((o) => [o.key, o]));
  const responder: Responder = (request, callIndex) => {
    const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const match = /<observation>\s*([\s\S]*?)\s*<\/observation>/.exec(user);
    if (match) {
      try {
        const view = JSON.parse(match[1] as string) as { facts?: { evalKey?: string } };
        const extract = view.facts?.evalKey ? byKey.get(view.facts.evalKey)?.extract : undefined;
        if (extract) return JSON.stringify({ memories: [{ ...extract, summary: extract.summary ?? null }] });
      } catch {
        // Fall back to the rules.
      }
    }
    return ruleBasedResponder(request, callIndex);
  };
  const llm = new ScriptedLlmProvider({ nodeEnv: 'test', allowScripted: false, responder });
  const bus = new InMemoryEventBus(clock);
  const emitter = createBusAuditEmitter({ bus, topic: TOPIC, service: 'memory-eval', defaultWorkspaceId: set.workspace, clock, ids, logger, failureMode: 'throw' });
  const redactor = new Redactor({ pii: true });
  const extractor = new MemoryExtractor({ llm, logger, redactor, maxCandidates: 5, maxAttempts: 2, maxContentChars: 4000, signals: config.write.signals });
  const resolver = new MemoryResolver({ store, index, embedder, similarityThreshold: config.write.resolver.similarityThreshold, relatedThreshold: config.write.resolver.relatedThreshold });
  const pipeline = new WritePipeline({ store, index, embedder, extractor, redactor, resolver, emitter, clock, ids, logger, service: 'memory-eval' });
  const profiles = new InMemoryScoringProfileStore(clock);
  const logStore = new InMemoryRetrievalLogStore();
  const tokens = new ApproxTokenCounter();

  const services = new Map<string, RetrievalService>();
  const retrievalFor = (profileName: string): RetrievalService => {
    let service = services.get(profileName);
    if (!service) {
      service = new RetrievalService({
        store,
        index,
        embedder,
        profiles,
        logStore,
        tokens,
        emitter,
        clock,
        ids,
        logger,
        redactor,
        llm,
        settings: { defaultLimit: 10, maxLimit: 50, maxQueryChars: 500, profileName, rerankEnabled: true },
        service: 'memory-eval',
      });
      services.set(profileName, service);
    }
    return service;
  };

  const toObservation = (o: GoldenObservation): Observation => ({
    id: o.id,
    workspaceId: o.workspace,
    source: 'eval',
    sourceRef: `eval:${set.name}:${o.key}`,
    kind: o.kind,
    occurredAt: o.occurredAt,
    ...(o.goalId ? { goalId: o.goalId } : {}),
    ...(o.threadId ? { threadId: o.threadId } : {}),
    text: o.text,
    facts: { evalKey: o.key },
    signal: { polarity: o.polarity, strength: o.strength },
    significance: 'normal',
  });

  return {
    clock,
    store,
    profiles,
    logStore,
    tokens,
    embedderName: `${embedder.name}/${embedder.model}`,
    llmName: `${llm.name}/${llm.model}`,
    retrievalFor,
    async replay(observations) {
      const stats: ReplayStats = { replayed: 0, processed: 0, skipped: 0, duplicate: 0, memories: 0, superseded: 0 };
      for (const o of observations) {
        clock.set(o.occurredAt);
        const result = await pipeline.process(toObservation(o));
        stats.replayed += 1;
        stats[result.status] += 1;
      }
      const workspaces = new Set(observations.map((o) => o.workspace));
      for (const workspaceId of workspaces) {
        const all = await store.listMemories({ workspaceId, filter: { statuses: ['active', 'superseded', 'tombstoned'] }, limit: 1000 });
        stats.memories += all.memories.filter((m) => m.status === 'active').length;
        stats.superseded += all.memories.filter((m) => m.status === 'superseded').length;
      }
      return stats;
    },
    async installProfile(workspaces, family, spec, status, canaryPercent) {
      let version = 0;
      for (const workspaceId of workspaces) {
        const put = await profiles.put({ workspaceId, name: family, config: spec.config, createdBy: 'memory-eval', description: spec.description });
        await profiles.setStatus(workspaceId, family, put.version, status, canaryPercent);
        version = put.version;
      }
      return version;
    },
    async hydrate(workspaceId, wanted) {
      const memories = await store.getMemories(workspaceId, wanted);
      const byId = new Map(memories.map((m) => [m.id, m]));
      return wanted
        .map((id) => byId.get(id))
        .filter((m): m is NonNullable<typeof m> => m !== undefined)
        .map((m) => ({ id: m.id, content: m.content, sourceRefs: m.sourceRefs.map((s) => s.ref), tokens: tokens.count(m.content) + 4 }));
    },
  };
}
