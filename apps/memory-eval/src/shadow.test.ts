import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deterministicUuid, type RetrievalLogEntry } from '@smallseedlabs/proba-memory-core';
import { BUNDLED_CONFIG, BUNDLED_GOLDEN, RECENCY_PROFILE } from './bundled.testing.js';
import { runCli } from './cli.js';
import { loadGoldenSet } from './golden.js';
import { defaultProfile, loadProfile } from './profiles.js';
import { renderShadowMarkdown } from './report.js';
import { runEvaluation } from './run.js';
import { analyseShadowLog, queryHashOf, runShadowEvaluation } from './shadow.js';
import { createEvalStack } from './stack.js';

const golden = () => loadGoldenSet(BUNDLED_GOLDEN);

describe('shadow profiles', () => {
  it('serves the baseline only, logs the shadow list, and reads it back', async () => {
    const g = golden();
    const { report, servedIds } = await runShadowEvaluation({ golden: g, baseline: defaultProfile(), candidate: loadProfile(RECENCY_PROFILE) });
    expect(report.entries).toMatchObject({ read: 12, matched: 12, withShadow: 12, unmatchedQueries: [] });
    expect(report.versions).toEqual(['eval-rollout v1 (active) vs v2 (shadow)']);
    expect(report.queries.every((q) => q.servedVersion === 1 && q.shadowVersion === 2)).toBe(true);
    // what was served is exactly what the baseline alone returns: the shadow never leaks into the response
    const alone = await runEvaluation({ golden: g, profiles: [defaultProfile()] });
    for (const row of alone.profiles[0]!.queries) {
      expect(servedIds[row.id]).toEqual(row.results.map((r) => r.id));
    }
    expect(report.queries.map((q) => q.servedIds)).toEqual(g.queries.map((q) => servedIds[q.id]));
  });

  it('scores the served list like a plain run of the baseline, and the shadow list like a plain run of the candidate', async () => {
    const g = golden();
    const candidate = loadProfile(RECENCY_PROFILE);
    const { report } = await runShadowEvaluation({ golden: g, baseline: defaultProfile(), candidate });
    const plain = await runEvaluation({ golden: g, profiles: [defaultProfile(), candidate] });
    for (const metric of ['recall@5', 'ndcg@5', 'mrr', 'recall@1', 'ndcg@3']) {
      expect(report.served.ranking[metric]).toBe(plain.profiles[0]!.summary.ranking[metric]);
      expect(report.shadow.ranking[metric]).toBe(plain.profiles[1]!.summary.ranking[metric]);
    }
    expect(report.served.latencyMs).toBeNull();
    expect(report.shadow.latencyMs).toBeNull();
    expect(report.comparison.find((m) => m.metric === 'ndcg@5')?.verdict).toBe('worse');
    expect(report.agreement.topOneSame).toBeGreaterThan(0.5);
    expect(report.agreement.overlap['overlap@5']).toBeGreaterThan(0);
  });

  it('renders a Markdown report', async () => {
    const { report } = await runShadowEvaluation({ golden: golden(), baseline: defaultProfile(), candidate: loadProfile(RECENCY_PROFILE) });
    const md = renderShadowMarkdown(report);
    expect(md).toContain('# Shadow evaluation: bundled');
    expect(md).toContain('Δ shadow − served');
    expect(md).toContain('Agreement:');
    expect(md).not.toContain('undefined');
  });

  it('matches a logged query to a golden query by its redacted, lower-cased hash', () => {
    expect(queryHashOf('  What  IS the monthly marketing budget ')).toBe(queryHashOf('what is the monthly marketing budget'));
    expect(queryHashOf('a')).not.toBe(queryHashOf('b'));
    expect(queryHashOf('a')).toHaveLength(32);
  });

  it('reports golden queries that have no logged shadow data, and ignores entries of other queries', async () => {
    const g = golden();
    const stack = createEvalStack(g);
    await stack.replay(g.observations);
    await stack.installProfile([g.workspace], 'fam', defaultProfile(), 'active');
    stack.clock.set(g.queries[0]!.asOf);
    const service = stack.retrievalFor('fam');
    const ctx = { workspaceId: g.workspace, actor: { type: 'service' as const, id: 'x' }, traceId: deterministicUuid('t', '1') };
    await service.search(ctx, { query: g.queries[0]!.query, limit: 5 }); // no shadow version installed: no shadow list
    await service.search({ ...ctx, traceId: deterministicUuid('t', '2') }, { query: 'something nobody asked' });
    const entries = await stack.logStore.list(g.workspace);
    const report = await analyseShadowLog({ entries, golden: g, hydrate: stack.hydrate, source: 'test' });
    expect(report.entries).toMatchObject({ read: 2, matched: 1, withShadow: 0 });
    expect(report.entries.unmatchedQueries).toHaveLength(12);
    expect(report.queries).toEqual([]);
    expect(report.shadow.scoredQueries).toBe(0);
  });

  it('records which profile served a canary request and leaves canary entries without a shadow list', async () => {
    const g = golden();
    const stack = createEvalStack(g);
    await stack.replay(g.observations);
    await stack.installProfile([g.workspace], 'fam', defaultProfile(), 'active');
    await stack.installProfile([g.workspace], 'fam', loadProfile(RECENCY_PROFILE), 'canary', 100);
    stack.clock.set(g.queries[0]!.asOf);
    const response = await stack
      .retrievalFor('fam')
      .search({ workspaceId: g.workspace, actor: { type: 'service', id: 'x' }, traceId: deterministicUuid('t', 'c') }, { query: g.queries[0]!.query });
    expect(response.profile).toMatchObject({ version: 2, served: 'canary' });
    const [entry] = await stack.logStore.list(g.workspace);
    expect(entry).toMatchObject({ profileVersion: 2, profileServed: 'canary', shadowResults: null });
  });
});

