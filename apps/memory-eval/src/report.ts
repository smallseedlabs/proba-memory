import { compareProfiles, type MetricDelta, type ProfileComparison } from './compare.js';
import type { GateResult } from './gate.js';
import { flatten } from './metrics.js';
import { headlineK, type EvalRunReport, type ProfileReport } from './run.js';
import type { ShadowReport } from './shadow.js';

/** The machine-readable report: the run plus the comparison of every profile with the baseline profile. */
export interface ComparisonReport extends EvalRunReport {
  baselineProfile: string;
  comparisons: ProfileComparison[];
}

export function buildComparisonReport(run: EvalRunReport, baselineName?: string): ComparisonReport {
  const comparisons = run.profiles.length > 1 ? compareProfiles(run, baselineName) : [];
  return { ...run, baselineProfile: baselineName ?? (run.profiles[0] as ProfileReport).name, comparisons };
}

const num = (n: number, digits = 3): string => n.toFixed(digits);
const signed = (n: number, digits = 3): string => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
const cell = (s: string): string => s.replace(/\|/g, '\\|');
const table = (header: string[], rows: string[][]): string => {
  const line = (cells: string[]): string => `| ${cells.map(cell).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
};

const isSize = (m: string): boolean => m.startsWith('tokens');
const isLatency = (m: string): boolean => m.startsWith('latencyMs');
const fmt = (metric: string, v: number): string => (isSize(metric) ? v.toFixed(1) : isLatency(metric) ? `${v.toFixed(2)} ms` : v.toFixed(3));
const fmtDelta = (m: MetricDelta): string => {
  const d = isSize(m.metric) ? m.delta.toFixed(1) : isLatency(m.metric) ? `${m.delta.toFixed(2)} ms` : signed(m.delta);
  return `${m.delta > 0 && !d.startsWith('+') ? '+' : ''}${d}`;
};

/** Metric names in reading order: ranking, avoid, tokens, latency. */
function metricOrder(profile: ProfileReport): string[] {
  const names = Object.keys(flatten(profile.summary));
  const rank = (m: string): number => (m.startsWith('avoidRate') ? 1 : isSize(m) ? 2 : isLatency(m) ? 3 : 0);
  return names.sort((a, b) => rank(a) - rank(b));
}

export function renderComparisonMarkdown(report: ComparisonReport): string {
  const out: string[] = [];
  const k = headlineK(report);
  const base = report.profiles.find((p) => p.name === report.baselineProfile) as ProfileReport;
  out.push(`# Memory evaluation: ${report.golden.name}`);
  out.push('');
  out.push(
    `- Mode: **${report.mode}**. Golden set \`${report.golden.name}\` (digest \`${report.golden.digest.slice(0, 12)}\`): ${report.golden.observations} observations, ${report.golden.queries} queries, workspace \`${report.golden.workspace}\`.`
  );
  out.push(`- Embedder \`${report.environment.embedder}\`, LLM \`${report.environment.llm}\` (in-process, no network). Headline cut-off: **k = ${k}**.`);
  out.push(`- Baseline profile: **${base.name}**.${report.profiles.length > 1 ? ' Candidates are compared with it.' : ''}`);
  out.push('');
  out.push('## Metrics');
  out.push('');
  const candidates = report.profiles.filter((p) => p !== base);
  // One value column and one delta + verdict column per candidate.
  const head = ['Metric', base.name, ...candidates.flatMap((c) => [c.name, `Δ vs ${base.name}`])];
  const rows = metricOrder(base).map((metric) => {
    const baseValue = flatten(base.summary)[metric];
    const cells = [`\`${metric}\``, baseValue ? fmt(metric, baseValue.value) : '-'];
    for (const c of candidates) {
      const delta = report.comparisons.find((x) => x.candidate === c.name)?.metrics.find((m) => m.metric === metric);
      const value = flatten(c.summary)[metric];
      cells.push(value ? fmt(metric, value.value) : '-');
      cells.push(delta ? `${fmtDelta(delta)} (${delta.verdict})` : '-');
    }
    return cells;
  });
  out.push(table(head, rows));
  out.push('');
  out.push(
    `Scored queries: ${base.summary.scoredQueries}${base.summary.avoidOnlyQueries ? `, avoid-only: ${base.summary.avoidOnlyQueries}` : ''}. Latency is wall time of an in-process retrieval and varies between runs: it is shown, never judged.`
  );

  if (report.mode === 'backtest') {
    out.push('');
    out.push('## Time-split windows');
    out.push('');
    out.push(`Each window replays observations up to the split time T on an empty store, then asks the queries after T. Cells show \`ndcg@${k}\` / \`recall@${k}\`.`);
    out.push('');
    const windows = base.windows ?? [];
    out.push(
      table(
        ['Window', 'Split T', 'Queries until', 'Replayed', 'Active / superseded', 'Asked', ...report.profiles.map((p) => p.name)],
        windows.map((w, i) => [
          w.name,
          w.replayUntil,
          w.queryUntil ?? 'end',
          String(w.replay.replayed),
          `${w.replay.memories} / ${w.replay.superseded}`,
          `${w.askedQueries}${w.skippedQueries.length ? ` (${w.skippedQueries.length} skipped: nothing known yet)` : ''}`,
          ...report.profiles.map((p) => {
            const s = p.windows?.[i]?.summary;
            return s && s.scoredQueries > 0 ? `${num(s.ranking[`ndcg@${k}`] ?? 0)} / ${num(s.ranking[`recall@${k}`] ?? 0)}` : 'no scored queries';
          }),
        ])
      )
    );
  }

  for (const cmp of report.comparisons) {
    out.push('');
    out.push(`## Query changes: ${cmp.candidate} vs ${cmp.baseline}`);
    out.push('');
    out.push(`${cmp.counts.improved} improved, ${cmp.counts.regressed} regressed, ${cmp.counts.unchanged} unchanged (by \`ndcg@${k}\`, then reciprocal rank).`);
    if (cmp.queries.length > 0) {
      out.push('');
      out.push(
        table(
          ['Query', 'Window', 'Change', `First hit (${cmp.baseline} → ${cmp.candidate})`, `recall@${k}`, `ndcg@${k}`],
          cmp.queries.map((q) => [
            `\`${q.id}\``,
            q.window ?? '-',
            q.change,
            `${q.baseline.firstRelevantRank ?? 'none'} → ${q.candidate.firstRelevantRank ?? 'none'}`,
            `${num(q.baseline.recall)} → ${num(q.candidate.recall)}`,
            `${num(q.baseline.ndcg)} → ${num(q.candidate.ndcg)}`,
          ])
        )
      );
    }
  }

  for (const profile of report.profiles) {
    out.push('');
    out.push(`## Queries: ${profile.name}`);
    out.push('');
    out.push(
      table(
        ['Query', 'Window', 'First hit', `recall@${k}`, `precision@${k}`, `ndcg@${k}`, 'RR', 'Tokens', 'Notes'],
        profile.queries.map((q) => {
          const at = q.metrics.byK[k];
          const first = q.results.find((r) => r.relevant)?.rank;
          const notes: string[] = [];
          if (q.targets > 0 && (at?.recall ?? 0) < 1) notes.push('missed an expected memory');
          if ((at?.avoidViolation ?? 0) > 0) notes.push('returned an avoided memory');
          if (q.leftOutTargets.length > 0) notes.push(`${q.leftOutTargets.length} target(s) not yet known`);
          if (q.degraded.length > 0) notes.push(`degraded: ${q.degraded.join(',')}`);
          return [
            `\`${q.id}\``,
            q.window ?? '-',
            q.targets === 0 ? '-' : first ? String(first) : 'none',
            q.targets === 0 ? '-' : num(at?.recall ?? 0),
            q.targets === 0 ? '-' : num(at?.precision ?? 0),
            q.targets === 0 ? '-' : num(at?.ndcg ?? 0),
            q.metrics.reciprocalRank === null ? '-' : num(q.metrics.reciprocalRank),
            String(q.metrics.tokens),
            notes.join('; '),
          ];
        })
      )
    );
  }

  out.push('');
  out.push('## Profiles');
  out.push('');
  out.push(table(['Profile', 'Config digest', 'Description'], report.profiles.map((p) => [p.name, `\`${p.configDigest.slice(0, 12)}\``, p.description || '-'])));
  out.push('');
  out.push(READING_GUIDE(k));
  return `${out.join('\n')}\n`;
}

