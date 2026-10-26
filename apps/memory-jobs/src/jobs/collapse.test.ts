import { afterEach, describe, expect, it } from 'vitest';
import { adjustedConfidence, pickWinner, upgradedConfidence } from './index.js';
import { DAY, ago, closeHarnesses, setup } from './harness.testing.js';

afterEach(closeHarnesses);

const SAME = 'Use sentence case in every headline.';
const OTHER_A = 'Quarterly budget review happens every March.';
const OTHER_B = 'The brand colour palette is teal and orange.';

describe('collapse: merging duplicates', () => {
  it('merges memories that say the same thing: most evidence wins, evidence adds up, confidence is upgraded, losers are superseded', async () => {
    const h = await setup();
    const [low, high, mid] = await h.seed('ws', [
      { content: SAME, category: 'semantic', evidenceCount: 1, confidence: 0.6, importance: 0.9, createdAt: ago(10 * DAY), sourceRefs: [{ kind: 'goal', id: 'g1', ref: 'dev:g1' }] },
      { content: SAME, category: 'semantic', evidenceCount: 4, confidence: 0.7, importance: 0.4, createdAt: ago(8 * DAY), sourceRefs: [{ kind: 'goal', id: 'g2', ref: 'dev:g2' }], observations: ['approval.granted'] },
      { content: SAME, category: 'semantic', evidenceCount: 2, confidence: 0.65, importance: 0.5, createdAt: ago(6 * DAY), lastReinforcedAt: ago(1 * DAY), sourceRefs: [{ kind: 'goal', id: 'g3', ref: 'dev:g3' }] },
    ]);
    const [run] = await h.runner.runJob(h.job('collapse'), 'manual');
    expect(run).toMatchObject({ status: 'succeeded', details: { duplicateGroups: 1, duplicatesMerged: 2, configVersion: 1 } });

    const winner = await h.get('ws', high.id);
    expect(winner).toMatchObject({ status: 'active', evidenceCount: 7, importance: 0.9, lastReinforcedAt: ago(1 * DAY) });
    expect(winner.confidence).toBeCloseTo(upgradedConfidence(0.7, 2, 0.1, 0.97), 6);
    expect(winner.confidence).toBeGreaterThan(0.7);
    expect(winner.sourceRefs.map((r) => r.ref).sort()).toEqual(['dev:g1', 'dev:g2', 'dev:g3']);
    for (const loser of [low, mid]) {
      expect(await h.get('ws', loser.id)).toMatchObject({ status: 'superseded', content: SAME });
      expect(await h.runtime.store.listLinks('ws', loser.id)).toEqual([expect.objectContaining({ fromId: high.id, toId: loser.id, relation: 'supersedes' })]);
    }
    expect(await h.runtime.store.countMemories('ws', { statuses: ['active', 'superseded', 'tombstoned'] })).toBe(3);

    const collapsed = (await h.events()).filter((e) => e.action === 'memory.collapsed');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].details).toMatchObject({ job: 'collapse', mergedCount: 2, evidenceCount: 7 });
    expect(JSON.stringify(collapsed)).not.toContain('sentence case');
  });

  it('does not merge across categories, across opposite stances, or below the threshold', async () => {
    const h = await setup();
    await h.seed('ws', [
      { content: SAME, category: 'semantic' },
      { content: SAME, category: 'procedural' },
      { content: OTHER_A, category: 'semantic', stance: 'positive' },
      { content: OTHER_A, category: 'semantic', stance: 'negative' },
      { content: 'The client prefers short headlines under forty characters.', category: 'episodic' },
      { content: 'The client likes short headlines under forty characters.', category: 'episodic' },
    ]);
    const [run] = await h.runner.runJob(h.job('collapse'), 'manual');
    expect(run.details).toMatchObject({ duplicateGroups: 0, duplicatesMerged: 0 });
  });

  it('is idempotent: a second run changes nothing and emits nothing', async () => {
    const h = await setup();
    await h.seed('ws', [
      { content: SAME, category: 'semantic', evidenceCount: 3, createdAt: ago(5 * DAY) },
      { content: SAME, category: 'semantic', evidenceCount: 1, createdAt: ago(4 * DAY) },
    ]);
    await h.runner.runJob(h.job('collapse'), 'manual');
    const before = await h.snapshot(['ws']);
    const [again] = await h.runner.runJob(h.job('collapse'), 'manual');
    expect(again).toMatchObject({ status: 'succeeded', changed: 0 });
    expect(await h.snapshot(['ws'])).toEqual(before);
  });

  it('keeps workspaces apart', async () => {
    const h = await setup();
    await h.seed('ws-a', [{ content: SAME, category: 'semantic' }]);
    await h.seed('ws-b', [{ content: SAME, category: 'semantic' }]);
    const runs = await h.runner.runJob(h.job('collapse'), 'manual');
    expect(runs.map((r) => r.changed)).toEqual([0, 0]);
    expect((await h.all('ws-a'))[0].status).toBe('active');
    expect((await h.all('ws-b'))[0].status).toBe('active');
  });

  it('dry run reports the groups and changes nothing', async () => {
    const h = await setup();
    await h.seed('ws', [
      { content: SAME, category: 'semantic', createdAt: ago(5 * DAY) },
      { content: SAME, category: 'semantic', createdAt: ago(4 * DAY) },
      { content: OTHER_A, category: 'semantic', createdAt: ago(4 * DAY) },
      { content: OTHER_B, category: 'semantic', createdAt: ago(3 * DAY) },
    ]);
    const a = (await h.all('ws')).find((m) => m.content === OTHER_A)!;
    const b = (await h.all('ws')).find((m) => m.content === OTHER_B)!;
    await h.runtime.store.transaction((tx) => tx.insertLink({ workspaceId: 'ws', fromId: a.id, toId: b.id, relation: 'supports', weight: 0.8, createdAt: ago(DAY) }));
    const before = await h.snapshot(['ws'], { global: true });
    const [run] = await h.runner.runJob(h.job('collapse'), 'manual', { dryRun: true });
    expect(run).toMatchObject({ status: 'succeeded', changed: 0, details: { dryRun: true, duplicateGroups: 1, configVersion: 0, confidenceAdjusted: 2, upgraded: 2 } });
    expect(await h.snapshot(['ws'], { global: true })).toEqual(before);
  });
});

