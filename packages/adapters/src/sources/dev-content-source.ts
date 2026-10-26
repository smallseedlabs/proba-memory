import { createHash } from 'node:crypto';
import { deterministicUuid, type ContentItem, type ContentPage, type HubContentSource } from '@smallseedlabs/proba-memory-core';

export const DEV_SOURCE_PREFIX = 'dev:';

/**
 * The credential-shaped string planted in one development message, to show that redaction removes it
 * before anything is stored. Assembled at runtime from a hash, so no source file holds a literal that
 * looks like a real key.
 */
export const DEV_CONTENT_API_KEY = ['sk', 'live', createHash('sha256').update('proba-dev-content-reporting-key').digest('hex').slice(0, 32)].join('-');

export interface DevHubContentSourceOptions {
  workspaceId: string;
  seed: string;
  nodeEnv: string;
  /** ALLOW_DEV_CONTENT_SOURCE: the explicit opt-in to run this source in production. */
  allowDev: boolean;
  /** Time of the first item; later items follow every six hours. Default 2026-10-01T09:00:00.000Z. */
  startAt?: string;
}

interface Scenario {
  kind: ContentItem['kind'];
  goal: number;
  thread?: number;
  author?: 'user' | 'brain';
  decision?: ContentItem['decision'];
  text: string;
}

/** A realistic marketing workspace: goals, approvals answered by a person, and conversation about preferences. */
const SCENARIOS: Scenario[] = [
  { kind: 'goal', goal: 1, text: 'Launch the autumn collection with a prospecting campaign on Meta and Google. Monthly budget 12000 USD, target ROAS 3.5.' },
  { kind: 'thread_message', goal: 1, thread: 1, author: 'user', text: 'We never use stock photos of people shaking hands. Real customers or lifestyle shots only.' },
  { kind: 'thread_message', goal: 1, thread: 1, author: 'user', text: 'Please keep all headlines under 40 characters, our placements truncate longer ones.' },
  { kind: 'approval', goal: 1, decision: 'requested', author: 'brain', text: "Creative set A: red banner with the headline '40% OFF TODAY ONLY' and a countdown timer." },
  { kind: 'approval', goal: 1, decision: 'rejected', author: 'user', text: "Creative set A: red banner with the headline '40% OFF TODAY ONLY' and a countdown timer. Reason: the discount banner with a countdown timer feels pushy and off-brand." },
  { kind: 'approval', goal: 1, decision: 'granted', author: 'user', text: 'Creative set B: lifestyle imagery of the collection outdoors with a soft call to action.' },
  { kind: 'thread_message', goal: 1, thread: 1, author: 'user', text: 'Brand tone is warm and plain-spoken. Avoid jargon and exclamation marks.' },
  { kind: 'approval', goal: 1, decision: 'rejected', author: 'user', text: 'Raise the daily budget on prospecting from 300 to 600 USD for the weekend. Reason: wait for two weeks of data before scaling.' },
  { kind: 'goal', goal: 2, text: 'Win back lapsed customers from the last six months using email-matched audiences and a 10% loyalty offer.' },
  { kind: 'thread_message', goal: 2, thread: 2, author: 'user', text: 'I prefer you check with me before changing any budget by more than 20 percent.' },
  { kind: 'thread_message', goal: 2, thread: 2, author: 'user', text: 'The target audience is women 28 to 45 in urban areas who already follow sustainability content.' },
  { kind: 'approval', goal: 2, decision: 'granted', author: 'user', text: 'Shift 15% of the Meta budget to Google search on brand terms.' },
  { kind: 'approval', goal: 2, decision: 'rejected', author: 'user', text: 'Use customer first names in ad copy. Reason: the privacy team does not allow names in ads.' },
  { kind: 'thread_message', goal: 2, thread: 2, author: 'user', text: 'Our CFO wants weekly spend reports on Monday mornings, as a short summary and not a spreadsheet.' },
  { kind: 'approval', goal: 2, decision: 'granted', author: 'user', text: 'Pause the ad set cold-lookalike-3 that spent 900 USD without a single conversion.' },
  { kind: 'goal', goal: 3, text: 'Grow newsletter sign-ups by 20% before the holiday season using lead-form ads.' },
  { kind: 'thread_message', goal: 3, thread: 3, author: 'user', text: 'Again: no stock photos with handshakes please. Lifestyle photography works best for us.' },
  { kind: 'approval', goal: 3, decision: 'granted', author: 'user', text: 'Creative set C: a short headline under 40 characters with benefit-led copy.' },
  { kind: 'approval', goal: 3, decision: 'rejected', author: 'user', text: "Creative set D: a flashing 'LAST CHANCE' banner with a countdown timer. Reason: countdown timers feel pushy." },
  { kind: 'thread_message', goal: 3, thread: 3, author: 'user', text: 'Thanks, the lifestyle creatives performed much better than expected last week.' },
  { kind: 'thread_message', goal: 3, thread: 3, author: 'user', text: 'Remember that Thursday launches work best for us. Never launch on Fridays.' },
  { kind: 'approval', goal: 3, decision: 'expired', author: 'brain', text: 'Increase the retargeting frequency cap to 8 impressions per week.' },
  { kind: 'goal', goal: 4, text: 'Reduce the cost per acquisition on branded search below 18 USD without losing impression share.' },
  {
    kind: 'thread_message',
    goal: 4,
    thread: 4,
    author: 'user',
    text: `To connect the reporting tool use the key ${DEV_CONTENT_API_KEY} and send results to jo.marketing@example.com or call +44 7700 900123.`,
  },
  { kind: 'approval', goal: 4, decision: 'granted', author: 'user', text: 'Add exact-match brand keywords and a negative keyword list for competitor names.' },
];

