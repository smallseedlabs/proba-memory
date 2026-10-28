import { errors as joseErrors, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { actAsAssertionClaimsSchema } from '@smallseedlabs/proba-protocol';
import {
  ACT_AS_ISSUER,
  CONTEXT_MEMORY_AUDIENCE,
  CONTEXT_CLOCK_SKEW_SECONDS,
  CONTEXT_READER_ROLE,
  CONTEXT_SERVICE_ISSUER,
  CONTEXT_SERVICE_TOKEN_MAX_TTL_SECONDS,
  TokenVerificationError,
  type ActAsAssertionClaims,
  type ActAsVerifier,
  type AppConfig,
  type ContextBridgeAuth,
  type ContextServiceToken,
  type ContextServiceVerifier,
} from '@smallseedlabs/proba-memory-core';
import { loadPublicKeySet } from './public-key-set.js';

const MAX_TOKEN_LENGTH = 8192;
const MAX_JTI_LENGTH = 128;

export interface BridgeVerifierOptions {
  keys: JWTVerifyGetKey;
  /** Clock override. */
  now?: () => Date;
}

/** Header shape and key id: both tokens are addressed to a key by `kid` and nothing else. */
function checkShape(token: string, what: string): void {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || token.split('.').length !== 3) {
    throw new TokenVerificationError('invalid_token', `Malformed ${what}`);
  }
  let kid: unknown;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new TokenVerificationError('invalid_token', `Malformed ${what}`);
  }
  if (typeof kid !== 'string' || kid === '') throw new TokenVerificationError('invalid_token', `${what} names no key id`);
}

/** Maps a jose failure to the port's error: expiry is told apart, an unexpected (non-JOSE) failure is an outage and rethrown. */
function rejection(error: unknown, what: string): never {
  if (error instanceof joseErrors.JWTExpired) throw new TokenVerificationError('token_expired', `${what} has expired`);
  if (!(error instanceof joseErrors.JOSEError)) throw error;
  throw new TokenVerificationError('invalid_token', `${what} rejected: ${error.message}`);
}

const isPositiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** The unverified payload of a JWT, or undefined when it is not one. Used only to pick which verifier to ask. */
function peekPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The bridge's service token: EdDSA, iss `proba-context`, aud `proba-memory`, sub `context-reader`, a `jti`, and a lifetime of at
 * most two minutes. Verified against the public keys in CONTEXT_SERVICE_PUBLIC_KEY_FILE.
 */
export class ContextServiceTokenVerifier implements ContextServiceVerifier {
  readonly name = 'context-service';
  private readonly keys: JWTVerifyGetKey;
  private readonly now: () => Date;

  constructor(options: BridgeVerifierOptions) {
    this.keys = options.keys;
    this.now = options.now ?? (() => new Date());
  }

  claimsToBeBridge(token: string): boolean {
    return peekPayload(token)?.iss === CONTEXT_SERVICE_ISSUER;
  }

  async verify(token: string): Promise<ContextServiceToken> {
    checkShape(token, 'service token');
    const currentDate = this.now();
    let payload: JWTPayload;
    let keyId: string;
    try {
      const result = await jwtVerify(token, this.keys, {
        algorithms: ['EdDSA'],
        issuer: CONTEXT_SERVICE_ISSUER,
        audience: CONTEXT_MEMORY_AUDIENCE,
        subject: CONTEXT_READER_ROLE,
        clockTolerance: CONTEXT_CLOCK_SKEW_SECONDS,
        currentDate,
        requiredClaims: ['exp', 'iat', 'sub', 'jti'],
      });
      payload = result.payload;
      keyId = result.protectedHeader.kid as string;
    } catch (error) {
      return rejection(error, 'Service token');
    }
    const { jti, iat, exp } = payload;
    const nowSec = Math.floor(currentDate.getTime() / 1000);
    if (typeof jti !== 'string' || jti === '' || jti.length > MAX_JTI_LENGTH) throw new TokenVerificationError('invalid_token', 'Service token has an invalid jti');
    if (!isPositiveNumber(iat) || !isPositiveNumber(exp) || exp <= iat) throw new TokenVerificationError('invalid_token', 'Service token has invalid iat or exp');
    if (exp - iat > CONTEXT_SERVICE_TOKEN_MAX_TTL_SECONDS) {
      throw new TokenVerificationError('invalid_token', `Service token lives longer than ${CONTEXT_SERVICE_TOKEN_MAX_TTL_SECONDS} seconds`);
    }
    if (iat > nowSec + CONTEXT_CLOCK_SKEW_SECONDS) throw new TokenVerificationError('invalid_token', 'Service token was issued in the future');
    return { jti, keyId, expiresAt: new Date(exp * 1000) };
  }
}