const READING_GUIDE = (k: number): string =>
  [
    '## How to read this',
    '',
    `- **recall@${k}**: share of the expected memories (targets) that appear in the top ${k}. **precision@${k}**: relevant memories in the top ${k} divided by ${k} (so a query with one target cannot score above ${(1 / k).toFixed(2)}; compare profiles, not the absolute value).`,
    `- **ndcg@${k}**: ranking quality with graded relevance, 1.0 is the ideal order. **mrr**: mean of 1 / rank of the first relevant memory (0 when none).`,
    '- **avoidRate@k**: share of queries that returned something listed under `avoid` (an outdated or unwanted memory) in the top k. Lower is better.',
    '- **tokens**: size of the packed result in tokens (the cost of putting it in a prompt). Lower is cheaper, but only when the quality metrics hold.',
    '- Δ is candidate minus baseline. "better" and "worse" account for the direction of the metric. A difference on a small golden set can be one query; look at **Query changes** before believing an average.',
  ].join('\n');

export function renderGateMarkdown(result: GateResult, context: { golden: string; baselineFile?: string }): string {
  const out: string[] = [];
  const label = { pass: 'PASS', regression: 'FAIL: regression', stale: 'FAIL: stale baseline', unknown_profile: 'FAIL: profile missing from the baseline' }[result.status];
  out.push(`# Regression gate: ${label}`);
  out.push('');
  out.push(`Golden set \`${context.golden}\`${context.baselineFile ? `, baseline \`${context.baselineFile}\`` : ''}.`);
  if (result.problems.length > 0) {
    out.push('');
    for (const p of result.problems) out.push(`- ${p}`);
  }
  if (result.checks.length > 0) {
    out.push('');
    out.push(
      table(
        ['Profile', 'Metric', 'Baseline', 'Current', 'Δ', 'Allowed', 'Status'],
        result.checks.map((c) => [
          c.profile,
          `\`${c.metric}\``,
          fmt(c.metric, c.baseline),
          c.current === null ? 'missing' : fmt(c.metric, c.current),
          c.delta === null ? '-' : fmtDelta({ metric: c.metric, delta: c.delta } as MetricDelta),
          c.allowedKind === 'relative' ? `+${(c.allowed * 100).toFixed(0)}%` : `${c.direction === 'higher' ? '-' : '+'}${num(c.allowed)}`,
          c.status,
        ])
      )
    );
  }
  return `${out.join('\n')}\n`;
}

