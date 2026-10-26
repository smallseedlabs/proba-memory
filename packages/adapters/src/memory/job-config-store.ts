import { randomUUID } from 'node:crypto';
import type { JobConfigRecord, JobConfigStore, PublishJobConfig } from '@smallseedlabs/proba-memory-core';
import { GLOBAL_WORKSPACE } from '@smallseedlabs/proba-memory-core';

/** In-process JobConfigStore. */
export class InMemoryJobConfigStore implements JobConfigStore {
  private readonly records: JobConfigRecord[] = [];

  private active(workspaceId: string, jobName: string): JobConfigRecord | undefined {
    return this.records.find((r) => r.workspaceId === workspaceId && r.jobName === jobName && r.status === 'active');
  }

  async resolve(workspaceId: string, jobName: string): Promise<JobConfigRecord | null> {
    const found = this.active(workspaceId, jobName) ?? this.active(GLOBAL_WORKSPACE, jobName);
    return found ? structuredClone(found) : null;
  }

  async publish(input: PublishJobConfig): Promise<JobConfigRecord> {
    const existing = this.records.filter((r) => r.workspaceId === input.workspaceId && r.jobName === input.jobName);
    if (input.onlyIfAbsent && existing.length > 0) {
      const current = this.active(input.workspaceId, input.jobName) ?? existing.sort((a, b) => b.version - a.version)[0];
      return structuredClone(current);
    }
    for (const r of existing) if (r.status === 'active') r.status = 'retired';
    const record: JobConfigRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      jobName: input.jobName,
      version: existing.reduce((m, r) => Math.max(m, r.version), 0) + 1,
      status: 'active',
      config: structuredClone(input.config),
      note: input.note ?? '',
      createdBy: input.createdBy,
      createdAt: new Date(input.at).toISOString(),
    };
    this.records.push(record);
    return structuredClone(record);
  }

  async list(workspaceId: string, jobName: string): Promise<JobConfigRecord[]> {
    return structuredClone(this.records.filter((r) => r.workspaceId === workspaceId && r.jobName === jobName).sort((a, b) => b.version - a.version));
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
