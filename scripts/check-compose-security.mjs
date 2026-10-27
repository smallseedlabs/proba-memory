#!/usr/bin/env node
/**
 * CI guard for docker-compose.yml. Fails (exit 1) when:
 *   1. a published port is not bound to 127.0.0.1 (checked on the RESOLVED config of every profile, so short and long syntax,
 *      variables and defaults are all covered), or a service uses host networking;
 *   2. a password/secret has a default: `${X_PASSWORD:-literal}`, a literal `X_PASSWORD: literal`, or a literal password
 *      inside a URL (`redis://user:literal@host`). The only accepted form is `${NAME:?message}`. Optional credentials of an
 *      external provider (`*_API_KEY`, `*_TOKENS`) may be left empty (`${NAME:-}`) but never carry a default value;
 *   3. a required variable is not really required: with it unset, `docker compose config` must fail naming it;
 *   4. the resolved config holds a secret that did not come from a required variable (checked by resolving with sentinel values).
 *
 * Usage: node scripts/check-compose-security.mjs [path/to/docker-compose.yml]
 * Needs the `docker compose` CLI (preinstalled on GitHub's ubuntu runners). No containers are started.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

// Must be a required variable: no default, not even an empty one.
const PASSWORD_NAME = /(PASSWORD|PASSWD|SECRET|HMAC_?KEY|PRIVATE_?KEY)/i;
// Credentials of an optional external provider (LLM, embedder, static dev tokens): empty by default is fine, a value is not.
const OPTIONAL_SECRET_NAME = /(API_?KEY|(^|_)TOKENS?$)/i;
const SECRET_NAME = new RegExp(`${PASSWORD_NAME.source}|${OPTIONAL_SECRET_NAME.source}`, 'i');
// ${NAME:-} / ${NAME-}: an empty default.
const EMPTY_DEFAULT = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?-\}$/;
const LOOPBACK = '127.0.0.1';
const SENTINEL = 'sentinel';
// ${NAME:?message}: the one accepted way to take a secret from the environment.
const REQUIRED = /\$\{([A-Za-z_][A-Za-z0-9_]*):\?[^}]*\}/g;
// ${NAME:-default}, ${NAME-default}, ${NAME:+alt}, ${NAME+alt}
const DEFAULTED = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-+])/g;
const URL_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^:/\s@]*:([^@\s/]+)@/gi;

function* strings(node, path = []) {
  if (typeof node === 'string') yield [path.join('.'), node, path[path.length - 1]];
  else if (Array.isArray(node)) for (const [i, v] of node.entries()) yield* strings(v, [...path, String(i)]);
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) yield* strings(v, [...path, k]);
}

/** Static checks on the compose text. Returns { violations, required } (required: names of ${NAME:?...} variables). */
export function checkComposeText(text) {
  const violations = [];
  const required = new Set();
  const doc = yaml.load(text);
  for (const [path, value, key] of strings(doc)) {
    for (const m of value.matchAll(REQUIRED)) required.add(m[1]);
    const masked = value.replace(REQUIRED, '\u0000');
    let defaulted = false;
    for (const m of masked.matchAll(DEFAULTED)) {
      if (PASSWORD_NAME.test(m[1])) {
        defaulted = true;
        violations.push(`${path}: "${m[1]}" has a default (${m[0]}...); use \${${m[1]}:?set ${m[1]}}`);
      } else if (OPTIONAL_SECRET_NAME.test(m[1])) {
        defaulted = true;
        const whole = value.match(new RegExp(`\\$\\{${m[1]}:?[-+][^}]*\\}`))?.[0] ?? m[0];
        if (!EMPTY_DEFAULT.test(whole)) violations.push(`${path}: "${m[1]}" has a non-empty default (${whole}); leave it empty or use \${${m[1]}:?set ${m[1]}}`);
      }
    }
    // A literal value for a secret-named key (POSTGRES_PASSWORD: proba). Anything that is not a required variable is refused.
    if (!defaulted && typeof key === 'string' && SECRET_NAME.test(key) && value.trim() !== '' && !/^\$\{[A-Za-z_][A-Za-z0-9_]*:\?[^}]*\}$/.test(value.trim())) {
      violations.push(`${path}: secret is not a required variable; use \${${key}:?set ${key}}`);
    }
    // Other ${...} expressions (a user name with a default, a port) are not secrets: mask them so the URL parts line up.
    const urlText = masked.replace(/\$\{[^}]*\}/g, (m) =>
      m.includes('://') ? m.replace(/^\$\{[A-Za-z_]\w*:?[-+]/, '').replace(/\}$/, '') : '\u0001'
    );
    for (const m of urlText.matchAll(URL_PASSWORD)) {
      if (m[1] !== '\u0000') violations.push(`${path}: a URL carries a literal password; take it from a \${NAME:?...} variable`);
    }
  }
  return { violations, required: [...required].sort() };
}

