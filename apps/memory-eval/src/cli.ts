import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger, loadConfigFromEnvironment, type RetrievalLogEntry } from '@smallseedlabs/proba-memory-core';
import { createRuntime } from '@smallseedlabs/proba-memory-adapters';
import { assertUniqueWindows, rollingWindows, windowsFromSplits, type BacktestWindow } from './backtest.js';
import { loadEvalConfig, type EvalConfig } from './config.js';
import { defaultGateConfig, evaluateGate, gateConfigSchema, loadBaseline, makeBaseline, type GateConfig } from './gate.js';
import { GoldenSetError, loadGoldenSet, parseDocument } from './golden.js';
import { defaultProfile, loadProfile, type ProfileSpec } from './profiles.js';
import { buildComparisonReport, renderComparisonMarkdown, renderGateMarkdown, renderShadowMarkdown } from './report.js';
import { runEvaluation } from './run.js';
import { analyseShadowLog, runShadowEvaluation } from './shadow.js';

const USAGE = `proba-memory evaluation harness

usage: npm run eval -- <command> [options]

commands
  validate   check a golden set and print what it holds
  run        replay the golden set and score one or more scoring profiles side by side (baseline = the first)
  backtest   like run, but time-split: replay up to T, ask the queries after T (needs --split, --rolling or windows in the config)
  gate       run, compare with the stored baseline, exit non-zero on a regression
  baseline   run and write the baseline file the gate compares with
  shadow     score served and shadow lists: in process (default), --source=runtime (reads retrieval_log) or --logs=<file.json>

common options
  --config=<file>        run configuration (YAML/JSON): golden, baseline, profiles, k, windows, gate
  --golden=<file>        golden set (YAML/JSON)
  --profile=<spec>       repeatable. \`default\`, \`name=default\`, \`<file>\` or \`name=<file>\`; the first is the baseline
  --baseline-profile=<n> compare against this profile instead of the first
  --k=1,3,5              cut-offs of the @k metrics (the last is the headline)
  --split=<ISO>          repeatable, a split time T (backtest); --horizon-days=<n> limits how far after T queries are asked
  --rolling=<from>,<to>,<stepDays>[,<horizonDays>]
  --out-dir=<dir>        write report.json and report.md there
  --json=<file> --md=<file>   write one of them
  --quiet                do not print the markdown report

gate options
  --baseline=<file>      stored baseline (default from the config)
  --tolerance=<0..1>     largest allowed absolute drop of a quality metric (default 0.02)
  --max-token-increase=<ratio>   largest allowed relative rise of the token pack (default 0.25)
  --max-latency-increase=<ratio> also gate retrieval latency (off by default: wall time is noisy)
  --allow-stale          compare even when the golden set or windows changed since the baseline

baseline options
  --baseline=<file>      where to write it (default from the config)
  --with-latency         also store latency (needed for --max-latency-increase; machine dependent)

shadow options
  --candidate=<spec>     profile that runs in shadow (default: the second --profile)
  --limit=<n>            log entries to read with --source=runtime (default 1000)

exit codes: 0 ok, 1 regression, 2 invalid input or usage, 3 stale or incomplete baseline`;

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

interface Args {
  command: string;
  flags: Map<string, string[]>;
  bool: Set<string>;
}

const BOOLEAN_FLAGS = new Set(['quiet', 'allow-stale', 'with-latency', 'help']);

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string[]>();
  const bool = new Set<string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (!arg.startsWith('--')) throw new GoldenSetError(`unexpected argument "${arg}"`);
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(name)) {
      bool.add(name);
      continue;
    }
    let value: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) {
      value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw new GoldenSetError(`--${name} needs a value`);
      i += 1;
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, flags, bool };
}

const one = (a: Args, name: string): string | undefined => a.flags.get(name)?.[a.flags.get(name)!.length - 1];
const many = (a: Args, name: string): string[] => a.flags.get(name) ?? [];

