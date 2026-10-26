# Contributing

- Work on a feature branch; `main` is protected and changes land through pull requests.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`).
- Before opening a PR: `npm run lint && npm run typecheck && npm run build && npm test`. With the local Postgres and
  Redis up (`npm run docker:up`), also run `npm run test:integration`.
- Every external dependency stays behind a port in `packages/core/src/ports`. A new adapter ships with the shared
  contract suite (`packages/core/src/testing`) and is registered in `createDefaultRegistries()`.
- Logs are structured JSON with `traceId`. Never log memory, conversation or query text, secrets or tokens.
- Audit events carry ids, counts and lengths only.
- This repository is public: no secrets, no real credentials, no private data. Configuration examples go in
  `.env.example` with placeholders.
- Retrieved text is untrusted data; do not add code paths that treat it as instructions.
