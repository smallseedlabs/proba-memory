import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';

/**
 * A set of Ed25519 public keys read from a file, addressed by `kid`.
 *
 * The file is a JWKS document: `{ "keys": [ { "kty": "OKP", "crv": "Ed25519", "x": "...", "kid": "..." } ] }`. Several keys
 * can be listed so a key can be rotated without a gap (add the new one, switch the signer, drop the old one on the next
 * restart). Private key material is refused wherever it is found: a file holding a private key is a mistake to fix, not to use.
 * Production adds two rules: the path is absolute and the file is not writable by group or others (whoever can edit the
 * file decides who the API trusts).
 */

export class PublicKeyFileError extends Error {
  constructor(
    readonly envName: string,
    detail: string
  ) {
    super(`${envName}: ${detail}`);
    this.name = 'PublicKeyFileError';
  }
}

export interface PublicKeySet {
  /** Key lookup for jose, matching the token header's `kid`. */
  keys: JWTVerifyGetKey;
  /** The key ids in the file. */
  keyIds: string[];
  /** The public key of each entry (`x`), to tell whether two files hold the same key. */
  publicKeys: string[];
}

export interface LoadPublicKeySetOptions {
  /** The environment variable the path came from, for error messages. */
  envName: string;
  nodeEnv: string;
}

const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];

export async function loadPublicKeySet(file: string, options: LoadPublicKeySetOptions): Promise<PublicKeySet> {
  const { envName } = options;
  if (file.trim() === '') throw new PublicKeyFileError(envName, 'no file is configured');
  const production = options.nodeEnv === 'production';
  if (production && !isAbsolute(file)) throw new PublicKeyFileError(envName, 'must be an absolute path when NODE_ENV=production');

  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new PublicKeyFileError(envName, `${file} is not a file`);
    if (production && process.platform !== 'win32' && (info.mode & 0o022) !== 0) {
      throw new PublicKeyFileError(envName, `${file} is writable by group or others; run chmod go-w on it`);
    }
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof PublicKeyFileError) throw err;
    throw new PublicKeyFileError(envName, `cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PublicKeyFileError(envName, `${file} is not a JSON Web Key Set`);
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new PublicKeyFileError(envName, `${file} lists no keys`);

  const seen = new Set<string>();
  for (const [index, key] of keys.entries()) {
    const k = (key ?? {}) as Record<string, unknown>;
    const at = `key ${index + 1}`;
    if (k.kty !== 'OKP' || k.crv !== 'Ed25519' || typeof k.x !== 'string' || k.x === '') {
      throw new PublicKeyFileError(envName, `${at} is not an Ed25519 public key (kty OKP, crv Ed25519, x)`);
    }
    if (PRIVATE_MEMBERS.some((m) => m in k)) throw new PublicKeyFileError(envName, `${at} holds private key material; list public keys only`);
    if (typeof k.kid !== 'string' || k.kid === '') throw new PublicKeyFileError(envName, `${at} has no kid`);
    if (k.alg !== undefined && k.alg !== 'EdDSA') throw new PublicKeyFileError(envName, `${at} has alg ${String(k.alg)}; only EdDSA is accepted`);
    if (k.use !== undefined && k.use !== 'sig') throw new PublicKeyFileError(envName, `${at} is not a signature key`);
    if (seen.has(k.kid)) throw new PublicKeyFileError(envName, `kid ${k.kid} is listed twice`);
    seen.add(k.kid);
  }
  const set: JSONWebKeySet = { keys: keys.map((k) => ({ ...(k as object), alg: 'EdDSA', use: 'sig' })) as JSONWebKeySet['keys'] };
  return { keys: createLocalJWKSet(set), keyIds: [...seen], publicKeys: keys.map((k) => (k as { x: string }).x) };
}
