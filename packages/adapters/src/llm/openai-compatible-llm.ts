import { LlmProviderError, type LlmProvider, type LlmRequest, type LlmResponse, type Logger } from '@smallseedlabs/proba-memory-core';
import { HttpStatusError, postJson, trimBaseUrl } from '../http/json-client.js';

export interface OpenAiCompatibleLlmOptions {
  /** Base URL up to (not including) `/chat/completions`, for example https://api.deepseek.com. */
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Merged into every request body (provider-specific switches). Cannot override model or messages. */
  extraBody?: Record<string, unknown>;
  defaultTemperature?: number;
  fetchFn?: typeof fetch;
  logger?: Logger;
  /** Reported as the provider name. */
  name?: string;
}

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * LlmProvider over the OpenAI-compatible `POST {baseUrl}/chat/completions` API with plain JSON mode
 * (`response_format: {type: 'json_object'}`) and NO tool calling: structured output is validated by the
 * caller (generateStructured), which retries when a reply is unusable.
 */
export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name: string;

  constructor(protected readonly options: OpenAiCompatibleLlmOptions) {
    if (!options.baseUrl) throw new Error('LLM_BASE_URL is required');
    if (!options.model) throw new Error('LLM_MODEL is required');
    if (!options.apiKey) throw new Error('LLM_API_KEY is required for this provider');
    this.name = options.name ?? 'openai-compatible';
  }

  get model(): string {
    return this.options.model;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.messages.length === 0) throw new LlmProviderError('a chat request needs at least one message', false);
    const { options } = this;
    let response: ChatResponse;
    try {
      response = await postJson<ChatResponse>({
        url: `${trimBaseUrl(options.baseUrl)}/chat/completions`,
        headers: { authorization: `Bearer ${options.apiKey}` },
        body: {
          ...(options.extraBody ?? {}),
          model: options.model,
          messages: request.messages,
          temperature: request.temperature ?? options.defaultTemperature ?? 0,
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          ...(request.json ? { response_format: { type: 'json_object' } } : {}),
          stream: false,
        },
        timeoutMs: options.timeoutMs ?? 60_000,
        maxRetries: options.maxRetries ?? 2,
        fetchFn: options.fetchFn,
        logger: options.logger,
        label: `${this.name} chat`,
      });
    } catch (err) {
      if (err instanceof HttpStatusError) {
        const transient = err.status === 408 || err.status === 409 || err.status === 425 || err.status === 429 || err.status >= 500;
        throw new LlmProviderError(err.message, transient, err.status);
      }
      throw new LlmProviderError(err instanceof Error ? err.message : String(err), true);
    }
    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    // Providers occasionally return an empty body in JSON mode: treat it as a retryable failure.
    if (typeof content !== 'string' || content.trim() === '') throw new LlmProviderError('the model returned an empty reply', true);
    return {
      content,
      model: response.model ?? options.model,
      ...(response.usage ? { usage: { promptTokens: response.usage.prompt_tokens ?? 0, completionTokens: response.usage.completion_tokens ?? 0 } } : {}),
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    };
  }

  /** Configuration check only: a readiness probe must not spend provider calls. */
  async ping(): Promise<void> {
    if (!this.options.baseUrl || !this.options.apiKey) throw new Error('llm provider is not configured');
  }

  async close(): Promise<void> {
    // No connection to release.
  }
}

/** The default provider: DeepSeek's OpenAI-compatible chat API (base URL and model come from configuration). */
export class DeepSeekLlmProvider extends OpenAiCompatibleLlmProvider {
  constructor(options: Omit<OpenAiCompatibleLlmOptions, 'name'>) {
    super({ ...options, name: 'deepseek' });
  }
}
