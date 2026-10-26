import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

const file = readFileSync(fileURLToPath(new URL('../../../../.env.example', import.meta.url)), 'utf8');

describe('.env.example', () => {
  const values = parse(file);

  it('is a valid configuration for a development run, with the documented defaults', () => {
    const config = loadConfig(values, { serviceName: 'memory-api' });
    expect(config.adapters).toMatchObject({ memoryStore: 'postgres', vectorIndex: 'postgres', eventBus: 'redis-streams', llmProvider: 'deepseek', embedder: 'openai-compatible' });
    expect(config.isProduction).toBe(false);
  });

  it('holds placeholders only: no keys, tokens or real credentials', () => {
    expect(values.LLM_API_KEY).toBe('');
    expect(values.EMBEDDER_API_KEY).toBe('');
    expect(values.DATABASE_URL).toContain('CHANGE_ME');
    expect(file).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(file).not.toMatch(/\bBearer\s+\S{12,}/);
  });

  it('names every setting the loader reads, so nothing is undocumented', () => {
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    const read = new Set([...source.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*(?:z\.|nonEmpty|positiveInt|nonNegativeInt|unit|bool)/gm)].map((m) => m[1]));
    const documented = new Set([...file.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    const missing = [...read].filter((k) => !documented.has(k));
    // Tuning knobs that only matter in unusual deployments may stay out of the example.
    const optional = /^(PORT|SERVICE_NAME|CONSUMER_NAME|BUS_|OUTBOX_RELAY_|EMBEDDER_(TIMEOUT|BATCH|MAX|SEND)|LLM_(TIMEOUT|MAX|TEMPERATURE)|DEV_CONTENT_|CONTENT_POLL|EXTRACTION_|MEMORY_MAX|INGEST_(RECLAIM|RETRY)|SIGNAL_|MEMORY_API_(RATE|SEARCH|AUTH|TRUST)|DECAY_(BATCH|IMPORTANCE_HALF|MIN)|JOB_LEASE|PG_MIGRATIONS|REDIS_|RETRIEVAL_MAX_QUERY)/;
    expect(missing.filter((k) => !optional.test(k))).toEqual([]);
  });
});
