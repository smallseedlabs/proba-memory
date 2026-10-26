import { describe, expect, it } from 'vitest';
import type { VerifiedIdentity } from '@smallseedlabs/proba-memory-core';
import { authorize, type AccessPolicy } from './authorization.js';

const identity = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  subject: 'uid-1',
  email: 'ana@example.com',
  emailVerified: true,
  name: null,
  provider: 'password',
  authTime: new Date(),
  ...over,
});
const policy: AccessPolicy = { allowedEmails: ['ana@example.com'], allowedEmailDomains: ['corp.example'], adminEmails: ['root@example.com'] };

describe('authorize', () => {
  it('gives viewers from the allow-list and allowed domains, admins from the admin list', () => {
    expect(authorize(identity(), policy, 'ws')).toEqual({ ok: true, session: { subject: 'uid-1', email: 'ana@example.com', role: 'viewer', workspaceId: 'ws' } });
    expect(authorize(identity({ email: 'bo@corp.example' }), policy, 'ws')).toMatchObject({ ok: true, session: { role: 'viewer' } });
    expect(authorize(identity({ email: 'root@example.com' }), policy, 'ws')).toMatchObject({ ok: true, session: { role: 'admin' } });
  });

  it('matches case-insensitively and puts the workspace from config into the session', () => {
    expect(authorize(identity({ email: 'ANA@Example.COM' }), policy, 'acme')).toMatchObject({ ok: true, session: { email: 'ana@example.com', workspaceId: 'acme' } });
    expect(authorize(identity({ email: 'Root@EXAMPLE.com' }), policy, 'ws')).toMatchObject({ ok: true, session: { role: 'admin' } });
  });

  it('requires a verified email even for listed addresses', () => {
    expect(authorize(identity({ emailVerified: false }), policy, 'ws')).toEqual({ ok: false, reason: 'email_not_verified' });
    expect(authorize(identity({ email: null }), policy, 'ws')).toEqual({ ok: false, reason: 'email_required' });
  });

  it('denies everything else, including look-alike domains, and denies all with an empty policy', () => {
    expect(authorize(identity({ email: 'eve@evil.example' }), policy, 'ws')).toEqual({ ok: false, reason: 'not_allowed' });
    expect(authorize(identity({ email: 'eve@notcorp.example' }), policy, 'ws')).toEqual({ ok: false, reason: 'not_allowed' });
    expect(authorize(identity({ email: 'eve@corp.example.evil.com' }), policy, 'ws')).toEqual({ ok: false, reason: 'not_allowed' });
    expect(authorize(identity(), { allowedEmails: [], allowedEmailDomains: [], adminEmails: [] }, 'ws')).toEqual({ ok: false, reason: 'not_allowed' });
  });
});
