import { afterEach, describe, expect, it } from 'vitest';
import { DAY, ago, closeHarnesses, setup } from './harness.testing.js';

afterEach(closeHarnesses);

const TEXT = 'Always show the price in the first line of the ad.';
const solid = {
  content: TEXT,
  category: 'semantic' as const,
  evidenceCount: 5,
  confidence: 0.85,
  createdAt: ago(20 * DAY),
  observations: ['approval.granted', 'approval.granted'],
  stance: 'positive' as const,
};

describe('promote', () => {
  it('promotes a repeated, confirmed, confident, old semantic memory to procedural', async () => {
    const h = await setup();
    const [source] = await h.seed('ws', [solid]);
    const [run] = await h.runner.runJob(h.job('promote'), 'manual');
    expect(run).toMatchObject({ status: 'succeeded', workspaceId: 'ws', changed: 2, details: { promoted: 1, toProcedural: 1, toSuper: 0, configVersion: 1 } });

    const memories = await h.all('ws');
    const promoted = memories.find((m) => m.category === 'procedural')!;
    expect(promoted).toMatchObject({ status: 'active', supersedesId: source.id, content: TEXT, evidenceCount: 5, confidence: 0.85, validFrom: source.validFrom });
    expect(promoted.provenance).toMatchObject({ createdBy: 'job:promote', derivedFrom: [source.id], observationIds: source.provenance.observationIds });
    expect(await h.get('ws', source.id)).toMatchObject({ status: 'superseded', validTo: h.clock.isoNow() });
    expect(await h.runtime.store.listLinks('ws', promoted.id)).toEqual([expect.objectContaining({ fromId: promoted.id, toId: source.id, relation: 'supersedes' })]);
    // the vector travels with the memory: no embedder call needed
    const vectors = await h.runtime.index.getVectors('ws', [source.id, promoted.id]);
    expect(vectors.get(promoted.id)).toEqual(vectors.get(source.id));
    expect(promoted.embeddingModel).toBe(source.embeddingModel);
    expect(memories).toHaveLength(2); // nothing deleted

    const events = (await h.events()).filter((e) => e.action === 'memory.promoted');
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ job: 'promote', fromMemoryId: source.id, fromCategory: 'semantic', toCategory: 'procedural', approvalsAgreeing: 2, runId: run.id });
    expect(JSON.stringify(events)).not.toContain('price in the first line');
  });

  it('promotes to super only past the stricter rule: more evidence, higher confidence, age, approvals and usefulness', async () => {
    const h = await setup();
    const [strong, almost] = await h.seed('ws', [
      { ...solid, content: 'Never run discount banners on the brand campaign.', stance: 'negative', evidenceCount: 8, confidence: 0.95, createdAt: ago(40 * DAY), usefulness: 0.7, observations: ['approval.rejected', 'approval.rejected', 'approval.rejected'] },
      { ...solid, content: 'Prefer teal as the accent colour.', evidenceCount: 8, confidence: 0.95, createdAt: ago(40 * DAY), usefulness: 0.3, observations: ['approval.granted', 'approval.granted', 'approval.granted'] },
    ]);
    await h.runner.runJob(h.job('promote'), 'manual');
    const memories = await h.all('ws');
    // rejections that agree with a negative memory are the strongest signal, exactly like approvals
    expect(memories.find((m) => m.category === 'super')?.supersedesId).toBe(strong.id);
    // low usefulness misses the super rule but still clears the procedural one
    expect(memories.find((m) => m.category === 'procedural')?.supersedesId).toBe(almost.id);
  });

  it('does not promote what misses a threshold, and says which one in the dry run', async () => {
    const h = await setup();
    await h.seed('ws', [
      { ...solid, content: 'Low evidence memory about bids.', evidenceCount: 2 },
      { ...solid, content: 'Low confidence memory about bids.', confidence: 0.5 },
      { ...solid, content: 'Young memory about bids.', createdAt: ago(2 * DAY) },
      { ...solid, content: 'Never confirmed memory about bids.', observations: [], evidenceCount: 5 },
      // approvals that disagree with the memory subtract
      { ...solid, content: 'Contested memory about bids.', stance: 'positive', observations: ['approval.rejected', 'approval.rejected', 'approval.granted'], evidenceCount: 4 },
      // already procedural: not a semantic memory
      { ...solid, content: 'Procedural memory about bids.', category: 'procedural' },
    ]);
    const [run] = await h.runner.runJob(h.job('promote'), 'manual', { dryRun: true });
    expect(run.details).toMatchObject({ candidates: 0, blocked: { evidence: 1, confidence: 1, age: 1, decisive_signals: 1, weighted_evidence: 1 } });
    const [real] = await h.runner.runJob(h.job('promote'), 'manual');
    expect(real).toMatchObject({ changed: 0 });
  });

  it('never promotes a memory that an active memory still contradicts, but does once the conflict is settled', async () => {
    const h = await setup();
    const [m, rival] = await h.seed('ws', [solid, { content: 'Hide the price until the landing page.', category: 'semantic', stance: 'negative', confidence: 0.4 }]);
    await h.runtime.store.transaction((tx) => tx.insertLink({ workspaceId: 'ws', fromId: rival.id, toId: m.id, relation: 'contradicts', weight: 0.9, createdAt: h.clock.isoNow() }));
    const [blocked] = await h.runner.runJob(h.job('promote'), 'manual');
    expect(blocked).toMatchObject({ changed: 0, details: { blocked: { active_contradiction: 1 } } });
    await h.runtime.store.transaction((tx) => tx.updateMemory('ws', rival.id, { status: 'superseded' }, h.clock.isoNow()));
    const [after] = await h.runner.runJob(h.job('promote'), 'manual');
    expect(after).toMatchObject({ changed: 2, details: { promoted: 1 } });
  });

  it('takes its thresholds from the versioned config', async () => {
    const h = await setup();
    await h.seed('ws', [{ ...solid, evidenceCount: 2, observations: ['approval.granted'] }]);
    const [first] = await h.runner.runJob(h.job('promote'), 'manual');
    expect(first.changed).toBe(0);
    await h.publish('*', 'promote', { toProcedural: { minEvidence: 2, minConfidence: 0.7, minAgeDays: 1, minWeightedEvidence: 2, minDecisiveSignals: 1, minUsefulness: 0 } });
    const [second] = await h.runner.runJob(h.job('promote'), 'manual');
    expect(second).toMatchObject({ details: { configVersion: 2, promoted: 1 } });
  });

  it('is idempotent: a second run changes nothing', async () => {
    const h = await setup();
    await h.seed('ws', [solid, { ...solid, content: 'Keep headlines under thirty characters.' }]);
    await h.runner.runJob(h.job('promote'), 'manual');
    const before = await h.snapshot(['ws']);
    const [again] = await h.runner.runJob(h.job('promote'), 'manual');
    expect(again).toMatchObject({ status: 'succeeded', changed: 0 });
    expect(await h.snapshot(['ws'])).toEqual(before);
  });

  it('keeps workspaces apart and honours the workspace filter', async () => {
    const h = await setup();
    await h.seed('ws-a', [solid]);
    await h.seed('ws-b', [solid]);
    const before = await h.snapshot(['ws-b']);
    const runs = await h.runner.runJob(h.job('promote'), 'manual', { workspaceId: 'ws-a' });
    expect(runs.map((r) => r.workspaceId)).toEqual(['ws-a']);
    expect(await h.snapshot(['ws-b'])).toEqual(before);
    expect(await h.runner.runJob(h.job('promote'), 'manual', { workspaceId: 'no-such-workspace' })).toEqual([]);
    expect((await h.all('ws-b')).filter((m) => m.category === 'procedural')).toHaveLength(0);
  });

  it('dry run lists what it would promote and changes nothing', async () => {
    const h = await setup();
    await h.seed('ws', [solid]);
    const before = await h.snapshot(['ws'], { global: true });
    const [run] = await h.runner.runJob(h.job('promote'), 'manual', { dryRun: true });
    expect(run).toMatchObject({ status: 'succeeded', changed: 0, details: { dryRun: true, wouldPromote: { procedural: 1, super: 0 }, configVersion: 0 } });
    expect(await h.snapshot(['ws'], { global: true })).toEqual(before);
  });
});
