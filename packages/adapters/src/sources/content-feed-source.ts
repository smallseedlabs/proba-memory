import {
  deterministicUuid,
  type ContentItem,
  type Logger,
  type Observation,
  type SourceAdapter,
  type SourceItem,
  type SourcePollOptions,
  type HubContentSource,
} from '@smallseedlabs/proba-memory-core';

export interface ContentFeedSourceOptions {
  source: HubContentSource;
  logger: Logger;
  /** Items left unacknowledged longer than this are handed out again by reclaim. Default 60000. */
  claimIdleMs?: number;
  /** Re-deliver at most this many times before the item is dropped (the observation store keeps it pending). Default 5. */
  maxDeliveries?: number;
  now?: () => number;
}

export const CONTENT_SOURCE_NAME = 'hub-content';

function convertContentItem(item: ContentItem): Observation {
  const decision = item.kind === 'approval' ? (item.decision ?? 'requested') : undefined;
  const kind = item.kind === 'goal' ? 'goal.created' : item.kind === 'approval' ? `approval.${decision}` : 'thread.message';
  let signal: Observation['signal'] = { polarity: 'neutral', strength: 0.3 };
  if (decision === 'rejected') signal = { polarity: 'negative', strength: 1 };
  else if (decision === 'granted') signal = { polarity: 'positive', strength: 0.9 };
  else if (decision === 'expired') signal = { polarity: 'neutral', strength: 0.3 };
  else if (decision === 'requested') signal = { polarity: 'neutral', strength: 0.2 };
  return {
    id: deterministicUuid('observation', `${CONTENT_SOURCE_NAME}:${item.kind}:${item.id}:${decision ?? ''}`),
    workspaceId: item.workspaceId,
    source: CONTENT_SOURCE_NAME,
    sourceRef: item.sourceRef,
    kind,
    occurredAt: item.occurredAt,
    ...(item.goalId ? { goalId: item.goalId } : {}),
    ...(item.threadId ? { threadId: item.threadId } : {}),
    ...(item.userId ? { userId: item.userId } : {}),
    ...(item.author ? { actor: item.author } : {}),
    text: item.text,
    facts: { contentKind: item.kind, ...(decision ? { decision } : {}), ...(item.author ? { authorType: item.author.type } : {}), textLength: item.text.length },
    signal,
    significance: item.kind === 'approval' ? 'high' : 'normal',
  };
}

/**
 * SourceAdapter over a HubContentSource (the text feed the Hub would provide): pages through it with a
 * cursor kept in process memory. After a restart it starts again from the beginning, which is safe because
 * observation ids are deterministic and the write path skips what it already processed.
 */
export class ContentFeedSource implements SourceAdapter {
  readonly name = CONTENT_SOURCE_NAME;
  private cursor: string | null = null;
  private readonly pending = new Map<string, { item: SourceItem; deliveredAt: number; count: number }>();
  private readonly claimIdleMs: number;
  private readonly maxDeliveries: number;
  private readonly now: () => number;

  constructor(private readonly options: ContentFeedSourceOptions) {
    this.claimIdleMs = options.claimIdleMs ?? 60_000;
    this.maxDeliveries = options.maxDeliveries ?? 5;
    this.now = options.now ?? Date.now;
  }

  async poll(options: SourcePollOptions = {}): Promise<SourceItem[]> {
    const page = await this.options.source.fetch(this.cursor, options.max ?? 50);
    if (page.nextCursor !== null) this.cursor = page.nextCursor;
    return page.items.map((c) => this.track(convertContentItem(c), 1));
  }

  async reclaim(): Promise<SourceItem[]> {
    const out: SourceItem[] = [];
    const now = this.now();
    for (const [id, p] of [...this.pending]) {
      if (now - p.deliveredAt < this.claimIdleMs) continue;
      if (p.count >= this.maxDeliveries) {
        this.pending.delete(id);
        this.options.logger.warn('content item dropped after repeated failures', { observationId: id, deliveries: p.count });
        continue;
      }
      out.push(this.track(p.item.observation, p.count + 1));
    }
    return out;
  }

  private track(observation: Observation, deliveryCount: number): SourceItem {
    const item: SourceItem = {
      observation,
      deliveryCount,
      ack: async () => {
        this.pending.delete(observation.id);
      },
      reject: async (reason: string) => {
        this.pending.delete(observation.id);
        this.options.logger.warn('content item rejected', { observationId: observation.id, reason });
      },
    };
    this.pending.set(observation.id, { item, deliveredAt: this.now(), count: deliveryCount });
    return item;
  }

  async ping(): Promise<void> {
    await this.options.source.ping();
  }

  async close(): Promise<void> {
    await this.options.source.close();
  }
}
