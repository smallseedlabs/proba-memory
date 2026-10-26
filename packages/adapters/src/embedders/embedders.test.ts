import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cosineSimilarity } from '@smallseedlabs/proba-memory-scoring';
import { runEmbedderContract } from '@smallseedlabs/proba-memory-core/testing';
import { startFakeOpenAiServer, type FakeOpenAiServer } from '../http/fake-openai-server.testing.js';
import { HashEmbedder, LOCAL_EMBEDDER_MODEL } from './hash-embedder.js';
import { OpenAiCompatibleEmbedder } from './openai-compatible-embedder.js';

runEmbedderContract('hash (local)', async () => ({
  embedder: new HashEmbedder({ dimension: 64, nodeEnv: 'test', allowLocal: false }),
  deterministic: true,
}));

describe('HashEmbedder', () => {
  it('labels its vectors local-hash', () => {
    expect(new HashEmbedder({ dimension: 16, nodeEnv: 'test', allowLocal: false }).model).toBe(LOCAL_EMBEDDER_MODEL);
    expect(LOCAL_EMBEDDER_MODEL).toBe('local-hash');
  });

  it('refuses production unless explicitly allowed', () => {
    expect(() => new HashEmbedder({ dimension: 16, nodeEnv: 'production', allowLocal: false })).toThrow(/production/);
    expect(() => new HashEmbedder({ dimension: 16, nodeEnv: 'production', allowLocal: true })).not.toThrow();
  });

  it('places texts that share words closer than unrelated texts', async () => {
    const e = new HashEmbedder({ dimension: 256, nodeEnv: 'test', allowLocal: false });
    const [a, b, c] = await e.embed(['the user rejected the countdown timer banner', 'countdown timer banner rejected by the user', 'weekly spend report on monday']);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });
});

describe('OpenAiCompatibleEmbedder', () => {
  let server: FakeOpenAiServer;
  beforeAll(async () => {
    server = await startFakeOpenAiServer({ dimension: 8 });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.requests.length = 0;
    server.failWith = [];
  });

  const make = (extra: Partial<ConstructorParameters<typeof OpenAiCompatibleEmbedder>[0]> = {}) =>
    new OpenAiCompatibleEmbedder({ baseUrl: server.baseUrl, model: 'any-model', version: '3', dimension: 8, apiKey: 'k', timeoutMs: 2000, maxRetries: 2, ...extra });

  runEmbedderContract('openai-compatible (local HTTP server)', async () => ({ embedder: make(), deterministic: true }));

  it('posts to {baseUrl}/embeddings with the model, input and bearer key, and orders results by index', async () => {
    const e = make();
    const vectors = await e.embed(['one', 'two']);
    expect(server.requests).toHaveLength(1);
    const r = server.requests[0];
    expect(r.url).toBe('/v1/embeddings');
    expect(r.headers.authorization).toBe('Bearer k');
    expect(r.body).toMatchObject({ model: 'any-model', input: ['one', 'two'] });
    expect(r.body).not.toHaveProperty('dimensions');
    const [again] = await e.embed(['one']);
    expect(again).toEqual(vectors[0]);
    expect(e.model).toBe('any-model');
    expect(e.version).toBe('3');
  });

  it('sends dimensions only when asked to', async () => {
    await make({ sendDimensions: true }).embed(['x']);
    expect(server.requests[0].body).toMatchObject({ dimensions: 8 });
  });

  it('splits large inputs into batches', async () => {
    const vectors = await make({ batchSize: 2 }).embed(['a', 'b', 'c', 'd', 'e']);
    expect(vectors).toHaveLength(5);
    expect(server.requests).toHaveLength(3);
  });

  it('retries a transient server error and then succeeds', async () => {
    server.failWith = [503];
    const vectors = await make().embed(['retry me']);
    expect(vectors).toHaveLength(1);
    expect(server.requests).toHaveLength(2);
  });

  it('does not retry a client error and reports it', async () => {
    server.failWith = [401];
    await expect(make().embed(['nope'])).rejects.toThrow(/401/);
    expect(server.requests).toHaveLength(1);
  });

  it('rejects a vector of the wrong dimension', async () => {
    await expect(make({ dimension: 16 }).embed(['x'])).rejects.toThrow(/dimension/i);
  });

  it('ping checks configuration without calling the provider', async () => {
    await make().ping();
    expect(server.requests).toHaveLength(0);
  });
});
