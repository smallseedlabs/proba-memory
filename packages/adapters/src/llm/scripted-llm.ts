import { LlmProviderError, type LlmProvider, type LlmRequest, type LlmResponse } from '@smallseedlabs/proba-memory-core';

export const SCRIPTED_LLM_MODEL = 'scripted-rules-1';

export type Responder = (request: LlmRequest, callIndex: number) => string | Promise<string>;

export interface ScriptedLlmOptions {
  /** Produces the reply. Default: the built-in rules (`ruleBasedResponder`). */
  responder?: Responder;
  nodeEnv: string;
  /** ALLOW_SCRIPTED_LLM: the explicit opt-in to run this provider in production. */
  allowScripted: boolean;
}

/**
 * Deterministic LlmProvider for local runs and automated checks: it answers from rules (or from the
 * `responder` you pass) instead of a model, so extraction and rerank run end to end without a network.
 * Refuses production unless ALLOW_SCRIPTED_LLM=true.
 */
export class ScriptedLlmProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly model = SCRIPTED_LLM_MODEL;
  /** Every request received, for assertions. */
  readonly calls: LlmRequest[] = [];
  private readonly responder: Responder;

  constructor(options: ScriptedLlmOptions) {
    if (options.nodeEnv === 'production' && !options.allowScripted) {
      throw new Error('The scripted LLM provider is not available when NODE_ENV=production. Configure LLM_PROVIDER=deepseek, or set ALLOW_SCRIPTED_LLM=true to run it deliberately.');
    }
    this.responder = options.responder ?? ruleBasedResponder;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.messages.length === 0) throw new LlmProviderError('a chat request needs at least one message', false);
    this.calls.push(request);
    const content = await this.responder(request, this.calls.length - 1);
    const promptTokens = Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    return { content, model: this.model, usage: { promptTokens, completionTokens: Math.ceil(content.length / 4) }, finishReason: 'stop' };
  }

  async ping(): Promise<void> {
    // Always available.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

interface ViewedObservation {
  kind?: string;
  text?: string | null;
  actor?: { type?: string; id?: string } | null;
  target?: { type?: string; id?: string } | null;
  goalId?: string | null;
  signal?: { polarity?: string; strength?: number; reason?: string };
  facts?: Record<string, unknown>;
}

const POSITIVE_WORDS = /\b(prefer|prefers|always|love|loves|like|likes|works well|works best|must use|should use)\b/i;
const NEGATIVE_WORDS = /\b(never|avoid|don't|dont|do not|hate|hates|dislike|dislikes|too aggressive|not allowed|must not|stop using)\b/i;

const clip = (s: string, n = 220): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

function statement(o: ViewedObservation): { memories: unknown[] } {
  const kind = o.kind ?? '';
  const text = (o.text ?? '').replace(/\s+/g, ' ').trim();
  const target = o.target?.type ? `${o.target.type}${o.target.id ? ` ${o.target.id}` : ''}` : 'item';
  const goal = o.goalId ? ` for goal ${o.goalId}` : '';
  const polarity = o.signal?.polarity === 'positive' || o.signal?.polarity === 'negative' ? o.signal.polarity : 'neutral';
  const memory = (category: string, content: string, importance: number, confidence: number, stance: string) => ({
    category,
    content: clip(content, 300),
    summary: clip(content, 120),
    importance,
    confidence,
    stance,
  });

  if (kind === 'approval.granted' || kind === 'goal.budget_approved') {
    return { memories: [memory('semantic', text ? `The user approved: ${clip(text)}` : `The user approved the ${target}${goal}.`, 0.8, 0.7, 'positive')] };
  }
  if (kind === 'approval.rejected' || kind === 'goal.budget_declined') {
    const why = typeof o.facts?.reason === 'string' && o.facts.reason ? ` Reason: ${o.facts.reason}` : '';
    return { memories: [memory('semantic', text ? `The user rejected: ${clip(text)}${why}` : `The user rejected the ${target}${goal}.${why}`, 0.85, 0.75, 'negative')] };
  }
  if (kind === 'approval.expired') {
    return { memories: [memory('episodic', `An approval request for the ${target}${goal} expired without an answer.`, 0.4, 0.8, 'neutral')] };
  }
  if (kind === 'approval.requested') {
    return { memories: [memory('episodic', text ? `Approval was requested: ${clip(text)}` : `Approval was requested for the ${target}${goal}.`, 0.35, 0.8, 'neutral')] };
  }
  if (kind === 'goal.created' || kind === 'goal') {
    return { memories: [memory('episodic', text ? `A goal was set: ${clip(text)}` : `A goal was created${goal}.`, 0.6, 0.8, 'neutral')] };
  }
  if (kind === 'goal.status_changed' || kind === 'goal.updated' || kind === 'goal.budget_proposed' || kind === 'goal.clarification_answered') {
    const to = typeof o.facts?.to === 'string' ? ` to ${o.facts.to}` : '';
    return { memories: [memory('episodic', `${kind.replace('goal.', 'The goal ').replace(/_/g, ' ')}${to}${goal}.`, 0.4, 0.8, 'neutral')] };
  }
  if (kind === 'brain.decision_made') {
    const decision = typeof o.facts?.decision === 'string' ? `: ${o.facts.decision}` : '';
    return { memories: [memory('episodic', `The brain made a decision${decision}${goal}.`, 0.45, 0.75, 'neutral')] };
  }
  if (kind.startsWith('control.')) {
    return { memories: [memory('episodic', `Execution control: ${kind.replace('control.', '').replace(/_/g, ' ')}${goal}.`, 0.5, 0.9, 'neutral')] };
  }
  if (kind.startsWith('command.')) {
    return { memories: [memory('episodic', `Command ${kind.replace('command.', '')}${goal}.`, 0.2, 0.8, 'neutral')] };
  }
  if (kind === 'thread.message' && text) {
    const stance = NEGATIVE_WORDS.test(text) ? 'negative' : POSITIVE_WORDS.test(text) ? 'positive' : polarity;
    const durable = stance !== 'neutral' || /\b(budget|audience|brand|tone|target|channel|launch|deadline)\b/i.test(text);
    return { memories: [memory(durable ? 'semantic' : 'episodic', `In a conversation the user said: ${clip(text)}`, durable ? 0.65 : 0.35, 0.65, stance)] };
  }
  if (kind === 'brain.reply_generated' && text) return { memories: [memory('episodic', `The assistant replied: ${clip(text)}`, 0.3, 0.6, 'neutral')] };
  if (kind === 'brain.explanation_generated' && text) return { memories: [memory('episodic', `The assistant explained: ${clip(text)}`, 0.3, 0.6, 'neutral')] };
  if (kind === 'brain.clarification_requested' && text) return { memories: [memory('episodic', `The assistant asked: ${clip(text)}`, 0.3, 0.6, 'neutral')] };
  if (text) return { memories: [memory('episodic', clip(text), 0.4, 0.6, polarity)] };
  return { memories: [] };
}

function orderByOverlap(system: string, user: string): { order: number[] } {
  void system;
  const match = /<data>\s*([\s\S]*?)\s*<\/data>/.exec(user);
  let query = '';
  let items: { index: number; text: string }[] = [];
  try {
    const parsed = JSON.parse(match?.[1] ?? '{}') as { query?: string; memories?: { index: number; text: string }[] };
    query = parsed.query ?? '';
    items = parsed.memories ?? [];
  } catch {
    // Fall through with nothing to order.
  }
  const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const score = (t: string): number => (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => words.has(w)).length;
  return { order: [...items].sort((a, b) => score(b.text) - score(a.text) || a.index - b.index).map((i) => i.index) };
}

/** Built-in rules: turn an observation into plain statements, or order memories by word overlap with a query. */
export const ruleBasedResponder: Responder = (request) => {
  const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
  const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (/order stored memories/i.test(system)) return JSON.stringify(orderByOverlap(system, user));
  const match = /<observation>\s*([\s\S]*?)\s*<\/observation>/.exec(user);
  let observation: ViewedObservation = {};
  try {
    observation = JSON.parse(match?.[1] ?? '{}') as ViewedObservation;
  } catch {
    return JSON.stringify({ memories: [] });
  }
  return JSON.stringify(statement(observation));
};
