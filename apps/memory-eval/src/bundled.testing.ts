import { fileURLToPath } from 'node:url';

/** Paths of the bundled files, for tests (works from `src` and from `dist`). */
const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export const BUNDLED_GOLDEN = here('../golden/bundled.yaml');
export const BUNDLED_BASELINE = here('../golden/bundled.baseline.json');
export const BUNDLED_CONFIG = here('../eval.config.yaml');
export const RECENCY_PROFILE = here('../profiles/recency-heavy.yaml');
