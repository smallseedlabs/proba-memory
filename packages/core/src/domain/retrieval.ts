import type { MemoryCategory, ProfileStatus, ScoreResult } from '@smallseedlabs/proba-memory-scoring';
import type { MemoryFilter } from './memory.js';

export interface SearchRequest {
  query: string;
  filter?: MemoryFilter;
  /** Max memories returned (after diversity and token packing). */
  limit?: number;
  /** Overrides the profile's token budget for the packed result. */
  tokenBudget?: number;
  /** Ask for the LLM rerank step (only when the profile enables it). */
  rerank?: boolean;
}

export interface CandidateTrace {
  id: string;
  category: MemoryCategory;
  vectorRank: number | null;
  vectorSimilarity: number | null;
  ftsRank: number | null;
  ftsScore: number | null;
  fusedScore: number;
  score: number;
  features: ScoreResult['features'];
  components: ScoreResult['components'];
  selected: boolean;
  /** Why a candidate was not returned. */
  droppedReason?: 'below_min_score' | 'outside_pool' | 'diversity' | 'over_limit' | 'over_budget' | 'reranked_out';
  mmrScore?: number;
  maxSimilarity?: number;
  /** Position in the final list (1-based), when selected. */
  position?: number;
}

export interface RetrievedMemory {
  id: string;
  category: MemoryCategory;
  content: string;
  summary: string | null;
  score: number;
  importance: number;
  confidence: number;
  usefulness: number;
  createdAt: string;
  lastReinforcedAt: string;
  sourceRefs: { kind: string; ref: string }[];
  /** Always `untrusted_data`: memory text came from users and models and must never be followed as instructions. */
  trust: 'untrusted_data';
  tokens: number;
  truncated: boolean;
}

export interface SearchProfileInfo {
  name: string;
  version: number;
  status: ProfileStatus;
  served: 'active' | 'canary';
  shadow?: { name: string; version: number };
}

export interface SearchResponse {
  retrievalId: string;
  traceId: string;
  query: { length: number };
  profile: SearchProfileInfo;
  results: RetrievedMemory[];
  stats: {
    vectorCandidates: number;
    textCandidates: number;
    fused: number;
    scored: number;
    returned: number;
    tokensUsed: number;
    tokenBudget: number;
    degraded: string[];
    durationMs: number;
  };
  /** Full candidate table with every feature (admins only through the API). */
  candidates?: CandidateTrace[];
}

/**
 * What happened after a retrieval, resolved from later observations that share its trace id (an approval granted
 * or rejected on a plan built from the retrieved memories). `none` means no outcome arrived within the window.
 */
export type RetrievalVerdict = 'approved' | 'rejected' | 'none';

export interface RetrievalOutcome {
  verdict: RetrievalVerdict;
  /** Observation that decided it (absent for `none`). */
  observationId?: string;
  /** UTC ISO 8601 time the outcome was resolved. */
  resolvedAt: string;
}

export interface RetrievalLogEntry {
  id: string;
  workspaceId: string;
  traceId: string;
  actorType: string;
  actorId: string;
  /** Redacted query text. */
  queryText: string;
  queryHash: string;
  filter: MemoryFilter;
  profileName: string;
  profileVersion: number;
  profileServed: 'active' | 'canary';
  shadowProfileVersion: number | null;
  candidates: CandidateTrace[];
  shadowResults: { id: string; score: number }[] | null;
  results: { id: string; score: number; position: number }[];
  stats: SearchResponse['stats'];
  createdAt: string;
  /** Resolved by the usage-feedback job; null until then. */
  outcome?: RetrievalOutcome | null;
  /** When the usage-feedback job applied the outcome to the memories' usefulness; null until then. */
  outcomeAppliedAt?: string | null;
}
