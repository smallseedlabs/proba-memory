import { MemoryExtractor, MemoryResolver, Redactor, RetrievalService, WritePipeline } from '@smallseedlabs/proba-memory-core';
import type { Runtime } from './runtime.js';

export function createRedactor(runtime: Runtime): Redactor {
  return new Redactor({ pii: runtime.config.write.redactPii });
}

/** The write path wired from the runtime (needs `embedder` and `llm`). */
export function createWritePipeline(runtime: Runtime): WritePipeline {
  const { config, logger } = runtime;
  const redactor = createRedactor(runtime);
  const extractor = new MemoryExtractor({
    llm: runtime.llm,
    logger,
    redactor,
    maxCandidates: config.write.extraction.maxCandidates,
    maxAttempts: config.write.extraction.maxAttempts,
    maxContentChars: config.write.maxContentChars,
    signals: config.write.signals,
  });
  const resolver = new MemoryResolver({
    store: runtime.store,
    index: runtime.index,
    embedder: runtime.embedder,
    similarityThreshold: config.write.resolver.similarityThreshold,
    relatedThreshold: config.write.resolver.relatedThreshold,
  });
  return new WritePipeline({
    store: runtime.store,
    index: runtime.index,
    embedder: runtime.embedder,
    extractor,
    redactor,
    resolver,
    emitter: runtime.emitter,
    clock: runtime.clock,
    ids: runtime.ids,
    logger,
    service: runtime.service,
  });
}

/** Retrieval wired from the runtime (needs `embedder` and `retrieval`; `llm` only when RERANK_ENABLED). */
export function createRetrievalService(runtime: Runtime): RetrievalService {
  const { config } = runtime;
  return new RetrievalService({
    store: runtime.store,
    index: runtime.index,
    embedder: runtime.embedder,
    profiles: runtime.profiles,
    logStore: runtime.logStore,
    tokens: runtime.tokens,
    emitter: runtime.emitter,
    clock: runtime.clock,
    ids: runtime.ids,
    logger: runtime.logger,
    redactor: createRedactor(runtime),
    ...(config.retrieval.rerankEnabled ? { llm: runtime.llm } : {}),
    settings: config.retrieval,
    service: runtime.service,
  });
}
