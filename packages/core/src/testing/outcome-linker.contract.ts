import { describe, expect, it } from 'vitest';
import type { ActionOutcomeLink, OutcomeLinker } from '../ports/outcome-linker.js';
import { uniqueName } from './fixtures.js';

const link = (workspaceId: string, id: string, metric = 'conversions'): ActionOutcomeLink => ({
  workspaceId,
  action: { kind: 'approval', id },
  metric: { platform: 'meta', campaignId: 'cmp_1', metric },
  before: { from: '2026-10-18T00:00:00.000Z', to: '2026-10-25T00:00:00.000Z' },
  after: { from: '2026-10-25T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
  beforeMean: 10,
  afterMean: 12,
  sampleSize: { before: 168, after: 168 },
  relativeChange: 0.2,
  correlation: null,
  method: 'window-means',
  caveat: 'correlation_not_causation',
});

/** Contract any OutcomeLinker adapter must satisfy. */
export function runOutcomeLinkerContract(name: string, factory: () => OutcomeLinker): void {
  describe(`OutcomeLinker contract: ${name}`, () => {
    it('records a link with its sample size and caveat and lists it by workspace', async () => {
      const linker = factory();
      const ws = uniqueName('ws');
      await linker.record(link(ws, 'a1'));
      const [got] = await linker.list(ws);
      expect(got).toMatchObject({ sampleSize: { before: 168, after: 168 }, caveat: 'correlation_not_causation', relativeChange: 0.2 });
    });

    it('is idempotent for the same action, metric and windows, and keeps different metrics apart', async () => {
      const linker = factory();
      const ws = uniqueName('ws');
      await linker.record(link(ws, 'a1'));
      await linker.record(link(ws, 'a1'));
      await linker.record(link(ws, 'a1', 'spend'));
      expect(await linker.list(ws)).toHaveLength(2);
      expect(await linker.list(ws, { kind: 'approval', id: 'a1' })).toHaveLength(2);
      expect(await linker.list(ws, { kind: 'approval', id: 'zzz' })).toHaveLength(0);
    });

    it('never lists another workspace', async () => {
      const linker = factory();
      const a = uniqueName('wsA');
      const b = uniqueName('wsB');
      await linker.record(link(a, 'a1'));
      expect(await linker.list(b)).toEqual([]);
    });
  });
}
