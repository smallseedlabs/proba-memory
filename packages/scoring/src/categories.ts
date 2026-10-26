/**
 * Memory categories. `super` memories are distilled from many lower-level ones
 * (promotion, milestone M2); extraction never produces them directly.
 */
export const MEMORY_CATEGORIES = ['working', 'episodic', 'semantic', 'procedural', 'super'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}
