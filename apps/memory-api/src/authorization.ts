import { CONTEXT_READER_ROLE, type ActAsAssertionClaims, type VerifiedIdentity } from '@smallseedlabs/proba-memory-core';

export type Role = 'viewer' | 'admin' | typeof CONTEXT_READER_ROLE;

/** Who a `context-reader` call acts for, as the Hub's assertion states it. */
export interface ActAs {
  /** The user (assertion `sub`). */
  actorId: string;
  workspaceId: string;
  goalId: string;
  threadId: string;
  /** Id of the assertion. */
  jti: string;
}

/** The authenticated, authorised caller. The workspace is decided here, from configuration or the assertion, never by the request. */
export interface Session {
  subject: string;
  email: string;
  role: Role;
  workspaceId: string;
  /** `context-reader` only: the user and workspace the call acts for, and the ids of the two tokens it carried. */
  actAs?: ActAs;
  tokenJti?: string;
}

/**
 * The routes the `context-reader` role may call: search, one memory by id and the scoring profiles, all limited to what the user may
 * read. Keys are `METHOD route-pattern` as Fastify reports them. Everything else (listing, retrieval logs, job runs, the session)
 * answers 403 to this role.
 */
export const CONTEXT_READER_ROUTES: ReadonlySet<string> = new Set(['POST /v1/memories/search', 'GET /v1/memories/:id', 'GET /v1/profiles']);

export function sessionFromAssertion(assertion: ActAsAssertionClaims, tokenJti: string): Session {
  return {
    subject: CONTEXT_READER_ROLE,
    email: '',
    role: CONTEXT_READER_ROLE,
    workspaceId: assertion.workspaceId,
    actAs: { actorId: assertion.sub, workspaceId: assertion.workspaceId, goalId: assertion.goalId, threadId: assertion.threadId, jti: assertion.jti },
    tokenJti,
  };
}

export interface AccessPolicy {
  /** Lower-case emails that may use the API (role viewer). */
  allowedEmails: readonly string[];
  /** Lower-case email domains that may use the API (role viewer). */
  allowedEmailDomains: readonly string[];
  /** Lower-case emails that may use the API as admin. */
  adminEmails: readonly string[];
}

export type DenialReason = 'email_required' | 'email_not_verified' | 'not_allowed';

export type Authorization = { ok: true; session: Session } | { ok: false; reason: DenialReason };

/**
 * The authorisation layer: which verified identities may use the API, and with which role.
 *
 * - The email must be present AND verified by the identity provider (an unverified address proves
 *   nothing about who owns it), whichever list it is matched against.
 * - `admin` when the email is in the admin list; otherwise `viewer` when the email is in the
 *   allow-list or its domain is an allowed domain; otherwise denied.
 * - Everything comes from configuration. An empty policy allows nobody.
 */
export function authorize(identity: VerifiedIdentity, policy: AccessPolicy, workspaceId: string): Authorization {
  if (!identity.email) return { ok: false, reason: 'email_required' };
  if (!identity.emailVerified) return { ok: false, reason: 'email_not_verified' };
  const email = identity.email.trim().toLowerCase();
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const admin = policy.adminEmails.includes(email);
  const viewer = policy.allowedEmails.includes(email) || policy.allowedEmailDomains.includes(domain);
  if (!admin && !viewer) return { ok: false, reason: 'not_allowed' };
  return { ok: true, session: { subject: identity.subject, email, role: admin ? 'admin' : 'viewer', workspaceId } };
}
