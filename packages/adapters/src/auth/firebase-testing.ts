import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose';
import { firebaseIssuer } from './firebase-token-verifier.js';

/**
 * Stand-in for Google's securetoken signer in automated checks: a locally generated RS256 key pair, its
 * JWKS, and a helper that mints Firebase-shaped ID tokens. No network access. (Same idea as
 * proba-hub's src/auth/firebase-testing.ts.)
 */
export interface FakeFirebaseIssuer {
  projectId: string;
  jwks: { keys: JWK[] };
  keys: JWTVerifyGetKey;
  mint: (options?: MintOptions) => Promise<string>;
}

export interface MintOptions {
  uid?: string;
  email?: string | null;
  emailVerified?: boolean;
  name?: string;
  provider?: string;
  aud?: string;
  iss?: string;
  sub?: string;
  /** Seconds relative to now. */
  iatOffset?: number;
  expOffset?: number;
  authTimeOffset?: number;
  omitAuthTime?: boolean;
  /** Sign with a key whose kid is not in the JWKS. */
  foreignKey?: boolean;
}

export async function createFakeFirebaseIssuer(projectId = 'proba-unit'): Promise<FakeFirebaseIssuer> {
  const kid = randomUUID();
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const foreign = await generateKeyPair('RS256');
  const jwks = { keys: [publicJwk] };

  const mint = async (o: MintOptions = {}): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const uid = o.uid ?? `uid-${randomUUID()}`;
    const claims: Record<string, unknown> = {
      firebase: { sign_in_provider: o.provider ?? 'password', identities: {} },
      email_verified: o.emailVerified ?? true,
      user_id: uid,
    };
    if (o.email !== null) claims.email = o.email ?? `${uid}@example.com`;
    if (o.name) claims.name = o.name;
    if (!o.omitAuthTime) claims.auth_time = now + (o.authTimeOffset ?? -60);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuer(o.iss ?? firebaseIssuer(projectId))
      .setAudience(o.aud ?? projectId)
      .setSubject(o.sub ?? uid)
      .setIssuedAt(now + (o.iatOffset ?? -30))
      .setExpirationTime(now + (o.expOffset ?? 3600))
      .sign(o.foreignKey ? foreign.privateKey : privateKey);
  };

  return { projectId, jwks, keys: createLocalJWKSet(jwks), mint };
}
