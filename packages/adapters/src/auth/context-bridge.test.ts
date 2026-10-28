import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, TokenVerificationError } from '@smallseedlabs/proba-memory-core';
import { ActAsAssertionVerifier, ContextServiceTokenVerifier, createContextBridgeAuth } from './context-bridge-verifiers.js';
import { PublicKeyFileError, loadPublicKeySet } from './public-key-set.js';
import { createContextBridgeSigners, createTokenSigner, type ContextBridgeSigners, type TokenSigner } from './context-bridge-testing.js';

let signers: ContextBridgeSigners;
let service: ContextServiceTokenVerifier;
let assertions: ActAsAssertionVerifier;
let dir: string;

beforeAll(async () => {
  signers = await createContextBridgeSigners();
  dir = await mkdtemp(join(tmpdir(), 'proba-bridge-test-'));
  const serviceKeys = await loadPublicKeySet(await signers.service.writeJwks(dir), { envName: 'CONTEXT_SERVICE_PUBLIC_KEY_FILE', nodeEnv: 'test' });
  const hubKeys = await loadPublicKeySet(await signers.hub.writeJwks(dir), { envName: 'HUB_ASSERTION_PUBLIC_KEY_FILE', nodeEnv: 'test' });
  service = new ContextServiceTokenVerifier({ keys: serviceKeys.keys });
  assertions = new ActAsAssertionVerifier({ keys: hubKeys.keys });
});

async function rejection(run: Promise<unknown>): Promise<TokenVerificationError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(TokenVerificationError);
  return error as TokenVerificationError;
}

describe('ContextServiceTokenVerifier', () => {
  it('accepts a token from the bridge and reports its id and key', async () => {
    const token = await signers.mintServiceToken({ jti: 'svc-1' });
    expect(service.claimsToBeBridge(token)).toBe(true);
    await expect(service.verify(token)).resolves.toMatchObject({ jti: 'svc-1', keyId: 'bridge-key-1' });
  });

  it('only claims tokens whose issuer is the bridge', async () => {
    expect(service.claimsToBeBridge(await signers.mintServiceToken({ iss: 'someone-else' }))).toBe(false);
    for (const bad of ['', 'abc', 'a.b.c', 'a.e30.c']) expect(service.claimsToBeBridge(bad)).toBe(false);
  });

  it('rejects the wrong issuer, audience and subject', async () => {
    expect((await rejection(service.verify(await signers.mintServiceToken({ iss: 'proba-hub' })))).message).toMatch(/iss/);
    expect((await rejection(service.verify(await signers.mintServiceToken({ aud: 'proba-audit' })))).message).toMatch(/aud/);
    expect((await rejection(service.verify(await signers.mintServiceToken({ sub: 'admin' })))).message).toMatch(/sub/);
  });

  it('rejects expiry, a lifetime over two minutes, a missing jti and a future iat', async () => {
    expect((await rejection(service.verify(await signers.mintServiceToken({ iatOffset: -300, expOffset: -200 })))).code).toBe('token_expired');
    await expect(service.verify(await signers.mintServiceToken({ iatOffset: -60, expOffset: -10 }))).resolves.toBeTruthy(); // 30s skew
    expect((await rejection(service.verify(await signers.mintServiceToken({ ttl: 121 })))).message).toMatch(/longer than 120/);
    await expect(service.verify(await signers.mintServiceToken({ ttl: 120 }))).resolves.toBeTruthy();
    expect((await rejection(service.verify(await signers.mintServiceToken({ jti: null })))).code).toBe('invalid_token');
    expect((await rejection(service.verify(await signers.mintServiceToken({ iatOffset: 120, ttl: 60 })))).code).toBe('invalid_token');
  });

  it('rejects a foreign key, the Hub key, tampering, no kid, HS256 and malformed input', async () => {
    const foreign = await createTokenSigner('bridge-key-1');
    expect((await rejection(service.verify(await signers.mintServiceToken({}, foreign)))).code).toBe('invalid_token');
    expect((await rejection(service.verify(await signers.mintServiceToken({}, signers.hub)))).code).toBe('invalid_token');
    const token = await signers.mintServiceToken();
    const [h, p, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), jti: 'other' })).toString('base64url');
    expect((await rejection(service.verify(`${h}.${forged}.${sig}`))).code).toBe('invalid_token');
    const noKid = await signers.service.sign({ iss: 'proba-context', aud: 'proba-memory', sub: 'context-reader', jti: 'x', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 }, { kid: undefined });
    expect((await rejection(service.verify(noKid))).message).toMatch(/key id/);
    const none = `${Buffer.from('{"alg":"none","kid":"bridge-key-1"}').toString('base64url')}.${p}.`;
    expect((await rejection(service.verify(none))).code).toBe('invalid_token');
    const hs = `${Buffer.from('{"alg":"HS256","kid":"bridge-key-1"}').toString('base64url')}.${p}.${sig}`;
    expect((await rejection(service.verify(hs))).code).toBe('invalid_token');
    for (const bad of ['not-a-jwt', '', 'a.b', 'x'.repeat(9000) + '.b.c']) expect((await rejection(service.verify(bad))).code).toBe('invalid_token');
  });
});

