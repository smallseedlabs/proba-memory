/**
 * JobConfigStore port: the rules and thresholds of the background jobs, as versioned data.
 *
 * Every job reads its settings from here, not from code. A version is immutable; publishing a new one retires
 * the previous active version of the same (workspace, job). Workspace `*` holds the global version every
 * workspace falls back to; a workspace with its own active version uses that one instead.
 */

export const GLOBAL_WORKSPACE = '*';

export interface JobConfigRecord {
  id: string;
  /** A workspace id, or `*` for the global version. */
  workspaceId: string;
  jobName: string;
  /** 1, 2, 3 ... per (workspaceId, jobName). */
  version: number;
  status: 'active' | 'retired';
  config: Record<string, unknown>;
  note: string;
  createdBy: string;
  /** UTC ISO 8601. */
  createdAt: string;
}

export interface PublishJobConfig {
  workspaceId: string;
  jobName: string;
  config: Record<string, unknown>;
  note?: string;
  createdBy: string;
  at: string;
  /** Publish only when no version exists yet for (workspaceId, jobName); otherwise return the active one. Used for seeding. */
  onlyIfAbsent?: boolean;
}

export interface JobConfigStore {
  /** The active version for the workspace (its own, else the global one); null when neither exists. */
  resolve(workspaceId: string, jobName: string): Promise<JobConfigRecord | null>;
  /** Publish a new active version (the previous active one is retired in the same step). Concurrent publishers get distinct versions. */
  publish(input: PublishJobConfig): Promise<JobConfigRecord>;
  /** Every version of (workspaceId, jobName), newest first. Does not fall back to the global versions. */
  list(workspaceId: string, jobName: string): Promise<JobConfigRecord[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
