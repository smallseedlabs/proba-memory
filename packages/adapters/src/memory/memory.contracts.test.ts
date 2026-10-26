import {
  runClockContract,
  runEventBusContract,
  runHubContentSourceContract,
  runIdGeneratorContract,
  runJobRunStoreContract,
  runJobSchedulerContract,
  runMemoryStoreContract,
  runOutboxStoreContract,
  runOutcomeLinkerContract,
  runRetrievalLogStoreContract,
  runScoringProfileStoreContract,
  runTokenCounterContract,
  runVectorIndexContract,
} from '@smallseedlabs/proba-memory-core/testing';
import { SystemClock, RandomIdGenerator } from '../runtime/system.js';
import { IntervalJobScheduler, ManualJobScheduler } from '../scheduler/interval-scheduler.js';
import { DevHubContentSource } from '../sources/dev-content-source.js';
import { SequentialIdGenerator } from './clock-ids.js';
import { InMemoryEventBus } from './event-bus.js';
import { InMemoryJobRunStore } from './job-run-store.js';
import { InMemoryMemoryStore, InMemoryVectorIndex } from './memory-store.js';
import { InMemoryOutboxStore } from './outbox-store.js';
import { InMemoryOutcomeLinker } from './outcome-linker.js';
import { InMemoryScoringProfileStore } from './profile-store.js';
import { InMemoryRetrievalLogStore } from './retrieval-log-store.js';
import { ApproxTokenCounter } from './token-counter.js';

const DIM = 8;

runClockContract('system clock', () => new SystemClock());
runIdGeneratorContract('random ids', () => new RandomIdGenerator());
runIdGeneratorContract('sequential ids', () => new SequentialIdGenerator());
runTokenCounterContract('approx', () => new ApproxTokenCounter());

runMemoryStoreContract('in-memory', async () => ({ store: new InMemoryMemoryStore(), dimension: DIM }));
runVectorIndexContract('in-memory', async () => {
  const store = new InMemoryMemoryStore();
  return { store, index: new InMemoryVectorIndex(store, DIM) };
});
runScoringProfileStoreContract('in-memory', async () => ({ store: new InMemoryScoringProfileStore() }));
runRetrievalLogStoreContract('in-memory', async () => ({ store: new InMemoryRetrievalLogStore() }));
runJobRunStoreContract('in-memory', async () => ({ store: new InMemoryJobRunStore() }));
runOutboxStoreContract('in-memory', async () => ({ store: new InMemoryOutboxStore() }));
runEventBusContract('in-memory', async () => ({ bus: new InMemoryEventBus() }));
runOutcomeLinkerContract('in-memory', () => new InMemoryOutcomeLinker());
runJobSchedulerContract('interval', async () => ({ scheduler: new IntervalJobScheduler(), ticks: true }));
runJobSchedulerContract('manual', async () => ({ scheduler: new ManualJobScheduler(), ticks: false }));
runHubContentSourceContract('development source', async () => ({
  source: new DevHubContentSource({ workspaceId: 'ws-dev', seed: 'contract', nodeEnv: 'test', allowDev: false }),
}));