describe('ActAsAssertionVerifier', () => {
  it('accepts an assertion from the Hub and returns the protocol claims', async () => {
    const goalId = '770e8400-e29b-41d4-a716-446655440002';
    const claims = await assertions.verify(await signers.mintAssertion({ sub: 'user-1', workspaceId: 'ws-1', goalId, jti: 'a-1' }));
    expect(claims).toMatchObject({ iss: 'proba-hub', sub: 'user-1', workspaceId: 'ws-1', goalId, jti: 'a-1', scopes: ['context:build'] });
  });

  it('requires proba-memory among the audiences', async () => {
    await expect(assertions.verify(await signers.mintAssertion({ aud: ['proba-context', 'proba-audit', 'proba-memory'] }))).resolves.toBeTruthy();
    expect((await rejection(assertions.verify(await signers.mintAssertion({ aud: ['proba-context', 'proba-audit'] })))).message).toMatch(/aud/);
  });

  it('rejects another issuer, expiry, a lifetime over five minutes, a future iat and a not-yet-valid assertion', async () => {
    expect((await rejection(assertions.verify(await signers.mintAssertion({ iss: 'proba-context' })))).message).toMatch(/iss/);
    expect((await rejection(assertions.verify(await signers.mintAssertion({ iatOffset: -400, expOffset: -100 })))).code).toBe('token_expired');
    await expect(assertions.verify(await signers.mintAssertion({ iatOffset: -60, expOffset: -10 }))).resolves.toBeTruthy(); // 30s skew
    expect((await rejection(assertions.verify(await signers.mintAssertion({ iatOffset: -60, expOffset: -40 })))).code).toBe('token_expired');
    expect((await rejection(assertions.verify(await signers.mintAssertion({ ttl: 301 })))).message).toMatch(/not valid/);
    expect((await rejection(assertions.verify(await signers.mintAssertion({ iatOffset: 120, ttl: 60 })))).code).toBe('invalid_token');
    expect((await rejection(assertions.verify(await signers.mintAssertion({ nbfOffset: 120 })))).code).toBe('invalid_token');
  });

  it('rejects claims the protocol schema refuses and the bridge key', async () => {
    expect((await rejection(assertions.verify(await signers.mintAssertion({ goalId: 'not-a-uuid' })))).code).toBe('invalid_token');
    expect((await rejection(assertions.verify(await signers.mintAssertion({ scopes: [] })))).code).toBe('invalid_token');
    expect((await rejection(assertions.verify(await signers.mintAssertion({}, signers.service)))).code).toBe('invalid_token');
  });
});