/**
 * The Hub's act-as assertion (`X-Act-As`): EdDSA, iss `proba-hub`, aud listing `proba-memory`, and the claims of the protocol's
 * ActAsAssertionClaims (user in `sub`, `workspaceId`, `goalId`, `threadId`, `scopes`, `jti`, a lifetime of at most five minutes).
 * Verified against the public keys in HUB_ASSERTION_PUBLIC_KEY_FILE.
 */
export class ActAsAssertionVerifier implements ActAsVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly now: () => Date;

  constructor(options: BridgeVerifierOptions) {
    this.keys = options.keys;
    this.now = options.now ?? (() => new Date());
  }

  async verify(token: string): Promise<ActAsAssertionClaims> {
    checkShape(token, 'act-as assertion');
    const currentDate = this.now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        algorithms: ['EdDSA'],
        issuer: ACT_AS_ISSUER,
        audience: CONTEXT_MEMORY_AUDIENCE,
        clockTolerance: CONTEXT_CLOCK_SKEW_SECONDS,
        currentDate,
        requiredClaims: ['exp', 'iat', 'sub', 'jti'],
      }));
    } catch (error) {
      return rejection(error, 'Act-as assertion');
    }
    const claims = actAsAssertionClaimsSchema.safeParse(payload);
    if (!claims.success) throw new TokenVerificationError('invalid_token', 'Act-as assertion claims are not valid');
    if (claims.data.jti.length > MAX_JTI_LENGTH) throw new TokenVerificationError('invalid_token', 'Act-as assertion has an invalid jti');
    if (claims.data.iat > Math.floor(currentDate.getTime() / 1000) + CONTEXT_CLOCK_SKEW_SECONDS) {
      throw new TokenVerificationError('invalid_token', 'Act-as assertion was issued in the future');
    }
    return claims.data;
  }
}

/**
 * The credentials of the `context-reader` role, or null when the role is off. Both key files are read here, at start-up: a
 * missing or unusable file stops the process instead of leaving the role half configured.
 */
export async function createContextBridgeAuth(config: AppConfig, options: { now?: () => Date } = {}): Promise<ContextBridgeAuth | null> {
  const { contextReader } = config.api;
  if (!contextReader.enabled) return null;
  if (config.isProduction && config.adapters.tokenVerifier === 'static') {
    throw new Error('MEMORY_API_TOKEN_VERIFIER=static is not available when NODE_ENV=production');
  }
  // One after the other, so a problem is always reported for the same file first.
  const service = await loadPublicKeySet(contextReader.serviceKeyFile, { envName: 'CONTEXT_SERVICE_PUBLIC_KEY_FILE', nodeEnv: config.env });
  const assertions = await loadPublicKeySet(contextReader.assertionKeyFile, { envName: 'HUB_ASSERTION_PUBLIC_KEY_FILE', nodeEnv: config.env });
  if (config.isProduction && service.publicKeys.some((x) => assertions.publicKeys.includes(x))) {
    throw new Error('CONTEXT_SERVICE_PUBLIC_KEY_FILE and HUB_ASSERTION_PUBLIC_KEY_FILE list the same key: the bridge and the Hub never share a key');
  }
  return {
    service: new ContextServiceTokenVerifier({ keys: service.keys, ...(options.now ? { now: options.now } : {}) }),
    assertions: new ActAsAssertionVerifier({ keys: assertions.keys, ...(options.now ? { now: options.now } : {}) }),
  };
}
