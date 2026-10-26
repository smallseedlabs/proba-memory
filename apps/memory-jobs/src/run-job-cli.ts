/* eslint-disable no-console -- command-line output is the point of this file */
import { pathToFileURL } from 'node:url';
import { createLogger, loadConfigFromEnvironment } from '@smallseedlabs/proba-memory-core';
import { createRuntime } from '@smallseedlabs/proba-memory-adapters';
import { createJobDeps, createJobs, JOB_NAMES, jobNeeds } from './jobs/index.js';
import { createJobRunner } from './runner.js';

export interface CliArgs {
  name: string | undefined;
  dryRun: boolean;
  workspaceId: string | undefined;
  help: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { name: undefined, dryRun: false, workspaceId: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--workspace') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) return { ...args, error: '--workspace needs a workspace id' };
      args.workspaceId = value;
      i += 1;
    } else if (a.startsWith('--')) return { ...args, error: `unknown option ${a}` };
    else if (args.name === undefined) args.name = a;
    else return { ...args, error: `unexpected argument ${a}` };
  }
  return args;
}

const USAGE = `usage: npm run job -- <name> [--dry-run] [--workspace <id>]
  jobs: ${JOB_NAMES.join(', ')}
  --dry-run          compute and report what would change; write nothing
  --workspace <id>   run for this workspace only (default: every workspace)`;

/**
 * Run one job once, for every workspace (or one), right now:
 *
 *   npm run job -- consolidate --dry-run
 *   npm run job -- decay
 *
 * Takes the same lease as the scheduled run, so it never overlaps one in progress.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.error || !args.name || !JOB_NAMES.includes(args.name)) {
    if (args.error) console.error(args.error);
    else if (args.name && !JOB_NAMES.includes(args.name)) console.error(`unknown job "${args.name}"`);
    console.error(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  const names = [args.name];
  const config = loadConfigFromEnvironment({ serviceName: 'memory-jobs-cli', defaultPort: 0 });
  const logger = createLogger({ service: config.service.name, level: config.log.level, env: config.env, pretty: false });
  const runtime = await createRuntime(config, { service: 'memory-jobs', logger, needs: jobNeeds(names) });
  try {
    // The job must be runnable even when JOBS_ENABLED does not list it.
    const job = createJobs({ ...config, jobs: { ...config.jobs, enabled: names } }, 'memory-jobs', createJobDeps(runtime, names)).at(0)!;
    const relay = runtime.createRelay();
    const runs = await createJobRunner(runtime).runJob(job, 'manual', { dryRun: args.dryRun || undefined, ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}) });
    // Publish what the run recorded before exiting.
    if (relay && !(args.dryRun || config.jobs.dryRun)) {
      relay.start();
      await new Promise((r) => setTimeout(r, Math.min(2000, config.audit.relay.pollIntervalMs * 2)));
      await relay.stop();
    }
    for (const run of runs) {
      console.log(
        JSON.stringify({ job: run.jobName, workspaceId: run.workspaceId, status: run.status, dryRun: args.dryRun || config.jobs.dryRun, processed: run.processed, changed: run.changed, details: run.details, error: run.error ?? undefined })
      );
    }
    if (runs.length === 0) console.log(JSON.stringify({ job: args.name, runs: 0, note: 'no workspace to run (none exists, or another run holds the lease)' }));
    if (runs.some((r) => r.status === 'failed')) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

// Only run when executed, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('fatal: job failed', err);
    process.exit(1);
  });
}
