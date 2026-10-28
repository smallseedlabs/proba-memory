import { spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SignJWT, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { loadPublicKeySet } from '@smallseedlabs/proba-memory-adapters';

const script = resolve(__dirname, 'generate-service-keypair.mjs');
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

describe('generate-service-keypair', () => {
  it('writes a private key for the signer and a public key set the API accepts, and the two belong together', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'proba-keygen-')), 'keys');
    const result = run('--kid', 'bridge-key-1', '--out', dir);
    expect(result.status).toBe(0);

    const pem = join(dir, 'bridge-key-1.private.pem');
    const jwks = join(dir, 'bridge-key-1.jwks.json');
    expect(statSync(pem).mode & 0o077).toBe(0);
    expect(readFileSync(jwks, 'utf8')).not.toContain('"d"');

    const set = await loadPublicKeySet(jwks, { envName: 'CONTEXT_SERVICE_PUBLIC_KEY_FILE', nodeEnv: 'production' });
    expect(set.keyIds).toEqual(['bridge-key-1']);

    const token = await new SignJWT({ sub: 'context-reader' }).setProtectedHeader({ alg: 'EdDSA', kid: 'bridge-key-1' }).sign(createPrivateKey(readFileSync(pem)));
    const verified = await jwtVerify(token, set.keys);
    expect(verified.payload.sub).toBe('context-reader');
  });

  it('refuses to replace a key unless asked, and refuses a bad kid or missing arguments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proba-keygen-'));
    expect(run('--kid', 'k1', '--out', dir).status).toBe(0);
    expect(run('--kid', 'k1', '--out', dir).status).toBe(1);
    expect(run('--kid', 'k1', '--out', dir, '--force').status).toBe(0);
    expect(run('--kid', '../x', '--out', dir).status).toBe(2);
    expect(run('--out', dir).status).toBe(2);
  });
});