describe('shadow command', () => {
  const capture = () => {
    const io = { out: '', err: '' };
    return { io, sink: { out: (t: string) => void (io.out += t), err: (t: string) => void (io.err += t) } };
  };

  it('runs in process from the bundled configuration', async () => {
    const { io, sink } = capture();
    expect(await runCli(['shadow', `--config=${BUNDLED_CONFIG}`], sink)).toBe(0);
    expect(io.out).toContain('(default served, recency-heavy shadow)');
  });

  it('needs a second profile when no candidate is configured', async () => {
    const { io, sink } = capture();
    expect(await runCli(['shadow', `--golden=${BUNDLED_GOLDEN}`], sink)).toBe(2);
    expect(io.err).toContain('shadow needs');
  });

  it('reads an exported retrieval log file', async () => {
    const g = golden();
    const stack = createEvalStack(g);
    await stack.replay(g.observations);
    await stack.installProfile([g.workspace], 'fam', defaultProfile(), 'active');
    await stack.installProfile([g.workspace], 'fam', loadProfile(RECENCY_PROFILE), 'shadow');
    const service = stack.retrievalFor('fam');
    const ids = new Set<string>();
    for (const q of g.queries) {
      stack.clock.set(q.asOf);
      const r = await service.search({ workspaceId: g.workspace, actor: { type: 'service', id: 'x' }, traceId: deterministicUuid('t', q.id) }, { query: q.query, limit: 5 });
      r.results.forEach((x) => ids.add(x.id));
    }
    const entries: RetrievalLogEntry[] = await stack.logStore.list(g.workspace, { limit: 100 });
    const memories = (await stack.hydrate(g.workspace, [...entries.flatMap((e) => e.shadowResults?.map((s) => s.id) ?? []), ...ids])).map((m) => ({ ...m, workspaceId: g.workspace }));
    const dir = mkdtempSync(join(tmpdir(), 'logs-'));
    const file = join(dir, 'logs.json');
    writeFileSync(file, JSON.stringify({ entries, memories }));
    const { io, sink } = capture();
    expect(await runCli(['shadow', `--golden=${BUNDLED_GOLDEN}`, `--logs=${file}`], sink)).toBe(0);
    expect(io.out).toContain('exported log');
    expect(io.out).toContain('with a shadow list: 12');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"nope": true}');
    expect(await runCli(['shadow', `--golden=${BUNDLED_GOLDEN}`, `--logs=${bad}`], capture().sink)).toBe(2);
  });
});
