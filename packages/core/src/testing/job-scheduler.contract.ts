import { afterEach, describe, expect, it } from 'vitest';
import type { JobScheduler } from '../ports/job-scheduler.js';
import { sleep } from './fixtures.js';

export interface JobSchedulerHarness {
  scheduler: JobScheduler;
  /** False for a scheduler that only runs jobs when triggered. */
  ticks: boolean;
}

/** Contract any JobScheduler adapter must satisfy. */
export function runJobSchedulerContract(name: string, factory: () => Promise<JobSchedulerHarness>): void {
  describe(`JobScheduler contract: ${name}`, () => {
    const open: JobScheduler[] = [];
    const make = async (): Promise<JobSchedulerHarness> => {
      const h = await factory();
      open.push(h.scheduler);
      return h;
    };
    afterEach(async () => {
      for (const s of open.splice(0)) await s.stop();
    });

    it('runs a registered job when triggered, with the manual trigger', async () => {
      const { scheduler } = await make();
      const seen: string[] = [];
      scheduler.register({ name: 'j', intervalMs: 3_600_000, run: async (t) => void seen.push(t) });
      expect(scheduler.names()).toEqual(['j']);
      await scheduler.trigger('j');
      expect(seen).toEqual(['manual']);
    });

    it('rejects an unknown job and a duplicate registration', async () => {
      const { scheduler } = await make();
      await expect(scheduler.trigger('nope')).rejects.toThrow(/unknown job/i);
      scheduler.register({ name: 'j', intervalMs: 1000, run: async () => undefined });
      expect(() => scheduler.register({ name: 'j', intervalMs: 1000, run: async () => undefined })).toThrow();
    });

    it('refuses to trigger a job that is still running', async () => {
      const { scheduler } = await make();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      scheduler.register({ name: 'slow', intervalMs: 3_600_000, run: () => gate });
      const first = scheduler.trigger('slow');
      await sleep(5);
      await expect(scheduler.trigger('slow')).rejects.toThrow(/already running/i);
      release();
      await first;
    });

    it('keeps the schedule alive when a run fails', async () => {
      const { scheduler, ticks } = await make();
      let runs = 0;
      scheduler.register({
        name: 'flaky',
        intervalMs: 15,
        initialDelayMs: 5,
        run: async () => {
          runs += 1;
          throw new Error('boom');
        },
      });
      if (ticks) {
        scheduler.start();
        await sleep(150);
        await scheduler.stop();
        expect(runs).toBeGreaterThanOrEqual(2);
      } else {
        await expect(scheduler.trigger('flaky')).rejects.toThrow('boom');
        await expect(scheduler.trigger('flaky')).rejects.toThrow('boom');
        expect(runs).toBe(2);
      }
    });

    it('never overlaps two runs of the same job and waits for a run in progress on stop', async () => {
      const { scheduler, ticks } = await make();
      if (!ticks) return;
      let active = 0;
      let maxActive = 0;
      let finished = 0;
      scheduler.register({
        name: 'overlap',
        intervalMs: 10,
        initialDelayMs: 5,
        run: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(60);
          active -= 1;
          finished += 1;
        },
      });
      scheduler.start();
      await sleep(120);
      await scheduler.stop();
      expect(maxActive).toBe(1);
      expect(active).toBe(0);
      expect(finished).toBeGreaterThanOrEqual(1);
      const after = finished;
      await sleep(80);
      expect(finished).toBe(after);
    });
  });
}
