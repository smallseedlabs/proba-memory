import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { assertUniqueWindows, makeWindow, rollingSchema, rollingWindows, windowSchema, type BacktestWindow } from './backtest.js';
import { gateConfigSchema, type GateConfig } from './gate.js';
import { GoldenSetError, parseDocument } from './golden.js';

/**
 * Optional run configuration (YAML or JSON), so CI and people run the same thing. Relative paths are resolved
 * from the directory of the config file. Command-line flags override it.
 *
 *   golden: golden/bundled.yaml
 *   baseline: baseline.json
 *   profiles: [default, profiles/candidate.yaml]     # `default` or `name=path`
 *   k: [1, 3, 5]
 *   windows: [{ replayUntil: 2026-09-20T00:00:00Z }]   # or: rolling: { from, to, stepDays, horizonDays }
 *   gate: { tolerance: 0.02, tokensMaxIncrease: 0.25 }
 */
const configSchema = z
  .object({
    golden: z.string().min(1).optional(),
    baseline: z.string().min(1).optional(),
    profiles: z.array(z.string().min(1)).optional(),
    k: z.array(z.number().int().min(1).max(50)).min(1).optional(),
    windows: z.array(windowSchema).optional(),
    rolling: rollingSchema.optional(),
    gate: gateConfigSchema.optional(),
    shadow: z.object({ baseline: z.string().min(1).optional(), candidate: z.string().min(1).optional() }).strict().optional(),
  })
  .strict();

export interface EvalConfig {
  golden?: string;
  baseline?: string;
  profiles?: string[];
  k?: number[];
  windows?: BacktestWindow[];
  gate?: GateConfig;
  shadow?: { baseline?: string; candidate?: string };
}

const isProfileAlias = (spec: string): boolean => /^[A-Za-z0-9._-]+=/.test(spec);

export function loadEvalConfig(path: string): EvalConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new GoldenSetError(`cannot read config ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = configSchema.safeParse(parseDocument(text, path));
  if (!parsed.success) {
    throw new GoldenSetError(`config ${path} is invalid:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
  }
  const c = parsed.data;
  if (c.windows && c.rolling) throw new GoldenSetError(`config ${path}: use either windows or rolling, not both`);
  const base = dirname(resolve(path));
  const rel = (p: string): string => resolve(base, p);
  // A profile spec is `default`, `name=default`, a path or `name=path`; only the path part is relative.
  const relProfile = (spec: string): string => {
    const alias = isProfileAlias(spec) ? spec.slice(0, spec.indexOf('=')) : null;
    const ref = alias ? spec.slice(alias.length + 1) : spec;
    const target = ref === 'default' ? ref : rel(ref);
    return alias ? `${alias}=${target}` : target;
  };
  const windows = c.windows ? c.windows.map((w) => makeWindow(w)) : c.rolling ? rollingWindows(c.rolling) : undefined;
  return {
    ...(c.golden ? { golden: rel(c.golden) } : {}),
    ...(c.baseline ? { baseline: rel(c.baseline) } : {}),
    ...(c.profiles ? { profiles: c.profiles.map(relProfile) } : {}),
    ...(c.k ? { k: c.k } : {}),
    ...(windows ? { windows: assertUniqueWindows(windows) } : {}),
    ...(c.gate ? { gate: c.gate } : {}),
    ...(c.shadow
      ? { shadow: { ...(c.shadow.baseline ? { baseline: relProfile(c.shadow.baseline) } : {}), ...(c.shadow.candidate ? { candidate: relProfile(c.shadow.candidate) } : {}) } }
      : {}),
  };
}