/**
 * Development HubContentSource: generates a believable workspace history (goals, answered approvals,
 * conversation about preferences, one message containing a secret and contact details to exercise
 * redaction). Every reference starts with `dev:` so it can never be mistaken for real Hub content. It
 * refuses to start in production unless ALLOW_DEV_CONTENT_SOURCE=true. Output is deterministic from the seed.
 */
export class DevHubContentSource implements HubContentSource {
  readonly name = 'dev';
  private readonly items: ContentItem[];

  constructor(options: DevHubContentSourceOptions) {
    if (options.nodeEnv === 'production' && !options.allowDev) {
      throw new Error('The development content source is not available when NODE_ENV=production. Set HUB_CONTENT_SOURCE to a real Hub feed, or ALLOW_DEV_CONTENT_SOURCE=true to run it deliberately.');
    }
    const start = new Date(options.startAt ?? '2026-10-01T09:00:00.000Z').getTime();
    const user = deterministicUuid('dev-user', options.seed);
    const goalId = (n: number): string => deterministicUuid('dev-goal', `${options.seed}:${n}`);
    const threadId = (n: number): string => deterministicUuid('dev-thread', `${options.seed}:${n}`);
    this.items = SCENARIOS.map((s, i): ContentItem => {
      const number = i + 1;
      const id = deterministicUuid('dev-content', `${options.seed}:${number}`);
      const base = {
        id,
        kind: s.kind,
        workspaceId: options.workspaceId,
        occurredAt: new Date(start + i * 6 * 3_600_000).toISOString(),
        goalId: goalId(s.goal),
        userId: user,
        author: { type: s.author ?? 'user', id: s.author === 'brain' ? 'brain' : user } as ContentItem['author'],
        text: s.text,
      };
      if (s.kind === 'goal') return { ...base, sourceRef: `${DEV_SOURCE_PREFIX}goal/${s.goal}` };
      if (s.kind === 'approval') return { ...base, decision: s.decision, sourceRef: `${DEV_SOURCE_PREFIX}approval/${number}` };
      return { ...base, threadId: threadId(s.thread ?? 1), sourceRef: `${DEV_SOURCE_PREFIX}thread/${s.thread ?? 1}/message/${number}` };
    });
  }

  /** Number of items the source will ever produce. */
  get size(): number {
    return this.items.length;
  }

  async fetch(cursor: string | null, limit: number): Promise<ContentPage> {
    const from = cursor === null ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isInteger(from) || from < 0) throw new Error('invalid cursor');
    const page = this.items.slice(from, from + Math.max(1, limit));
    const next = from + page.length;
    return { items: structuredClone(page), nextCursor: page.length === 0 ? null : String(next) };
  }

  async ping(): Promise<void> {
    // Always available.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
