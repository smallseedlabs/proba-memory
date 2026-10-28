/**
 * Context bridge authentication ports: the two credentials a `context-reader` call carries.
 *
 * - The SERVICE TOKEN proves who is calling: the context bridge (EdDSA JWT, iss `proba-context`, aud `proba-memory`).
 * - The ACT-AS ASSERTION proves for whom: the user, goal and workspace the Hub vouches for (EdDSA JWT, iss `proba-hub`,
 *   protocol `ActAsAssertionClaims`), sent as `X-Act-As`.
 *
 * Both reject with a TokenVerificationError; any other error is an outage.
 */

import type { ActAsAssertionClaims } from '@smallseedlabs/proba-protocol';

/** The role name, the service token subject and the actor id its reads are audited under. */
export const CONTEXT_READER_ROLE = 'context-reader';
export const CONTEXT_SERVICE_ISSUER = 'proba-context';
/** Audience of the service token, and the audience an act-as assertion must list for this API. */
export const CONTEXT_MEMORY_AUDIENCE = 'proba-memory';
export const ACT_AS_ISSUER = 'proba-hub';
/** A service token lives at most two minutes (exp - iat). */
export const CONTEXT_SERVICE_TOKEN_MAX_TTL_SECONDS = 120;
/** Clock difference tolerated when checking exp, nbf and iat of either token. */
export const CONTEXT_CLOCK_SKEW_SECONDS = 30;
/** Request header that carries the assertion. */
export const ACT_AS_HEADER = 'x-act-as';

export interface ContextServiceToken {
  /** Unique id of this token (jti). */
  jti: string;
  /** Key id that verified it. */
  keyId: string;
  expiresAt: Date;
}

export interface ContextServiceVerifier {
  /** Short name for logs and audit events. */
  readonly name: string;
  /** Whether the token claims to come from the bridge (decided from its unverified issuer only; `verify` decides the rest). */
  claimsToBeBridge(token: string): boolean;
  verify(token: string): Promise<ContextServiceToken>;
}

export interface ActAsVerifier {
  verify(token: string): Promise<ActAsAssertionClaims>;
}

export interface ContextBridgeAuth {
  service: ContextServiceVerifier;
  assertions: ActAsVerifier;
}

export type { ActAsAssertionClaims };
