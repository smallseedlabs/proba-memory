import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Observation } from '@smallseedlabs/proba-memory-core';
import { makeObservation } from '@smallseedlabs/proba-memory-core/testing';
import { makeLogEntry } from '@smallseedlabs/proba-memory-core/testing';
import { nextUsefulness } from './index.js';
import { DAY, HOUR, ago, closeHarnesses, setup, type Harness } from './harness.testing.js';

afterEach(closeHarnesses);

async function retrieval(h: Harness, ws: string, ids: string[], createdAt = ago(2 * HOUR)) {
  const traceId = randomUUID();
  const entry = makeLogEntry(ws, { traceId, createdAt, results: ids.map((id, i) => ({ id, score: 0.9 - i * 0.1, position: i + 1 })) });
  await h.runtime.logStore.append(entry);
  return entry;
}

async function decide(h: Harness, ws: string, traceId: string, kind: 'approval.granted' | 'approval.rejected', occurredAt = ago(HOUR)): Promise<Observation> {
  const o = makeObservation(ws, { kind, traceId, occurredAt });
  await h.runtime.store.claimObservation(o, h.clock.isoNow());
  return o;
}

describe('usage-feedback', () => {
  it('moves usefulness toward 1 for the memories of an approved retrieval, less for lower positions', async () => {
    const h = await setup();
    const [first, second] = await h.seed('ws', [{ content: 'Prefer short headlines.', usefulness: 0.5 }, { content: 'Never use all caps.', usefulness: 0.5 }]);
    const entry = await retrieval(h, 'ws', [first.id, second.id]);
    const decisive = await decide(h, 'ws', entry.traceId, 'approval.granted');
    const [run] = await h.runner.runJob(h.job('usage-feedback'), 'manual');
    expect(run).toMatchObject({ status: 'succeeded', details: { resolved: { approved: 1, rejected: 0, none: 0 }, logsApplied: 1, memoriesUpdated: 2 } });
    const cfg = { learningRate: 0.1, positionDiscount: 0.25 };
    expect((await h.get('ws', first.id)).usefulness).toBeCloseTo(nextUsefulness(0.5, 1, 1, cfg), 8);
    expect((await h.get('ws', second.id)).usefulness).toBeCloseTo(nextUsefulness(0.5, 1, 2, cfg), 8);
    expect((await h.get('ws', first.id)).usefulness).toBeGreaterThan((await h.get('ws', second.id)).usefulness);
    const log = (await h.runtime.logStore.get('ws', entry.id))!;
    expect(log.outcome).toMatchObject({ verdict: 'approved', observationId: decisive.id });
    expect(log.outcomeAppliedAt).toBe(h.clock.isoNow());
    const events = (await h.events()).filter((e) => e.action === 'memory.usage_updated');
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ job: 'usage-feedback', retrievalId: entry.id, verdict: 'approved', updated: 2 });
  });

  it('moves usefulness toward 0 when the retrieval ended in a rejection', async () => {
    const h = await setup();
    const [m] = await h.seed('ws', [{ content: 'Prefer short headlines.', usefulness: 0.5 }]);
    const entry = await retrieval(h, 'ws', [m.id]);
    await decide(h, 'ws', entry.traceId, 'approval.rejected');
    await h.runner.runJob(h.job('usage-feedback'), 'manual');
    expect((await h.get('ws', m.id)).usefulness).toBeCloseTo(0.45, 8);
  });

  it('waits for an outcome, then closes the retrieval as `none` after the window without changing anything', async () => {
    const h = await setup();
    const [m] = await h.seed('ws', [{ content: 'Prefer short headlines.', usefulness: 0.5 }]);
    const recent = await retrieval(h, 'ws', [m.id], ago(2 * HOUR));
    const stale = await retrieval(h, 'ws', [m.id], ago(3 * DAY));
    const [run] = await h.runner.runJob(h.job('usage-feedback'), 'manual');
    expect(run).toMatchObject({ details: { resolved: { approved: 0, rejected: 0, none: 1 }, memoriesUpdated: 0 } });
    expect((await h.runtime.logStore.get('ws', recent.id))!.outcome).toBeUndefined();
    expect((await h.runtime.logStore.get('ws', stale.id))!.outcome).toMatchObject({ verdict: 'none' });
    expect((await h.get('ws', m.id)).usefulness).toBe(0.5);
    // an approval that arrives later still resolves the recent one
    await decide(h, 'ws', recent.traceId, 'approval.granted', ago(HOUR / 2));
    await h.runner.runJob(h.job('usage-feedback'), 'manual');
    expect((await h.get('ws', m.id)).usefulness).toBeGreaterThan(0.5);
  });

  it('ignores decisions that predate the retrieval, and the first decision wins', async () => {
    const h = await setup();
    const [m] = await h.seed('ws', [{ content: 'Prefer short headlines.', usefulness: 0.5 }]);
    const entry = await retrieval(h, 'ws', [m.id], ago(2 * HOUR));
    await decide(h, 'ws', entry.traceId, 'approval.rejected', ago(5 * HOUR)); // before the retrieval
    await decide(h, 'ws', entry.traceId, 'approval.granted', ago(HOUR));
    await decide(h, 'ws', entry.traceId, 'approval.rejected', ago(HOUR / 2));
    await h.runner.runJob(h.job('usage-feedback'), 'manual');
    expect((await h.runtime.logStore.get('ws', entry.id))!.outcome?.verdict).toBe('approved');
  });

  it('is idempotent: an outcome is applied exactly once, however often the job runs', async () => {
    const h = await setup();
    const [m] = await h.seed('ws', [{ content: 'Prefer short headlines.', usefulness: 0.5 }]);
    const entry = await retrieval(h, 'ws', [m.id]);
    await decide(h, 'ws', entry.traceId, 'approval.granted');
    await h.runner.runJob(h.job('usage-feedback'), 'manual');
    const once = (await h.get('ws', m.id)).usefulness;
    const before = await h.snapshot(['ws']);
    for (let i = 0; i < 3; i += 1) expect((await h.runner.runJob(h.job('usage-feedback'), 'manual'))[0]).toMatchObject({ status: 'succeeded', changed: 0 });
    expect((await h.get('ws', m.id)).usefulness).toBe(once);
    expect(await h.snapshot(['ws'])).toEqual(before);
  });

  it('does not touch memories that are no longer active', async () => {
    const h = await setup();
    const [m] = await h.seed('ws', [{ content: 'Prefer short headlines.', usefulness: 0.5, status: 'superseded' }]);
    const entry = await retrieval(h, 'ws', [m.id]);
    await decide(h, 'ws', entry.traceId, 'approval.granted');
    const [run] = await h.runner.runJob(h.job('usage-feedback'), 'manual');
    expect(run.details).toMatchObject({ logsApplied: 1, memoriesUpdated: 0 });
    expect((await h.get('ws', m.id)).usefulness).toBe(0.5);
  });

  it('keeps workspaces apart: another workspace\'s decision with the same trace id changes nothing', async () => {
    const h = await setup();
    const [a] = await h.seed('ws-a', [{ content: 'Prefer short headlines.', usefulness: 0.5 }]);
    const [b] = await h.seed('ws-b', [{ content: 'Prefer short headlines.', usefulness: 0.5 }]);
    const entry = await retrieval(h, 'ws-a', [a.id], ago(2 * HOUR));
    await decide(h, 'ws-b', entry.traceId, 'approval.granted');
    await h.runner.runJob(h.job('usage-feedback'), 'manual');
    expect((await h.runtime.logStore.get('ws-a', entry.id))!.outcome).toBeUndefined();
    expect((await h.get('ws-a', a.id)).usefulness).toBe(0.5);
    expect((await h.get('ws-b', b.id)).usefulness).toBe(0.5);
    expect(await h.runtime.logStore.get('ws-b', entry.id)).toBeNull();
  });

  it('dry run reports what it would do and changes nothing', async () => {
    const h = await setup();
    const [m] = await h.seed('ws', [{ content: 'Prefer short headlines.', usefulness: 0.5 }]);
    const entry = await retrieval(h, 'ws', [m.id]);
    await decide(h, 'ws', entry.traceId, 'approval.granted');
    const before = await h.snapshot(['ws'], { global: true });
    const [run] = await h.runner.runJob(h.job('usage-feedback'), 'manual', { dryRun: true });
    expect(run).toMatchObject({ status: 'succeeded', changed: 0, details: { dryRun: true, resolved: { approved: 1 }, configVersion: 0 } });
    expect(await h.snapshot(['ws'], { global: true })).toEqual(before);
    expect((await h.runtime.logStore.get('ws', entry.id))!.outcome).toBeUndefined();
  });
});
