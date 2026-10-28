import type { Observation } from '../domain/index.js';

/** Longest owner id kept. Longer ids are not user ids: the memory is stored with no owner. */
export const MAX_OWNER_ID_LENGTH = 128;

/**
 * The user a memory learned from an observation belongs to: the user who acted (`actor` of type `user`, the actor of the audit
 * event), otherwise the user the event is about (`userId`). Null when no user is behind the observation, for example a system or
 * brain action with no user: such a memory has no owner.
 */
export function ownerOfObservation(observation: Pick<Observation, 'actor' | 'userId'>): string | null {
  const candidates = [observation.actor?.type === 'user' ? observation.actor.id : undefined, observation.userId];
  for (const candidate of candidates) {
    const id = typeof candidate === 'string' ? candidate.trim() : '';
    if (id !== '' && id.length <= MAX_OWNER_ID_LENGTH) return id;
  }
  return null;
}
