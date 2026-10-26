import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertUniqueWindows, makeWindow, rollingWindows, windowsFromSplits } from './backtest.js';
import { BUNDLED_CONFIG, BUNDLED_GOLDEN, RECENCY_PROFILE } from './bundled.testing.js';
import { runCli } from './cli.js';
import { compareProfiles } from './compare.js';
import { loadEvalConfig } from './config.js';
import { GoldenSetError, loadGoldenSet, parseGoldenSet } from './golden.js';
import { defaultProfile, loadProfile, makeProfile } from './profiles.js';
import { buildComparisonReport, renderComparisonMarkdown } from './report.js';
import { runEvaluation, type EvalRunReport } from './run.js';

const golden = () => loadGoldenSet(BUNDLED_GOLDEN);

/** The report without wall-clock latency, which differs between runs. */
const withoutLatency = (r: EvalRunReport): unknown =>
  JSON.parse(JSON.stringify(r, (k, v: unknown) => (k === 'latencyMs' ? undefined : v)));

afterEach(() => vi.unstubAllGlobals());

describe('static run', () => {
  it('replays the corpus through the real write path and scores the default profile', async () => {
    const report = await runEvaluation({ golden: golden(), profiles: [defaultProfile()] });
    expect(report.mode).toBe('static');
    expect(report.environment).toEqual({ embedder: 'local-hash/local-hash', llm: 'scripted/scripted-rules-1' });
    const p = report.profiles[0]!;
    expect(p.summary.scoredQueries).toBe(12);
    expect(p.summary.ranking['recall@5']).toBe(1);
    expect(p.summary.ranking['mrr']).toBeGreaterThan(0.5);
    expect(p.summary.tokens.mean).toBeGreaterThan(0);
    expect(p.summary.latencyMs?.p95).toBeGreaterThanOrEqual(0);
    for (const q of p.queries) {
      expect(q.degraded).toEqual([]);
      expect(q.results.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic: the same input gives the same report, apart from latency', async () => {
    const a = await runEvaluation({ golden: golden(), profiles: [defaultProfile(), loadProfile(RECENCY_PROFILE)] });
    const b = await runEvaluation({ golden: golden(), profiles: [defaultProfile(), loadProfile(RECENCY_PROFILE)] });
    expect(withoutLatency(a)).toEqual(withoutLatency(b));
  });

  it('makes no network call: every adapter is in process', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network is not allowed in tests')));
    vi.stubGlobal('fetch', fetchSpy);
    await runEvaluation({ golden: golden(), profiles: [defaultProfile()] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a query that is asked before the end of the corpus (it would see the future)', async () => {
    const g = parseGoldenSet({
      version: 1,
      name: 'leak',
      workspace: 'w',
      observations: [
        { key: 'a', occurredAt: '2026-09-01T00:00:00Z', text: 'first thing' },
        { key: 'b', occurredAt: '2026-10-01T00:00:00Z', text: 'second thing' },
      ],
      queries: [{ id: 'early', query: 'thing', asOf: '2026-09-15T00:00:00Z', expect: { observations: ['a'] } }],
    });
    await expect(runEvaluation({ golden: g, profiles: [defaultProfile()] })).rejects.toThrow(/leak the future/);
  });

  it('rejects duplicate profile names, an empty profile list and a set without observations', async () => {
    await expect(runEvaluation({ golden: golden(), profiles: [defaultProfile(), defaultProfile()] })).rejects.toThrow(/two profiles are named/);
    await expect(runEvaluation({ golden: golden(), profiles: [] })).rejects.toThrow(/no scoring profile/);
    const g = parseGoldenSet({ version: 1, name: 'x', workspace: 'w', now: '2026-10-01T00:00:00Z', queries: [{ id: 'q', query: 'q', expect: { facts: ['f'] } }] });
    await expect(runEvaluation({ golden: g, profiles: [defaultProfile()] })).rejects.toThrow(/no observations/);
  });

  it('keeps workspaces apart: a query only sees memories of its own workspace', async () => {
    const g = parseGoldenSet({
      version: 1,
      name: 'iso',
      workspace: 'w1',
      observations: [
        { key: 'mine', occurredAt: '2026-09-01T00:00:00Z', text: 'we prefer green banners', extract: { category: 'semantic', content: 'We prefer green banners.', importance: 0.7, confidence: 0.8 } },
        { key: 'theirs', workspace: 'w2', occurredAt: '2026-09-02T00:00:00Z', text: 'we prefer green buttons', extract: { category: 'semantic', content: 'We prefer green buttons.', importance: 0.7, confidence: 0.8 } },
      ],
      queries: [{ id: 'green', query: 'what green things do we prefer', expect: { observations: ['mine'], avoid: { observations: ['theirs'] } } }],
    });
    const report = await runEvaluation({ golden: g, profiles: [defaultProfile()] });
    const row = report.profiles[0]!.queries[0]!;
    expect(row.results).toHaveLength(1);
    expect(row.metrics.byK[5]?.avoidViolation).toBe(0);
  });
});

describe('profile comparison', () => {
  /** The old budget repeats the query words and wins on relevance alone; only recency prefers the new one. */
  const recencyGolden = () =>
    parseGoldenSet({
      version: 1,
      name: 'recency',
      workspace: 'ws',
      now: '2026-10-25T00:00:00Z',
      observations: [
        { key: 'old', occurredAt: '2026-04-01T00:00:00Z', text: 'old budget', extract: { category: 'semantic', content: 'What is the budget for ads? The budget for ads is 10000 dollars.', importance: 0.5, confidence: 0.8 } },
        { key: 'new', occurredAt: '2026-10-20T00:00:00Z', text: 'new budget', extract: { category: 'semantic', content: 'The ads spend limit is now 20000 dollars.', importance: 0.5, confidence: 0.8 } },
      ],
      queries: [{ id: 'budget', query: 'what is the budget for ads', expect: { observations: ['new'], avoid: { observations: ['old'] } } }],
    });

  it('shows a candidate that fixes a stale answer as better, query by query', async () => {
    const baseline = makeProfile('relevance-only', { weights: { relevance: 1, recency: 0, importance: 0, confidence: 0, usefulness: 0 }, mmr: { enabled: false } });
    const candidate = makeProfile('recency', { weights: { relevance: 0.3, recency: 0.7, importance: 0, confidence: 0, usefulness: 0 }, halfLifeDays: { semantic: 30 }, mmr: { enabled: false } });
    const run = await runEvaluation({ golden: recencyGolden(), profiles: [baseline, candidate], k: [1, 2] });
    const [a, b] = run.profiles;
    expect(a!.queries[0]!.results[0]!.relevant).toBe(false);
    expect(b!.queries[0]!.results[0]!.relevant).toBe(true);
    const [cmp] = compareProfiles(run);
    expect(cmp!.baseline).toBe('relevance-only');
    expect(cmp!.metrics.find((m) => m.metric === 'mrr')).toMatchObject({ baseline: 0.5, candidate: 1, verdict: 'better' });
    expect(cmp!.metrics.find((m) => m.metric === 'avoidRate@1')).toMatchObject({ baseline: 1, candidate: 0, verdict: 'better' });
    expect(cmp!.metrics.find((m) => m.metric.startsWith('latencyMs'))?.verdict).toBe('info');
    expect(cmp!.queries).toEqual([expect.objectContaining({ id: 'budget', change: 'improved' })]);
    expect(cmp!.counts).toEqual({ improved: 1, regressed: 0, unchanged: 0 });
  });

  it('picks the baseline by name and reports every other profile against it', async () => {
    const run = await runEvaluation({ golden: golden(), profiles: [defaultProfile(), loadProfile(RECENCY_PROFILE), makeProfile('tight', { packing: { tokenBudget: 60 } })] });
    expect(compareProfiles(run).map((c) => c.candidate)).toEqual(['recency-heavy', 'tight']);
    expect(compareProfiles(run, 'tight').map((c) => c.candidate)).toEqual(['default', 'recency-heavy']);
    const tight = run.profiles[2]!.summary;
    expect(tight.tokens.max).toBeLessThanOrEqual(60);
    expect(() => compareProfiles(run, 'nope')).toThrow(GoldenSetError);
  });

  it('renders JSON and Markdown reports', async () => {
    const run = await runEvaluation({ golden: golden(), profiles: [defaultProfile(), loadProfile(RECENCY_PROFILE)] });
    const report = buildComparisonReport(run);
    expect(report.baselineProfile).toBe('default');
    expect(report.comparisons).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(report)).schemaVersion).toBe(1);
    const md = renderComparisonMarkdown(report);
    expect(md).toContain('# Memory evaluation: bundled');
    expect(md).toContain('| `recall@5` |');
    expect(md).toContain('## Query changes: recency-heavy vs default');
    expect(md).toContain('## How to read this');
    expect(md).not.toContain('undefined');
  });
});

describe('time-split backtest', () => {
  const windows = windowsFromSplits(['2026-09-18T00:00:00Z', '2026-10-08T00:00:00Z']);

  it('replays only what happened up to T on a fresh store per window', async () => {
    const run = await runEvaluation({ golden: golden(), profiles: [defaultProfile()], windows, k: [3] });
    expect(run.mode).toBe('backtest');
    const [w1, w2] = run.profiles[0]!.windows!;
    expect(w1!.replay.replayed).toBe(6);
    expect(w2!.replay.replayed).toBe(11);
    expect(w1!.replay.memories).toBe(6);
    // Later facts are not visible and not held against the profile.
    const rows = run.profiles[0]!.queries;
    const texts = rows.filter((r) => r.window === w1!.name).flatMap((r) => r.results.map((x) => x.excerpt)).join(' ');
    expect(texts).not.toMatch(/Black Friday|evening|20000/);
    expect(w1!.skippedQueries).toEqual(expect.arrayContaining(['current-budget', 'today', 'newsletter-performance']));
    const launchRules = rows.find((r) => r.window === w1!.name && r.id === 'launch-rules')!;
    expect(launchRules.leftOutTargets).toEqual(['observation:approval-rule']);
    expect(launchRules.targets).toBe(1);
  });

  it('enforces "avoid" only once the replacing observation is known', async () => {
    const run = await runEvaluation({ golden: golden(), profiles: [defaultProfile()], windows, k: [3] });
    const rows = run.profiles[0]!.queries;
    // posting-time-new happened on 10-05: unknown at 09-18, known at 10-08.
    expect(rows.find((r) => r.id === 'posting-time' && r.window === windows[0]!.name)).toBeUndefined();
    expect(rows.find((r) => r.id === 'posting-time' && r.window === windows[1]!.name)!.hasAvoid).toBe(true);
    // current-budget (10-15) is unknown in both windows, so it is skipped rather than judged against the old budget.
    expect(rows.some((r) => r.id === 'current-budget')).toBe(false);
  });

  it('limits queries to the window when queryUntil is set', async () => {
    const short = windowsFromSplits(['2026-09-18T00:00:00Z'], 1);
    const run = await runEvaluation({ golden: golden(), profiles: [defaultProfile()], windows: short });
    expect(run.profiles[0]!.windows![0]!.askedQueries).toBe(0);
    expect(run.profiles[0]!.queries).toEqual([]);
    expect(run.profiles[0]!.summary.scoredQueries).toBe(0);
  });

  it('builds windows from splits, rolling steps and explicit definitions', () => {
    expect(windows.map((w) => [w.name, w.replayUntil, w.queryUntil])).toEqual([
      ['T2026-09-18', '2026-09-18T00:00:00.000Z', null],
      ['T2026-10-08', '2026-10-08T00:00:00.000Z', null],
    ]);
    const rolling = rollingWindows({ from: '2026-09-01T00:00:00Z', to: '2026-09-22T00:00:00Z', stepDays: 7, horizonDays: 10 });
    expect(rolling.map((w) => w.replayUntil.slice(0, 10))).toEqual(['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22']);
    expect(rolling[0]!.queryUntil).toBe('2026-09-11T00:00:00.000Z');
    expect(() => makeWindow({ replayUntil: '2026-09-18T00:00:00Z', queryUntil: '2026-09-01T00:00:00Z' })).toThrow(/after replayUntil/);
    expect(() => windowsFromSplits(['not a date'])).toThrow(GoldenSetError);
    expect(() => assertUniqueWindows([windows[0]!, windows[0]!])).toThrow(/two windows/);
    expect(() => rollingWindows({ from: '2026-09-22T00:00:00Z', to: '2026-09-01T00:00:00Z', stepDays: 7 })).toThrow(/not be before/);
  });

  it('adds a per-window table to the Markdown report', async () => {
    const run = await runEvaluation({ golden: golden(), profiles: [defaultProfile(), loadProfile(RECENCY_PROFILE)], windows, k: [3] });
    const md = renderComparisonMarkdown(buildComparisonReport(run));
    expect(md).toContain('## Time-split windows');
    expect(md).toContain('T2026-09-18');
    expect(md).toContain('nothing known yet');
  });
});

describe('profiles and config files', () => {
  it('merges a profile file over the default and validates it', () => {
    const p = loadProfile(RECENCY_PROFILE);
    expect(p.name).toBe('recency-heavy');
    expect(p.config.weights.recency).toBe(0.35);
    expect(p.config.weights.relevance).toBe(0.4);
    expect(p.config.halfLifeDays.semantic).toBe(30);
    expect(p.config.halfLifeDays.working).toBe(1);
    expect(p.config.fusion.k).toBe(60);
    expect(loadProfile(`mine=${RECENCY_PROFILE}`).name).toBe('mine');
    expect(loadProfile('base=default').name).toBe('base');
    expect(loadProfile('default').digest).toBe(defaultProfile().digest);
    expect(p.digest).not.toBe(defaultProfile().digest);
  });

  it('rejects an invalid profile with the path of the problem', () => {
    expect(() => makeProfile('bad', { weights: { relevance: -1 } })).toThrow(/weights.relevance/);
    expect(() => makeProfile('bad name', {})).toThrow(/letters, digits/);
    expect(() => makeProfile('bad', { surprise: 1 })).toThrow(GoldenSetError);
    expect(() => loadProfile('/no/such/profile.yaml')).toThrow(/cannot read profile/);
  });

  it('resolves the paths of the bundled config relative to the file', () => {
    const c = loadEvalConfig(BUNDLED_CONFIG);
    expect(c.golden).toBe(BUNDLED_GOLDEN);
    expect(c.baseline?.endsWith('bundled.baseline.json')).toBe(true);
    expect(c.profiles).toEqual(['default']);
    expect(c.shadow?.candidate).toBe(`recency-heavy=${RECENCY_PROFILE}`);
    expect(c.gate?.tolerance).toBe(0.02);
  });

  it('rejects a config with both windows and rolling, or an unknown key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const both = join(dir, 'both.yaml');
    writeFileSync(both, 'windows: [{ replayUntil: 2026-09-18T00:00:00Z }]\nrolling: { from: 2026-09-01T00:00:00Z, to: 2026-09-10T00:00:00Z, stepDays: 3 }\n');
    expect(() => loadEvalConfig(both)).toThrow(/either windows or rolling/);
    const unknown = join(dir, 'unknown.yaml');
    writeFileSync(unknown, 'gold: x\n');
    expect(() => loadEvalConfig(unknown)).toThrow(/invalid/);
  });
});

