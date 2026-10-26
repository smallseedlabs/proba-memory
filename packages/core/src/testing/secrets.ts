import { randomBytes } from 'node:crypto';

/**
 * Credential-shaped strings for the redaction tests, built at runtime from a prefix and random filler.
 * No committed file contains a literal that looks like a real credential, so secret scanners have nothing
 * to flag, while the redactor still has to recognise every shape.
 */
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const filler = (length: number, alphabet = ALNUM): string => {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
};
const b64url = (value: string): string => Buffer.from(value).toString('base64url');

export interface FakeSecrets {
  /** Dash style API key. */
  apiKey: string;
  /** Underscore style secret and publishable keys. */
  secretKey: string;
  publishableKey: string;
  jwt: string;
  awsKey: string;
  githubToken: string;
  slackToken: string;
  googleKey: string;
  bearerValue: string;
  privateKey: string;
  /** A distinctive piece of `apiKey` that must never survive redaction. */
  apiKeyFragment: string;
}

/** A fresh set on every call. */
export function makeSecrets(): FakeSecrets {
  const apiKey = ['sk', 'live', filler(32, '0123456789abcdef')].join('-');
  const header = ['BEGIN', 'RSA', 'PRIVATE', 'KEY'].join(' ');
  const footer = ['END', 'RSA', 'PRIVATE', 'KEY'].join(' ');
  return {
    apiKey,
    apiKeyFragment: apiKey.slice(-14),
    secretKey: ['sk', 'live', filler(24)].join('_'),
    publishableKey: ['pk', 'test', filler(24)].join('_'),
    jwt: [b64url(JSON.stringify({ alg: 'HS256' })), b64url(JSON.stringify({ sub: filler(10) })), filler(43)].join('.'),
    awsKey: 'AK' + 'IA' + filler(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'),
    githubToken: ['gh', 'p'].join('') + '_' + filler(36),
    slackToken: ['xox', 'b'].join('') + '-' + filler(10, '0123456789') + '-' + filler(12),
    googleKey: 'AI' + 'za' + filler(35, ALNUM + '-_'),
    bearerValue: filler(28),
    privateKey: `-----${header}-----\n${filler(40)}\n-----${footer}-----`,
  };
}
