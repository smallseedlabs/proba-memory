import type { ActionOutcomeLink, ActionRef, Logger, OutcomeLinker } from '@smallseedlabs/proba-memory-core';

const key = (l: ActionOutcomeLink): string =>
  [l.workspaceId, l.action.kind, l.action.id, l.metric.platform, l.metric.accountId ?? '', l.metric.campaignId ?? '', l.metric.metric, l.before.from, l.after.to].join('|');

/** Keeps links in process memory. */
export class InMemoryOutcomeLinker implements OutcomeLinker {
  readonly name = 'memory';
  private readonly links = new Map<string, ActionOutcomeLink>();

  async record(link: ActionOutcomeLink): Promise<void> {
    this.links.set(key(link), structuredClone(link));
  }

  async list(workspaceId: string, action?: ActionRef): Promise<ActionOutcomeLink[]> {
    return structuredClone(
      [...this.links.values()].filter((l) => l.workspaceId === workspaceId && (!action || (l.action.kind === action.kind && l.action.id === action.id)))
    );
  }
}

/** Default: outcome learning is a later milestone, so links are logged and not stored. */
export class NoopOutcomeLinker implements OutcomeLinker {
  readonly name = 'noop';

  constructor(private readonly logger?: Logger) {}

  async record(link: ActionOutcomeLink): Promise<void> {
    this.logger?.debug('outcome link not stored (outcome learning is not enabled)', {
      workspaceId: link.workspaceId,
      action: link.action,
      metric: link.metric.metric,
      sampleSize: link.sampleSize,
    });
  }

  async list(): Promise<ActionOutcomeLink[]> {
    return [];
  }
}
