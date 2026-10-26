import { afterEach, describe, expect, it } from 'vitest';
import { DAY, ago, closeHarnesses, setup } from './harness.testing.js';

afterEach(closeHarnesses);

const TEXT = 'The client wants discount banners in every campaign.';

const approvalRef = [{ kind: 'approval' as const, id: 'a1', ref: 'audit:a1' }];
const threadRef = [{ kind: 'thread' as const, id: 't1', ref: 'audit:t1' }];

describe('contradictions', () => {
  it('resolves by recency: the more recently reinforced memory stays, the other is superseded and linked', async () => {
    const h = await setup();
    await h.publish('*', 'contradictions', { weights: { recency: 1, evidence: 0, source: 0 } });
    const [old, recent] = await h.seed('ws', [
      { content: TEXT, category: 'semantic', stance: 'positive', createdAt: ago(60 * DAY), lastReinforcedAt: ago(60 * DAY) },
      { content: TEXT, category: 'semantic', stance: 'negative', createdAt: ago(2 * DAY), lastReinforcedAt: ago(1 * DAY) },
    ]);
    const [run] = await h.runner.runJob(h.job('contradictions'), 'manual');
    expect(run).toMatchObject({ status: 'succeeded', details: { pairs: 1, resolved: 1, unresolved: 0, configVersion: 1 } });
    expect(await h.get('ws', old.id)).toMatchObject({ status: 'superseded', validTo: h.clock.isoNow() });
    expect((await h.get('ws', recent.id)).status).toBe('active');
    const relations = (await h.runtime.store.listLinks('ws', old.id)).map((l) => [l.fromId, l.toId, l.relation]).sort();
    expect(relations).toEqual([[recent.id, old.id, 'contradicts'], [recent.id, old.id, 'supersedes']]);
    const events = (await h.events()).filter((e) => e.action === 'memory.contradiction_resolved');
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ job: 'contradictions', winnerId: recent.id, loserId: old.id });
    expect(JSON.stringify(events)).not.toContain('discount banners');
    expect(await h.runtime.store.countMemories('ws', { statuses: ['active', 'superseded', 'tombstoned'] })).toBe(2);
  });

  it('resolves by evidence strength: approvals and rejections outweigh a more recent single observation', async () => {
    const h = await setup();
    await h.publish('*', 'contradictions', { weights: { recency: 0, evidence: 1, source: 0 } });
    const [strong, fresh] = await h.seed('ws', [
      { content: TEXT, category: 'semantic', stance: 'positive', evidenceCount: 4, createdAt: ago(60 * DAY), lastReinforcedAt: ago(60 * DAY), observations: ['approval.granted', 'approval.granted', 'approval.granted'] },
      { content: TEXT, category: 'semantic', stance: 'negative', evidenceCount: 1, createdAt: ago(1 * DAY) },
    ]);
    await h.runner.runJob(h.job('contradictions'), 'manual');
    expect((await h.get('ws', strong.id)).status).toBe('active');
    expect((await h.get('ws', fresh.id)).status).toBe('superseded');
  });

  it('resolves by source: a granted approval is trusted over a thread remark', async () => {
    const h = await setup();
    await h.publish('*', 'contradictions', { weights: { recency: 0, evidence: 0, source: 1 } });
    const [fromApproval, fromThread] = await h.seed('ws', [
      { content: TEXT, category: 'semantic', stance: 'positive', sourceRefs: approvalRef },
      { content: TEXT, category: 'semantic', stance: 'negative', sourceRefs: threadRef },
    ]);
    await h.runner.runJob(h.job('contradictions'), 'manual');
    expect((await h.get('ws', fromApproval.id)).status).toBe('active');
    expect((await h.get('ws', fromThread.id)).status).toBe('superseded');
  });

  it('keeps both when the scores are too close, links them `contradicts` once, and resolves later when evidence tips the balance', async () => {
    const h = await setup();
    await h.publish('*', 'contradictions', { weights: { recency: 0, evidence: 1, source: 0 } });
    const [a, b] = await h.seed('ws', [
      { content: TEXT, category: 'semantic', stance: 'positive', createdAt: ago(5 * DAY) },
      { content: TEXT, category: 'semantic', stance: 'negative', createdAt: ago(3 * DAY) },
    ]);
    const [first] = await h.runner.runJob(h.job('contradictions'), 'manual');
    expect(first).toMatchObject({ details: { pairs: 1, resolved: 0, unresolved: 1, newLinks: 1 }, changed: 1 });
    expect((await h.get('ws', a.id)).status).toBe('active');
    expect((await h.get('ws', b.id)).status).toBe('active');
    expect(await h.runtime.store.listLinks('ws', a.id)).toEqual([expect.objectContaining({ fromId: b.id, toId: a.id, relation: 'contradicts' })]);

    // run twice more: no new link, no new event
    const eventsBefore = (await h.events()).filter((e) => e.action.startsWith('memory.contradiction')).length;
    const [second] = await h.runner.runJob(h.job('contradictions'), 'manual');
    expect(second).toMatchObject({ changed: 0, details: { unresolved: 1, newLinks: 0 } });
    expect((await h.events()).filter((e) => e.action.startsWith('memory.contradiction')).length).toBe(eventsBefore);
    expect(eventsBefore).toBe(1);
    expect((await h.events()).find((e) => e.action === 'memory.contradiction_linked')?.details).toMatchObject({ job: 'contradictions' });

    // new evidence on `a` tips the balance
    const extra = await h.runtime.store.transaction(async (tx) => {
      await tx.updateMemory('ws', a.id, { evidenceCount: 8 }, h.clock.isoNow());
    });
    void extra;
    // evidenceCount alone is "other" observations: weighted 8 versus 1
    const [third] = await h.runner.runJob(h.job('contradictions'), 'manual');
    expect(third.details).toMatchObject({ resolved: 1 });
    expect((await h.get('ws', b.id)).status).toBe('superseded');
  });

  it('only pairs memories with opposite stance and similar meaning', async () => {
    const h = await setup();
    await h.seed('ws', [
      { content: TEXT, category: 'semantic', stance: 'positive' },
      { content: TEXT, category: 'semantic', stance: 'neutral' },
      { content: TEXT, category: 'semantic', stance: 'positive' },
      { content: 'Quarterly budget review happens every March.', category: 'semantic', stance: 'negative' },
    ]);
    const [run] = await h.runner.runJob(h.job('contradictions'), 'manual');
    expect(run.details).toMatchObject({ pairs: 0 });
  });

  it('is idempotent once settled', async () => {
    const h = await setup();
    await h.publish('*', 'contradictions', { weights: { recency: 1, evidence: 0, source: 0 } });
    await h.seed('ws', [
      { content: TEXT, category: 'semantic', stance: 'positive', lastReinforcedAt: ago(60 * DAY) },
      { content: TEXT, category: 'semantic', stance: 'negative', lastReinforcedAt: ago(1 * DAY) },
    ]);
    await h.runner.runJob(h.job('contradictions'), 'manual');
    const before = await h.snapshot(['ws']);
    const [again] = await h.runner.runJob(h.job('contradictions'), 'manual');
    expect(again).toMatchObject({ status: 'succeeded', changed: 0 });
    expect(await h.snapshot(['ws'])).toEqual(before);
  });

  it('keeps workspaces apart', async () => {
    const h = await setup();
    await h.seed('ws-a', [{ content: TEXT, category: 'semantic', stance: 'positive' }]);
    await h.seed('ws-b', [{ content: TEXT, category: 'semantic', stance: 'negative' }]);
    const runs = await h.runner.runJob(h.job('contradictions'), 'manual');
    expect(runs.map((r) => r.details.pairs)).toEqual([0, 0]);
  });

  it('dry run reports what it would resolve and changes nothing', async () => {
    const h = await setup();
    await h.seed('ws', [
      { content: TEXT, category: 'semantic', stance: 'positive', lastReinforcedAt: ago(90 * DAY), evidenceCount: 1 },
      { content: TEXT, category: 'semantic', stance: 'negative', lastReinforcedAt: ago(1 * DAY), evidenceCount: 6, observations: ['approval.rejected', 'approval.rejected', 'approval.rejected'], sourceRefs: approvalRef },
    ]);
    const before = await h.snapshot(['ws'], { global: true });
    const [run] = await h.runner.runJob(h.job('contradictions'), 'manual', { dryRun: true });
    expect(run).toMatchObject({ status: 'succeeded', changed: 0, details: { dryRun: true, wouldResolve: 1, configVersion: 0 } });
    expect(await h.snapshot(['ws'], { global: true })).toEqual(before);
  });
});
