/**
 * TokenVerifier port: turns the bearer token a client presents into a verified identity.
 *
 * It answers "who is this?" only. Whether that person may use the API, and with which role,
 * is decided afterwards by the authorization layer from configuration.
 */

export interface VerifiedIdentity {
  /** Stable subject id of the identity provider (Firebase uid). */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  /** Sign-in method reported by the provider, for example "password" or "google.com". */
  provider: string | null;
  authTime: Date;
}

export type TokenErrorCode = 'invalid_token' | 'token_expired';

export class TokenVerificationError extends Error {
  constructor(
    readonly code: TokenErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

export interface TokenVerifier {
  /** Resolves with the identity, or rejects with a TokenVerificationError. Any other error is an outage. */
  verify(token: string): Promise<VerifiedIdentity>;
  /** Short adapter name for logs, for example "firebase". */
  readonly name: string;
}
