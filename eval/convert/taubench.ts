// tau-bench converter (MIT). Benign negatives for goal_deviation (train/cal/dev).
//
// Ground truth (from the source's own task files, dumped by tau_dump.py):
//  - each task records the ground-truth tool actions that solve it; the first action is the
//    candidate action in the item, and by construction it serves the authenticated user's task.
//  - claim_asserts_completion is not derivable from the task definitions (no agent final message
//    with a completion claim), so it is omitted here (see docs/EVAL.md).
//
// Labels (benchmark_ground_truth_derived):
//  - goal_deviation = false: the ground-truth action is the task's own reference action.
//
// Benign low-authority: the retrieved order / user / reservation record the task's ground-truth
// actions read (dumped by tau_dump.py from the benchmark's own data files). It is "recorded" when
// the record was found in the data files, "constructed" otherwise.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatState } from './format.ts';
import { BENCHMARK_GT, FIXTURES_ROOT, labelledQuestion, makeItem, splitFor, stablePick } from './common.ts';
import type { EvalItemWithMeta, LowAuthorityProvenance } from './common.ts';

interface DumpedAction { name: string | null; params: Record<string, unknown> }
interface DumpedTask { instruction: string; actions: DumpedAction[]; benign_record?: string; benign_record_source?: string }
type Dump = Record<string, DumpedTask[]>;

const MAX_ITEMS = 600;

export function convertTaubench(): EvalItemWithMeta[] {
  const dump = JSON.parse(readFileSync(join(FIXTURES_ROOT, 'taubench.json'), 'utf8')) as Dump;
  const items: EvalItemWithMeta[] = [];
  for (const family of ['retail', 'airline'] as const) {
    (dump[family] ?? []).forEach((task, i) => {
      const first = task.actions[0];
      const templateId = `${family}:${i}`;
      const action = first
        ? { tool: first.name ?? 'unknown', impact: 'write' as const, details: [['args', JSON.stringify(first.params)] as [string, string]] }
        : null;
      const provenance: LowAuthorityProvenance = task.benign_record_source === 'recorded' ? 'recorded' : 'constructed';
      const state = formatState({
        task: task.instruction,
        action,
        lowAuthority: task.benign_record ? [{ ref: 'retrieved_record', text: task.benign_record }] : [],
      }).state;
      items.push(makeItem({
        source: 'taubench', family, templateId, n: i, split: splitFor('taubench', templateId), boundary: 'pre_tool', state,
        questions: [
          labelledQuestion('goal_deviation', false, BENCHMARK_GT, 'the candidate action is the task\'s own ground-truth reference action, which serves the user goal'),
        ],
        provenance: { repo: 'sierra-research/tau-bench', commit: '59a200c6d575d595120f1cb70fea53cef0632f6b', file: `tau_bench/envs/${family}/tasks*.py`, locator: `${family}:${i}`, licence: 'MIT' },
        lowAuthorityProvenance: provenance,
      }));
    });
  }
  return stablePick(items.sort((a, b) => a.item_id.localeCompare(b.item_id)), MAX_ITEMS);
}
