/* eslint-disable no-console -- command-line output is the point of this file */
import { createLogger, loadConfigFromEnvironment, type RetrievalService } from '@smallseedlabs/proba-memory-core';
import { createRetrievalService, createRuntime } from '@smallseedlabs/proba-memory-adapters';

/**
 * Search the memory store from the command line, in process (no HTTP, no sign-in): for operators and
 * local runs. Prints the query, every candidate with its features, and the final order.
 *
 *   npm run search -- "what does the user think about discount banners"
 *   npm run search -- --workspace=seedbed --limit=5 --json "countdown timer"
 */
interface Args {
  query: string;
  workspace?: string;
  limit?: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { query: '', json: false };
  const words: string[] = [];
  for (const a of argv) {
    if (a === '--json') args.json = true;
    else if (a.startsWith('--workspace=')) args.workspace = a.slice('--workspace='.length);
    else if (a.startsWith('--limit=')) args.limit = Number(a.slice('--limit='.length));
    else words.push(a);
  }
  args.query = words.join(' ').trim();
  return args;
}

const f = (n: number | null | undefined, d = 3): string => (n === null || n === undefined ? '  -  ' : n.toFixed(d));

export function formatSearch(query: string, response: Awaited<ReturnType<RetrievalService['search']>>): string {
  const lines: string[] = [];
  lines.push(`query: ${JSON.stringify(query)}`);
  lines.push(`profile: ${response.profile.name} v${response.profile.version} (${response.profile.served})   retrieval ${response.retrievalId}`);
  lines.push(
    `candidates: vector ${response.stats.vectorCandidates}, text ${response.stats.textCandidates}, fused ${response.stats.fused}, scored ${response.stats.scored}   returned ${response.stats.returned}, ${response.stats.tokensUsed}/${response.stats.tokenBudget} tokens${response.stats.degraded.length ? `   degraded: ${response.stats.degraded.join(',')}` : ''}`
  );
  lines.push('');
  lines.push('candidates (best score first)');
  lines.push('  id        category    vec(rank,sim)  fts(rank)  fused   relev  recen  impor  confi  usefu   age(d)  score   outcome');
  const candidates = [...(response.candidates ?? [])].sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    const outcome = c.selected ? `#${c.position}` : `dropped: ${c.droppedReason ?? '-'}`;
    lines.push(
      `  ${c.id.slice(0, 8)}  ${c.category.padEnd(10)}  ${String(c.vectorRank ?? '-').padStart(3)},${f(c.vectorSimilarity)}    ${String(c.ftsRank ?? '-').padStart(3)}      ${f(c.fusedScore, 4)}  ${f(c.features.relevance, 2)}   ${f(c.features.recency, 2)}   ${f(c.features.importance, 2)}   ${f(c.features.confidence, 2)}   ${f(c.features.usefulness, 2)}   ${f(c.features.ageDays, 1).padStart(6)}  ${f(c.score)}  ${outcome}`
    );
  }
  lines.push('');
  lines.push('final order');
  response.results.forEach((r, i) => lines.push(`  ${i + 1}. [${r.category}] score ${f(r.score)}  ${r.content}`));
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error('usage: search [--workspace=<id>] [--limit=<n>] [--json] <query>');
    process.exit(2);
  }
  const config = loadConfigFromEnvironment({ serviceName: 'memory-search-cli' });
  const logger = createLogger({ service: config.service.name, level: process.env.LOG_LEVEL ? config.log.level : 'warn', env: config.env, pretty: false });
  const runtime = await createRuntime(config, { service: 'memory-api', logger, needs: { embedder: true, retrieval: true, llm: config.retrieval.rerankEnabled } });
  try {
    await runtime.profiles.ensureDefault();
    const retrieval = createRetrievalService(runtime);
    const workspaceId = args.workspace ?? config.api.workspaceId;
    const response = await retrieval.search(
      { workspaceId, actor: { type: 'user', id: 'operator-cli' }, traceId: runtime.ids.uuid(), includeCandidates: true },
      { query: args.query, ...(args.limit ? { limit: args.limit } : {}) }
    );
    console.log(args.json ? JSON.stringify(response, null, 2) : formatSearch(args.query, response));
    // The memory.retrieved audit event is committed to the outbox with the log row; the next running
    // relay (memory-api, memory-ingestor or memory-jobs) publishes it to the bus.
  } finally {
    await runtime.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
