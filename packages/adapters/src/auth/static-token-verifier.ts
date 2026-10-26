import { timingSafeEqual } from 'node:crypto';
import { TokenVerificationError, type StaticTokenEntry, type TokenVerifier, type VerifiedIdentity } from '@smallseedlabs/proba-memory-core';

export interface StaticTokenVerifierOptions {
  tokens: readonly StaticTokenEntry[];
  /** NODE_ENV. The static verifier refuses to exist in production. */
  nodeEnv: string;
}

/**
 * TokenVerifier for automated checks and local runs: a fixed table of opaque tokens, no network and
 * no keys. It is a stand-in for the identity provider, not an authentication scheme, so it refuses
 * to start when NODE_ENV=production. Everything after verification (authorisation, audit, rate
 * limits) is exactly the same as with the Firebase adapter.
 */
export class StaticTokenVerifier implements TokenVerifier {
  readonly name = 'static';

  constructor(private readonly options: StaticTokenVerifierOptions) {
    if (options.nodeEnv === 'production') {
      throw new Error('The static token verifier is not available when NODE_ENV=production. Set AUDIT_API_TOKEN_VERIFIER=firebase.');
    }
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    const presented = Buffer.from(token);
    let match: StaticTokenEntry | undefined;
    for (const entry of this.options.tokens) {
      const known = Buffer.from(entry.token);
      // Compare every entry in constant time, so a response time does not reveal how much of a token matched.
      if (known.length === presented.length && timingSafeEqual(known, presented)) match = entry;
    }
    if (!match) throw new TokenVerificationError('invalid_token', 'Token not recognised');
    return {
      subject: match.subject,
      email: match.email,
      emailVerified: match.emailVerified,
      name: null,
      provider: 'static',
      authTime: new Date(),
    };
  }
}
