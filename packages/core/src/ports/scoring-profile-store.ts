import type { ProfileStatus, ScoringConfig, ScoringProfile } from '@smallseedlabs/proba-memory-scoring';

export interface NewScoringProfile {
  workspaceId: string;
  name: string;
  config: ScoringConfig;
  status?: ProfileStatus;
  canaryPercent?: number;
  description?: string;
  createdBy: string;
}

/**
 * ScoringProfileStore port: scoring profiles as versioned data. A profile version is immutable once
 * stored; only its rollout status changes. Workspace `*` holds the profiles every workspace falls back to.
 */
export interface ScoringProfileStore {
  /** Insert the built-in default profile (global, version 1, active) if it is missing. Idempotent. Returns it. */
  ensureDefault(): Promise<ScoringProfile>;
  /** All versions visible to the workspace: its own and the global ones. */
  list(workspaceId: string): Promise<ScoringProfile[]>;
  /**
   * The versions of profile `name` that govern the workspace: its own when it has any active one,
   * otherwise the global ones. Input of selectProfiles.
   */
  resolve(workspaceId: string, name: string): Promise<ScoringProfile[]>;
  /** Store a new version (the next number for the workspace and name). */
  put(profile: NewScoringProfile): Promise<ScoringProfile>;
  /** Move one version through the rollout (draft, shadow, canary, active, retired). Activating a version retires the previous active one. */
  setStatus(workspaceId: string, name: string, version: number, status: ProfileStatus, canaryPercent?: number): Promise<ScoringProfile | null>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
