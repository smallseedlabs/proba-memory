import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

export interface FakeOpenAiServer {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Status codes to answer with before behaving normally (for example [500, 500]). */
  failWith: number[];
  /** Chat replies to return, in order; when empty a default JSON reply is used. A null entry returns an empty message. */
  chatReplies: (string | null)[];
  close(): Promise<void>;
}

function hashVector(text: string, dimension: number): number[] {
  const v: number[] = [];
  let counter = 0;
  while (v.length < dimension) {
    const h = createHash('sha256').update(`${text}:${counter++}`).digest();
    for (let i = 0; i + 1 < h.length && v.length < dimension; i += 2) v.push(h.readUInt16BE(i) / 65535 - 0.5);
  }
  return v;
}

/** A tiny OpenAI-compatible HTTP server for adapter tests (/embeddings and /chat/completions). */
export async function startFakeOpenAiServer(options: { dimension?: number } = {}): Promise<FakeOpenAiServer> {
  const state = { requests: [] as RecordedRequest[], failWith: [] as number[], chatReplies: [] as (string | null)[] };
  const dimension = options.dimension ?? 8;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      state.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const fail = state.failWith.shift();
      if (fail) return send(fail, { error: { message: `forced ${fail}` } });
      if (req.url?.endsWith('/embeddings')) {
        const input = (Array.isArray(body.input) ? body.input : [body.input]) as string[];
        const dims = typeof body.dimensions === 'number' ? body.dimensions : dimension;
        // Answer out of order on purpose: clients must use `index`.
        const data = input.map((t, index) => ({ index, embedding: hashVector(String(t), dims) })).reverse();
        return send(200, { data });
      }
      if (req.url?.endsWith('/chat/completions')) {
        const next = state.chatReplies.length > 0 ? state.chatReplies.shift() : '{"memories":[]}';
        return send(200, {
          model: String(body.model),
          choices: [{ index: 0, message: { role: 'assistant', content: next }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        });
      }
      return send(404, { error: { message: 'not found' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: state.requests,
    get failWith() {
      return state.failWith;
    },
    set failWith(v: number[]) {
      state.failWith = v;
    },
    get chatReplies() {
      return state.chatReplies;
    },
    set chatReplies(v: (string | null)[]) {
      state.chatReplies = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as FakeOpenAiServer;
}
