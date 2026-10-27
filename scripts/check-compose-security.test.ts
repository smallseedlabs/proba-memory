import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The checker is a plain .mjs script (CI runs it directly); load it dynamically.
const checker = (await import(resolve(__dirname, 'check-compose-security.mjs'))) as {
  checkComposeText: (text: string) => { violations: string[]; required: string[] };
};
const composePath = resolve(__dirname, '../docker-compose.yml');
const hasDocker = spawnSync('docker', ['compose', 'version']).status === 0;

// Each script run starts several `docker compose config` processes; give them room on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

describe('check-compose-security (static checks)', () => {
  it('the repository docker-compose.yml passes', () => {
    const { violations, required } = checker.checkComposeText(readFileSync(composePath, 'utf8'));
    expect(violations).toEqual([]);
    expect(required).toEqual(expect.arrayContaining(['POSTGRES_PASSWORD', 'REDIS_PASSWORD']));
  });

  const check = (env: string) => checker.checkComposeText(`services:\n  s:\n    image: x\n    environment:\n${env}\n`).violations;

  it('refuses a password with a default value', () => {
    expect(check('      DB_PASSWORD: ${DB_PASSWORD:-proba}')).toEqual([expect.stringContaining('has a default')]);
    expect(check('      DB_PASSWORD: ${DB_PASSWORD-proba}')).toEqual([expect.stringContaining('has a default')]);
  });

  it('refuses an empty default too: a password variable has to be required', () => {
    expect(check('      DB_PASSWORD: ${DB_PASSWORD:-}')).toEqual([expect.stringContaining('has a default')]);
  });

  it('refuses a literal password', () => {
    expect(check('      POSTGRES_PASSWORD: proba')).toEqual([expect.stringContaining('not a required variable')]);
    expect(check('      ANCHOR_HMAC_KEY: abcdef')).toEqual([expect.stringContaining('not a required variable')]);
  });

  it('refuses a literal password inside a URL, with or without a defaulted user', () => {
    expect(check('      REDIS_URL: redis://proba:secret@redis:6379')).toEqual([expect.stringContaining('literal password')]);
    expect(check('      REDIS_URL: redis://${REDIS_USER:-proba}:secret@redis:6379')).toEqual([expect.stringContaining('literal password')]);
    expect(check('      DB_URL: ${DB_URL:-postgresql://a:literal@db:5432/x}')).toEqual([expect.stringContaining('literal password')]);
  });

  it('accepts required variables, in values and inside URLs', () => {
    expect(check('      DB_PASSWORD: ${DB_PASSWORD:?set DB_PASSWORD}')).toEqual([]);
    expect(check('      REDIS_URL: redis://${REDIS_USER:-proba}:${REDIS_PASSWORD:?set REDIS_PASSWORD}@redis:6379')).toEqual([]);
    expect(check('      DB_URL: ${DB_URL:-postgresql://a:${DB_PASSWORD:?set DB_PASSWORD}@db:5432/x}')).toEqual([]);
  });

  it('lets an optional provider key stay empty but never carry a value', () => {
    expect(check('      LLM_API_KEY: ${LLM_API_KEY:-}')).toEqual([]);
    expect(check('      MEMORY_API_STATIC_TOKENS: ${MEMORY_API_STATIC_TOKENS:-}')).toEqual([]);
    expect(check('      LLM_API_KEY: ${LLM_API_KEY:-sk-abc}')).toEqual([expect.stringContaining('non-empty default')]);
    expect(check('      LLM_API_KEY: sk-abc')).toEqual([expect.stringContaining('not a required variable')]);
  });

  it('does not mistake non-secrets for secrets', () => {
    expect(check('      MEMORY_API_TOKEN_VERIFIER: ${MEMORY_API_TOKEN_VERIFIER:-firebase}\n      LOG_LEVEL: ${LOG_LEVEL:-info}')).toEqual([]);
  });
});

describe.skipIf(!hasDocker)('check-compose-security (the script, on resolved compose files)', () => {
  const run = (compose: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-test-'));
    const file = join(dir, 'docker-compose.yml');
    writeFileSync(file, compose);
    return spawnSync('node', [resolve(__dirname, 'check-compose-security.mjs'), file], { encoding: 'utf8' });
  };
  const good = `services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
    ports:
      - "127.0.0.1:5432:5432"
`;

  it('passes the repository docker-compose.yml', () => {
    const r = spawnSync('node', [resolve(__dirname, 'check-compose-security.mjs'), composePath], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('passes a minimal compliant file', () => {
    expect(run(good).status).toBe(0);
  });

  it.each([
    ['a port bound to all interfaces', good.replace('127.0.0.1:5432:5432', '5432:5432'), /port 5432:5432 is bound to 0\.0\.0\.0/],
    ['a port bound to a LAN address', good.replace('127.0.0.1:', '0.0.0.0:'), /is bound to 0\.0\.0\.0/],
    ['a long-syntax port without a host ip', good.replace('- "127.0.0.1:5432:5432"', '- target: 5432\n        published: 5432'), /bound to/],
    ['a password with a default', good.replace(':?set POSTGRES_PASSWORD', ':-proba'), /has a default/],
    ['a literal password', good.replace('${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}', 'proba'), /not a required variable/],
    ['host networking', good.replace('    image', '    network_mode: host\n    image'), /network_mode host/],
  ])('fails on %s', (_name, compose, message) => {
    const r = run(compose);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(message);
  });
});
