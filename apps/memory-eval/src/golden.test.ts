import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoldenSetError, loadGoldenSet, parseGoldenSet, stableStringify } from './golden.js';
import { BUNDLED_GOLDEN } from './bundled.testing.js';

const minimal = () => ({
  version: 1,
  name: 'mini',
  workspace: 'ws',
  observations: [{ key: 'o1', occurredAt: '2026-09-01T10:00:00Z', text: 'We like short headlines.' }],
  queries: [{ id: 'q1', query: 'headlines', expect: { observations: ['o1'], facts: [{ value: 'short', grade: 3 }] } }],
});

describe('golden set loader', () => {
  it('loads the bundled golden set', () => {
    const g = loadGoldenSet(BUNDLED_GOLDEN);
    expect(g.name).toBe('bundled');
    expect(g.observations.length).toBeGreaterThanOrEqual(10);
    expect(g.queries.length).toBeGreaterThanOrEqual(10);
    expect(g.k).toEqual([1, 3, 5]);
    // sorted by time, whatever the order in the file
    const times = g.observations.map((o) => o.occurredAt);
    expect([...times].sort()).toEqual(times);
  });

  it('normalises targets, defaults and the query time', () => {
    const g = parseGoldenSet(minimal());
    const q = g.queries[0]!;
    expect(q.targets).toEqual([
      { kind: 'observation', value: 'o1', grade: 1 },
      { kind: 'fact', value: 'short', grade: 3 },
    ]);
    expect(q.asOf).toBe('2026-09-01T10:00:00.000Z');
    expect(g.observations[0]).toMatchObject({ kind: 'thread.message', polarity: 'neutral', workspace: 'ws', ref: 'eval:mini:o1' });
    expect(g.k).toEqual([1, 3, 5]);
  });

  it('reads YAML and JSON files and gives the same digest for the same content in any key order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-'));
    const json = join(dir, 'a.json');
    const yml = join(dir, 'b.yaml');
    writeFileSync(json, JSON.stringify(minimal()));
    writeFileSync(
      yml,
      `queries:\n  - { id: q1, query: headlines, expect: { facts: [{ grade: 3, value: short }], observations: [o1] } }\nobservations:\n  - { text: "We like short headlines.", occurredAt: 2026-09-01T10:00:00Z, key: o1 }\nworkspace: ws\nname: mini\nversion: 1\n`
    );
    expect(loadGoldenSet(yml).digest).toBe(loadGoldenSet(json).digest);
    expect(() => loadGoldenSet(join(dir, 'x.txt'))).toThrow(/yaml, .yml or .json/);
    expect(() => loadGoldenSet(join(dir, 'missing.yaml'))).toThrow(GoldenSetError);
  });

  it('changes the digest when anything that is measured changes', () => {
    const a = parseGoldenSet(minimal());
    const changed = minimal();
    changed.queries[0]!.query = 'how long are headlines';
    expect(parseGoldenSet(changed).digest).not.toBe(a.digest);
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  it.each([
    ['an unknown observation in expect', (d: ReturnType<typeof minimal>) => (d.queries[0]!.expect.observations = ['nope']), /unknown observation "nope"/],
    ['a duplicate observation key', (d: ReturnType<typeof minimal>) => d.observations.push({ ...d.observations[0]!, text: 'other text' }), /key "o1" is used twice/],
    ['a repeated observation text', (d: ReturnType<typeof minimal>) => d.observations.push({ ...d.observations[0]!, key: 'o2' }), /repeats the text/],
    ['a duplicate query id', (d: ReturnType<typeof minimal>) => d.queries.push({ ...d.queries[0]! }), /query id "q1" is used twice/],
    ['a query that expects nothing', (d: ReturnType<typeof minimal>) => (d.queries[0]!.expect = { observations: [], facts: [] }), /expects nothing/],
    ['a timestamp without a timezone', (d: ReturnType<typeof minimal>) => (d.observations[0]!.occurredAt = '2026-09-01T10:00:00'), /timezone/],
    ['a wrong version', (d: ReturnType<typeof minimal>) => ((d as { version: number }).version = 2), /version/],
    ['an unknown field', (d: ReturnType<typeof minimal>) => ((d as Record<string, unknown>)['surprise'] = 1), /surprise|Unrecognized/],
  ])('rejects %s', (_name, mutate, message) => {
    const doc = minimal();
    mutate(doc);
    expect(() => parseGoldenSet(doc)).toThrow(message);
  });

  it('needs a time for queries when there is neither `now` nor an observation', () => {
    expect(() => parseGoldenSet({ version: 1, name: 'x', workspace: 'w', queries: [{ id: 'q', query: 'q', expect: { facts: ['f'] } }] })).toThrow(/no asOf/);
  });
});
