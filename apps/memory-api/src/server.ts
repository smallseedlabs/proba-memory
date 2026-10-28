import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {
  ACT_AS_HEADER,
  CONTEXT_READER_ROLE,
  RetrievalInputError,
  TokenVerificationError,
  type AppConfig,
  type AuditEmitter,
  type Clock,
  type ContextBridgeAuth,
  type JobRunStore,
  type Logger,
  type MemoryStore,
  type RateLimiter,
  type RetrievalContext,
  type RetrievalLogStore,
  type RetrievalService,
  type ScoringProfileStore,
  type TokenVerifier,
} from '@smallseedlabs/proba-memory-core';
import { CONTEXT_READER_ROUTES, authorize, sessionFromAssertion, type Role, type Session } from './authorization.js';
import { ApiError } from './http/errors.js';
import {
  API_LIMITS,
  actAsParamsSchema,
  jobRunsQuerySchema,
  listQuerySchema,
  memoryParamsSchema,
  memoryRetrievalsQuerySchema,
  noQuerySchema,
  parseWith,
  retrievalParamsSchema,
  searchBodySchema,
  toMemoryFilter,
} from './http/schemas.js';
import { toJobRunView, toLinkView, toMemoryRetrievalView, toMemoryView, toProfileView, toRetrievalRecordView } from './http/views.js';

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
  /** Credentials of the `context-reader` role; absent when the role is off (its tokens are then just unknown tokens). */
  contextBridge?: ContextBridgeAuth;
  limiter: RateLimiter;
  store: MemoryStore;
  profiles: ScoringProfileStore;
  /** Retrieval and read auditing. Every read is recorded as memory.retrieved; if that fails the read is refused (fails closed). */
  retrieval: RetrievalService;
  /** Retrieval log for admin reads of past searches. */
  logStore: RetrievalLogStore;
  /** Job run history for admin operations screens. */
  jobRuns: JobRunStore;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extra facts about who is denied: the `context-reader` role is a service acting for a user, not a person. */
interface DenyExtra {
  actor?: { type: 'service'; id: string };
  workspaceId?: string;
  verifier?: string;
  details?: Record<string, unknown>;
}

/** Where a `context-reader` call names its user and workspace: the body of the search, the query of every read. */
const scopeSource = (request: FastifyRequest): unknown => (request.method === 'POST' ? request.body : request.query);

