import { describe, expect, it } from 'vitest';
import { ConfigError, isPolicyEmptyForConfig, loadConfig, parseCorsOrigins, parseHalfLives, parseList, parseNameList, redactConfig } from './index.js';

describe('loadConfig defaults', () => {
  const c = loadConfig({}, { serviceName: 'memory-api', defaultPort: 3200 });

  it('chooses Postgres + pgvector, Redis Streams and a DeepSeek-compatible provider by default', () => {
    expect(c.adapters).toMatchObject({ memoryStore: 'postgres', vectorIndex: 'postgres', eventBus: 'redis-streams', llmProvider: 'deepseek', embedder: 'openai-compatible', outboxStore: 'postgres' });
    expect(c.llm).toMatchObject({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '' });
    expect(c.postgres.embeddingDimension).toBe(1024);
  });

  it('names the service and port, defaults to development and the outbox transport', () => {
    expect(c.service).toMatchObject({ name: 'memory-api', port: 3200 });
    expect(c).toMatchObject({ env: 'development', isDevelopment: true, isProduction: false });
    expect(c.audit.transport).toBe('outbox');
    expect(c.write.redactPii).toBe(true);
  });

  it('has the documented category half-lives and decay floors', () => {
    expect(c.jobs.decay.halfLifeDays).toEqual({ working: 1, episodic: 14, semantic: 180, procedural: 365, super: 730 });
    expect(c.jobs.enabled).toEqual(['decay']);
    expect(c.write.sources).toEqual(['audit']);
  });

  it('refuses nobody-can-use-it API access to go unnoticed', () => {
    expect(isPolicyEmptyForConfig(c)).toBe(true);
    expect(isPolicyEmptyForConfig(loadConfig({ MEMORY_API_ADMIN_EMAILS: 'a@x.example' }))).toBe(false);
  });
});

describe('loadConfig overrides and validation', () => {
  it('treats empty strings as unset', () => {
    expect(loadConfig({ EMBEDDING_DIMENSION: '', LLM_MODEL: '' }).llm.model).toBe('deepseek-flash');
  });

  it('swaps adapters by name', () => {
    const c = loadConfig({ MEMORY_STORE: 'memory', EVENT_BUS: 'memory', LLM_PROVIDER: 'openai-compatible', EMBEDDER: 'hash' });
    expect(c.adapters).toMatchObject({ memoryStore: 'memory', eventBus: 'memory', llmProvider: 'openai-compatible', embedder: 'hash' });
  });

  it('reports every problem at once, without echoing secret values', () => {
    const run = () => loadConfig({ PORT: 'abc', EMBEDDING_DIMENSION: '2', LLM_API_KEY: 'sk-super-secret-value-123456', MEMORY_API_CORS_ORIGINS: '*', DECAY_HALF_LIFE_DAYS: 'bogus=1', RESOLVER_RELATED_THRESHOLD: '0.99', RESOLVER_SIMILARITY_THRESHOLD: '0.5' });
    expect(run).toThrow(ConfigError);
    try {
      run();
    } catch (err) {
      const issues = (err as ConfigError).issues.join('\n');
      expect(issues).toMatch(/PORT/);
      expect(issues).toMatch(/EMBEDDING_DIMENSION/);
      expect((err as ConfigError).message).not.toContain('sk-super-secret-value');
    }
    expect(() => loadConfig({ MEMORY_API_CORS_ORIGINS: '*' })).toThrow(/no wildcard/);
    expect(() => loadConfig({ DECAY_HALF_LIFE_DAYS: 'bogus=1' })).toThrow(/DECAY_HALF_LIFE_DAYS/);
    expect(() => loadConfig({ RESOLVER_RELATED_THRESHOLD: '0.99', RESOLVER_SIMILARITY_THRESHOLD: '0.5' })).toThrow(/RESOLVER_RELATED_THRESHOLD/);
    expect(() => loadConfig({ RETRIEVAL_DEFAULT_LIMIT: '90', RETRIEVAL_MAX_LIMIT: '50' })).toThrow(/RETRIEVAL_DEFAULT_LIMIT/);
    expect(() => loadConfig({ MEMORY_API_STATIC_TOKENS: 'not json' })).toThrow(/MEMORY_API_STATIC_TOKENS/);
    expect(() => loadConfig({ LLM_EXTRA_BODY: '[1]' })).toThrow(/LLM_EXTRA_BODY/);
  });

  it('parses static tokens and per-category half-life overrides', () => {
    const c = loadConfig({ MEMORY_API_STATIC_TOKENS: '[{"token":"abcdefgh","subject":"s","email":"a@x.example"}]', DECAY_HALF_LIFE_DAYS: 'working=2, episodic=7' });
    expect(c.api.staticTokens).toEqual([{ token: 'abcdefgh', subject: 's', email: 'a@x.example', emailVerified: true }]);
    expect(c.jobs.decay.halfLifeDays).toMatchObject({ working: 2, episodic: 7, semantic: 180 });
  });

  it('accepts LLM_EXTRA_BODY for provider-specific switches', () => {
    expect(loadConfig({ LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' }).llm.extraBody).toEqual({ thinking: { type: 'disabled' } });
  });
});

describe('redactConfig', () => {
  it('masks keys, tokens and credentials in connection strings', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgresql://user:dbpassword@db:5432/app',
      REDIS_URL: 'redis://:redispass@cache:6379',
      LLM_API_KEY: 'sk-super-secret-value-123456',
      EMBEDDER_API_KEY: 'embedder-secret-value-123456',
      MEMORY_API_STATIC_TOKENS: '[{"token":"abcdefgh","subject":"s","email":"a@x.example"}]',
    });
    const text = JSON.stringify(redactConfig(c));
    for (const secret of ['dbpassword', 'redispass', 'sk-super-secret-value', 'embedder-secret-value', 'abcdefgh']) expect(text).not.toContain(secret);
    expect(text).toContain('db:5432');
  });
});

describe('parsers', () => {
  it('parseList lower-cases, trims and de-duplicates', () => {
    expect(parseList(' A@x.com, b@x.com ,a@X.com,, ')).toEqual(['a@x.com', 'b@x.com']);
  });
  it('parseNameList keeps case and order', () => {
    expect(parseNameList('audit, content ,audit')).toEqual(['audit', 'content']);
  });
  it('parseCorsOrigins accepts exact origins only', () => {
    expect(parseCorsOrigins('https://insights.example.com/, http://localhost:5173')).toEqual(['https://insights.example.com', 'http://localhost:5173']);
    for (const bad of ['*', 'https://x.example/path', 'ftp://x.example', 'not a url']) expect(() => parseCorsOrigins(bad), bad).toThrow();
  });
  it('parseHalfLives rejects unknown categories and non-positive days', () => {
    expect(parseHalfLives('super=1000')).toEqual({ super: 1000 });
    for (const bad of ['working=0', 'working=-1', 'x=1', 'working', 'working=abc']) expect(() => parseHalfLives(bad), bad).toThrow();
  });
});
