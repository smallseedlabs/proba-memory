import { describe, expect, it } from 'vitest';
import {
  MIN_RETRIEVAL_TRUST,
  effectiveTrust,
  filterAndRankKnowledge,
  type ProvenanceMemory,
} from './provenance.js';

describe('H4-01 knowledge provenance, decay, and own-outcome ranking', () => {
  const now = new Date('2026-11-21T22:00:00.000Z');

  it('decays trust over time, filters trust < 0.2 and retired entries, and ranks own_outcome above web/seed', () => {
    const items: ProvenanceMemory[] = [
      {
        id: 'web-1',
        content: 'Web advice',
        sourceKind: 'web_example',
        trust: 0.7,
        status: 'approved',
        lastVerifiedAt: '2026-11-20T22:00:00.000Z',
      },
      {
        id: 'own-1',
        content: 'Own campaign post-mortem: video CTR 2.4x static',
        sourceKind: 'own_outcome',
        trust: 0.7,
        status: 'approved',
        lastVerifiedAt: '2026-11-20T22:00:00.000Z',
        evidenceCampaignId: 'cmp-1',
      },
      {
        id: 'stale-1',
        content: 'Very old advice below 0.2',
        sourceKind: 'seed',
        trust: 0.5,
        status: 'approved',
        lastVerifiedAt: '2026-06-01T00:00:00.000Z',
      },
      {
        id: 'retired-1',
        content: 'Retired rule',
        sourceKind: 'own_outcome',
        trust: 0.9,
        status: 'retired',
      },
    ];

    expect(effectiveTrust(items[2]!, now)).toBeLessThan(MIN_RETRIEVAL_TRUST);

    const ranked = filterAndRankKnowledge(items, now);
    expect(ranked.map((r) => r.id)).toEqual(['own-1', 'web-1']);
  });
});
