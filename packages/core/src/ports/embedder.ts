/** Embedder port: text to vector. `model` and `version` are stored on every memory row they embed. */
export interface Embedder {
  readonly name: string;
  readonly model: string;
  /** Bump when the model is replaced by a different build under the same name. */
  readonly version: string;
  readonly dimension: number;
  /** One vector per text, same order, each of length `dimension`, L2-normalised or not (callers use cosine). */
  embed(texts: string[], options?: { purpose?: 'document' | 'query' }): Promise<number[][]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
