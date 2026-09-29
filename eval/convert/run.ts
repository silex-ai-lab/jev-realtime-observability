// Orchestrates the converters and writes eval/splits/{items.jsonl,kev-train.jsonl,stats.json}.
// Deterministic: items are sorted by item_id, JSON objects have a stable key order, and no
// timestamps or RNG state are used. Run: `node eval/convert/run.ts` (after `node eval/sources/fetch.ts`).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalItem } from '../../contracts/eval.ts';
import { convertInjecagent } from './injecagent.ts';
import { convertAsb } from './asb.ts';
import { convertToolemu } from './toolemu.ts';
import { convertTaubench } from './taubench.ts';
import { convertAgentdojo } from './agentdojo.ts';
import { finalizeSplits } from './common.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPLITS_DIR = join(HERE, '..', 'splits');

const MAX_PER_SOURCE = 600;
const MAX_TOTAL = 3000;

function byId(a: EvalItem, b: EvalItem): number {
  return a.item_id.localeCompare(b.item_id);
}

function labelKey(v: boolean | string | number): string {
  return typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
}

function sortedKeys<T extends object>(o: T): string[] {
  return Object.keys(o).sort();
}

function buildStats(items: EvalItem[]): Record<string, unknown> {
  const bySplit: Record<string, number> = {};
  const bySource: Record<string, Record<string, unknown>> = {};
  const byQuestionLabel: Record<string, Record<string, number>> = {};
  const sources = new Set(items.map(i => i.source));

  for (const s of [...sources].sort()) {
    const srcItems = items.filter(i => i.source === s);
    const split: Record<string, number> = {};
    const questions: Record<string, Record<string, number>> = {};
    for (const item of srcItems) {
      split[item.split] = (split[item.split] ?? 0) + 1;
      bySplit[item.split] = (bySplit[item.split] ?? 0) + 1;
      for (const q of item.questions) {
        const labels = (questions[q.question_id] ??= {});
        const key = labelKey(q.label);
        labels[key] = (labels[key] ?? 0) + 1;
        const global = (byQuestionLabel[q.question_id] ??= {});
        global[key] = (global[key] ?? 0) + 1;
      }
    }
    // stable key order
    const splitOut: Record<string, number> = {};
    for (const k of sortedKeys(split)) splitOut[k] = split[k];
    const qOut: Record<string, Record<string, number>> = {};
    for (const qid of sortedKeys(questions)) {
      const labels: Record<string, number> = {};
      for (const k of sortedKeys(questions[qid])) labels[k] = questions[qid][k];
      qOut[qid] = labels;
    }
    bySource[s] = { total: srcItems.length, by_split: splitOut, questions: qOut };
  }

  const bySplitOut: Record<string, number> = {};
  for (const k of sortedKeys(bySplit)) bySplitOut[k] = bySplit[k];
  const qlOut: Record<string, Record<string, number>> = {};
  for (const qid of sortedKeys(byQuestionLabel)) {
    const labels: Record<string, number> = {};
    for (const k of sortedKeys(byQuestionLabel[qid])) labels[k] = byQuestionLabel[qid][k];
    qlOut[qid] = labels;
  }

  return {
    total_items: items.length,
    by_split: bySplitOut,
    by_source: bySource,
    by_question_label: qlOut,
    notes: [
      'labels: noul questions are boolean; choice questions are the option string; score questions are the level index (0..3).',
      'splits are a deterministic hash of (source, template_id): train 60% / calibration 20% / dev 20%; AgentDojo is test-only.',
      'evidence classes: benchmark_ground_truth_derived unless marked heuristic_derived (ToolEmu).',
    ],
  };
}

function kevTrainLines(items: EvalItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.split !== 'train') continue;
    const questions: Record<string, Record<string, unknown>> = {};
    for (const q of item.questions) {
      questions[q.question_id] = { ...q.question, label: q.label };
    }
    out.push(JSON.stringify({ state: item.state, questions }));
  }
  return out;
}

function main(): void {
  const all: EvalItem[] = [
    ...convertInjecagent(),
    ...convertAsb(),
    ...convertToolemu(),
    ...convertTaubench(),
    ...convertAgentdojo(),
  ];

  // Enforce the no-state-leakage invariant (merge identical states onto one template_id), then
  // enforce caps deterministically: drop the largest item_id suffixes first, per source.
  const merged = finalizeSplits(all);
  const bySource = new Map<string, EvalItem[]>();
  for (const item of merged) {
    const list = bySource.get(item.source) ?? [];
    list.push(item);
    bySource.set(item.source, list);
  }
  const capped: EvalItem[] = [];
  for (const [source, list] of [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = list.sort(byId).slice(0, MAX_PER_SOURCE);
    capped.push(...sorted);
  }
  const final = capped.sort(byId).slice(0, MAX_TOTAL);

  for (const item of final) EvalItem.parse(item); // fail fast if a converter emits an invalid item

  mkdirSync(SPLITS_DIR, { recursive: true });
  writeFileSync(join(SPLITS_DIR, 'items.jsonl'), final.map(i => JSON.stringify(i)).join('\n') + '\n');
  writeFileSync(join(SPLITS_DIR, 'kev-train.jsonl'), kevTrainLines(final).join('\n') + '\n');
  writeFileSync(join(SPLITS_DIR, 'stats.json'), JSON.stringify(buildStats(final), null, 2) + '\n');

  const counts = new Map<string, number>();
  for (const i of final) counts.set(i.source, (counts.get(i.source) ?? 0) + 1);
  // eslint-disable-next-line no-console
  console.log(`wrote ${final.length} items: ${[...counts.entries()].sort().map(([s, n]) => `${s}=${n}`).join(', ')}`);
}

main();
