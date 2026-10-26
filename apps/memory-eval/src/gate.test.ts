import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { windowsFromSplits } from './backtest.js';
import { BUNDLED_BASELINE, BUNDLED_CONFIG, BUNDLED_GOLDEN } from './bundled.testing.js';
import { runCli } from './cli.js';
import { defaultGateConfig, evaluateGate, gateConfigSchema, loadBaseline, makeBaseline, type Baseline } from './gate.js';
import { loadGoldenSet } from './golden.js';
import { defaultProfile, makeProfile } from './profiles.js';
import { renderGateMarkdown } from './report.js';
import { runEvaluation, type EvalRunReport } from './run.js';

let current: EvalRunReport;
beforeAll(async () => {
  current = await runEvaluation({ golden: loadGoldenSet(BUNDLED_GOLDEN), profiles: [defaultProfile()] });
});

const baselineOf = (report: EvalRunReport): Baseline => structuredClone(makeBaseline(report));
const tweak = (b: Baseline, metric: string, by: number): Baseline => {
  const copy = structuredClone(b);
  copy.profiles['default']!.metrics[metric] = (copy.profiles['default']!.metrics[metric] ?? 0) + by;
  return copy;
};
const statusOf = (r: ReturnType<typeof evaluateGate>, metric: string) => r.checks.find((c) => c.metric === metric)?.status;

describe('the bundled baseline (what CI runs)', () => {
  it('matches the bundled golden set and the current ranking', () => {
    const result = evaluateGate(current, loadBaseline(BUNDLED_BASELINE));
    expect(result.problems).toEqual([]);
    expect(result.status).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.checks.every((c) => c.status === 'ok')).toBe(true);
    expect(result.checks.some((c) => c.metric === 'recall@5')).toBe(true);
    expect(result.checks.some((c) => c.metric.startsWith('latencyMs'))).toBe(false);
  });

  it('fails when the ranking gets worse (a profile that returns nothing)', async () => {
    const broken = await runEvaluation({ golden: loadGoldenSet(BUNDLED_GOLDEN), profiles: [makeProfile('default', { minScore: 0.99 })] });
    const result = evaluateGate(broken, loadBaseline(BUNDLED_BASELINE));
    expect(result.status).toBe('regression');
    expect(result.exitCode).toBe(1);
    expect(statusOf(result, 'recall@5')).toBe('regressed');
    expect(statusOf(result, 'ndcg@5')).toBe('regressed');
    expect(statusOf(result, 'mrr')).toBe('regressed');
    expect(statusOf(result, 'tokens.mean')).toBe('improved');
    const md = renderGateMarkdown(result, { golden: 'bundled' });
    expect(md).toContain('FAIL: regression');
    expect(md).toContain('regressed');
  });
});

