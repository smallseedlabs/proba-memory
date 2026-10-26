import type { Logger } from '@smallseedlabs/proba-memory-core';

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

export interface JsonRequestOptions {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  maxRetries: number;
  /** Delay before retry n (1-based) when the server gave no Retry-After. */
  backoffMs?: (attempt: number) => number;
  fetchFn?: typeof fetch;
  logger?: Logger;
  /** Name for logs. */
  label: string;
}

const retryable = (status: number): boolean => status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;

/**
 * POST JSON and parse the JSON answer. Retries timeouts, network errors, 408/409/425/429 and 5xx with
 * backoff (honouring Retry-After); any other status fails at once with HttpStatusError.
 * Never logs bodies or headers: they can hold the content being embedded and the API key.
 */
export async function postJson<T>(options: JsonRequestOptions): Promise<T> {
  const doFetch = options.fetchFn ?? fetch;
  const backoff = options.backoffMs ?? ((n: number) => Math.min(8000, 250 * 2 ** (n - 1)));
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= options.maxRetries + 1; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let retryAfterMs: number | undefined;
    try {
      const response = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...options.headers },
        body: JSON.stringify(options.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after'));
        retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
        // Keep a short, unexpanded excerpt of the error body: provider error messages name the problem, not our data.
        const excerpt = (await response.text().catch(() => '')).slice(0, 300);
        throw new HttpStatusError(response.status, `${options.label} answered ${response.status}${excerpt ? `: ${excerpt}` : ''}`, retryAfterMs);
      }
      return (await response.json()) as T;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error.name === 'AbortError' ? new Error(`${options.label} timed out after ${options.timeoutMs}ms`) : error;
      const isRetryable = error instanceof HttpStatusError ? retryable(error.status) : true;
      if (!isRetryable || attempt > options.maxRetries) break;
      const wait = (error instanceof HttpStatusError ? error.retryAfterMs : undefined) ?? backoff(attempt);
      options.logger?.warn(`${options.label} request failed, retrying`, { attempt, waitMs: wait, error: lastError.message.slice(0, 200) });
      await new Promise((resolve) => setTimeout(resolve, wait));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error(`${options.label} failed`);
}

/** `https://host/v1/` -> `https://host/v1` */
export function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}
