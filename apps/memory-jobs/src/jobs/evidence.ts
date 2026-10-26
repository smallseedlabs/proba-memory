import type { Memory, MemoryStore, StoredObservation } from '@smallseedlabs/proba-memory-core';

/** The strongest preference signal in the system: a person granted or rejected something. */
export const isDecisive = (kind: string): boolean => kind === 'approval.granted' || kind === 'approval.rejected';

export interface PreferenceEvidence {
  /** Approvals and rejections that agree with the memory's stance (neutral memories agree with both). */
  agree: number;
  /** Approvals and rejections that point the other way. */
  disagree: number;
  /** Observations that were not approvals or rejections (the rest of the memory's evidence count). */
  other: number;
  /** decisiveWeight * (agree - disagree) + other, never below 0. */
  weighted: number;
}

/**
 * How strongly the memory is backed, counting approvals and rejections as the strongest signal: each that agrees
 * counts `decisiveWeight` times an ordinary observation, each that disagrees subtracts as much. Observation ids are
 * capped on a memory, so evidence beyond the ids that can be looked up counts as ordinary.
 */
export async function preferenceEvidence(
  store: Pick<MemoryStore, 'getObservation'>,
  memory: Memory,
  decisiveWeight: number
): Promise<PreferenceEvidence> {
  let agree = 0;
  let disagree = 0;
  for (const id of memory.provenance.observationIds) {
    const o: StoredObservation | null = await store.getObservation(memory.workspaceId, id);
    if (!o || !isDecisive(o.kind)) continue;
    const granted = o.kind === 'approval.granted';
    const stance = memory.provenance.stance;
    if (stance === 'neutral' || (stance === 'positive') === granted) agree += 1;
    else disagree += 1;
  }
  const other = Math.max(0, memory.evidenceCount - agree - disagree);
  return { agree, disagree, other, weighted: Math.max(0, decisiveWeight * (agree - disagree) + other) };
}
