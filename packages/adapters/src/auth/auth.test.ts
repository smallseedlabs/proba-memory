import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet } from 'jose';
import { TokenVerificationError } from '@smallseedlabs/proba-memory-core';
import { FIREBASE_JWKS_URL, FirebaseTokenVerifier } from './firebase-token-verifier.js';
import { createFakeFirebaseIssuer, type FakeFirebaseIssuer } from './firebase-testing.js';
import { StaticTokenVerifier } from './static-token-verifier.js';

const PROJECT = 'proba-unit';
let issuer: FakeFirebaseIssuer;
let verifier: FirebaseTokenVerifier;

beforeAll(async () => {
  issuer = await createFakeFirebaseIssuer(PROJECT);
  verifier = new FirebaseTokenVerifier({ projectId: PROJECT, keys: issuer.keys });
});

async function rejection(token: string, v: FirebaseTokenVerifier = verifier): Promise<TokenVerificationError> {
  const error = await v.verify(token).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(TokenVerificationError);
  return error as TokenVerificationError;
}

describe('FirebaseTokenVerifier (same checks as proba-hub)', () => {
  it('accepts a valid token and maps the identity', async () => {
    const identity = await verifier.verify(await issuer.mint({ uid: 'abc123', email: 'Ana@Example.com', name: 'Ana Example', provider: 'google.com' }));
    expect(identity).toMatchObject({ subject: 'abc123', email: 'Ana@Example.com', emailVerified: true, name: 'Ana Example', provider: 'google.com' });
    expect(identity.authTime.getTime()).toBeLessThanOrEqual(Date.now());
    expect(verifier.name).toBe('firebase');
  });

  it('reports unverified emails and missing names and emails', async () => {
    const unverified = await verifier.verify(await issuer.mint({ emailVerified: false }));
    expect(unverified.emailVerified).toBe(false);
    expect(unverified.name).toBeNull();
    expect((await verifier.verify(await issuer.mint({ email: null }))).email).toBeNull();
  });

  it('rejects another project (aud), the wrong issuer, expiry, future times and an empty subject', async () => {
    expect((await rejection(await issuer.mint({ aud: 'someone-else' }))).message).toMatch(/aud/);
    expect((await rejection(await issuer.mint({ iss: 'https://securetoken.google.com/someone-else' }))).message).toMatch(/iss/);
    expect((await rejection(await issuer.mint({ iatOffset: -7200, expOffset: -3600 }))).code).toBe('token_expired');
    await expect(verifier.verify(await issuer.mint({ expOffset: -2 }))).resolves.toBeTruthy(); // small skew is tolerated
    expect((await rejection(await issuer.mint({ expOffset: -30 }))).code).toBe('token_expired');
    expect((await rejection(await issuer.mint({ omitAuthTime: true }))).code).toBe('invalid_token');
    expect((await rejection(await issuer.mint({ authTimeOffset: 600 }))).message).toMatch(/auth_time/);
    expect((await rejection(await issuer.mint({ iatOffset: 600 }))).code).toBe('invalid_token');
    expect((await rejection(await issuer.mint({ sub: '' }))).code).toBe('invalid_token');
  });

  it('rejects a foreign key, tampering, malformed input, alg none and HS256', async () => {
    expect((await rejection(await issuer.mint({ foreignKey: true }))).code).toBe('invalid_token');
    const token = await issuer.mint({ uid: 'victim' });
    const [h, p, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as object;
    const forged = Buffer.from(JSON.stringify({ ...payload, sub: 'attacker' })).toString('base64url');
    expect((await rejection(`${h}.${forged}.${sig}`)).code).toBe('invalid_token');
    for (const bad of ['not-a-jwt', '', 'a.b', 'x'.repeat(9000) + '.b.c']) expect((await rejection(bad)).code).toBe('invalid_token');
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const claims = enc({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'x', iat: now, exp: now + 3600, auth_time: now });
    expect((await rejection(`${enc({ alg: 'none' })}.${claims}.`)).code).toBe('invalid_token');
    expect((await rejection(`${enc({ alg: 'HS256', kid: issuer.jwks.keys[0].kid })}.${claims}.c2ln`)).code).toBe('invalid_token');
  });

  it('requires a project id', () => {
    expect(() => new FirebaseTokenVerifier({ projectId: ' ', keys: createLocalJWKSet({ keys: [] }) })).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('fetches Googles public keys by default (mocked fetch, no network) and caches them', async () => {
    const fetchJwks = vi.fn(async (_url: string) => new Response(JSON.stringify(issuer.jwks), { status: 200, headers: { 'content-type': 'application/json' } }));
    const remote = new FirebaseTokenVerifier({ projectId: PROJECT, fetchJwks });
    expect((await remote.verify(await issuer.mint({ uid: 'remote-user' }))).subject).toBe('remote-user');
    expect(String(fetchJwks.mock.calls[0][0])).toBe(FIREBASE_JWKS_URL);
    await remote.verify(await issuer.mint());
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it('treats an unreachable key endpoint as an outage, not as a bad token', async () => {
    const fetchJwks = vi.fn(async () => new Response('nope', { status: 500 }));
    const remote = new FirebaseTokenVerifier({ projectId: PROJECT, fetchJwks });
    const error = await remote.verify(await issuer.mint()).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TokenVerificationError);
  });
});

describe('StaticTokenVerifier', () => {
  const tokens = [{ token: 'token-for-ana-0001', subject: 'ana', email: 'ana@example.com', emailVerified: true }];

  it('maps a known token to its identity and rejects any other', async () => {
    const v = new StaticTokenVerifier({ tokens, nodeEnv: 'test' });
    expect(await v.verify('token-for-ana-0001')).toMatchObject({ subject: 'ana', email: 'ana@example.com', emailVerified: true, provider: 'static' });
    for (const bad of ['token-for-ana-0002', 'token-for-ana-000', '', 'x'.repeat(5000)]) {
      await expect(v.verify(bad)).rejects.toBeInstanceOf(TokenVerificationError);
    }
  });

  it('refuses to exist in production', () => {
    expect(() => new StaticTokenVerifier({ tokens, nodeEnv: 'production' })).toThrow(/not available when NODE_ENV=production/);
    expect(() => new StaticTokenVerifier({ tokens, nodeEnv: 'development' })).not.toThrow();
  });
});