describe('collapse: upgrade on reinforcement, downgrade on contradiction', () => {
  it('raises confidence once per new supporting memory, and never counts the same link twice', async () => {
    const h = await setup();
    const [a, b] = await h.seed('ws', [
      { content: OTHER_A, category: 'semantic', confidence: 0.6 },
      { content: OTHER_B, category: 'semantic', confidence: 0.7 },
    ]);
    await h.runtime.store.transaction((tx) => tx.insertLink({ workspaceId: 'ws', fromId: a.id, toId: b.id, relation: 'supports', weight: 0.8, createdAt: ago(DAY) }));
    const [run] = await h.runner.runJob(h.job('collapse'), 'manual');
    expect(run.details).toMatchObject({ confidenceAdjusted: 2, upgraded: 2, downgraded: 0 });
    expect((await h.get('ws', a.id)).confidence).toBeCloseTo(0.63, 6);
    expect((await h.get('ws', b.id)).confidence).toBeCloseTo(0.73, 6);
    expect((await h.get('ws', a.id)).provenance.adjustments).toEqual({ supports: [b.id], contradicts: [] });
    const [again] = await h.runner.runJob(h.job('collapse'), 'manual');
    expect(again).toMatchObject({ changed: 0, details: { confidenceAdjusted: 0 } });
    expect((await h.get('ws', a.id)).confidence).toBeCloseTo(0.63, 6);
    const adjusted = (await h.events()).filter((e) => e.action === 'memory.confidence_adjusted');
    expect(adjusted).toHaveLength(2);
    expect(adjusted[0].details).toMatchObject({ direction: 'up', newSupports: 1 });
  });

  it('lowers confidence once on a contradiction between two active memories, and stops once one is superseded', async () => {
    const h = await setup();
    const [a, b] = await h.seed('ws', [
      { content: OTHER_A, category: 'semantic', confidence: 0.8, stance: 'positive' },
      { content: OTHER_B, category: 'semantic', confidence: 0.5, stance: 'negative' },
    ]);
    await h.runtime.store.transaction((tx) => tx.insertLink({ workspaceId: 'ws', fromId: b.id, toId: a.id, relation: 'contradicts', weight: 0.8, createdAt: ago(DAY) }));
    const [run] = await h.runner.runJob(h.job('collapse'), 'manual');
    expect(run.details).toMatchObject({ confidenceAdjusted: 2, downgraded: 2 });
    expect((await h.get('ws', a.id)).confidence).toBeCloseTo(0.7, 6);
    expect((await h.get('ws', b.id)).confidence).toBeCloseTo(0.4, 6);
    expect((await h.runner.runJob(h.job('collapse'), 'manual'))[0]).toMatchObject({ changed: 0 });

    // links to a memory that is no longer active are ignored
    const [c, d] = await h.seed('ws', [
      { content: 'Never use exclamation marks.', category: 'semantic', confidence: 0.8, stance: 'negative' },
      { content: 'Exclamation marks are fine in sales copy.', category: 'semantic', confidence: 0.8, stance: 'positive', status: 'superseded' },
    ]);
    await h.runtime.store.transaction((tx) => tx.insertLink({ workspaceId: 'ws', fromId: d.id, toId: c.id, relation: 'contradicts', weight: 0.8, createdAt: ago(DAY) }));
    await h.runner.runJob(h.job('collapse'), 'manual');
    expect((await h.get('ws', c.id)).confidence).toBe(0.8);
  });

  it('keeps confidence inside the floor and the ceiling', () => {
    const cfg = { supportConfidenceGain: 0.03, contradictionPenalty: 0.1, confidenceFloor: 0.05, confidenceCeiling: 0.97 };
    expect(adjustedConfidence(0.96, 5, 0, cfg)).toBeCloseTo(0.97, 6);
    expect(adjustedConfidence(0.99, 2, 0, cfg)).toBe(0.99); // above the ceiling already: not lowered, not raised
    expect(adjustedConfidence(0.08, 0, 3, cfg)).toBe(0.05);
    expect(adjustedConfidence(0.02, 0, 1, cfg)).toBe(0.02); // below the floor already: not lowered further
    expect(upgradedConfidence(0.5, 0, 0.1, 0.97)).toBe(0.5);
    expect(pickWinner([{ evidenceCount: 1, confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', id: 'b' }, { evidenceCount: 3, confidence: 0.1, createdAt: '2026-02-01T00:00:00.000Z', id: 'a' }] as never).id).toBe('a');
  });
});
