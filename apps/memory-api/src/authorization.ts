import type { VerifiedIdentity } from '@smallseedlabs/proba-memory-core';

export type Role = 'viewer' | 'admin';

/** The authenticated, authorised caller. The workspace is decided here, from configuration, never by the request. */
export interface Session {
  subject: string;
  email: string;
  role: Role;
  workspaceId: string;
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
