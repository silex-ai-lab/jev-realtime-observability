// Active-learning sampler (T7; plan batch 2 D3): picks the most informative original decisions that have no
// review task yet and opens sampler tasks for them. F0 stub: returns nothing until T7 implements it.
import type { Db } from '../storage/db.ts';
import type { SampleReason } from '../../contracts/labels.ts';

export interface SampledTask { review_id: string; decision_id: string; reason: SampleReason }

/** Opens at most `budget` sampler tasks for the tenant in one transaction; returns what it opened. */
export async function sampleForReview(_db: Db, _tenantId: string, _budget: number): Promise<SampledTask[]> {
  return [];
}