export function renderShadowMarkdown(report: ShadowReport): string {
  const out: string[] = [];
  const k = report.k[report.k.length - 1] as number;
  out.push(`# Shadow evaluation: ${report.golden.name}`);
  out.push('');
  out.push(`- Source: ${report.source}.`);
  out.push(`- Log entries read: ${report.entries.read}; matching a golden query: ${report.entries.matched}; with a shadow list: ${report.entries.withShadow}.`);
  if (report.versions.length > 0) out.push(`- Profile versions: ${report.versions.join('; ')}.`);
  if (report.entries.unmatchedQueries.length > 0) out.push(`- No shadow data for: ${report.entries.unmatchedQueries.map((q) => `\`${q}\``).join(', ')}.`);
  out.push('');
  out.push('The **served** list is what callers received. The **shadow** list was scored on the same candidates and only logged. Sizes are re-counted from the stored memories; there is no latency for a shadow list.');
  out.push('');
  const servedFlat = flatten(report.served);
  const shadowFlat = flatten(report.shadow);
  out.push(
    table(
      ['Metric', 'Served', 'Shadow', 'Δ shadow − served'],
      report.comparison
        .filter((m) => !isLatency(m.metric))
        .map((m) => [`\`${m.metric}\``, fmt(m.metric, servedFlat[m.metric]?.value ?? 0), fmt(m.metric, shadowFlat[m.metric]?.value ?? 0), `${fmtDelta(m)} (${m.verdict})`])
    )
  );
  out.push('');
  out.push(`Agreement: ${Object.entries(report.agreement.overlap).map(([key, v]) => `${key} ${num(v)}`).join(', ')}, same first result ${num(report.agreement.topOneSame)}.`);
  if (report.queries.length > 0) {
    out.push('');
    out.push(
      table(
        ['Query', 'Served v', 'Shadow v', `ndcg@${k} served`, `ndcg@${k} shadow`],
        report.queries.map((q) => [`\`${q.id}\``, String(q.servedVersion), String(q.shadowVersion), q.servedNdcg === null ? '-' : num(q.servedNdcg), q.shadowNdcg === null ? '-' : num(q.shadowNdcg)])
      )
    );
  }
  out.push('');
  out.push('Promote a shadow version to canary only when it is not worse on the metrics above on a golden set that covers your real questions, and the agreement is what you expect from the change.');
  return `${out.join('\n')}\n`;
}
