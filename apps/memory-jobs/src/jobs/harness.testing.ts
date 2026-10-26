import { randomUUID } from 'node:crypto';
import {
  GLOBAL_WORKSPACE,
  M2_JOB_NAMES,
  MemoryLogger,
  loadConfig,
  type AuditEvent,
  type JobConfigRecord,
  type LlmRequest,
  type Memory,
  type MemoryInsert,
  type Observation,
  type Stance,
} from '@smallseedlabs/proba-memory-core';
import { makeMemoryInsert, makeObservation } from '@smallseedlabs/proba-memory-core/testing';
import { ManualClock, ScriptedLlmProvider, createRuntime, type Runtime } from '@smallseedlabs/proba-memory-adapters';
import { createJobDeps, createJobs, jobNeeds, type JobDeps } from './index.js';
import { createJobRunner } from '../runner.js';
import { defaultJobConfig } from '../job-configs.js';
import type { Job, M2JobName } from '@smallseedlabs/proba-memory-core';

export const NOW = '2026-10-26T12:00:00.000Z';
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();

export const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MEMORY_STORE: 'memory',
  VECTOR_INDEX: 'memory',
  SCORING_PROFILE_STORE: 'memory',
  RETRIEVAL_LOG_STORE: 'memory',
  JOB_RUN_STORE: 'memory',
  JOB_CONFIG_STORE: 'memory',
  EMBEDDING_MIGRATION_STORE: 'memory',
  OUTBOX_STORE: 'memory',
  EVENT_BUS: 'memory',
  AUDIT_TRANSPORT: 'bus',
  JOB_SCHEDULER: 'manual',
  EMBEDDER: 'hash',
  ALLOW_LOCAL_EMBEDDER: 'true',
  LLM_PROVIDER: 'scripted',
  ALLOW_SCRIPTED_LLM: 'true',
  EMBEDDING_DIMENSION: '64',
  JOBS_BATCH_SIZE: '50',
};

export type Responder = (request: LlmRequest, callIndex: number) => string | Promise<string>;

/** A scripted model that summarises by joining the notes it was given. No network. */
export const joiningResponder: Responder = (request) => {
  const user = request.messages.at(-1)!.content;
  const json = user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1);
  const data = JSON.parse(json) as { notes: { content: string }[] };
  const first = data.notes[0]?.content ?? 'nothing';
  return JSON.stringify({ content: `Consolidated from ${data.notes.length} notes: ${first}`, summary: `Consolidated: ${first.slice(0, 60)}` });
};

export interface SeedItem extends Partial<MemoryInsert> {
  content: string;
  stance?: Stance;
  /** Observation kinds to attach as evidence (for example `approval.granted`). */
  observations?: string[];
}

export interface Harness {
  runtime: Runtime;
  config: ReturnType<typeof loadConfig>;
  clock: ManualClock;
  logger: MemoryLogger;
  llm: ScriptedLlmProvider;
  deps: JobDeps;
  runner: ReturnType<typeof createJobRunner>;
  /** A fresh job of this name wired to the harness. */
  job(name: string): Job;
  seed(workspaceId: string, items: SeedItem[]): Promise<Memory[]>;
  get(workspaceId: string, id: string): Promise<Memory>;
  all(workspaceId: string): Promise<Memory[]>;
  events(): Promise<AuditEvent[]>;
  publish(workspaceId: string, job: M2JobName, patch: Record<string, unknown>): Promise<JobConfigRecord>;
  /** Everything a dry run must leave alone, as one comparable value. */
  snapshot(workspaceIds: string[], options?: { global?: boolean }): Promise<unknown>;
}

const open: Runtime[] = [];

export async function closeHarnesses(): Promise<void> {
  for (const r of open.splice(0)) await r.close();
}

