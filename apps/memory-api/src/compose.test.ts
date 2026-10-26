import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { loadConfig } from '@smallseedlabs/proba-memory-core';

const read = (name: string): Record<string, any> => load(readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('docker-compose.local.yml', () => {
  it('gives every service a configuration the services accept (the local sign-in token included)', () => {
    const local = read('docker-compose.local.yml');
    for (const service of ['migrate', 'memory-api', 'memory-ingestor', 'memory-jobs']) {
      const env = local.services[service].environment as Record<string, string>;
      const config = loadConfig({ DATABASE_URL: 'postgresql://u:p@db:5432/x', ...env }, { serviceName: service });
      expect(config.isProduction, service).toBe(false);
    }
    const api = loadConfig({ ...(local.services['memory-api'].environment as Record<string, string>) }, { serviceName: 'memory-api' });
    expect(api.api.staticTokens).toHaveLength(1);
    expect(api.api.access.adminEmails).toContain(api.api.staticTokens[0].email.toLowerCase());
  });

  it('the base file keeps production-safe defaults: real providers, no stand-ins allowed', () => {
    const env = read('docker-compose.yml').services['memory-api'].environment as Record<string, string>;
    expect(env.NODE_ENV).toContain('production');
    expect(env.ALLOW_LOCAL_EMBEDDER).toContain('false');
    expect(env.ALLOW_SCRIPTED_LLM).toContain('false');
    expect(env.ALLOW_DEV_CONTENT_SOURCE).toContain('false');
    expect(env.MEMORY_API_TOKEN_VERIFIER).toContain('firebase');
  });
});