function compose(args, { file, env, cwd }) {
  return spawnSync('docker', ['compose', '-f', file, '--env-file', env.__EMPTY_ENV__, '--profile', '*', ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '', ...env.vars },
    encoding: 'utf8',
  });
}

/** Resolved-config checks: ports and sentinel secrets, plus "every required variable is really required". */
export function checkResolvedCompose(file, required) {
  const violations = [];
  const dir = mkdtempSync(join(tmpdir(), 'compose-check-'));
  const emptyEnv = join(dir, 'empty.env');
  writeFileSync(emptyEnv, '');
  const cwd = resolve(file, '..');
  const sentinels = Object.fromEntries(required.map((name) => [name, `${SENTINEL}-${name.toLowerCase()}`]));

  const full = compose(['config', '--format', 'json'], { file, cwd, env: { __EMPTY_ENV__: emptyEnv, vars: sentinels } });
  if (full.status !== 0) {
    return [`docker compose config failed with every required variable set: ${full.stderr.trim().split('\n').pop()}`];
  }
  const config = JSON.parse(full.stdout);

  for (const [name, service] of Object.entries(config.services ?? {})) {
    if (service.network_mode === 'host') violations.push(`${name}: network_mode host exposes every port of the container`);
    for (const port of service.ports ?? []) {
      if (port.host_ip !== LOOPBACK) {
        violations.push(`${name}: port ${port.published ?? '(random)'}:${port.target} is bound to ${port.host_ip ?? '0.0.0.0'}, not ${LOOPBACK}`);
      }
    }
    for (const [key, value] of Object.entries(service.environment ?? {})) {
      const v = String(value ?? '');
      if (SECRET_NAME.test(key) && v !== '' && !v.includes(SENTINEL)) {
        violations.push(`${name}: ${key} resolves to a value that did not come from a required variable`);
      }
      for (const m of v.matchAll(URL_PASSWORD)) {
        if (!m[1].includes(SENTINEL)) violations.push(`${name}: ${key} holds a URL with a password that did not come from a required variable`);
      }
    }
  }

  // Each required variable must really be required: unset on its own, compose has to refuse and name it.
  for (const name of required) {
    const { [name]: _omitted, ...rest } = sentinels;
    const r = compose(['config', '-q'], { file, cwd, env: { __EMPTY_ENV__: emptyEnv, vars: rest } });
    if (r.status === 0) violations.push(`${name} is not required: compose starts without it`);
    else if (!r.stderr.includes(name)) violations.push(`${name}: compose failed without it, but not because of it (${r.stderr.trim().split('\n').pop()})`);
  }
  return violations;
}

function main() {
  const file = resolve(process.argv[2] ?? 'docker-compose.yml');
  const { violations, required } = checkComposeText(readFileSync(file, 'utf8'));
  if (required.length === 0) violations.push('no ${NAME:?...} variable found: the compose file has no required passwords at all');
  violations.push(...checkResolvedCompose(file, required));

  if (violations.length > 0) {
    console.error(`compose security check FAILED (${file}):`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`compose security check passed: every published port is on ${LOOPBACK}, no secret has a default (${required.length} required: ${required.join(', ')})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
