import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_NAME, DEFAULT_SCORING_CONFIG_V1, GLOBAL_PROFILE_WORKSPACE } from '@smallseedlabs/proba-memory-scoring';
import type { ScoringProfileStore } from '../ports/scoring-profile-store.js';
import { uniqueName } from './fixtures.js';

export interface ScoringProfileStoreHarness {
  store: ScoringProfileStore;
  cleanup?: () => Promise<void>;
}

/** Contract any ScoringProfileStore adapter must satisfy. */
export function runScoringProfileStoreContract(name: string, factory: () => Promise<ScoringProfileStoreHarness>): void {
  describe(`ScoringProfileStore contract: ${name}`, () => {
    const open: ScoringProfileStoreHarness[] = [];
    const make = async (): Promise<ScoringProfileStoreHarness> => {
      const h = await factory();
      open.push(h);
      return h;
    };
    afterEach(async () => {
      for (const h of open.splice(0)) {
        await h.cleanup?.();
        await h.store.close();
      }
    });

    it('ensures the default profile once: global, version 1, active', async () => {
      const { store } = await make();
      const a = await store.ensureDefault();
      const b = await store.ensureDefault();
      expect(b.id).toBe(a.id);
      expect(a).toMatchObject({ workspaceId: GLOBAL_PROFILE_WORKSPACE, name: DEFAULT_PROFILE_NAME, version: 1, status: 'active' });
      expect(a.config).toEqual(DEFAULT_SCORING_CONFIG_V1);
      const ws = uniqueName('ws');
      const resolved = await store.resolve(ws, DEFAULT_PROFILE_NAME);
      expect(resolved.some((p) => p.id === a.id && p.status === 'active')).toBe(true);
      expect((await store.list(ws)).some((p) => p.id === a.id)).toBe(true);
    });

    it('stores a new version per workspace and name, numbered from 1', async () => {
      const { store } = await make();
      await store.ensureDefault();
      const ws = uniqueName('ws');
      const config = { ...DEFAULT_SCORING_CONFIG_V1, weights: { ...DEFAULT_SCORING_CONFIG_V1.weights, recency: 0.4 } };
      const v1 = await store.put({ workspaceId: ws, name: 'tuned', config, createdBy: 'tester', description: 'more recency' });
      const v2 = await store.put({ workspaceId: ws, name: 'tuned', config, createdBy: 'tester' });
      expect([v1.version, v2.version]).toEqual([1, 2]);
      expect(v1).toMatchObject({ workspaceId: ws, name: 'tuned', status: 'draft', description: 'more recency', createdBy: 'tester' });
      expect(v1.config.weights.recency).toBe(0.4);
      const other = await store.put({ workspaceId: uniqueName('ws'), name: 'tuned', config, createdBy: 't' });
      expect(other.version).toBe(1);
    });

    it('rolls a version out: shadow, canary, active (the previous active one is retired)', async () => {
      const { store } = await make();
      await store.ensureDefault();
      const ws = uniqueName('ws');
      const v1 = await store.put({ workspaceId: ws, name: DEFAULT_PROFILE_NAME, config: DEFAULT_SCORING_CONFIG_V1, createdBy: 't' });
      const v2 = await store.put({ workspaceId: ws, name: DEFAULT_PROFILE_NAME, config: DEFAULT_SCORING_CONFIG_V1, createdBy: 't' });
      await store.setStatus(ws, DEFAULT_PROFILE_NAME, v1.version, 'active');
      const shadow = await store.setStatus(ws, DEFAULT_PROFILE_NAME, v2.version, 'shadow');
      expect(shadow?.status).toBe('shadow');
      const canary = await store.setStatus(ws, DEFAULT_PROFILE_NAME, v2.version, 'canary', 25);
      expect(canary).toMatchObject({ status: 'canary', canaryPercent: 25 });
      let set = await store.resolve(ws, DEFAULT_PROFILE_NAME);
      expect(set.map((p) => [p.version, p.status]).sort()).toEqual([
        [1, 'active'],
        [2, 'canary'],
      ]);
      await store.setStatus(ws, DEFAULT_PROFILE_NAME, v2.version, 'active');
      set = await store.resolve(ws, DEFAULT_PROFILE_NAME);
      expect(set.find((p) => p.version === 2)?.status).toBe('active');
      expect(set.filter((p) => p.status === 'active')).toHaveLength(1);
      expect(set.find((p) => p.version === 1)?.status).toBe('retired');
      expect(await store.setStatus(ws, DEFAULT_PROFILE_NAME, 99, 'active')).toBeNull();
    });

    it('prefers the workspace profile over the global one once it has an active version', async () => {
      const { store } = await make();
      const global = await store.ensureDefault();
      const ws = uniqueName('ws');
      const own = await store.put({ workspaceId: ws, name: DEFAULT_PROFILE_NAME, config: DEFAULT_SCORING_CONFIG_V1, createdBy: 't' });
      // Not active yet: the global profile still governs.
      expect((await store.resolve(ws, DEFAULT_PROFILE_NAME)).some((p) => p.id === global.id)).toBe(true);
      await store.setStatus(ws, DEFAULT_PROFILE_NAME, own.version, 'active');
      const set = await store.resolve(ws, DEFAULT_PROFILE_NAME);
      expect(set.every((p) => p.workspaceId === ws)).toBe(true);
      // Another workspace is unaffected.
      expect((await store.resolve(uniqueName('ws'), DEFAULT_PROFILE_NAME)).every((p) => p.workspaceId === GLOBAL_PROFILE_WORKSPACE)).toBe(true);
      expect((await store.list(uniqueName('ws'))).some((p) => p.id === own.id)).toBe(false);
    });

    it('rejects an invalid config and an out-of-range canary percentage', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const bad = { ...DEFAULT_SCORING_CONFIG_V1, weights: { relevance: 0, recency: 0, importance: 0, confidence: 0, usefulness: 0 } };
      await expect(store.put({ workspaceId: ws, name: 'bad', config: bad, createdBy: 't' })).rejects.toThrow();
      const ok = await store.put({ workspaceId: ws, name: 'ok', config: DEFAULT_SCORING_CONFIG_V1, createdBy: 't' });
      await expect(store.setStatus(ws, 'ok', ok.version, 'canary', 150)).rejects.toThrow();
    });

    it('answers ping', async () => {
      const { store } = await make();
      await expect(store.ping()).resolves.toBeUndefined();
    });
  });
}
