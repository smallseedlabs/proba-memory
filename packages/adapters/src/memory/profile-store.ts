import {
  DEFAULT_PROFILE_NAME,
  DEFAULT_SCORING_CONFIG_V1,
  GLOBAL_PROFILE_WORKSPACE,
  parseScoringConfig,
  type ProfileStatus,
  type ScoringProfile,
} from '@smallseedlabs/proba-memory-scoring';
import { deterministicUuid, type Clock, type NewScoringProfile, type ScoringProfileStore } from '@smallseedlabs/proba-memory-core';
import { randomUUID } from 'node:crypto';
import { SystemClock } from '../runtime/system.js';

/** Validate the pieces of a profile every adapter must check the same way. */
export function assertValidProfileInput(config: unknown, canaryPercent: number | undefined): void {
  parseScoringConfig(config);
  if (canaryPercent !== undefined && !(Number.isInteger(canaryPercent) && canaryPercent >= 0 && canaryPercent <= 100)) {
    throw new RangeError('canaryPercent must be a whole number between 0 and 100');
  }
}

export const DEFAULT_PROFILE_ID = deterministicUuid('scoring-profile', `${GLOBAL_PROFILE_WORKSPACE}:${DEFAULT_PROFILE_NAME}:1`);

/** In-process ScoringProfileStore. */
export class InMemoryScoringProfileStore implements ScoringProfileStore {
  private readonly profiles: ScoringProfile[] = [];

  constructor(private readonly clock: Clock = new SystemClock()) {}

  async ensureDefault(): Promise<ScoringProfile> {
    const existing = this.profiles.find((p) => p.id === DEFAULT_PROFILE_ID);
    if (existing) return structuredClone(existing);
    const profile: ScoringProfile = {
      id: DEFAULT_PROFILE_ID,
      workspaceId: GLOBAL_PROFILE_WORKSPACE,
      name: DEFAULT_PROFILE_NAME,
      version: 1,
      status: 'active',
      canaryPercent: 0,
      config: structuredClone(DEFAULT_SCORING_CONFIG_V1),
      description: 'Built-in default scoring profile',
      createdBy: 'system',
      createdAt: this.clock.isoNow(),
    };
    this.profiles.push(profile);
    return structuredClone(profile);
  }

  async list(workspaceId: string): Promise<ScoringProfile[]> {
    return structuredClone(this.profiles.filter((p) => p.workspaceId === workspaceId || p.workspaceId === GLOBAL_PROFILE_WORKSPACE));
  }

  async resolve(workspaceId: string, name: string): Promise<ScoringProfile[]> {
    const own = this.profiles.filter((p) => p.workspaceId === workspaceId && p.name === name);
    if (own.some((p) => p.status === 'active')) return structuredClone(own);
    return structuredClone(this.profiles.filter((p) => p.workspaceId === GLOBAL_PROFILE_WORKSPACE && p.name === name));
  }

  async put(input: NewScoringProfile): Promise<ScoringProfile> {
    assertValidProfileInput(input.config, input.canaryPercent);
    const version = Math.max(0, ...this.profiles.filter((p) => p.workspaceId === input.workspaceId && p.name === input.name).map((p) => p.version)) + 1;
    const profile: ScoringProfile = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      version,
      status: input.status ?? 'draft',
      canaryPercent: input.canaryPercent ?? 0,
      config: structuredClone(parseScoringConfig(input.config)),
      description: input.description ?? '',
      createdBy: input.createdBy,
      createdAt: this.clock.isoNow(),
    };
    this.profiles.push(profile);
    return structuredClone(profile);
  }

  async setStatus(workspaceId: string, name: string, version: number, status: ProfileStatus, canaryPercent?: number): Promise<ScoringProfile | null> {
    assertValidProfileInput(DEFAULT_SCORING_CONFIG_V1, canaryPercent);
    const target = this.profiles.find((p) => p.workspaceId === workspaceId && p.name === name && p.version === version);
    if (!target) return null;
    if (status === 'active') {
      for (const p of this.profiles) if (p !== target && p.workspaceId === workspaceId && p.name === name && p.status === 'active') p.status = 'retired';
    }
    target.status = status;
    target.canaryPercent = status === 'canary' ? (canaryPercent ?? target.canaryPercent) : 0;
    return structuredClone(target);
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