describe('command line', () => {
  const capture = () => {
    const io = { out: '', err: '' };
    return { io, sink: { out: (t: string) => void (io.out += t), err: (t: string) => void (io.err += t) } };
  };

  it('validates a golden set', async () => {
    const { io, sink } = capture();
    expect(await runCli(['validate', `--golden=${BUNDLED_GOLDEN}`], sink)).toBe(0);
    expect(io.out).toContain('golden set "bundled" is valid');
  });

  it('runs profiles side by side and writes report.json and report.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'out-'));
    const { io, sink } = capture();
    const code = await runCli(['run', `--golden=${BUNDLED_GOLDEN}`, '--profile=default', `--profile=${RECENCY_PROFILE}`, '--k=1,3', `--out-dir=${dir}`, '--quiet'], sink);
    expect(code).toBe(0);
    expect(io.out).toBe('');
    expect(existsSync(join(dir, 'report.md'))).toBe(true);
    const json = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as { k: number[]; profiles: unknown[]; comparisons: unknown[] };
    expect(json.k).toEqual([1, 3]);
    expect(json.profiles).toHaveLength(2);
    expect(json.comparisons).toHaveLength(1);
  });

  it('runs a backtest from --split flags and refuses one without windows', async () => {
    const a = capture();
    expect(await runCli(['backtest', `--golden=${BUNDLED_GOLDEN}`, '--split=2026-10-08T00:00:00Z', '--k=3'], a.sink)).toBe(0);
    expect(a.io.out).toContain('Mode: **backtest**');
    const b = capture();
    expect(await runCli(['backtest', `--golden=${BUNDLED_GOLDEN}`], b.sink)).toBe(2);
    expect(b.io.err).toContain('needs --split');
  });

  it('exits 2 on bad input and prints the usage for help', async () => {
    const a = capture();
    expect(await runCli(['run'], a.sink)).toBe(2);
    expect(a.io.err).toContain('no golden set');
    const b = capture();
    expect(await runCli(['frobnicate'], b.sink)).toBe(2);
    const c = capture();
    expect(await runCli(['run', `--golden=${BUNDLED_GOLDEN}`, '--k=0'], c.sink)).toBe(2);
    const d = capture();
    expect(await runCli(['run', 'oops'], d.sink)).toBe(2);
    const e = capture();
    expect(await runCli(['help'], e.sink)).toBe(0);
    expect(e.io.out).toContain('exit codes');
  });
});
