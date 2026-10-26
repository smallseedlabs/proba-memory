import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmProviderError, type LlmProvider, type LlmRequest, type LlmResponse } from '../ports/llm-provider.js';
import { MemoryLogger } from '../logger/index.js';
import { StructuredOutputError, extractJsonObject, generateStructured } from './structured.js';

const schema = z.object({ items: z.array(z.object({ text: z.string().min(1) })).max(3) }).strict();

function provider(replies: (string | Error)[]): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let i = 0;
  return {
    name: 'fake',
    model: 'fake-1',
    requests,
    async complete(request): Promise<LlmResponse> {
      requests.push(structuredClone(request));
      const next = replies[Math.min(i, replies.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return { content: next, model: 'fake-1', usage: { promptTokens: 10, completionTokens: 5 } };
    },
    async ping() {},
    async close() {},
  };
}
const run = (llm: LlmProvider, maxAttempts = 3) => generateStructured({ llm, logger: new MemoryLogger(), system: 'sys', user: 'usr', schema, maxAttempts });

describe('extractJsonObject', () => {
  it('finds the first balanced object in prose or code fences', () => {
    expect(extractJsonObject('Sure! ```json\n{"a":1}\n``` hope that helps')).toBe('{"a":1}');
    expect(extractJsonObject('x {"a":{"b":[1,2]}} y {"c":1}')).toBe('{"a":{"b":[1,2]}}');
  });
  it('is not fooled by braces inside strings or escaped quotes', () => {
    expect(extractJsonObject('{"a":"}{ \\" }"}')).toBe('{"a":"}{ \\" }"}');
  });
  it('returns null without a complete object', () => {
    expect(extractJsonObject('no json')).toBeNull();
    expect(extractJsonObject('{"a":1')).toBeNull();
  });
});

describe('generateStructured', () => {
  it('returns the validated value, asking for JSON mode without tools', async () => {
    const llm = provider(['{"items":[{"text":"one"}]}']);
    const r = await run(llm);
    expect(r).toMatchObject({ value: { items: [{ text: 'one' }] }, attempts: 1, usage: { promptTokens: 10, completionTokens: 5 } });
    expect(llm.requests[0]).toMatchObject({ json: true, temperature: 0 });
    expect(llm.requests[0]).not.toHaveProperty('tools');
  });

  it('tells the model what was wrong and tries again, accumulating usage', async () => {
    const llm = provider(['not json at all', '{"items":[{"text":""}]}', '{"items":[{"text":"fixed"}]}']);
    const r = await run(llm);
    expect(r.attempts).toBe(3);
    expect(r.value.items[0].text).toBe('fixed');
    expect(r.usage).toEqual({ promptTokens: 30, completionTokens: 15 });
    const last = llm.requests[2].messages;
    expect(last.at(-1)!.content).toMatch(/not valid/);
    expect(last.at(-1)!.content).toMatch(/items\.0\.text/);
  });

  it('rejects unknown fields (strict schemas) and gives up after maxAttempts', async () => {
    const llm = provider(['{"items":[],"extra":true}']);
    await expect(run(llm, 2)).rejects.toBeInstanceOf(StructuredOutputError);
    expect(llm.requests).toHaveLength(2);
  });

  it('retries retryable provider errors but rethrows a non-retryable one at once', async () => {
    const flaky = provider([new LlmProviderError('rate limited', true, 429), '{"items":[]}']);
    expect((await run(flaky)).attempts).toBe(2);
    const fatal = provider([new LlmProviderError('bad key', false, 401), '{"items":[]}']);
    await expect(run(fatal)).rejects.toMatchObject({ retryable: false, status: 401 });
    expect(fatal.requests).toHaveLength(1);
  });

  it('fails with the last issues when every attempt is a provider error', async () => {
    const llm = provider([new LlmProviderError('503', true, 503)]);
    await expect(run(llm, 2)).rejects.toMatchObject({ attempts: 2, lastIssues: ['503'] });
  });

  it('never logs the model reply text', async () => {
    const logger = new MemoryLogger();
    const llm = provider(['{"items":[{"text":"private words"}],"x":1}', '{"items":[]}']);
    await generateStructured({ llm, logger, system: 's', user: 'u', schema, maxAttempts: 2 });
    expect(JSON.stringify(logger.records)).not.toContain('private words');
  });
});
