/**
 * RateLimiter port: counts hits per key in fixed windows.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** The limit of the window the key is in. */
  limit: number;
  /** Hits left in the window (0 when not allowed). */
  remaining: number;
  /** Seconds until the window resets (at least 1 when not allowed). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Count one hit for `key` under `limit` hits per `windowMs`, and say whether it is allowed. */
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
  /** Current state of the key without counting a hit. */
  peek(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
  close(): Promise<void>;
}