describe('tolerance', () => {
  it('lets a drop inside the tolerance pass and fails one beyond it', () => {
    const base = baselineOf(current);
    expect(evaluateGate(current, tweak(base, 'ndcg@5', 0.015)).status).toBe('pass');
    expect(evaluateGate(current, tweak(base, 'ndcg@5', 0.03)).status).toBe('regression');
    // exactly the tolerance is allowed
    expect(evaluateGate(current, tweak(base, 'ndcg@5', 0.02)).status).toBe('pass');
  });

  it('uses a per-metric tolerance when set', () => {
    const base = tweak(baselineOf(current), 'ndcg@5', 0.05);
    const strict = evaluateGate(current, base, { config: gateConfigSchema.parse({ tolerance: 0.02 }) });
    const loose = evaluateGate(current, base, { config: gateConfigSchema.parse({ tolerance: 0.02, metricTolerance: { 'ndcg@5': 0.06 } }) });
    expect(strict.status).toBe('regression');
    expect(loose.status).toBe('pass');
  });

  it('marks a better metric as improved, and does not fail on it', () => {
    const result = evaluateGate(current, tweak(baselineOf(current), 'mrr', -0.1));
    expect(statusOf(result, 'mrr')).toBe('improved');
    expect(result.status).toBe('pass');
  });

  it('fails when unwanted memories show up more often than before', () => {
    const base = tweak(baselineOf(current), 'avoidRate@3', -0.25);
    const result = evaluateGate(current, base);
    expect(statusOf(result, 'avoidRate@3')).toBe('regressed');
    expect(evaluateGate(current, base, { config: gateConfigSchema.parse({ avoidTolerance: 0.3 }) }).status).toBe('pass');
  });

  it('fails when the token pack grows beyond the allowed ratio', () => {
    const base = baselineOf(current);
    const smaller = tweak(base, 'tokens.mean', -(base.profiles['default']!.metrics['tokens.mean']! * 0.5));
    expect(statusOf(evaluateGate(current, smaller), 'tokens.mean')).toBe('regressed');
    expect(evaluateGate(current, smaller, { config: gateConfigSchema.parse({ tokensMaxIncrease: 1.5 }) }).status).toBe('pass');
  });

  it('fails on a metric the baseline has and the run no longer reports', () => {
    const base = structuredClone(baselineOf(current));
    base.profiles['default']!.metrics['recall@9'] = 1;
    const result = evaluateGate(current, base);
    expect(statusOf(result, 'recall@9')).toBe('missing');
    expect(result.exitCode).toBe(1);
  });
});

describe('latency', () => {
  it('is left out of the stored baseline and of the gate by default', () => {
    expect(JSON.stringify(makeBaseline(current))).not.toContain('latencyMs');
    expect(Object.keys(makeBaseline(current, undefined, { includeLatency: true }).profiles['default']!.metrics)).toContain('latencyMs.p95');
  });

  it('can be gated with a ratio and a minimum absolute rise', () => {
    const base = structuredClone(makeBaseline(current, undefined, { includeLatency: true }));
    base.profiles['default']!.metrics['latencyMs.p95'] = 0.0001;
    const config = (min: number) => gateConfigSchema.parse({ latencyMaxIncrease: 0.5, latencyMinDeltaMs: min });
    expect(statusOf(evaluateGate(current, base, { config: config(0) }), 'latencyMs.p95')).toBe('regressed');
    expect(statusOf(evaluateGate(current, base, { config: config(10_000) }), 'latencyMs.p95')).toBe('ok');
    expect(evaluateGate(current, base).checks.some((c) => c.metric.startsWith('latencyMs'))).toBe(false);
  });
});

describe('stale and incomplete baselines', () => {
  it('exits 3 when the golden set changed since the baseline, unless told to compare anyway', () => {
    const base = baselineOf(current);
    base.golden.digest = 'f'.repeat(64);
    const stale = evaluateGate(current, base);
    expect(stale.status).toBe('stale');
    expect(stale.exitCode).toBe(3);
    expect(stale.problems[0]).toContain('golden set changed');
    const forced = evaluateGate(current, base, { allowStale: true });
    expect(forced.status).toBe('pass');
    expect(forced.problems).toHaveLength(1);
  });

  it('exits 3 for another golden set, mode, k or windows', async () => {
    const base = baselineOf(current);
    expect(evaluateGate(current, { ...base, golden: { ...base.golden, name: 'other' } }).exitCode).toBe(3);
    expect(evaluateGate(current, { ...base, k: [1, 3] }).exitCode).toBe(3);
    const windows = windowsFromSplits(['2026-10-08T00:00:00Z']);
    expect(evaluateGate(current, base, { windows }).exitCode).toBe(3);
    const bt = await runEvaluation({ golden: loadGoldenSet(BUNDLED_GOLDEN), profiles: [defaultProfile()], windows });
    expect(evaluateGate(bt, base, { windows }).exitCode).toBe(3);
    expect(evaluateGate(bt, makeBaseline(bt, windows), { windows }).exitCode).toBe(0);
  });

  it('exits 3 for a profile that has no entry in the baseline', async () => {
    const other = await runEvaluation({ golden: loadGoldenSet(BUNDLED_GOLDEN), profiles: [makeProfile('candidate', {})] });
    const result = evaluateGate(other, baselineOf(current));
    expect(result.status).toBe('unknown_profile');
    expect(result.exitCode).toBe(3);
    expect(result.problems.join(' ')).toContain('"candidate"');
  });

  it('rejects an invalid baseline file and gate config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'base-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"schemaVersion": 2}');
    expect(() => loadBaseline(bad)).toThrow(/invalid/);
    expect(() => loadBaseline(join(dir, 'missing.json'))).toThrow(/cannot read baseline/);
    expect(() => gateConfigSchema.parse({ tolerance: 2 })).toThrow();
    expect(defaultGateConfig()).toMatchObject({ tolerance: 0.02, avoidTolerance: 0, tokensMaxIncrease: 0.25, latencyMaxIncrease: null });
  });
});