describe('loadPublicKeySet', () => {
  const load = (file: string, nodeEnv = 'test') => loadPublicKeySet(file, { envName: 'KEYS', nodeEnv });
  const writeKeys = async (keys: unknown, name = `keys-${Math.random().toString(16).slice(2)}.json`): Promise<string> => {
    const file = join(dir, name);
    await writeFile(file, typeof keys === 'string' ? keys : JSON.stringify(keys));
    return file;
  };
  const okKey = (signer: TokenSigner = signers.service) => signer.jwks.keys[0];

  it('loads several keys by kid', async () => {
    const second = await createTokenSigner('bridge-key-2');
    const set = await load(await writeKeys({ keys: [okKey(), okKey(second)] }));
    expect(set.keyIds).toEqual(['bridge-key-1', 'bridge-key-2']);
  });

  it('refuses a missing file, bad JSON, no keys and keys of another type', async () => {
    await expect(load(join(dir, 'missing.json'))).rejects.toThrow(/cannot read/);
    await expect(load('')).rejects.toThrow(/no file/);
    await expect(load(await writeKeys('not json'))).rejects.toThrow(/not a JSON Web Key Set/);
    await expect(load(await writeKeys({ keys: [] }))).rejects.toThrow(/lists no keys/);
    await expect(load(await writeKeys({ keys: [{ kty: 'RSA', n: 'x', e: 'AQAB', kid: 'a' }] }))).rejects.toThrow(/Ed25519 public key/);
    await expect(load(dir)).rejects.toThrow(/not a file/);
  });

  it('refuses private key material, a missing or repeated kid, and another alg', async () => {
    await expect(load(await writeKeys({ keys: [{ ...okKey(), d: 'c2VjcmV0' }] }))).rejects.toThrow(/private key material/);
    await expect(load(await writeKeys({ keys: [{ ...okKey(), kid: undefined }] }))).rejects.toThrow(/no kid/);
    await expect(load(await writeKeys({ keys: [okKey(), okKey()] }))).rejects.toThrow(/listed twice/);
    await expect(load(await writeKeys({ keys: [{ ...okKey(), alg: 'RS256' }] }))).rejects.toThrow(/only EdDSA/);
  });

  it('in production wants an absolute path and a file others cannot write', async () => {
    const file = await writeKeys({ keys: [okKey()] }, 'production-keys.json');
    await chmod(file, 0o644);
    await expect(load(file, 'production')).resolves.toBeTruthy();
    await expect(load('relative/keys.json', 'production')).rejects.toThrow(/absolute path/);
    await chmod(file, 0o666);
    await expect(load(file, 'production')).rejects.toBeInstanceOf(PublicKeyFileError);
    await expect(load(file, 'production')).rejects.toThrow(/writable by group or others/);
    await expect(load(file, 'test')).resolves.toBeTruthy();
  });
});

