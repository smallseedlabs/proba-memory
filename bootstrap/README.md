# Bootstrap self memory

`proba-self.json` is Proba's "self": who Proba is, what success and operator satisfaction mean, right and wrong behaviour, the limbs
(tools) and where their inputs come from. It is public, versioned data: no secrets, no customer data.

- **Loaded:** memory-api upserts it on every start into the reserved system workspace `__proba_system__`
  (`apps/memory-api/src/self-seed.ts`, `packages/core/src/bootstrap/self-memory.ts`). Each entry becomes one memory whose id is derived
  from `(version, key)`, so re-seeding the same version changes nothing.
- **Changing it:** edit the entries and bump `version`. On the next start the new entries supersede the old ones (`superseded`, linked
  with `supersedes`) and entries you removed are tombstoned; nothing is edited in place. Editing text without a version bump is
  reported as a conflict in the log and the stored text is kept.
- **Read-only to tenants:** served by `GET /v1/self` (people and the `context-reader` role). No route writes memories, the write
  pipeline refuses observations for the system workspace, jobs never run there, and the id cannot be configured as a tenant workspace.
- **Core and detail (schema `proba.self-memory/v2`):** exactly one `tier: core` entry, authored with the version and at most 1200
  characters (~300 tokens): what Proba is, the end goal, success, right and wrong, and how to handle blocked actions. Every other entry
  is `tier: detail` with `tags` saying when it matters: `step:<stepType>`, `tool:<verb>`, `need:landing_url|creative|metrics`,
  `goal:no_campaign|has_campaign|awaiting_approval`, `topic:<word>`. Tier and tags are stored with the version's rows (signals
  `self.tier:*`, `self.tag:*`) and returned by `GET /v1/self`, which also returns `core` on its own.
- **Reaches the model:** proba-context puts the core first in the packet's policy section (required, never dropped) and the gateway
  puts it first in the model's system text, before its fixed safety rules, as a byte-stable prefix. Detail entries go to the memory
  section only when their tags match the run (step, goal state, missing inputs, tools offered or asked for) and can be dropped for budget.
- **Config:** `MEMORY_SELF_SEED_ENABLED` (default `true`), `MEMORY_SELF_SEED_FILE` (default: this file).
