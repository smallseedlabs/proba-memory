#!/usr/bin/env node
/**
 * Generates an Ed25519 key pair for the context bridge's service token or for the Hub's act-as assertions.
 *
 *   node scripts/generate-service-keypair.mjs --kid bridge-key-1 --out /path/to/dir
 *
 * Writes two files into --out (created if missing, mode 0700):
 *   <kid>.private.pem  the private key (PKCS#8, mode 0600). It goes to the signer only: the context bridge for its service token,
 *                      the Proba Hub for its assertions. Never commit it, never put it on the memory-api host.
 *   <kid>.jwks.json    the public key as a JSON Web Key Set (mode 0644). This is the file the memory-api reads: set
 *                      CONTEXT_SERVICE_PUBLIC_KEY_FILE (bridge key) or HUB_ASSERTION_PUBLIC_KEY_FILE (Hub key) to its absolute path.
 *
 * To rotate, list the new public key next to the old one in the JWKS file, switch the signer to the new kid, then drop the old key.
 * A kid is a short label (letters, digits, - _ .); the signer puts it in the token header.
 */
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { kid: { type: 'string' }, out: { type: 'string' }, force: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
});

const usage = 'Usage: node scripts/generate-service-keypair.mjs --kid <key id> --out <directory> [--force]';
if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (!values.kid || !values.out) {
  console.error(usage);
  process.exit(2);
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(values.kid)) {
  console.error('The kid must be 1-64 characters: letters, digits, dot, dash or underscore, starting with a letter or digit.');
  process.exit(2);
}

const dir = resolve(values.out);
const privateFile = join(dir, `${values.kid}.private.pem`);
const publicFile = join(dir, `${values.kid}.jwks.json`);
if (!values.force && (existsSync(privateFile) || existsSync(publicFile))) {
  console.error(`${values.kid} already exists in ${dir}; choose another kid or pass --force to replace it.`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: values.kid, alg: 'EdDSA', use: 'sig' };

mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
chmodSync(privateFile, 0o600);
writeFileSync(publicFile, `${JSON.stringify({ keys: [jwk] }, null, 2)}\n`, { mode: 0o644 });

console.log(`Private key (signer only): ${privateFile}`);
console.log(`Public key set (memory-api): ${publicFile}`);