export async function setup(options: { env?: Record<string, string>; responder?: Responder } = {}): Promise<Harness> {
  const config = loadConfig({ ...BASE_ENV, ...options.env }, { serviceName: 'memory-jobs' });
  const clock = new ManualClock(NOW);
  const logger = new MemoryLogger();
  const runtime = await createRuntime(config, { service: 'memory-jobs', logger, clock, needs: jobNeeds([...M2_JOB_NAMES]) });
  open.push(runtime);
  const llm = new ScriptedLlmProvider({ responder: options.responder ?? joiningResponder, nodeEnv: 'test', allowScripted: false });
  const deps: JobDeps = { ...createJobDeps(runtime, [...M2_JOB_NAMES]), llm };
  const runner = createJobRunner(runtime);

  const get = async (workspaceId: string, id: string): Promise<Memory> => {
    const m = await runtime.store.getMemory(workspaceId, id);
    if (!m) throw new Error(`memory ${id} not found in ${workspaceId}`);
    return m;
  };
  const all = async (workspaceId: string): Promise<Memory[]> => {
    const out: Memory[] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await runtime.store.listMemories({ workspaceId, filter: { statuses: ['active', 'superseded', 'tombstoned'] }, limit: 200, ...(cursor ? { cursor } : {}) });
      out.push(...page.memories);
      if (!page.nextCursor) return out;
      cursor = page.nextCursor;
    }
  };
  const events = async (): Promise<AuditEvent[]> => {
    const sub = await runtime.bus.subscribe({ topic: config.eventBus.auditTopic, group: `test-${randomUUID()}`, consumer: 'c' });
    return (await sub.read<AuditEvent>({ max: 10_000 })).map((m) => m.payload);
  };

  return {
    runtime,
    config,
    clock,
    logger,
    llm,
    deps,
    runner,
    job: (name) => createJobs({ ...config, jobs: { ...config.jobs, enabled: [name] } }, 'memory-jobs', deps)[0],
    async seed(workspaceId, items) {
      const out: Memory[] = [];
      for (const item of items) {
        const { content, stance, observations, ...rest } = item;
        const id = rest.id ?? randomUUID();
        const [vector] = await runtime.embedder.embed([content]);
        const observationIds: string[] = [];
        for (const kind of observations ?? []) {
          const o: Observation = makeObservation(workspaceId, { kind, occurredAt: rest.createdAt ?? ago(DAY) });
          await runtime.store.claimObservation(o, NOW);
          observationIds.push(o.id);
        }
        const base = makeMemoryInsert(workspaceId, {
          id,
          content,
          embedding: vector,
          embeddingModel: runtime.embedder.model,
          embeddingVersion: runtime.embedder.version,
          lastReinforcedAt: rest.createdAt ?? ago(DAY),
          validFrom: rest.createdAt ?? ago(DAY),
          createdAt: ago(DAY),
          ...rest,
        });
        const insert: MemoryInsert = {
          ...base,
          provenance: { ...base.provenance, stance: stance ?? base.provenance.stance, observationIds, signals: [...new Set(observations ?? [])], ...(rest.provenance ?? {}) },
        };
        await runtime.store.transaction((tx) => tx.insertMemory(insert));
        out.push(await get(workspaceId, id));
      }
      return out;
    },
    get,
    all,
    events,
    async publish(workspaceId, job, patch) {
      const current = (await runtime.jobConfigs.resolve(workspaceId, job))?.config ?? defaultJobConfig(job);
      return runtime.jobConfigs.publish({ workspaceId, jobName: job, config: { ...current, ...patch }, createdBy: 'test', at: clock.isoNow(), note: 'test' });
    },
    async snapshot(workspaceIds, options = {}) {
      const state: Record<string, unknown> = {};
      for (const ws of workspaceIds) {
        const memories = (await all(ws)).sort((a, b) => (a.id < b.id ? -1 : 1));
        const links = [];
        for (const m of memories) links.push(await runtime.store.listLinks(ws, m.id));
        const vectors = [...(await runtime.index.getVectors(ws, memories.map((m) => m.id)))].sort(([a], [b]) => (a < b ? -1 : 1));
        const configs = [];
        for (const name of M2_JOB_NAMES) configs.push(await runtime.jobConfigs.list(ws, name));
        state[ws] = { memories, links, vectors, configs };
      }
      const globalConfigs = [];
      if (options.global) for (const name of M2_JOB_NAMES) globalConfigs.push(await runtime.jobConfigs.list(GLOBAL_WORKSPACE, name));
      return { state, globalConfigs, events: (await events()).filter((e) => workspaceIds.includes(e.workspaceId) && e.action.startsWith('memory.')).length };
    },
  };
}
