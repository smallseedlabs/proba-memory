/* eslint-disable no-console -- command-line output is the point of this file */
import { readFileSync } from 'node:fs';
import { createLogger, GLOBAL_WORKSPACE, loadConfigFromEnvironment, M2_JOB_NAMES } from '@smallseedlabs/proba-memory-core';
import { createRuntime } from '@smallseedlabs/proba-memory-adapters';
import { defaultJobConfig, isM2JobName, JOB_CONFIG_SPECS } from './job-configs.js';

const USAGE = `usage:
  npm run job-config -- seed                                   publish the built-in defaults as version 1 where no version exists
  npm run job-config -- show <job> [--workspace <id>]          the active version (the workspace's own, else the global one)
  npm run job-config -- history <job> [--workspace <id>]       every version of the workspace's (or the global) config
  npm run job-config -- publish <job> <file.json> [--workspace <id>] [--note <text>]
jobs: ${M2_JOB_NAMES.join(', ')}
Without --workspace, publish writes the global version (workspace "*"). A version is immutable: publishing retires the previous one.`;

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Operator tool for the versioned job rules. The jobs only ever read them; this is how a new version is written. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, job] = argv;
  if (!command || command === '--help' || !['seed', 'show', 'history', 'publish'].includes(command)) {
    console.error(USAGE);
    process.exit(command === '--help' ? 0 : 2);
  }
  if (command !== 'seed' && (!job || !isM2JobName(job))) {
    console.error(`unknown or missing job\n${USAGE}`);
    process.exit(2);
  }
  const config = loadConfigFromEnvironment({ serviceName: 'memory-jobs-cli', defaultPort: 0 });
  const logger = createLogger({ service: config.service.name, level: config.log.level, env: config.env, pretty: false });
  const runtime = await createRuntime(config, { service: 'memory-jobs', logger, needs: { jobs: true } });
  const workspace = option(argv, '--workspace') ?? GLOBAL_WORKSPACE;
  const by = `cli:${process.env.USER ?? 'operator'}`;
  try {
    if (command === 'seed') {
      for (const name of M2_JOB_NAMES) {
        const r = await runtime.jobConfigs.publish({ workspaceId: GLOBAL_WORKSPACE, jobName: name, config: defaultJobConfig(name), note: 'seeded from the built-in defaults', createdBy: 'system:defaults', at: runtime.clock.isoNow(), onlyIfAbsent: true });
        console.log(JSON.stringify({ job: name, workspaceId: r.workspaceId, version: r.version, status: r.status }));
      }
    } else if (command === 'show') {
      const r = await runtime.jobConfigs.resolve(workspace, job);
      console.log(r ? JSON.stringify(r, null, 2) : `no config for ${job}; the first run seeds the defaults (or run: seed)`);
    } else if (command === 'history') {
      console.log(JSON.stringify(await runtime.jobConfigs.list(workspace, job), null, 2));
    } else {
      const file = argv[2];
      if (!file) {
        console.error(USAGE);
        process.exit(2);
      }
      const parsed = JOB_CONFIG_SPECS[job as keyof typeof JOB_CONFIG_SPECS].schema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (!parsed.success) {
        console.error(`invalid ${job} config:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
        process.exit(2);
      }
      const r = await runtime.jobConfigs.publish({ workspaceId: workspace, jobName: job, config: parsed.data as Record<string, unknown>, note: option(argv, '--note') ?? '', createdBy: by, at: runtime.clock.isoNow() });
      console.log(JSON.stringify({ job, workspaceId: r.workspaceId, version: r.version, status: r.status }));
    }
  } finally {
    await runtime.close();
  }
}

main().catch((err) => {
  console.error('fatal: job-config failed', err);
  process.exit(1);
});
