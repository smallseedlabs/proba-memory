import { afterEach, describe, expect, it } from 'vitest';
import type { LlmProvider } from '../ports/llm-provider.js';

export interface LlmProviderHarness {
  provider: LlmProvider;
  cleanup?: () => Promise<void>;
}

/** Contract any LlmProvider adapter must satisfy. The factory's provider must answer ordinary chat requests. */
export function runLlmProviderContract(name: string, factory: () => Promise<LlmProviderHarness>): void {
  describe(`LlmProvider contract: ${name}`, () => {
    const open: LlmProviderHarness[] = [];
    const make = async (): Promise<LlmProviderHarness> => {
      const h = await factory();
      open.push(h);
      return h;
    };
    afterEach(async () => {
      for (const h of open.splice(0)) {
        await h.cleanup?.();
        await h.provider.close();
      }
    });

    it('names itself and its model', async () => {
      const { provider } = await make();
      expect(provider.name.length).toBeGreaterThan(0);
      expect(provider.model.length).toBeGreaterThan(0);
    });

    it('answers a chat request with text and the model that answered', async () => {
      const { provider } = await make();
      const response = await provider.complete({
        messages: [
          { role: 'system', content: 'Reply with a JSON object.' },
          { role: 'user', content: '<observation>{"kind":"goal.created"}</observation>' },
        ],
        json: true,
        temperature: 0,
        maxTokens: 200,
      });
      expect(typeof response.content).toBe('string');
      expect(response.content.length).toBeGreaterThan(0);
      expect(response.model.length).toBeGreaterThan(0);
      if (response.usage) {
        expect(response.usage.promptTokens).toBeGreaterThanOrEqual(0);
        expect(response.usage.completionTokens).toBeGreaterThanOrEqual(0);
      }
    });

    it('rejects a request without messages', async () => {
      const { provider } = await make();
      await expect(provider.complete({ messages: [] })).rejects.toThrow();
    });

    it('answers ping', async () => {
      const { provider } = await make();
      await expect(provider.ping()).resolves.toBeUndefined();
    });
  });
}
