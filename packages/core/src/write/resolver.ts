import { cosineSimilarity } from '@smallseedlabs/proba-memory-scoring';
import type { Memory, Stance } from '../domain/index.js';
import type { MemoryStore } from '../ports/memory-store.js';
import type { VectorIndex } from '../ports/vector-index.js';
import type { CandidateMemory } from './extractor.js';

export interface ResolverOptions {
  store: Pick<MemoryStore, 'getMemories'>;
  index: VectorIndex;
  embedder: { model: string; version: string };
  /** Similarity at or above which a candidate is the same memory as an existing one. */
  similarityThreshold: number;
  /** Similarity at or above which a new memory is linked to the existing one. */
  relatedThreshold: number;
}

export type Resolution =
  | { action: 'create'; candidate: CandidateMemory; vector: number[]; related: { memory: Memory; similarity: number } | null }
  | { action: 'merge'; candidate: CandidateMemory; vector: number[]; target: Memory; similarity: number }
  | { action: 'supersede'; candidate: CandidateMemory; vector: number[]; target: Memory; similarity: number }
  | { action: 'drop'; candidate: CandidateMemory; reason: 'duplicate_in_batch'; duplicateOf: number };

/** Opposite evidence about the same thing: a rejection after an approval, or the reverse. Neutral never contradicts. */
export function contradicts(a: Stance, b: Stance): boolean {
  return (a === 'positive' && b === 'negative') || (a === 'negative' && b === 'positive');
}

/**
 * Decides what each candidate becomes, by nearest neighbours inside the workspace and the same category:
 *  - same meaning, same stance      -> merge (reinforce the existing memory, no new row);
 *  - same meaning, opposite stance  -> supersede (the newer evidence replaces the older memory);
 *  - related                        -> create, linked `supports` / `contradicts`;
 *  - otherwise                      -> create.
 * Candidates of one observation that duplicate each other are dropped.
 */
export class MemoryResolver {
  constructor(private readonly options: ResolverOptions) {}

  async resolve(workspaceId: string, candidates: CandidateMemory[], vectors: number[][]): Promise<Resolution[]> {
    const { index, store, embedder, similarityThreshold, relatedThreshold } = this.options;
    const out: Resolution[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const vector = vectors[i];

      let duplicateOf = -1;
      for (let j = 0; j < i; j += 1) {
        const prior = out[j];
        if (prior.action === 'drop') continue;
        if (candidates[j].category === candidate.category && cosineSimilarity(vectors[j], vector) >= similarityThreshold && !contradicts(candidates[j].stance, candidate.stance)) {
          duplicateOf = j;
          break;
        }
      }
      if (duplicateOf >= 0) {
        out.push({ action: 'drop', candidate, reason: 'duplicate_in_batch', duplicateOf });
        continue;
      }

      const hits = await index.search({
        workspaceId,
        vector,
        limit: 5,
        model: embedder.model,
        version: embedder.version,
        filter: { categories: [candidate.category], statuses: ['active'] },
      });
      const memories = new Map((await store.getMemories(workspaceId, hits.map((h) => h.id))).map((m) => [m.id, m]));
      // Best match first; hits whose memory vanished or is not active are skipped.
      const ranked = hits.map((h) => ({ hit: h, memory: memories.get(h.id) })).filter((r): r is { hit: (typeof hits)[number]; memory: Memory } => r.memory?.status === 'active');
      const best = ranked[0];
      if (best && best.hit.similarity >= similarityThreshold) {
        const existingStance = best.memory.provenance.stance;
        if (contradicts(existingStance, candidate.stance)) {
          out.push({ action: 'supersede', candidate, vector, target: best.memory, similarity: best.hit.similarity });
        } else {
          out.push({ action: 'merge', candidate, vector, target: best.memory, similarity: best.hit.similarity });
        }
        continue;
      }
      const related = best && best.hit.similarity >= relatedThreshold ? { memory: best.memory, similarity: best.hit.similarity } : null;
      out.push({ action: 'create', candidate, vector, related });
    }
    return out;
  }
}
