import type { FactValue, Observation } from '../domain/index.js';

/**
 * Redaction of secrets and personal data. It runs at ingestion, BEFORE anything is stored or sent to
 * an LLM, and again on what the LLM returns. It is idempotent: redacting redacted text changes nothing.
 * Patterns favour recall for secrets (always on) and precision for personal data (REDACT_PII).
 */

export interface Redaction {
  type: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
}

export interface RedactorOptions {
  /** Also redact personal data (email, phone, card, IBAN, SSN). Secrets are always redacted. */
  pii: boolean;
}

interface Rule {
  type: string;
  pattern: RegExp;
  pii: boolean;
  /** Replace only when this returns true (for example a Luhn check). */
  accept?: (match: string) => boolean;
  /** Build the replacement; default is the label. */
  replace?: (match: string, label: string, groups: string[]) => string;
}

const label = (type: string): string => `[REDACTED:${type}]`;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of value) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

const RULES: Rule[] = [
  // --- secrets (always) ---
  { type: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, pii: false },
  { type: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, pii: false },
  { type: 'aws_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, pii: false },
  { type: 'github_token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g, pii: false },
  { type: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, pii: false },
  { type: 'api_key', pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, pii: false },
  { type: 'google_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, pii: false },
  { type: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, pii: false },
  {
    type: 'url_credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    pii: false,
    replace: (_m, l, g) => `${g[0]}${l}@`,
  },
  {
    type: 'credential',
    pattern: /\b(api[_-]?key|secret|password|passwd|pwd|token|authorization|private[_-]?key)(\s*[:=]\s*)(["']?)(?!\[REDACTED)[^\s"',;]{6,}\3/gi,
    pii: false,
    replace: (_m, l, g) => `${g[0]}${g[1]}${l}`,
  },
  // --- personal data (REDACT_PII) ---
  { type: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, pii: true },
  { type: 'card', pattern: /\b(?:\d[ -]?){12,18}\d\b/g, pii: true, accept: (m) => luhnValid(m.replace(/[ -]/g, '')) },
  { type: 'iban', pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, pii: true, accept: ibanValid },
  { type: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, pii: true },
  {
    type: 'phone',
    pattern: /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}(?!\w|\.\d)/g,
    pii: true,
    accept: (m) => {
      const digits = m.replace(/\D/g, '');
      // Dates (2026-10-26) and short ids are not phone numbers.
      return digits.length >= 9 && digits.length <= 15 && !/^\d{4}-\d{2}-\d{2}$/.test(m.trim());
    },
  },
];

export class Redactor {
  constructor(private readonly options: RedactorOptions) {}

  redact(input: string): RedactionResult {
    let text = input;
    const counts = new Map<string, number>();
    for (const rule of RULES) {
      if (rule.pii && !this.options.pii) continue;
      text = text.replace(rule.pattern, (...args: unknown[]) => {
        const match = args[0] as string;
        if (rule.accept && !rule.accept(match)) return match;
        counts.set(rule.type, (counts.get(rule.type) ?? 0) + 1);
        const groups = args.slice(1, -2).filter((g): g is string => typeof g === 'string');
        return rule.replace ? rule.replace(match, label(rule.type), groups) : label(rule.type);
      });
    }
    return { text, redactions: [...counts].map(([type, count]) => ({ type, count })) };
  }

  /** Redact text, facts and (for the ids that are free text) nothing else; returns a copy and what was redacted. */
  redactObservation(observation: Observation): { observation: Observation; redactions: Redaction[] } {
    const totals = new Map<string, number>();
    const note = (r: Redaction[]): void => {
      for (const { type, count } of r) totals.set(type, (totals.get(type) ?? 0) + count);
    };
    let text = observation.text;
    if (text !== null) {
      const r = this.redact(text);
      text = r.text;
      note(r.redactions);
    }
    const facts: Record<string, FactValue> = {};
    for (const [key, value] of Object.entries(observation.facts)) {
      if (typeof value === 'string') {
        const r = this.redact(value);
        note(r.redactions);
        facts[key] = r.text;
      } else if (Array.isArray(value)) {
        facts[key] = value.map((v) => {
          if (typeof v !== 'string') return v;
          const r = this.redact(v);
          note(r.redactions);
          return r.text;
        });
      } else {
        facts[key] = value;
      }
    }
    const reason = observation.signal.reason === undefined ? undefined : this.redact(observation.signal.reason);
    if (reason) note(reason.redactions);
    return {
      observation: {
        ...observation,
        text,
        facts,
        signal: { ...observation.signal, ...(reason ? { reason: reason.text } : {}) },
      },
      redactions: [...totals].map(([type, count]) => ({ type, count })),
    };
  }
}
