import { describe, expect, it } from 'vitest';
import { buildOutcomeLink } from './outcomes.js';

const HOUR = 3_600_000;
const at = '2026-10-20T12:00:00.000Z';
const t = (offsetHours: number): string => new Date(Date.parse(at) + offsetHours * HOUR).toISOString();
const base = { workspaceId: 'ws', action: { kind: 'approval' as const, id: 'a1' }, metric: { platform: 'meta', metric: 'conversions' }, actionAt: at, windowMs: 24 * HOUR };

describe('buildOutcomeLink', () => {
  it('compares the means before and after, with sample sizes and the correlation caveat', () => {
    const link = buildOutcomeLink({ ...base, samples: [{ at: t(-3), value: 10 }, { at: t(-1), value: 20 }, { at: t(1), value: 30 }, { at: t(5), value: 30 }, { at: t(7), value: 60 }] });
    expect(link).toMatchObject({ beforeMean: 15, afterMean: 40, sampleSize: { before: 2, after: 3 }, method: 'window-means', caveat: 'correlation_not_causation', correlation: null });
    expect(link.relativeChange).toBeCloseTo((40 - 15) / 15, 12);
    expect(link.before).toEqual({ from: t(-24), to: at });
    expect(link.after).toEqual({ from: at, to: t(24) });
  });

  it('puts the sample at the action time in the after window, and ignores samples outside both windows', () => {
    const link = buildOutcomeLink({ ...base, samples: [{ at, value: 5 }, { at: t(-25), value: 100 }, { at: t(24), value: 100 }] });
    expect(link.sampleSize).toEqual({ before: 0, after: 1 });
  });

  it('has no relative change without a baseline or with a zero baseline', () => {
    expect(buildOutcomeLink({ ...base, samples: [{ at: t(1), value: 3 }] }).relativeChange).toBeNull();
    expect(buildOutcomeLink({ ...base, samples: [{ at: t(-1), value: 0 }, { at: t(1), value: 3 }] }).relativeChange).toBeNull();
  });

  it('skips non-finite values and invalid times', () => {
    const link = buildOutcomeLink({ ...base, samples: [{ at: t(1), value: Number.NaN }, { at: 'bad', value: 1 }, { at: t(2), value: 4 }] });
    expect(link.sampleSize).toEqual({ before: 0, after: 1 });
    expect(link.afterMean).toBe(4);
  });

  it('copes with no samples at all', () => {
    expect(buildOutcomeLink({ ...base, samples: [] })).toMatchObject({ beforeMean: 0, afterMean: 0, sampleSize: { before: 0, after: 0 }, relativeChange: null });
  });
});