describe('createContextBridgeAuth', () => {
  const env = (extra: Record<string, string>) => loadConfig({ NODE_ENV: 'test', MEMORY_API_TOKEN_VERIFIER: 'static', ...extra }, { serviceName: 'memory-api' });

  it('is off unless enabled', async () => {
    await expect(createContextBridgeAuth(env({}))).resolves.toBeNull();
    const files = { CONTEXT_SERVICE_PUBLIC_KEY_FILE: await signers.service.writeJwks(dir), HUB_ASSERTION_PUBLIC_KEY_FILE: await signers.hub.writeJwks(dir) };
    await expect(createContextBridgeAuth(env(files))).resolves.toBeNull();
  });

  it('cannot be enabled without both key files', () => {
    expect(() => env({ MEMORY_API_CONTEXT_READER_ENABLED: 'true' })).toThrow(/CONTEXT_SERVICE_PUBLIC_KEY_FILE: required/);
    expect(() => env({ MEMORY_API_CONTEXT_READER_ENABLED: 'true', CONTEXT_SERVICE_PUBLIC_KEY_FILE: '/x/a.json' })).toThrow(/HUB_ASSERTION_PUBLIC_KEY_FILE: required/);
  });

  it('verifies both credentials once enabled', async () => {
    const config = env({
      MEMORY_API_CONTEXT_READER_ENABLED: 'true',
      CONTEXT_SERVICE_PUBLIC_KEY_FILE: await signers.service.writeJwks(dir),
      HUB_ASSERTION_PUBLIC_KEY_FILE: await signers.hub.writeJwks(dir),
    });
    const auth = await createContextBridgeAuth(config);
    expect(auth).not.toBeNull();
    await expect(auth!.service.verify(await signers.mintServiceToken())).resolves.toBeTruthy();
    await expect(auth!.assertions.verify(await signers.mintAssertion())).resolves.toBeTruthy();
  });

  describe('in production', () => {
    const prod = (extra: Record<string, string>) =>
      loadConfig(
        {
          NODE_ENV: 'production',
          MEMORY_API_TOKEN_VERIFIER: 'firebase',
          FIREBASE_PROJECT_ID: 'proba-prod',
          MEMORY_API_CONTEXT_READER_ENABLED: 'true',
          ...extra,
        },
        { serviceName: 'memory-api' }
      );

    it('refuses relative paths, one file for both keys and the static verifier', async () => {
      const a = await signers.service.writeJwks(dir);
      const b = await signers.hub.writeJwks(dir);
      expect(() => prod({ CONTEXT_SERVICE_PUBLIC_KEY_FILE: 'keys/a.json', HUB_ASSERTION_PUBLIC_KEY_FILE: b })).toThrow(/absolute path/);
      expect(() => prod({ CONTEXT_SERVICE_PUBLIC_KEY_FILE: a, HUB_ASSERTION_PUBLIC_KEY_FILE: a })).toThrow(/different files/);
      expect(() => prod({ CONTEXT_SERVICE_PUBLIC_KEY_FILE: a, HUB_ASSERTION_PUBLIC_KEY_FILE: b, MEMORY_API_TOKEN_VERIFIER: 'static' })).toThrow(/static is not available/);
      expect(() => prod({ CONTEXT_SERVICE_PUBLIC_KEY_FILE: a, HUB_ASSERTION_PUBLIC_KEY_FILE: b })).not.toThrow();
    });

    it('refuses the same key listed for the bridge and for the Hub', async () => {
      const a = await signers.service.writeJwks(dir);
      const same = await writeFile(join(dir, 'same-key.json'), JSON.stringify(signers.service.jwks)).then(() => join(dir, 'same-key.json'));
      await chmod(a, 0o644);
      await chmod(same, 0o644);
      await expect(createContextBridgeAuth(prod({ CONTEXT_SERVICE_PUBLIC_KEY_FILE: a, HUB_ASSERTION_PUBLIC_KEY_FILE: same }))).rejects.toThrow(/list the same key/);
    });

    it('refuses an unreadable or group-writable key file at start-up', async () => {
      const a = await signers.service.writeJwks(dir);
      const b = await signers.hub.writeJwks(dir);
      await chmod(b, 0o664);
      await expect(createContextBridgeAuth(prod({ CONTEXT_SERVICE_PUBLIC_KEY_FILE: a, HUB_ASSERTION_PUBLIC_KEY_FILE: b }))).rejects.toThrow(/HUB_ASSERTION_PUBLIC_KEY_FILE.*writable/);
      await expect(createContextBridgeAuth(prod({ CONTEXT_SERVICE_PUBLIC_KEY_FILE: join(dir, 'gone.json'), HUB_ASSERTION_PUBLIC_KEY_FILE: b }))).rejects.toThrow(/CONTEXT_SERVICE_PUBLIC_KEY_FILE: cannot read/);
    });
  });
});
