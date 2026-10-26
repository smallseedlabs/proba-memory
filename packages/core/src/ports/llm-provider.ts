/**
 * LlmProvider port: one chat completion. Providers do not claim tool calling: structured output is
 * obtained by asking for JSON and validating it (see generateStructured).
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  /** Ask the provider for a JSON object (response_format json_object where the API has it). */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmResponse {
  content: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
  finishReason?: string;
}

export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