function numberFlag(a: Args, name: string): number | undefined {
  const v = one(a, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new GoldenSetError(`--${name} must be a number, got "${v}"`);
  return n;
}

function writeOutputs(a: Args, io: CliIo, json: unknown, markdown: string): void {
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(path, text);
  };
  const dir = one(a, 'out-dir');
  const jsonPath = one(a, 'json') ?? (dir ? resolve(dir, 'report.json') : undefined);
  const mdPath = one(a, 'md') ?? (dir ? resolve(dir, 'report.md') : undefined);
  if (jsonPath) write(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  if (mdPath) write(mdPath, markdown);
  if (!a.bool.has('quiet')) io.out(markdown);
}

interface Resolved {
  config: EvalConfig;
  goldenPath: string;
  profiles: ProfileSpec[];
  windows: BacktestWindow[] | undefined;
  k: number[] | undefined;
}

function resolveInputs(a: Args, options: { needProfiles?: boolean } = {}): Resolved {
  const configPath = one(a, 'config');
  const config: EvalConfig = configPath ? loadEvalConfig(configPath) : {};
  const goldenPath = one(a, 'golden') ?? config.golden;
  if (!goldenPath) throw new GoldenSetError('no golden set: pass --golden=<file> or set `golden` in --config');
  const profileSpecs = many(a, 'profile').length > 0 ? many(a, 'profile') : (config.profiles ?? []);
  const profiles = profileSpecs.length > 0 ? profileSpecs.map(loadProfile) : options.needProfiles === false ? [] : [defaultProfile()];

  let windows: BacktestWindow[] | undefined = config.windows;
  const splits = many(a, 'split');
  const rolling = one(a, 'rolling');
  const horizon = numberFlag(a, 'horizon-days');
  if (splits.length > 0) windows = windowsFromSplits(splits, horizon);
  if (rolling) {
    const [from, to, step, h] = rolling.split(',');
    if (!from || !to || !step) throw new GoldenSetError('--rolling needs <from>,<to>,<stepDays>[,<horizonDays>]');
    windows = rollingWindows({ from, to, stepDays: Number(step), ...(h ? { horizonDays: Number(h) } : horizon ? { horizonDays: horizon } : {}) });
  }
  if (windows) assertUniqueWindows(windows);

  const kFlag = one(a, 'k');
  const k = kFlag ? kFlag.split(',').map((x) => Number(x.trim())) : config.k;
  if (k && k.some((n) => !Number.isInteger(n) || n < 1)) throw new GoldenSetError('--k must be whole numbers of at least 1, for example --k=1,3,5');
  return { config, goldenPath, profiles, windows, k };
}

function gateConfigFrom(a: Args, config: EvalConfig): GateConfig {
  const base: Record<string, unknown> = { ...(config.gate ?? defaultGateConfig()) };
  const tolerance = numberFlag(a, 'tolerance');
  const tokens = numberFlag(a, 'max-token-increase');
  const latency = numberFlag(a, 'max-latency-increase');
  if (tolerance !== undefined) base['tolerance'] = tolerance;
  if (tokens !== undefined) base['tokensMaxIncrease'] = tokens;
  if (latency !== undefined) base['latencyMaxIncrease'] = latency;
  return gateConfigSchema.parse(base);
}

/** Run one command; returns the process exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    const a = parseArgs(argv);
    if (a.command === 'help' || a.bool.has('help')) {
      io.out(`${USAGE}\n`);
      return 0;
    }
    switch (a.command) {
      case 'validate': {
        const { goldenPath } = resolveInputs(a, { needProfiles: false });
        const g = loadGoldenSet(goldenPath);
        const targets = g.queries.reduce((n, q) => n + q.targets.length, 0);
        io.out(
          `golden set "${g.name}" is valid: ${g.observations.length} observations, ${g.queries.length} queries, ${targets} expected targets, k = [${g.k.join(', ')}], digest ${g.digest.slice(0, 12)}\n`
        );
        return 0;
      }
      case 'run':
      case 'backtest': {
        const r = resolveInputs(a);
        if (a.command === 'backtest' && !r.windows) throw new GoldenSetError('backtest needs --split, --rolling or `windows`/`rolling` in the config');
        const golden = loadGoldenSet(r.goldenPath);
        const run = await runEvaluation({ golden, profiles: r.profiles, ...(r.windows ? { windows: r.windows } : {}), ...(r.k ? { k: r.k } : {}) });
        const report = buildComparisonReport(run, one(a, 'baseline-profile'));
        writeOutputs(a, io, report, renderComparisonMarkdown(report));
        return 0;
      }
      case 'baseline': {
        const r = resolveInputs(a);
        const path = one(a, 'baseline') ?? r.config.baseline;
        if (!path) throw new GoldenSetError('no baseline file: pass --baseline=<file> or set `baseline` in --config');
        const golden = loadGoldenSet(r.goldenPath);
        const run = await runEvaluation({ golden, profiles: r.profiles, ...(r.windows ? { windows: r.windows } : {}), ...(r.k ? { k: r.k } : {}) });
        mkdirSync(dirname(resolve(path)), { recursive: true });
        writeFileSync(path, `${JSON.stringify(makeBaseline(run, r.windows, { includeLatency: a.bool.has('with-latency') }), null, 2)}\n`);
        io.out(`baseline written to ${path} for ${run.profiles.map((p) => p.name).join(', ')} (golden set ${golden.name}, digest ${golden.digest.slice(0, 12)})\n`);
        return 0;
      }
      case 'gate': {
        const r = resolveInputs(a);
        const path = one(a, 'baseline') ?? r.config.baseline;
        if (!path) throw new GoldenSetError('no baseline file: pass --baseline=<file> or set `baseline` in --config');
        const baseline = loadBaseline(path);
        const golden = loadGoldenSet(r.goldenPath);
        const run = await runEvaluation({ golden, profiles: r.profiles, ...(r.windows ? { windows: r.windows } : {}), ...(r.k ? { k: r.k } : {}) });
        const result = evaluateGate(run, baseline, { config: gateConfigFrom(a, r.config), ...(r.windows ? { windows: r.windows } : {}), allowStale: a.bool.has('allow-stale') });
        const markdown = renderGateMarkdown(result, { golden: golden.name, baselineFile: path });
        writeOutputs(a, io, { gate: result, report: buildComparisonReport(run, one(a, 'baseline-profile')) }, markdown);
        if (result.exitCode !== 0) io.err(`gate failed (${result.status}), exit code ${result.exitCode}\n`);
        return result.exitCode;
      }
      case 'shadow':
        return await shadowCommand(a, io);
      default:
        io.err(`unknown command "${a.command}"\n\n${USAGE}\n`);
        return 2;
    }
  } catch (err) {
    if (err instanceof GoldenSetError) {
      io.err(`${err.message}\n`);
      return 2;
    }
    io.err(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 2;
  }
}

async function shadowCommand(a: Args, io: CliIo): Promise<number> {
  const r = resolveInputs(a);
  const golden = loadGoldenSet(r.goldenPath);
  const source = one(a, 'source') ?? 'process';
  const logsFile = one(a, 'logs');
  if (logsFile || source === 'runtime') {
    const hydrateAndReport = async (entries: RetrievalLogEntry[], hydrate: Parameters<typeof analyseShadowLog>[0]['hydrate'], label: string): Promise<number> => {
      const report = await analyseShadowLog({ entries, golden, hydrate, source: label, ...(r.k ? { k: r.k } : {}) });
      writeOutputs(a, io, report, renderShadowMarkdown(report));
      return 0;
    };
    if (logsFile) {
      const doc = parseDocument(readFileSync(logsFile, 'utf8'), logsFile);
      const entries = (Array.isArray(doc) ? doc : (doc as { entries?: unknown }).entries) as RetrievalLogEntry[] | undefined;
      const memories = (doc as { memories?: { id: string; workspaceId: string; content: string; sourceRefs?: string[] }[] }).memories ?? [];
      if (!Array.isArray(entries)) throw new GoldenSetError(`${logsFile}: expected an array of retrieval log entries or { entries, memories }`);
      const byId = new Map(memories.map((m) => [m.id, m]));
      return hydrateAndReport(
        entries,
        async (_workspaceId, ids) =>
          ids.flatMap((id) => {
            const m = byId.get(id);
            return m ? [{ id, content: m.content, sourceRefs: m.sourceRefs ?? [], tokens: Math.ceil(m.content.length / 4) + 4 }] : [];
          }),
        `exported log ${logsFile}`
      );
    }
    // Read-only: the retrieval log and the memory store of the configured deployment.
    const config = loadConfigFromEnvironment({ serviceName: 'memory-eval' });
    const logger = createLogger({ service: config.service.name, level: process.env['LOG_LEVEL'] ? config.log.level : 'warn', env: config.env, pretty: false });
    const runtime = await createRuntime(config, { service: 'memory-eval', logger, needs: { retrieval: true } });
    try {
      const limit = numberFlag(a, 'limit') ?? 1000;
      const workspaces = [...new Set([golden.workspace, ...golden.queries.map((q) => q.workspace)])];
      const entries = (await Promise.all(workspaces.map((w) => runtime.logStore.list(w, { limit })))).flat();
      return await hydrateAndReport(
        entries,
        async (workspaceId, ids) => {
          const memories = await runtime.store.getMemories(workspaceId, ids);
          const byId = new Map(memories.map((m) => [m.id, m]));
          return ids.flatMap((id) => {
            const m = byId.get(id);
            return m ? [{ id, content: m.content, sourceRefs: m.sourceRefs.map((s) => s.ref), tokens: runtime.tokens.count(m.content) + 4 }] : [];
          });
        },
        `retrieval_log of the configured deployment, workspace ${golden.workspace}`
      );
    } finally {
      await runtime.close();
    }
  }

  const baselineSpec = r.config.shadow?.baseline ?? r.profiles[0];
  const candidateSpec = one(a, 'candidate') ?? r.config.shadow?.candidate ?? r.profiles[1];
  if (!baselineSpec || !candidateSpec) throw new GoldenSetError('shadow needs a served profile and a shadow profile: pass two --profile values or --candidate=<spec>');
  const baseline = typeof baselineSpec === 'string' ? loadProfile(baselineSpec) : baselineSpec;
  const candidate = typeof candidateSpec === 'string' ? loadProfile(candidateSpec) : candidateSpec;
  const { report } = await runShadowEvaluation({ golden, baseline, candidate, ...(r.k ? { k: r.k } : {}) });
  writeOutputs(a, io, report, renderShadowMarkdown(report));
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runCli(process.argv.slice(2), {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
  );
}
