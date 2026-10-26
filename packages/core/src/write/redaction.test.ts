import { describe, expect, it } from 'vitest';
import type { Observation } from '../domain/index.js';
import { Redactor, luhnValid } from './redaction.js';

const all = new Redactor({ pii: true });
const secretsOnly = new Redactor({ pii: false });

describe('secrets (always redacted)', () => {
  const cases: [string, string, string][] = [
    ['api_key', 'use sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c for the tool', 'api_key'],
    ['api_key (pk)', 'pk_test_aaaaaaaaaaaaaaaaaaaaaaaa', 'api_key'],
    ['jwt', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk here', 'jwt'],
    ['aws_key', 'AKIAIOSFODNN7EXAMPLE', 'aws_key'],
    ['github_token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github_token'],
    ['slack_token', 'xoxb-1234567890-abcdefghij', 'slack_token'],
    ['google_key', 'AIzaSyA-1234567890abcdefghijklmnopqrstu', 'google_key'],
    ['bearer_token', 'Authorization: Bearer abcdefghijklmnop1234567890', 'bearer_token'],
    ['private_key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'private_key'],
    ['url_credentials', 'postgres://admin:hunter2secret@db.internal:5432/app', 'url_credentials'],
    ['credential', 'password = "correct-horse-battery"', 'credential'],
    ['credential (token=)', 'token=abcdef123456', 'credential'],
  ];
  it.each(cases)('%s', (_name, input, type) => {
    for (const redactor of [all, secretsOnly]) {
      const r = redactor.redact(input);
      expect(r.redactions.map((x) => x.type)).toContain(type);
      expect(r.text).toContain(`[REDACTED:`);
    }
  });

  it('keeps the surrounding text and the name of a credential, drops only its value', () => {
    expect(all.redact('The password: s3cretvalue is rotated weekly').text).toBe('The password: [REDACTED:credential] is rotated weekly');
    expect(all.redact('connect to postgres://admin:hunter2secret@db.internal/app now').text).toBe('connect to postgres://[REDACTED:url_credentials]@db.internal/app now');
    const key = all.redact('Use sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c for it');
    expect(key.text).toBe('Use [REDACTED:api_key] for it');
    expect(JSON.stringify(key)).not.toContain('4f9a8b7c');
  });

  it('redacts a private key even when its end marker is missing', () => {
    expect(all.redact('-----BEGIN PRIVATE KEY-----\nabc').text).toBe('[REDACTED:private_key]');
  });

  it('counts every occurrence', () => {
    const r = all.redact('sk-aaaaaaaaaaaaaaaaaaaa and sk-bbbbbbbbbbbbbbbbbbbb');
    expect(r.redactions).toEqual([{ type: 'api_key', count: 2 }]);
  });

  it('leaves ordinary text alone', () => {
    const text = 'The launch budget is 5000 dollars. Keep headlines under 40 characters. Ask about the token economy later.';
    expect(all.redact(text)).toEqual({ text, redactions: [] });
  });
});

describe('personal data (REDACT_PII)', () => {
  it('redacts emails, phones, cards (Luhn-valid), IBANs (checksum-valid) and SSNs when enabled', () => {
    const r = all.redact('Mail jo.marketing@example.com or call +44 7700 900123. Card 4111 1111 1111 1111, IBAN GB82 WEST 1234 5698 7654 32, SSN 123-45-6789.');
    expect(r.text).toBe('Mail [REDACTED:email] or call [REDACTED:phone]. Card [REDACTED:card], IBAN [REDACTED:iban], SSN [REDACTED:ssn].');
    expect(r.redactions.map((x) => x.type).sort()).toEqual(['card', 'email', 'iban', 'phone', 'ssn']);
  });

  it('redacts a phone number at the end of a sentence', () => {
    expect(all.redact('Call +44 7700 900123.').text).toBe('Call [REDACTED:phone].');
    expect(all.redact('Call (020) 7946 0958.').text).toContain('[REDACTED:phone]');
  });

  it('leaves personal data alone when switched off, but still redacts secrets', () => {
    const r = secretsOnly.redact('jo@example.com uses sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c');
    expect(r.text).toBe('jo@example.com uses [REDACTED:api_key]');
  });

  it('does not mistake dates, short numbers, order totals or invalid card numbers for personal data', () => {
    for (const text of ['Launch on 2026-10-26 at noon', 'Spend 12345 on prospecting', 'Order 1234567890123456 shipped', 'Version 3.14.159 released', 'Budget of 1,250,000 USD']) {
      expect(all.redact(text).text, text).toBe(text);
    }
  });

  it('validates Luhn checksums', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('123')).toBe(false);
    expect(luhnValid('abcd')).toBe(false);
  });
});

describe('properties', () => {
  const samples = [
    'sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c',
    'password=abcdef123456 and jo@example.com and +44 7700 900123',
    'plain text with nothing in it',
    'Bearer abcdefghijklmnop1234567890 and ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    '',
  ];
  it('is idempotent', () => {
    for (const s of samples) {
      const once = all.redact(s).text;
      expect(all.redact(once)).toEqual({ text: once, redactions: [] });
    }
  });
  it('never leaves a redacted value anywhere in the output', () => {
    for (const s of samples.slice(0, 2)) {
      const out = all.redact(s).text;
      expect(out).not.toMatch(/4f9a8b7c|abcdef123456|jo@example|7700 900123/);
    }
  });
  it('handles very long input quickly (no catastrophic backtracking)', () => {
    const long = 'a1 '.repeat(50_000) + 'x'.repeat(100_000) + ' 1-'.repeat(20_000);
    const t0 = Date.now();
    all.redact(long);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('redactObservation', () => {
  const base: Observation = {
    id: 'o1',
    workspaceId: 'ws',
    source: 'test',
    sourceRef: 'test:1',
    kind: 'thread.message',
    occurredAt: '2026-10-26T10:00:00.000Z',
    text: 'my key is sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c, mail jo@example.com',
    facts: { note: 'password=abcdef123456', list: ['call +44 7700 900123', 7, true], count: 3, flag: false },
    signal: { polarity: 'negative', strength: 0.5, reason: 'sent token=abcdef123456' },
    significance: 'normal',
  };

  it('redacts text, string facts, string lists and the signal reason, leaving other values and ids untouched', () => {
    const { observation, redactions } = all.redactObservation(base);
    expect(observation.text).toBe('my key is [REDACTED:api_key], mail [REDACTED:email]');
    expect(observation.facts).toEqual({ note: 'password=[REDACTED:credential]', list: ['call [REDACTED:phone]', 7, true], count: 3, flag: false });
    expect(observation.signal.reason).toBe('sent token=[REDACTED:credential]');
    expect(observation.id).toBe('o1');
    expect(observation.signal).toMatchObject({ polarity: 'negative', strength: 0.5 });
    expect(Object.fromEntries(redactions.map((r) => [r.type, r.count]))).toEqual({ api_key: 1, email: 1, credential: 2, phone: 1 });
  });

  it('does not change the input and copes with null text', () => {
    const copy = structuredClone(base);
    all.redactObservation(base);
    expect(base).toEqual(copy);
    expect(all.redactObservation({ ...base, text: null }).observation.text).toBeNull();
  });
});
