import { afterEach, describe, expect, it } from 'vitest';
import { cleanupReason } from './index.js';
import { defaultJobConfig, type CleanupConfig } from '../job-configs.js';
import { DAY, HOUR, NOW, ago, closeHarnesses, setup } from './harness.testing.js';
import type { Memory } from '@smallseedlabs/proba-memory-core';

afterEach(closeHarnesses);

describe('cleanup', () => {
  it('tombstones expired working memories and stale low-importance items, and nothing else', async () => {
    const h = await setup();
    const [expired, byDate, fresh, stale, important, touched, proc, sup] = await h.seed('ws', [
      { content: 'Working: draft headline idea one.', category: 'working', lastReinforcedAt: ago(30 * HOUR) },
      { content: 'Working: draft headline idea two.', category: 'working', lastReinforcedAt: ago(1 * HOUR), validTo: ago(HOUR / 2) },
      { content: 'Working: draft headline idea three.', category: 'working', lastReinforcedAt: ago(2 * HOUR) },
      { content: 'Episodic: an old low-value note.', category: 'episodic', importance: 0.05, lastReinforcedAt: ago(90 * DAY) },
      { content: 'Episodic: an old but important note.', category: 'episodic', importance: 0.8, lastReinforcedAt: ago(90 * DAY) },
      { content: 'Episodic: an old note someone read last week.', category: 'episodic', importance: 0.05, lastReinforcedAt: ago(90 * DAY), lastAccessedAt: ago(7 * DAY) },
      { content: 'Procedural: low importance but a rule.', category: 'procedural', importance: 0.05, lastReinforcedAt: ago(400 * DAY) },
      { content: 'Super: low importance but distilled.', category: 'super', importance: 0.05, lastReinforcedAt: ago(400 * DAY) },
    ]);
    const [run] = await h.runner.runJob(h.job('cleanup'), 'manual');
    expect(run).toMatchObject({ status: 'succeeded', processed: 8, changed: 3, details: { tombstoned: 3, byReason: { expired_working: 2, stale_low_importance: 1 } } });
    for (const m of [expired, byDate, stale]) expect(await h.get('ws', m.id)).toMatchObject({ status: 'tombstoned', content: m.content });
    for (const m of [fresh, important, touched, proc, sup]) expect((await h.get('ws', m.id)).status).toBe('active');
    expect((await h.get('ws', byDate.id)).validTo).toBe(byDate.validTo); // an existing end of validity is kept
    expect((await h.get('ws', expired.id)).validTo).toBe(h.clock.isoNow());
    expect(await h.runtime.store.countMemories('ws', { statuses: ['active', 'superseded', 'tombstoned'] })).toBe(8); // never deleted
  });

  it('audits memory.tombstoned per batch with ids and counts, never text', async () => {
    const h = await setup({ env: { JOBS_BATCH_SIZE: '2' } });
    await h.seed('ws', Array.from({ length: 5 }, (_, i) => ({ content: `Working: confidential note ${i}.`, category: 'working' as const, lastReinforcedAt: ago(40 * HOUR), createdAt: ago((50 - i) * HOUR) })));
    const [run] = await h.runner.runJob(h.job('cleanup'), 'manual');
    expect(run).toMatchObject({ changed: 5, details: { batches: 3 } });
    const events = (await h.events()).filter((e) => e.action === 'memory.tombstoned');
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.traceId === run.traceId && e.workspaceId === 'ws' && e.target?.id === 'cleanup')).toBe(true);
    expect(events.reduce((n, e) => n + (e.details as { tombstoned: number }).tombstoned, 0)).toBe(5);
    expect(JSON.stringify(events)).not.toContain('confidential');
  });

  it('takes its thresholds from the versioned config', async () => {
    const h = await setup();
    await h.seed('ws', [{ content: 'Working: still useful.', category: 'working', lastReinforcedAt: ago(30 * HOUR) }]);
    await h.publish('*', 'cleanup', { workingTtlHours: 72 });
    expect((await h.runner.runJob(h.job('cleanup'), 'manual'))[0]).toMatchObject({ changed: 0, details: { configVersion: 1 } });
    await h.publish('*', 'cleanup', { workingTtlHours: 12 });
    expect((await h.runner.runJob(h.job('cleanup'), 'manual'))[0]).toMatchObject({ changed: 1, details: { configVersion: 2 } });
  });

  it('is idempotent', async () => {
    const h = await setup();
    await h.seed('ws', [
      { content: 'Working: a.', category: 'working', lastReinforcedAt: ago(30 * HOUR) },
      { content: 'Episodic: b.', category: 'episodic', importance: 0.05, lastReinforcedAt: ago(90 * DAY) },
    ]);
    await h.runner.runJob(h.job('cleanup'), 'manual');
    const before = await h.snapshot(['ws']);
    const [again] = await h.runner.runJob(h.job('cleanup'), 'manual');
    expect(again).toMatchObject({ status: 'succeeded', changed: 0 });
    expect(await h.snapshot(['ws'])).toEqual(before);
  });

  it('keeps workspaces apart', async () => {
    const h = await setup();
    const [a] = await h.seed('ws-a', [{ content: 'Working: a.', category: 'working', lastReinforcedAt: ago(30 * HOUR) }]);
    const [b] = await h.seed('ws-b', [{ content: 'Working: b.', category: 'working', lastReinforcedAt: ago(30 * HOUR) }]);
    await h.runner.runJob(h.job('cleanup'), 'manual', { workspaceId: 'ws-a' });
    expect((await h.get('ws-a', a.id)).status).toBe('tombstoned');
    expect((await h.get('ws-b', b.id)).status).toBe('active');
  });

  it('dry run counts what it would tombstone and changes nothing', async () => {
    const h = await setup();
    await h.seed('ws', [{ content: 'Working: a.', category: 'working', lastReinforcedAt: ago(30 * HOUR) }]);
    const before = await h.snapshot(['ws'], { global: true });
    const [run] = await h.runner.runJob(h.job('cleanup'), 'manual', { dryRun: true });
    expect(run).toMatchObject({ status: 'succeeded', changed: 0, details: { dryRun: true, wouldTombstone: 1, configVersion: 0 } });
    expect(await h.snapshot(['ws'], { global: true })).toEqual(before);
  });

  it('cleanupReason: the rules in one place', () => {
    const cfg = defaultJobConfig('cleanup') as unknown as CleanupConfig;
    const now = Date.parse(NOW);
    const base = { category: 'episodic', importance: 0.1, lastReinforcedAt: ago(61 * DAY), lastAccessedAt: null, validTo: null } as unknown as Memory;
    expect(cleanupReason(base, now, cfg)).toBe('stale_low_importance');
    expect(cleanupReason({ ...base, importance: 0.16 }, now, cfg)).toBeNull();
    expect(cleanupReason({ ...base, lastReinforcedAt: ago(59 * DAY) }, now, cfg)).toBeNull();
    expect(cleanupReason({ ...base, category: 'working', lastReinforcedAt: ago(25 * HOUR) }, now, cfg)).toBe('expired_working');
    expect(cleanupReason({ ...base, category: 'working', importance: 0.99, lastReinforcedAt: ago(HOUR) }, now, cfg)).toBeNull();
  });
});
