import type { Embedder, Logger } from '@smallseedlabs/proba-memory-core';
import { postJson, trimBaseUrl } from '../http/json-client.js';

export interface OpenAiCompatibleEmbedderOptions {
  /** Base URL up to (not including) `/embeddings`, for example https://host/v1. */
  baseUrl: string;
  model: string;
  /** Recorded on every row the model embeds; bump it when the provider changes the model under the same name. */
  version: string;
  dimension: number;
  apiKey?: string;
  timeoutMs?: number;
  batchSize?: number;
  maxRetries?: number;
  /** Send `dimensions` so a provider that supports it returns vectors of the configured length. */
  sendDimensions?: boolean;
  fetchFn?: typeof fetch;
  logger?: Logger;
}

interface EmbeddingsResponse {
  data?: { index?: number; embedding?: number[] }[];
}

/**
 * Embedder over the OpenAI-compatible `POST {baseUrl}/embeddings` API. No vendor is assumed: the base
 * URL, model and key come from configuration. The length of every returned vector is checked against the
 * configured dimension, because the database column has a fixed size.
 */
export class OpenAiCompatibleEmbedder implements Embedder {
  readonly name = 'openai-compatible';

  constructor(private readonly options: OpenAiCompatibleEmbedderOptions) {
    if (!options.baseUrl) throw new Error('EMBEDDER_BASE_URL is required for the openai-compatible embedder');
    if (!options.model) throw new Error('EMBEDDER_MODEL is required for the openai-compatible embedder');
  }

  get model(): string {
    return this.options.model;
  }

  get version(): string {
    return this.options.version;
  }

  get dimension(): number {
    return this.options.dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const batchSize = this.options.batchSize ?? 32;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      out.push(...(await this.embedBatch(texts.slice(i, i + batchSize))));
    }
    return out;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const { options } = this;
    const response = await postJson<EmbeddingsResponse>({
      url: `${trimBaseUrl(options.baseUrl)}/embeddings`,
      headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : undefined,
      body: {
        model: options.model,
        input: batch,
        encoding_format: 'float',
        ...(options.sendDimensions ? { dimensions: options.dimension } : {}),
      },
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
      fetchFn: options.fetchFn,
      logger: options.logger,
      label: 'embeddings',
    });
    const data = response.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error(`embeddings returned ${Array.isArray(data) ? data.length : 'no'} vectors for ${batch.length} texts`);
    }
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((d, i) => {
      const v = d.embedding;
      if (!Array.isArray(v) || v.length !== options.dimension || !v.every((x) => Number.isFinite(x))) {
        throw new Error(
          `embedding ${i} has ${Array.isArray(v) ? v.length : 'no'} dimensions but EMBEDDING_DIMENSION is ${options.dimension}; set the dimension to the model's output size (or enable EMBEDDER_SEND_DIMENSIONS if the provider supports it)`
        );
      }
      return v;
    });
  }

  /** Configuration check only: a readiness probe must not spend provider calls. Provider outages show up as degraded retrievals. */
  async ping(): Promise<void> {
    if (!this.options.baseUrl || !this.options.model) throw new Error('embedder is not configured');
  }

  async close(): Promise<void> {
    // No connection to release.
  }
}