/** The request without the two scope parameters of the `context-reader` role (already checked against the assertion). */
function withoutScope(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const { actorId: _actorId, workspaceId: _workspaceId, ...rest } = input as Record<string, unknown>;
  return rest;
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
    if (status === 429 || (error as { error?: string }).error === 'rate_limited') {
      const retryAfter = (error as { retryAfter?: string | number }).retryAfter;
      if (retryAfter !== undefined) reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests. Try again shortly.', traceId: request.traceId });
    }
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
      // Framework rate limit so scanners (CodeQL MissingRateLimiting) see a recognised control on authorised routes. The ceiling is
      // deliberately high: deps.limiter stays the primary, documented per-user (and per-bridge-user) control.
      await v1.register(rateLimit, {
        global: true,
        max: Math.max(api.rateLimit.max * 100, 1_000),
        timeWindow: api.rateLimit.windowMs,
        addHeaders: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false, 'retry-after': true },
        errorResponseBuilder: (_request, context) => ({
          statusCode: 429,
          error: 'rate_limited',
          message: 'Too many requests. Try again shortly.',
          retryAfter: context.after,
        }),
      });

      const deny = async (request: FastifyRequest, reason: string, outcome: 'denied' | 'failure', actorId?: string, extra: DenyExtra = {}): Promise<void> => {
        // A flood of rejected calls must not flood the audit trail: a few records per reason and client per minute.
        const gate = await deps.limiter.hit(`deny-audit:${reason}:${request.ip}`, 5, 60_000);
        if (!gate.allowed) return;
        await deps.bestEffortEmitter
          .forTrace(request.traceId)
          .emit({
            actor: extra.actor ?? (actorId ? { type: 'user', id: actorId } : { type: 'system', id: 'anonymous' }),
            workspaceId: extra.workspaceId ?? api.workspaceId,
            action: 'auth.denied',
            category: 'auth',
            outcome,
            errorCode: reason,
            riskLevel: 'medium',
            target: { type: 'route', id: `${request.method} ${routeOf(request)}` },
            details: { component: 'http', verifier: extra.verifier ?? deps.verifier.name, ...extra.details },
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
        actorId?: string,
        extra?: DenyExtra
      ): Promise<FastifyReply> => {
        await deps.limiter.hit(`auth-fail:${request.ip}`, api.rateLimit.authFailureMax, api.rateLimit.authFailureWindowMs);
        log(request).info('request refused', { code, route: routeOf(request) });
        await deny(request, code, outcome, actorId, extra);
        if (status === 401) reply.header('WWW-Authenticate', 'Bearer realm="proba-memory"');
        return reply.code(status).send({ error: code, message, traceId: request.traceId });
      };

      /**
       * The `context-reader` role: a service token proves the bridge is calling, the Hub's act-as assertion proves for which user,
       * and the `actorId` / `workspaceId` of the request (query, or body for the search) must say the same. The order is deliberate:
       * the route is checked before anything about the user, so every route outside the allow-list answers 403 to this role.
       */
      const admitBridgeCall = async (request: FastifyRequest, reply: FastifyReply, token: string, bridge: ContextBridgeAuth): Promise<FastifyReply | void> => {
        const caller = { type: 'service' as const, id: CONTEXT_READER_ROLE };
        const verifier = bridge.service.name;
        let service;
        try {
          service = await bridge.service.verify(token);
        } catch (err) {
          if (err instanceof TokenVerificationError) {
            const expired = err.code === 'token_expired';
            return failAuth(request, reply, 401, err.code, expired ? 'Your sign-in has expired. Sign in again.' : 'Your sign-in could not be verified. Sign in again.', 'failure', undefined, { verifier });
          }
          log(request).error('service token verification unavailable', { err });
          return reply.code(503).send({ error: 'auth_unavailable', message: 'Sign-in checks are unavailable right now. Try again in a moment.', traceId: request.traceId });
        }
        const refuse = async (status: number, code: string, message: string, extra: Record<string, unknown> = {}, workspaceId?: string): Promise<FastifyReply> => {
          log(request).info('request refused', { code, route: routeOf(request) });
          await deny(request, code, 'denied', undefined, { actor: caller, verifier, ...(workspaceId ? { workspaceId } : {}), details: { caller: CONTEXT_READER_ROLE, tokenJti: service.jti, ...extra } });
          return reply.code(status).send({ error: code, message, traceId: request.traceId });
        };

        if (!CONTEXT_READER_ROUTES.has(`${request.method} ${routeOf(request)}`)) {
          return refuse(403, 'insufficient_role', 'This role cannot use this route.');
        }
        const assertionHeader = request.headers[ACT_AS_HEADER];
        if (typeof assertionHeader !== 'string' || assertionHeader.trim() === '') {
          return refuse(400, 'act_as_required', 'The X-Act-As assertion is required.');
        }
        let assertion;
        try {
          assertion = await bridge.assertions.verify(assertionHeader.trim());
        } catch (err) {
          if (err instanceof TokenVerificationError) {
            return refuse(403, err.code === 'token_expired' ? 'act_as_expired' : 'act_as_invalid', 'The X-Act-As assertion is not valid.');
          }
          log(request).error('act-as verification unavailable', { err });
          return reply.code(503).send({ error: 'auth_unavailable', message: 'Sign-in checks are unavailable right now. Try again in a moment.', traceId: request.traceId });
        }
        const withAssertion = { assertionJti: assertion.jti };
        const params = actAsParamsSchema.safeParse(scopeSource(request));
        if (!params.success) {
          return refuse(400, 'act_as_scope_required', 'actorId and workspaceId are required.', withAssertion, assertion.workspaceId);
        }
        if (params.data.actorId !== assertion.sub || params.data.workspaceId !== assertion.workspaceId) {
          return refuse(403, 'act_as_mismatch', 'actorId and workspaceId must match the X-Act-As assertion.', withAssertion, assertion.workspaceId);
        }

        const session = sessionFromAssertion(assertion, service.jti);
        request.session = session;
        // Per user and workspace, so one busy user cannot use up the bridge's allowance for everybody else.
        const rate = await deps.limiter.hit(`context-reader:${assertion.workspaceId}:${assertion.sub}`, api.rateLimit.max, api.rateLimit.windowMs);
        reply.header('X-RateLimit-Limit', String(rate.limit)).header('X-RateLimit-Remaining', String(rate.remaining));
        if (!rate.allowed) {
          await deny(request, 'rate_limited', 'denied', undefined, { actor: caller, verifier, workspaceId: assertion.workspaceId, details: { caller: CONTEXT_READER_ROLE, tokenJti: service.jti, ...withAssertion } });
          return reply
            .code(429)
            .header('Retry-After', String(rate.retryAfterSeconds))
            .send({ error: 'rate_limited', message: 'Too many requests. Try again shortly.', traceId: request.traceId });
        }
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
        const presented = header.replace(/^Bearer\s+/i, '');
        if (deps.contextBridge?.service.claimsToBeBridge(presented)) return admitBridgeCall(request, reply, presented, deps.contextBridge);
        let identity;
        try {
          identity = await deps.verifier.verify(presented);
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
      const contextOf = (request: FastifyRequest, session: Session, includeCandidates = false): RetrievalContext => {
        if (!session.actAs) return { workspaceId: session.workspaceId, actor: { type: 'user', id: session.subject }, traceId: request.traceId, includeCandidates };
        // The reader is the bridge (a service), acting for the user of the assertion: its reads are recorded under the bridge, with the
        // ids of the assertion and the token, and are limited to what that user may read.
        return {
          workspaceId: session.workspaceId,
          actor: { type: 'service', id: CONTEXT_READER_ROLE },
          ...(UUID.test(session.actAs.actorId) ? { userId: session.actAs.actorId } : {}),
          traceId: request.traceId,
          includeCandidates: false,
          visibleTo: session.actAs.actorId,
          auditDetails: { caller: CONTEXT_READER_ROLE, assertionJti: session.actAs.jti, ...(session.tokenJti ? { tokenJti: session.tokenJti } : {}) },
        };
      };
      /** The query as the route's schema sees it: the `context-reader` role's `actorId` and `workspaceId` were already checked against the assertion. */
      const queryOf = (request: FastifyRequest, session: Session): unknown => (session.actAs ? withoutScope(request.query) : request.query);
      const bodyOf = (request: FastifyRequest, session: Session): unknown => (session.actAs ? withoutScope(request.body) : request.body);
      const roleOf = (session: Session): Role => session.role;

      v1.get('/session', async (request) => {
        parseWith(noQuerySchema, request.query);
        const session = need(request);
        await deps.retrieval.recordRead(contextOf(request, session), 'session', {});
        return { subject: session.subject, email: session.email, role: roleOf(session), workspaceId: session.workspaceId };
      });

      v1.post('/memories/search', async (request, reply) => {
        const session = need(request);
        const body = parseWith(searchBodySchema, bodyOf(request, session), 'body');
        const { kinds, ...f } = body.filter ?? {};
        if (kinds !== undefined) {
          if (f.categories !== undefined) throw new ApiError(400, 'invalid_body', 'Some request body fields are not valid.', [{ path: 'filter.kinds', message: 'use either categories or kinds, not both' }]);
          f.categories = kinds;
        }
        if (f.statuses?.some((s) => s !== 'active')) await requireAdmin(request, session, 'Searching memories that are not active');
        if (body.includeCandidates) await requireAdmin(request, session, 'The candidate table');
        if (session.actAs) {
          // The bridge asks for fewer and smaller answers than a person browsing.
          const caps = API_LIMITS.contextReader;
          const issues = [
            ...(body.limit !== undefined && body.limit > caps.maxLimit ? [{ path: 'limit', message: `at most ${caps.maxLimit} for this role` }] : []),
            ...(body.tokenBudget !== undefined && body.tokenBudget > caps.maxTokenBudget ? [{ path: 'tokenBudget', message: `at most ${caps.maxTokenBudget} for this role` }] : []),
          ];
          if (issues.length > 0) throw new ApiError(400, 'invalid_body', 'Some request body fields are not valid.', issues);
        }
        // Search is the expensive call (embedding plus several queries): its own, lower limit on top of the general one.
        // The bridge's allowance is per user and workspace, so one busy user cannot use up everybody else's.
        const limiterKey = session.actAs ? `${session.workspaceId}:${session.actAs.actorId}` : session.subject;
        const rate = await deps.limiter.hit(`search:${limiterKey}`, api.rateLimit.searchMax, api.rateLimit.windowMs);
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
            ...(body.limit !== undefined ? { limit: body.limit } : session.actAs ? { limit: API_LIMITS.contextReader.defaultLimit } : {}),
            ...(body.minScore !== undefined ? { minScore: body.minScore } : {}),
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
        parseWith(noQuerySchema, queryOf(request, session));
        const { id } = parseWith(memoryParamsSchema, request.params, 'path');
        // Looked up inside the caller's workspace only: another workspace's id is indistinguishable from a missing one. For the
        // `context-reader` role the lookup also names the user, so another user's memory is just as indistinguishable (404, never 403).
        const visibleTo = session.actAs?.actorId;
        const memory = await deps.store.getMemory(session.workspaceId, id, visibleTo);
        await deps.retrieval.recordRead(contextOf(request, session), 'get', { found: memory !== null }, memory ? [memory.id] : []);
        if (!memory) throw new ApiError(404, 'not_found', 'There is no memory with this id.');
        let links = await deps.store.listLinks(session.workspaceId, memory.id);
        if (visibleTo !== undefined && links.length > 0) {
          // A link to a memory the user may not read would name it: only links whose other end is readable are shown.
          const readable = new Set((await deps.store.getMemories(session.workspaceId, links.map((l) => (l.fromId === memory.id ? l.toId : l.fromId)), visibleTo)).map((m) => m.id));
          links = links.filter((l) => readable.has(l.fromId === memory.id ? l.toId : l.fromId));
        }
        return { memory: toMemoryView(memory), links: links.map(toLinkView) };
      });

      v1.get('/profiles', async (request) => {
        const session = need(request);
        parseWith(noQuerySchema, queryOf(request, session));
        const profiles = await deps.profiles.list(session.workspaceId);
        await deps.retrieval.recordRead(contextOf(request, session), 'profiles', { count: profiles.length });
        return { profiles: profiles.map((p) => toProfileView(p, session.role)) };
      });

      v1.get('/retrievals/:id', async (request) => {
        const session = need(request);
        await requireAdmin(request, session, 'Reading a retrieval log');
        parseWith(noQuerySchema, request.query);
        const { id } = parseWith(retrievalParamsSchema, request.params, 'path');
        const entry = await deps.logStore.get(session.workspaceId, id);
        await deps.retrieval.recordRead(contextOf(request, session), 'retrieval', { found: entry !== null }, entry ? [entry.id] : []);
        if (!entry) throw new ApiError(404, 'not_found', 'There is no retrieval with this id.');
        return toRetrievalRecordView(entry);
      });

      v1.get('/memories/:id/retrievals', async (request) => {
        const session = need(request);
        await requireAdmin(request, session, 'Listing retrievals for a memory');
        const { id } = parseWith(memoryParamsSchema, request.params, 'path');
        const q = parseWith(memoryRetrievalsQuerySchema, request.query);
        const memory = await deps.store.getMemory(session.workspaceId, id);
        if (!memory) {
          await deps.retrieval.recordRead(contextOf(request, session), 'memory_retrievals', { found: false }, []);
          throw new ApiError(404, 'not_found', 'There is no memory with this id.');
        }
        const entries = await deps.logStore.listByMemoryId(session.workspaceId, id, { limit: q.limit });
        await deps.retrieval.recordRead(
          contextOf(request, session),
          'memory_retrievals',
          { count: entries.length },
          [id, ...entries.map((e) => e.id)]
        );
        return {
          retrievals: entries.map((e) => toMemoryRetrievalView(e, id)).filter((v): v is NonNullable<typeof v> => v !== null),
        };
      });

      v1.get('/jobs/runs', async (request) => {
        const session = need(request);
        await requireAdmin(request, session, 'Listing job runs');
        const q = parseWith(jobRunsQuerySchema, request.query);
        const runs = await deps.jobRuns.list({
          workspaceId: session.workspaceId,
          ...(q.job !== undefined ? { jobName: q.job } : {}),
          ...(q.status !== undefined ? { status: q.status } : {}),
          limit: q.limit,
        });
        await deps.retrieval.recordRead(
          contextOf(request, session),
          'job_runs',
          { count: runs.length, ...(q.job ? { job: q.job } : {}), ...(q.status ? { status: q.status } : {}) },
          runs.map((r) => r.id)
        );
        return { runs: runs.map(toJobRunView) };
      });
    },
    { prefix: '/v1' }
  );

  return app;
}
