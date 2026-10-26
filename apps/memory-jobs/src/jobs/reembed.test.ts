import { afterEach, describe, expect, it } from 'vitest';
import { ago, closeHarnesses, setup, DAY } from './harness.testing.js';

afterEach(closeHarnesses);

const OLD = { embeddingModel: 'old-model', embeddingVersion: '0' };
const texts = ['Prefer short headlines.', 'Never use all caps.', 'Quarterly review happens in March.', 'The palette is teal and orange.', 'Keep bids steady on weekends.'];

describe('reembed', () => {
  it('re-embeds in batches into a staged vector, then cuts over; retrieval keeps working throughout', async () => {
    const h = await setup({ env: { JOBS_BATCH_SIZE: '2' } });
    const seeded = await h.seed('ws', texts.map((content) => ({ content, ...OLD })));
    const target = { model: h.runtime.embedder.model, version: h.runtime.embedder.version };
    const probe = (await h.runtime.embedder.embed([texts[0]]))[0];

    // Stage only two memories this run: nothing becomes visible yet.
    await h.publish('*', 'reembed', { maxPerRun: 2 });
    const [partial] = await h.runner.runJob(h.job('reembed'), 'manual');
    expect(partial).toMatchObject({ status: 'succeeded', details: { staged: 2, swapped: 0, after: { active: 5, staged: 2, pending: 3, atTarget: 0 } } });
    for (const m of await h.all('ws')) expect(m).toMatchObject(OLD);
    // vector search with the OLD model still finds every memory: no downtime
    const old = await h.runtime.index.search({ workspaceId: 'ws', vector: probe, limit: 10, model: 'old-model', version: '0' });
    expect(old).toHaveLength(5);
    expect(await h.runtime.index.search({ workspaceId: 'ws', vector: probe, limit: 10, ...target })).toHaveLength(0);

    // Raise the cap: the next run finishes the staging and cuts over atomically.
    await h.publish('*', 'reembed', { maxPerRun: 100 });
    const [done] = await h.runner.runJob(h.job('reembed'), 'manual');
    expect(done).toMatchObject({ status: 'succeeded', details: { staged: 3, swapped: 5, after: { atTarget: 5, pending: 0, staged: 0 } } });
    for (const m of await h.all('ws')) expect(m).toMatchObject({ embeddingModel: target.model, embeddingVersion: target.version });
    expect(await h.runtime.index.search({ workspaceId: 'ws', vector: probe, limit: 10, ...target })).toHaveLength(5);
    expect(await h.runtime.index.search({ workspaceId: 'ws', vector: probe, limit: 10, model: 'old-model', version: '0' })).toHaveLength(0);
    // content and everything else is untouched
    for (const s of seeded) expect(await h.get('ws', s.id)).toMatchObject({ content: s.content, status: 'active', confidence: s.confidence });
    expect((await h.runtime.index.getVectors('ws', [seeded[0].id])).get(seeded[0].id)).toEqual(probe);
  });

  it('audits every staged batch and the cutover, with counts only', async () => {
    const h = await setup({ env: { JOBS_BATCH_SIZE: '2' } });
    await h.seed('ws', texts.map((content) => ({ content, ...OLD })));
    const [run] = await h.runner.runJob(h.job('reembed'), 'manual');
    const events = (await h.events()).filter((e) => e.action === 'memory.reembedded');
    expect(events.map((e) => (e.details as { phase: string }).phase)).toEqual(['staged', 'staged', 'staged', 'cutover']);
    expect(events.every((e) => e.traceId === run.traceId && e.workspaceId === 'ws')).toBe(true);
    expect(events.at(-1)?.details).toMatchObject({ swapped: 5, job: 'reembed' });
    expect(JSON.stringify(events)).not.toContain('headlines');
  });

  it('a version change under the same model name is a re-embed too', async () => {
    const h = await setup();
    await h.seed('ws', [{ content: texts[0], embeddingModel: h.runtime.embedder.model, embeddingVersion: '0' }]);
    const [run] = await h.runner.runJob(h.job('reembed'), 'manual');
    expect(run).toMatchObject({ details: { staged: 1, swapped: 1 } });
    expect((await h.all('ws'))[0].embeddingVersion).toBe(h.runtime.embedder.version);
  });

  it('also embeds memories that have no vector yet, and leaves superseded and tombstoned memories alone', async () => {
    const h = await setup();
    const [, , retired, gone] = await h.seed('ws', [
      { content: texts[0], embedding: null, embeddingModel: null, embeddingVersion: null },
      { content: texts[1], ...OLD },
      { content: texts[2], ...OLD, status: 'superseded' },
      { content: texts[3], ...OLD, status: 'tombstoned' },
    ]);
    const [run] = await h.runner.runJob(h.job('reembed'), 'manual');
    expect(run).toMatchObject({ details: { staged: 2, swapped: 2 } });
    expect(await h.get('ws', retired.id)).toMatchObject(OLD);
    expect(await h.get('ws', gone.id)).toMatchObject(OLD);
  });

  it('autoCutover=false stages everything and waits for an operator', async () => {
    const h = await setup();
    await h.publish('*', 'reembed', { autoCutover: false });
    await h.seed('ws', texts.slice(0, 2).map((content) => ({ content, ...OLD })));
    const [run] = await h.runner.runJob(h.job('reembed'), 'manual');
    expect(run).toMatchObject({ details: { staged: 2, swapped: 0, after: { staged: 2, pending: 0 } } });
    expect((await h.all('ws'))[0]).toMatchObject(OLD);
  });

  it('is idempotent: a second run embeds nothing and swaps nothing', async () => {
    const h = await setup();
    await h.seed('ws', texts.map((content) => ({ content, ...OLD })));
    await h.runner.runJob(h.job('reembed'), 'manual');

    const before = await h.snapshot(['ws']);
    const [again] = await h.runner.runJob(h.job('reembed'), 'manual');
    expect(again).toMatchObject({ status: 'succeeded', changed: 0, details: { staged: 0, swapped: 0, batches: 0 } });
    expect(await h.snapshot(['ws'])).toEqual(before);
  });

  it('keeps workspaces apart', async () => {
    const h = await setup();
    await h.seed('ws-a', [{ content: texts[0], ...OLD }]);
    await h.seed('ws-b', [{ content: texts[0], ...OLD }]);
    await h.runner.runJob(h.job('reembed'), 'manual', { workspaceId: 'ws-a' });
    expect((await h.all('ws-a'))[0].embeddingModel).toBe(h.runtime.embedder.model);
    expect((await h.all('ws-b'))[0]).toMatchObject(OLD);
    const stats = await h.runtime.embeddingMigration.stats('ws-b', { model: h.runtime.embedder.model, version: h.runtime.embedder.version });
    expect(stats).toMatchObject({ active: 1, pending: 1, staged: 0 });
  });

  it('dry run counts what it would embed and changes nothing', async () => {
    const h = await setup();
    await h.seed('ws', texts.map((content) => ({ content, ...OLD, createdAt: ago(DAY) })));
    const before = await h.snapshot(['ws'], { global: true });
    const [run] = await h.runner.runJob(h.job('reembed'), 'manual', { dryRun: true });
    expect(run).toMatchObject({ status: 'succeeded', changed: 0, details: { dryRun: true, wouldEmbed: 5, before: { pending: 5 } } });
    expect(await h.snapshot(['ws'], { global: true })).toEqual(before);
    expect(await h.runtime.embeddingMigration.stats('ws', { model: h.runtime.embedder.model, version: h.runtime.embedder.version })).toMatchObject({ staged: 0, pending: 5 });
  });
});
