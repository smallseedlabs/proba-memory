import type { ZodType } from 'zod';
import type { Logger } from '../ports/logger.js';
import { LlmProviderError, type LlmMessage, type LlmProvider } from '../ports/llm-provider.js';

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastIssues: string[]
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

/** Pull the first balanced JSON object out of a reply (models sometimes wrap it in prose or code fences). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface StructuredRequest<T> {
  llm: LlmProvider;
  system: string;
  user: string;
  schema: ZodType<T>;
  /** Total tries including the first. */
  maxAttempts: number;
  temperature?: number;
  maxTokens?: number;
  logger: Logger;
}

export interface StructuredResult<T> {
  value: T;
  attempts: number;
  usage: { promptTokens: number; completionTokens: number };
  model: string;
}

/**
 * Plain JSON-mode prompting with strict validation: ask for JSON, parse, validate with zod; if the reply
 * is unusable, tell the model what was wrong and ask again, up to `maxAttempts`. No tool calling is assumed.
 * A non-retryable provider error is rethrown at once; a retryable one counts as an attempt.
 */
export async function generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const messages: LlmMessage[] = [
    { role: 'system', content: request.system },
    { role: 'user', content: request.user },
  ];
  const usage = { promptTokens: 0, completionTokens: 0 };
  let issues: string[] = [];
  for (let attempt = 1; attempt <= request.maxAttempts; attempt += 1) {
    let content: string;
    let model = request.llm.model;
    try {
      const response = await request.llm.complete({
        messages,
        json: true,
        temperature: request.temperature ?? 0,
        maxTokens: request.maxTokens,
      });
      content = response.content;
      model = response.model;
      usage.promptTokens += response.usage?.promptTokens ?? 0;
      usage.completionTokens += response.usage?.completionTokens ?? 0;
    } catch (err) {
      if (err instanceof LlmProviderError && !err.retryable) throw err;
      issues = [err instanceof Error ? err.message : String(err)];
      request.logger.warn('llm call failed', { attempt, err });
      if (attempt === request.maxAttempts) break;
      continue;
    }
    const json = extractJsonObject(content);
    let parsedValue: unknown;
    if (json === null) {
      issues = ['the reply contains no JSON object'];
    } else {
      try {
        parsedValue = JSON.parse(json);
        const result = request.schema.safeParse(parsedValue);
        if (result.success) return { value: result.data, attempts: attempt, usage, model };
        issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      } catch {
        issues = ['the JSON could not be parsed'];
      }
    }
    request.logger.warn('llm reply rejected', { attempt, issues: issues.slice(0, 5) });
    messages.push(
      { role: 'assistant', content: content.slice(0, 4000) },
      {
        role: 'user',
        content: `That reply was not valid: ${issues.slice(0, 5).join('; ')}. Reply again with ONLY the corrected JSON object.`,
      }
    );
  }
  throw new StructuredOutputError(`no valid structured output after ${request.maxAttempts} attempts`, request.maxAttempts, issues);
}
