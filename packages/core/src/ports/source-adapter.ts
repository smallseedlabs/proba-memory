/**
 * SourceAdapter port: a feed of Observations from somewhere (the audit stream, the Hub content feed).
 *
 * poll() returns items that stay pending for the adapter's consumer group until ack()ed. An item the
 * ingestor cannot process is left unacked (it is re-delivered by reclaim() and finally dead-lettered
 * by the adapter) or rejected at once. Records the adapter does not care about are acked by the
 * adapter itself and never surface.
 */

import type { Observation } from '../domain/index.js';

export interface SourceItem {
  observation: Observation;
  /** 1 on the first delivery. */
  deliveryCount: number;
  ack(): Promise<void>;
  /** Poison item: dead-letter it with a reason and acknowledge it. */
  reject(reason: string): Promise<void>;
}

export interface SourcePollOptions {
  max?: number;
  blockMs?: number;
}

export interface SourceAdapter {
  readonly name: string;
  poll(options?: SourcePollOptions): Promise<SourceItem[]>;
  /** Re-deliver items another consumer left pending for too long. */
  reclaim(options?: SourcePollOptions): Promise<SourceItem[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * What the Hub could expose so that memory can read goal, approval and thread text from the Hub itself.
 * Secondary to the audit stream: protocol v0.3.3 audit events carry the conversation text in their optional
 * admin-only `content` field, which the audit source uses first. This feed adds what audit events do not
 * hold (goal and approval wording, history from before `content` existed). The ingestor wraps any HubContentSource in a SourceAdapter that pages through it with a cursor.
 * See docs/ARCHITECTURE.md ("Hub content feed") for the proposed HTTP shape.
 */
export interface ContentItem {
  /** Stable id inside the Hub (idempotency key together with `kind`). */
  id: string;
  kind: 'goal' | 'approval' | 'thread_message';
  workspaceId: string;
  /** UTC ISO 8601. */
  occurredAt: string;
  goalId?: string;
  threadId?: string;
  userId?: string;
  /** Who wrote it. */
  author?: { type: 'user' | 'brain' | 'system'; id: string };
  /** The text: goal description, approval request/answer, message body. Redacted by the ingestor before use. */
  text: string;
  /** approval items: how it was answered. */
  decision?: 'granted' | 'rejected' | 'expired' | 'requested';
  /** Source reference, for example `hub:goal/<id>`; development data uses `dev:`. */
  sourceRef: string;
}

export interface ContentPage {
  items: ContentItem[];
  /** Pass back to continue after these items; null when there is nothing more for now. */
  nextCursor: string | null;
}

export interface HubContentSource {
  readonly name: string;
  fetch(cursor: string | null, limit: number): Promise<ContentPage>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
