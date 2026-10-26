import { describe, expect, it } from 'vitest';
import { AdapterRegistry, UnknownAdapterError } from './registry.js';

describe('AdapterRegistry', () => {
  it('creates the adapter registered under a name, passing deps', async () => {
    const r = new AdapterRegistry<{ kind: string; dep: number }, number>('Thing')
      .register('a', (dep) => ({ kind: 'a', dep }))
      .register('b', async (dep) => ({ kind: 'b', dep }));
    expect(await r.create('a', 1)).toEqual({ kind: 'a', dep: 1 });
    expect(await r.create('b', 2)).toEqual({ kind: 'b', dep: 2 });
    expect(r.names()).toEqual(['a', 'b']);
    expect(r.has('a')).toBe(true);
    expect(r.has('z')).toBe(false);
  });

  it('lists the available adapters when the name is unknown', async () => {
    const r = new AdapterRegistry<string, null>('EventBus').register('memory', () => 'm');
    await expect(r.create('kafka', null)).rejects.toThrow(UnknownAdapterError);
    await expect(r.create('kafka', null)).rejects.toThrow(/Unknown EventBus adapter "kafka". Available: memory/);
  });

  it('rejects duplicate registration', () => {
    const r = new AdapterRegistry<string, null>('X').register('a', () => 'a');
    expect(() => r.register('a', () => 'again')).toThrow(/already registered/);
  });
});