describe('gate command', () => {
  const capture = () => {
    const io = { out: '', err: '' };
    return { io, sink: { out: (t: string) => void (io.out += t), err: (t: string) => void (io.err += t) } };
  };

  it('passes on the bundled configuration, as CI runs it', async () => {
    const { io, sink } = capture();
    expect(await runCli(['gate', `--config=${BUNDLED_CONFIG}`, '--quiet'], sink)).toBe(0);
    expect(io.err).toBe('');
  });

  it('exits non-zero when a metric drops more than the tolerance below the stored baseline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const stored = JSON.parse(readFileSync(BUNDLED_BASELINE, 'utf8')) as Baseline;
    stored.profiles['default']!.metrics['ndcg@5']! += 0.1;
    const path = join(dir, 'baseline.json');
    writeFileSync(path, JSON.stringify(stored));
    const failing = capture();
    expect(await runCli(['gate', `--config=${BUNDLED_CONFIG}`, `--baseline=${path}`], failing.sink)).toBe(1);
    expect(failing.io.out).toContain('FAIL: regression');
    expect(failing.io.err).toContain('gate failed');
    const lenient = capture();
    expect(await runCli(['gate', `--config=${BUNDLED_CONFIG}`, `--baseline=${path}`, '--tolerance=0.2', '--quiet'], lenient.sink)).toBe(0);
  });

  it('exits 3 on a stale baseline and writes the JSON report on request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const stored = JSON.parse(readFileSync(BUNDLED_BASELINE, 'utf8')) as Baseline;
    stored.golden.digest = '0'.repeat(64);
    const path = join(dir, 'baseline.json');
    writeFileSync(path, JSON.stringify(stored));
    const { sink } = capture();
    expect(await runCli(['gate', `--config=${BUNDLED_CONFIG}`, `--baseline=${path}`, `--out-dir=${dir}`, '--quiet'], sink)).toBe(3);
    const json = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as { gate: { status: string; exitCode: number } };
    expect(json.gate).toMatchObject({ status: 'stale', exitCode: 3 });
    expect(await runCli(['gate', `--config=${BUNDLED_CONFIG}`, `--baseline=${path}`, '--allow-stale', '--quiet'], capture().sink)).toBe(0);
  });

  it('writes a baseline that the gate then accepts, for another profile set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const path = join(dir, 'new-baseline.json');
    const args = [`--golden=${BUNDLED_GOLDEN}`, '--profile=default', '--profile=tight=default', `--baseline=${path}`, '--quiet'];
    const written = capture();
    expect(await runCli(['baseline', ...args], written.sink)).toBe(0);
    expect(written.io.out).toContain('baseline written');
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    expect(Object.keys(stored.profiles)).toEqual(['default', 'tight']);
    expect(await runCli(['gate', ...args], capture().sink)).toBe(0);
    expect(await runCli(['gate', `--golden=${BUNDLED_GOLDEN}`, '--quiet'], capture().sink)).toBe(2);
  });
});
