/** Source of time. Swap for a manual clock in tests. */
export interface Clock {
  now(): Date;
  /** Current time as UTC ISO 8601 with trailing Z and millisecond precision. */
  isoNow(): string;
}
