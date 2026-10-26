import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import {
  RetrievalInputError,
  TokenVerificationError,
  type AppConfig,
  type AuditEmitter,
  type Clock,
  type Logger,
  type MemoryStore,
  type RateLimiter,
  type RetrievalContext,
  type RetrievalService,
  type ScoringProfileStore,
  type TokenVerifier,
} from '@smallseedlabs/proba-memory-core';
import { authorize, type Role, type Session } from './authorization.js';
import { ApiError } from './http/errors.js';
import { API_LIMITS, listQuerySchema, memoryParamsSchema, noQuerySchema, parseWith, searchBodySchema, toMemoryFilter } from './http/schemas.js';
import { toLinkView, toMemoryView, toProfileView } from './http/views.js';

export const TRACE_HEADER = 'X-Trace-Id';

declare module 'fastify' {
  interface FastifyRequest {
    /** Id of this request: every log line and audit event of the request carries it. */
    traceId: string;
    /** Set by the authentication hook of /v1 routes. */
    session?: Session;
    startedAt: number;
  }
}

export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

export interface ServerDeps {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  verifier: TokenVerifier;
  limiter: RateLimiter;
  store: MemoryStore;
  profiles: ScoringProfileStore;
  /** Retrieval and read auditing. Every read is recorded as memory.retrieved; if that fails the read is refused (fails closed). */
  retrieval: RetrievalService;
  /** Used for denials, errors and lifecycle events: a hiccup must not make things worse. */
  bestEffortEmitter: AuditEmitter;
  readiness: ReadinessCheck[];
}

const READINESS_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The path with every :param kept as a pattern, so logs and audit events never hold ids from the URL. */
const routeOf = (request: FastifyRequest): string => request.routeOptions?.url ?? 'unmatched';

