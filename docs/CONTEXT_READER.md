# The `context-reader` service role

The context bridge reads memories on behalf of one user at a time, to build that user's context. It is not a person, so it does not use a
Firebase ID token. It is a service role with two credentials, a narrow allow-list of routes and reads that are limited to what the user may read.
The contract of every call is in [`openapi.yaml`](openapi.yaml); a request and a response of each route, and the claims of both credentials,
are in [`contracts/context-reader/`](contracts/context-reader/).

## What a call carries

| Part | Value |
|------|-------|
| `Authorization: Bearer <service token>` | EdDSA JWT of the bridge: `iss` `proba-context`, `aud` `proba-memory`, `sub` `context-reader`, `jti`, `exp` at most 120 seconds after `iat`. Says **who is calling**. Verified with the keys in `CONTEXT_SERVICE_PUBLIC_KEY_FILE` (matched by the header's `kid`). |
| `X-Act-As: <assertion>` | EdDSA JWT of the Proba Hub: `iss` `proba-hub`, `aud` that lists `proba-memory`, the claims of the protocol's `ActAsAssertionClaims` (`sub` is the user, plus `workspaceId`, `goalId`, `threadId`, `scopes`, `jti`), `exp` at most 300 seconds after `iat`. Says **for whom**. Verified with the keys in `HUB_ASSERTION_PUBLIC_KEY_FILE`. |
| `actorId`, `workspaceId` | Must equal the assertion's `sub` and `workspaceId`. The search (`POST /v1/memories/search`) carries them in its JSON body; the other reads carry them in the query string. |

A clock difference of up to 30 seconds is tolerated on both tokens. Any other signing algorithm, a missing `kid`, an unknown key, a wrong issuer or
audience, or a lifetime beyond the limits is refused.

| Case | Answer |
|------|--------|
| Service token missing or invalid | `401` |
| `X-Act-As` missing | `400` `act_as_required` |
| `actorId` or `workspaceId` missing | `400` `act_as_scope_required` |
| Assertion expired, for another audience or issuer, or badly signed | `403` `act_as_expired` / `act_as_invalid` |
| Parameters differ from the assertion | `403` `act_as_mismatch` |
| A route outside the allow-list | `403` `insufficient_role` |
| The role is not enabled | `401` (its tokens are just unknown tokens) |

Each refusal is recorded as `auth.denied` with the reason (never the tokens).

## Where it is accepted

Only these routes accept the role. Listing, retrieval logs, job runs, the session route and everything administrative answer `403`.

- `POST /v1/memories/search`
- `GET /v1/memories/{id}`
- `GET /v1/profiles`

## What it can read

A memory has an owner (`owner_actor_id`, the user whose audit events it was learned from) and a visibility: `owner` (only that user) or `workspace`
(every user of the workspace). The role reads a memory only when it is in the assertion's workspace **and** the acting user owns it or it is `workspace`-visible.

- **Search**: the scope is part of the filter given to every candidate generator (vector index, full-text search, structured filter) and to hydration, so
  a memory of another user is never a candidate, never ranked and never counted. Supports `filter` (`kinds` or `categories`, `tags`, `minConfidence`, ...),
  `minScore`, `limit` (default 5, at most 20) and `tokenBudget` (at most 4000); a larger value is a `400`. Candidate tables and non-active statuses stay administrator-only.
- **Get by id**: a memory the user may not read, an unowned private memory or another workspace's memory is `404`, exactly like a missing one (never `403`). Links to
  memories the user may not read are left out.
- **Profiles**: the scoring profiles of the workspace, without their configuration.

Memories written by the pipeline are owned by the user who acted in the observation (otherwise the user it is about) and are private to that owner; one with no user behind it has
no owner and is read by nobody through this role. Viewers and administrators keep their workspace-wide reads.

## What is recorded

Every read is audited like any other read, by the same fail-closed emitter, as `memory.retrieved`, with the actor `service:context-reader`, the user as `userId`, and in `details`
`caller` (`context-reader`), `assertionJti` and `tokenJti`; ids and counts only, never memory text or the query. If the audit event cannot be sent, the read fails.
Rate limiting is per user and workspace (and the search has its own, lower allowance per user); rejected credentials count against the client address like any other failed sign-in.

## Turning it on

The role is off by default. Set:

| Variable | Meaning |
|----------|---------|
| `MEMORY_API_CONTEXT_READER_ENABLED` | `true` to accept the role. |
| `CONTEXT_SERVICE_PUBLIC_KEY_FILE` | Path of the JSON Web Key Set that holds the bridge's public key(s). |
| `HUB_ASSERTION_PUBLIC_KEY_FILE` | Path of the JSON Web Key Set that holds the Hub's public key(s). |

The service refuses to start when the role is enabled without both files, when a file is unreadable or holds anything but Ed25519 public keys (a file with private key material is refused), or when a key has no `kid`.
With `NODE_ENV=production` it also requires absolute paths, files that are not writable by group or others, two different files (the bridge and the Hub must not share a key), and refuses `MEMORY_API_TOKEN_VERIFIER=static`. Keys are read once at start-up; restart to rotate.

### Generating a key pair

Run once for the bridge and once for the Hub, each on the machine that will sign:

```bash
node scripts/generate-service-keypair.mjs --kid bridge-key-1 --out /secure/path/keys
node scripts/generate-service-keypair.mjs --kid hub-key-1 --out /secure/path/keys
```

Each run writes `<kid>.private.pem` (mode 0600; the signer keeps it) and `<kid>.jwks.json` (public). Give the memory-api host only the `.jwks.json` file and point the variable
at its absolute path. Private keys are ignored by git (`*.private.pem`) and must never be committed or copied to the memory-api host. To rotate, add the new key to the key set next
to the old one, switch the signer to the new `kid`, then remove the old key at the next restart.
