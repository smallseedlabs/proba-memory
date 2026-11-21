export type KnowledgeSourceKind = 'own_outcome' | 'seed' | 'web_example';
export type KnowledgeStatus = 'approved' | 'retired' | 'quarantined';

export const MIN_RETRIEVAL_TRUST = 0.2;
export const DEFAULT_HALF_LIFE_DAYS = 30;

export interface ProvenanceMemory {
  id: string;
  content: string;
  sourceKind: KnowledgeSourceKind;
  trust: number;
  status: KnowledgeStatus;
  lastVerifiedAt?: string;
  evidenceCampaignId?: string;
}

const SOURCE_RANK_BONUS: Record<KnowledgeSourceKind, number> = {
  own_outcome: 0.25,
  seed: 0.05,
  web_example: 0,
};

export function effectiveTrust(
  memory: Pick<ProvenanceMemory, 'trust' | 'lastVerifiedAt' | 'sourceKind'>,
  now: Date = new Date(),
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS
): number {
  const base = Math.max(0, Math.min(1, memory.trust));
  if (!memory.lastVerifiedAt || halfLifeDays <= 0) return base;
  const verifiedMs = Date.parse(memory.lastVerifiedAt);
  if (!Number.isFinite(verifiedMs)) return base;
  const ageDays = Math.max(0, (now.getTime() - verifiedMs) / (24 * 60 * 60 * 1000));
  const decayFactor = Math.pow(0.5, ageDays / halfLifeDays);
  return Number((base * decayFactor).toFixed(4));
}

export function filterAndRankKnowledge<T extends ProvenanceMemory>(
  items: readonly T[],
  now: Date = new Date()
): Array<T & { effectiveTrust: number; rankScore: number }> {
  return items
    .filter((item) => item.status === 'approved')
    .map((item) => {
      const eff = effectiveTrust(item, now);
      return {
        ...item,
        effectiveTrust: eff,
        rankScore: eff + (SOURCE_RANK_BONUS[item.sourceKind] ?? 0),
      };
    })
    .filter((item) => item.effectiveTrust >= MIN_RETRIEVAL_TRUST)
    .sort((a, b) => b.rankScore - a.rankScore);
}