/**
 * Build the memory-api HTTP server. Every dependency is injected, so the same server runs on the real
 * adapters and, in tests, on in-memory ones. Fastify, CORS, a trace id on every
 * response, one structured log line per request, Firebase ID-token sign-in, an allow-list with
 * viewer/admin roles, the workspace taken from the session, per-caller rate limits.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, logger } = deps;
  const api = config.api;

  const app = Fastify({
    logger: false,
    trustProxy: api.trustProxy,
    disableRequestLogging: true,
    maxParamLength: 200,
    bodyLimit: API_LIMITS.bodyMaxBytes,
  });

  app.decorateRequest('traceId', '');
  app.decorateRequest('session', undefined);
  app.decorateRequest('startedAt', 0);

  const log = (request: FastifyRequest): Logger => logger.child({ traceId: request.traceId });

  app.addHook('onRequest', async (request, reply) => {
    // Always a fresh id: a client-supplied one would let a caller write into somebody else's trace.
    request.traceId = randomUUID();
    request.startedAt = Date.now();
    reply.header(TRACE_HEADER, request.traceId);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  app.addHook('onResponse', async (request, reply) => {
    log(request).info('request completed', {
      method: request.method,
      route: routeOf(request),
      // Names only: parameter values can hold search text.
      queryParams: Object.keys((request.query as Record<string, unknown> | undefined) ?? {}).sort(),
      statusCode: reply.statusCode,
      durationMs: Date.now() - request.startedAt,
      ...(request.session ? { actor: request.session.subject, role: request.session.role, workspaceId: request.session.workspaceId } : {}),
      remoteAddress: request.ip,
    });
  });

  await app.register(cors, {
    origin: api.corsOrigins.length > 0 ? api.corsOrigins : false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: [TRACE_HEADER, 'Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    credentials: false,
    maxAge: 600,
  });

  app.setNotFoundHandler(async (request, reply) => {
    reply.code(404).send({ error: 'not_found', message: 'This route does not exist.', traceId: request.traceId });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ApiError) {
      for (const [k, v] of Object.entries(error.headers ?? {})) reply.header(k, v);
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.issues ? { issues: error.issues } : {}),
        traceId: request.traceId,
      });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: 'The request could not be understood.', traceId: request.traceId });
    }
    log(request).error('request failed', { err: error, route: routeOf(request) });
    await deps.bestEffortEmitter
      .forTrace(request.traceId)
      .emit({
        actor: { type: 'service', id: config.service.name },
        workspaceId: request.session?.workspaceId ?? api.workspaceId,
        action: 'system.error',
        category: 'system',
        outcome: 'failure',
        target: { type: 'route', id: `${request.method} ${routeOf(request)}` },
        errorCode: 'unhandled_error',
        errorMessage: error.message.slice(0, 500),
        riskLevel: 'medium',
        details: { component: 'http', statusCode: status },
      })
      .catch(() => null);
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong. Try again in a moment.', traceId: request.traceId });
  });

  // -- Liveness and readiness: no authentication, no audit trail entry, nothing sensitive in the answer.
  app.get('/health', async () => ({ status: 'ok', service: config.service.name }));

  app.get('/ready', async (_request, reply) => {
    const results = await Promise.all(
      deps.readiness.map(async (r) => {
        try {
          await withTimeout(r.check(), READINESS_TIMEOUT_MS);
          return [r.name, 'ok'] as const;
        } catch {
          return [r.name, 'unavailable'] as const;
        }
      })
    );
    const ready = results.every(([, state]) => state === 'ok');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks: Object.fromEntries(results) });
  });

  // -- Everything under /v1: authenticated, authorised, rate limited, audited.
  await app.register(
    async (v1) => {
      const deny = async (request: FastifyRequest, reason: string, outcome: 'denied' | 'failure', actorId?: string): Promise<void> => {
        // A flood of rejected calls must not flood the audit trail: a few records per reason and client per minute.
        const gate = await deps.limiter.hit(`deny-audit:${reason}:${request.ip}`, 5, 60_000);
        if (!gate.allowed) return;
        await deps.bestEffortEmitter
          .forTrace(request.traceId)
          .emit({
            actor: actorId ? { type: 'user', id: actorId } : { type: 'system', id: 'anonymous' },
            workspaceId: api.workspaceId,
            action: 'auth.denied',
            category: 'auth',
            outcome,
            errorCode: reason,
            riskLevel: 'medium',
            target: { type: 'route', id: `${request.method} ${routeOf(request)}` },
            details: { component: 'http', verifier: deps.verifier.name },
          })
          .catch(() => null);
      };

      const failAuth = async (
        request: FastifyRequest,
        reply: FastifyReply,
        status: number,
        code: string,
        message: string,
        outcome: 'denied' | 'failure',
        actorId?: string
      ): Promise<FastifyReply> => {
        await deps.limiter.hit(`auth-fail:${request.ip}`, api.rateLimit.authFailureMax, api.rateLimit.authFailureWindowMs);
        log(request).info('request refused', { code, route: routeOf(request) });
        await deny(request, code, outcome, actorId);
        if (status === 401) reply.header('WWW-Authenticate', 'Bearer realm="proba-memory"');
        return reply.code(status).send({ error: code, message, traceId: request.traceId });
      };

      v1.addHook('preHandler', async (request, reply) => {
        // 1. A client that keeps presenting bad credentials is refused before any token work.
        const failures = await deps.limiter.peek(`auth-fail:${request.ip}`, api.rateLimit.authFailureMax, api.rateLimit.authFailureWindowMs);
        if (!failures.allowed) {
          await deny(request, 'rate_limited', 'denied');
          return reply
            .code(429)
            .header('Retry-After', String(failures.retryAfterSeconds))
            .send({ error: 'rate_limited', message: 'Too many rejected sign-ins. Try again later.', traceId: request.traceId });
        }

        // 2. Who is calling. Only the Authorization header carries a token: never the URL.
        const header = request.headers.authorization;
        if (!header || !/^Bearer\s+\S+$/i.test(header)) {
          return failAuth(request, reply, 401, 'missing_token', 'Sign in to continue.', 'failure');
        }
        let identity;
        try {
          identity = await deps.verifier.verify(header.replace(/^Bearer\s+/i, ''));
        } catch (err) {
          if (err instanceof TokenVerificationError) {
            const expired = err.code === 'token_expired';
            return failAuth(
              request,
              reply,
              401,
              err.code,
              expired ? 'Your sign-in has expired. Sign in again.' : 'Your sign-in could not be verified. Sign in again.',
              'failure'
            );
          }
          log(request).error('token verification unavailable', { err });
          return reply.code(503).send({ error: 'auth_unavailable', message: 'Sign-in checks are unavailable right now. Try again in a moment.', traceId: request.traceId });
        }

        // 3. May they use the API, and as what. The workspace is set here, from configuration.
        const decision = authorize(identity, api.access, api.workspaceId);
        if (!decision.ok) {
          return failAuth(request, reply, 403, decision.reason, 'This account does not have access to memory data.', 'denied', identity.subject);
        }
        request.session = decision.session;

        // 4. Per-caller rate limit.
        const rate = await deps.limiter.hit(`user:${decision.session.subject}`, api.rateLimit.max, api.rateLimit.windowMs);
        reply.header('X-RateLimit-Limit', String(rate.limit)).header('X-RateLimit-Remaining', String(rate.remaining));
        if (!rate.allowed) {
          await deny(request, 'rate_limited', 'denied', decision.session.subject);
          return reply
            .code(429)
            .header('Retry-After', String(rate.retryAfterSeconds))
            .send({ error: 'rate_limited', message: 'Too many requests. Try again shortly.', traceId: request.traceId });
        }
      });

      const need = (request: FastifyRequest): Session => {
        if (!request.session) throw new ApiError(401, 'missing_token', 'Sign in to continue.');
        return request.session;
      };
      const requireAdmin = async (request: FastifyRequest, session: Session, what: string): Promise<void> => {
        if (session.role === 'admin') return;
        await deny(request, 'insufficient_role', 'denied', session.subject);
        throw new ApiError(403, 'insufficient_role', `${what} needs an administrator account.`);
      };
      const contextOf = (request: FastifyRequest, session: Session, includeCandidates = false): RetrievalContext => ({
        workspaceId: session.workspaceId,
        actor: { type: 'user', id: session.subject },
        traceId: request.traceId,
        includeCandidates,
      });
      const roleOf = (session: Session): Role => session.role;

      v1.get('/session', async (request) => {
        parseWith(noQuerySchema, request.query);
        const session = need(request);
        await deps.retrieval.recordRead(contextOf(request, session), 'session', {});
        return { subject: session.subject, email: session.email, role: roleOf(session), workspaceId: session.workspaceId };
      });

      v1.post('/memories/search', async (request, reply) => {
        const session = need(request);
        const body = parseWith(searchBodySchema, request.body, 'body');
        const f = body.filter ?? {};
        if (f.statuses?.some((s) => s !== 'active')) await requireAdmin(request, session, 'Searching memories that are not active');
        if (body.includeCandidates) await requireAdmin(request, session, 'The candidate table');
        // Search is the expensive call (embedding plus several queries): its own, lower limit on top of the general one.
        const rate = await deps.limiter.hit(`search:${session.subject}`, api.rateLimit.searchMax, api.rateLimit.windowMs);
        if (!rate.allowed) {
          await deny(request, 'rate_limited', 'denied', session.subject);
          return reply
            .code(429)
            .header('Retry-After', String(rate.retryAfterSeconds))
            .send({ error: 'rate_limited', message: 'Searches are limited. Try again shortly.', traceId: request.traceId });
        }
        try {
          return await deps.retrieval.search(contextOf(request, session, body.includeCandidates === true), {
            query: body.query,
            filter: toMemoryFilter(f),
            ...(body.limit !== undefined ? { limit: body.limit } : {}),
            ...(body.tokenBudget !== undefined ? { tokenBudget: body.tokenBudget } : {}),
            ...(body.rerank !== undefined ? { rerank: body.rerank } : {}),
          });
        } catch (err) {
          if (err instanceof RetrievalInputError) throw new ApiError(400, 'invalid_body', err.message);
          throw err;
        }
      });

      v1.get('/memories', async (request) => {
        const session = need(request);
        const q = parseWith(listQuerySchema, request.query);
        if (q.status?.some((s) => s !== 'active')) await requireAdmin(request, session, 'Listing memories that are not active');
        const filter = toMemoryFilter({ categories: q.category, statuses: q.status, minConfidence: q.minConfidence, minImportance: q.minImportance, goalId: q.goalId, threadId: q.threadId, sourceKind: q.sourceKind, createdFrom: q.createdFrom, createdTo: q.createdTo });
        let page;
        try {
          page = await deps.store.listMemories({ workspaceId: session.workspaceId, filter, limit: q.limit, cursor: q.cursor });
        } catch (err) {
          if (err instanceof Error && err.message === 'invalid cursor') throw new ApiError(400, 'invalid_query', 'The cursor is not valid.', [{ path: 'cursor', message: 'not a cursor this API issued' }]);
          throw err;
        }
        await deps.retrieval.recordRead(
          contextOf(request, session),
          'list',
          { filterKeys: Object.keys(filter).sort(), hasMore: page.nextCursor !== null },
          page.memories.map((m) => m.id)
        );
        return { memories: page.memories.map(toMemoryView), nextCursor: page.nextCursor };
      });

      v1.get('/memories/:id', async (request) => {
        const session = need(request);
        parseWith(noQuerySchema, request.query);
        const { id } = parseWith(memoryParamsSchema, request.params, 'path');
        // Looked up inside the caller's workspace only: another workspace's id is indistinguishable from a missing one.
        const memory = await deps.store.getMemory(session.workspaceId, id);
        await deps.retrieval.recordRead(contextOf(request, session), 'get', { found: memory !== null }, memory ? [memory.id] : []);
        if (!memory) throw new ApiError(404, 'not_found', 'There is no memory with this id.');
        const links = await deps.store.listLinks(session.workspaceId, memory.id);
        return { memory: toMemoryView(memory), links: links.map(toLinkView) };
      });

      v1.get('/profiles', async (request) => {
        const session = need(request);
        parseWith(noQuerySchema, request.query);
        const profiles = await deps.profiles.list(session.workspaceId);
        await deps.retrieval.recordRead(contextOf(request, session), 'profiles', { count: profiles.length });
        return { profiles: profiles.map((p) => toProfileView(p, session.role)) };
      });
    },
    { prefix: '/v1' }
  );

  return app;
}
