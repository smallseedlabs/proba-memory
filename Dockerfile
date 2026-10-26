# One Dockerfile, one target per process:
#   docker build --target memory-api -t proba-memory-api .
# Targets: memory-api, memory-ingestor, memory-jobs, migrate

# Stage 1: build every workspace
FROM node:20-alpine AS builder
# The protocol package is installed from a git tag (see package.json), which needs git.
RUN apk add --no-cache git
WORKDIR /app
COPY package*.json ./
COPY packages/scoring/package.json packages/scoring/
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY apps/memory-api/package.json apps/memory-api/
COPY apps/memory-ingestor/package.json apps/memory-ingestor/
COPY apps/memory-jobs/package.json apps/memory-jobs/
COPY apps/memory-eval/package.json apps/memory-eval/
RUN npm ci
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build

# Stage 2: production dependencies only
FROM node:20-alpine AS prod-deps
RUN apk add --no-cache git
WORKDIR /app
COPY package*.json ./
COPY packages/scoring/package.json packages/scoring/
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY apps/memory-api/package.json apps/memory-api/
COPY apps/memory-ingestor/package.json apps/memory-ingestor/
COPY apps/memory-jobs/package.json apps/memory-jobs/
COPY apps/memory-eval/package.json apps/memory-eval/
RUN npm ci --omit=dev && npm cache clean --force

# Stage 3: shared runtime base (no git, non-root user)
FROM node:20-alpine AS runtime
RUN addgroup -g 1001 -S proba && adduser -u 1001 -S proba -G proba
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=builder /app/packages/scoring/package.json /app/packages/scoring/
COPY --from=builder /app/packages/scoring/dist /app/packages/scoring/dist
COPY --from=builder /app/packages/core/package.json /app/packages/core/
COPY --from=builder /app/packages/core/dist /app/packages/core/dist
COPY --from=builder /app/packages/adapters/package.json /app/packages/adapters/
COPY --from=builder /app/packages/adapters/dist /app/packages/adapters/dist
USER proba

# --- app targets ---
FROM runtime AS memory-api
COPY --from=builder --chown=proba:proba /app/apps/memory-api/package.json /app/apps/memory-api/
COPY --from=builder --chown=proba:proba /app/apps/memory-api/dist /app/apps/memory-api/dist
ENV PORT=3200
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "apps/memory-api/dist/index.js"]

FROM runtime AS memory-ingestor
COPY --from=builder --chown=proba:proba /app/apps/memory-ingestor/package.json /app/apps/memory-ingestor/
COPY --from=builder --chown=proba:proba /app/apps/memory-ingestor/dist /app/apps/memory-ingestor/dist
ENV PORT=3201
EXPOSE 3201
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "apps/memory-ingestor/dist/index.js"]

FROM runtime AS memory-jobs
COPY --from=builder --chown=proba:proba /app/apps/memory-jobs/package.json /app/apps/memory-jobs/
COPY --from=builder --chown=proba:proba /app/apps/memory-jobs/dist /app/apps/memory-jobs/dist
ENV PORT=3202
EXPOSE 3202
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "apps/memory-jobs/dist/index.js"]

# One-shot job: apply the Postgres migrations.
FROM runtime AS migrate
COPY --chown=proba:proba migrations ./migrations
CMD ["node", "packages/adapters/dist/postgres/migrate-cli.js"]

# One-shot: the retrieval regression gate on the bundled golden set (in process, no services needed).
#   docker run --rm proba-memory-eval                       # gate
#   docker run --rm proba-memory-eval run --golden=apps/memory-eval/golden/bundled.yaml --profile=default
FROM runtime AS memory-eval
COPY --from=builder --chown=proba:proba /app/apps/memory-eval/package.json /app/apps/memory-eval/
COPY --from=builder --chown=proba:proba /app/apps/memory-eval/dist /app/apps/memory-eval/dist
COPY --chown=proba:proba apps/memory-eval/golden ./apps/memory-eval/golden
COPY --chown=proba:proba apps/memory-eval/profiles ./apps/memory-eval/profiles
COPY --chown=proba:proba apps/memory-eval/eval.config.yaml ./apps/memory-eval/eval.config.yaml
ENTRYPOINT ["node", "apps/memory-eval/dist/cli.js"]
CMD ["gate", "--config", "apps/memory-eval/eval.config.yaml"]
