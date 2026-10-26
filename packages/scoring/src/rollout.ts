import { createHash } from 'node:crypto';
import type { ScoringProfile } from './profile.js';

export interface ProfileSelection {
  /** The profile whose ranking is returned to the caller. */
  served: ScoringProfile;
  /** Why this one was served. */
  reason: 'active' | 'canary';
  /** A profile scored in the background and logged, never returned. */
  shadow?: ScoringProfile;
}

/** Stable bucket 0..99 of a routing key (the request trace id): the same request always lands in the same bucket. */
export function rolloutBucket(routingKey: string): number {
  const digest = createHash('sha256').update(routingKey).digest();
  return digest.readUInt32BE(0) % 100;
}

const newest = (profiles: ScoringProfile[], status: ScoringProfile['status']): ScoringProfile | undefined =>
  profiles.filter((p) => p.status === status).sort((a, b) => b.version - a.version)[0];

/**
 * Rollout: a new profile version first runs as `shadow` (scored and logged next to the live one, never
 * returned), then as `canary` for a percentage of requests, then becomes `active`.
 * `profiles` are the versions of ONE profile name for the workspace.
 */
export function selectProfiles(profiles: ScoringProfile[], routingKey: string): ProfileSelection {
  const active = newest(profiles, 'active');
  if (!active) throw new Error('no active scoring profile');
  const canary = newest(profiles, 'canary');
  const shadow = newest(profiles, 'shadow');
  const useCanary = canary !== undefined && rolloutBucket(routingKey) < canary.canaryPercent;
  return {
    served: useCanary ? canary : active,
    reason: useCanary ? 'canary' : 'active',
    ...(shadow ? { shadow } : {}),
  };
}
