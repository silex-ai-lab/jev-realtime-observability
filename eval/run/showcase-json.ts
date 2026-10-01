// Writes web/demo/data/learning-evidence.json (full precision) from the committed eval and fine-tune
// artefacts — the same sources as the generated Results block in docs/EVAL.md (eval/run/summary-md.ts).
//   node eval/run/showcase-json.ts --out runs/eval-2026-09-28-v2 --ft runs/ft-kev-0.8b-2026-09-28 --ft4b runs/ft-kev-4b-2026-09-29
// Regeneration is byte-identical (no timestamps, no RNG); a drift test asserts the committed file matches.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
// @ts-expect-error browser module, pure JS shared with the demo (the one gate rule)
import { decide } from '../../web/demo/js/learning/gate.js';

const arg = (k: string, d?: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const out = arg('out')!, ft = arg('ft')!, ft4b = arg('ft4b')!;
const json = arg('json', 'web/demo/data/learning-evidence.json')!;

type Metric = number | null | number[];
type Meta = { judge_source?: string | null; rtt_p50_ms?: number; rtt_p95_ms?: number; rtt_n?: number };
const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as Record<string, Record<string, Record<string, Metric>>>;
const heldOut = (label: string, key: string): Record<string, Metric> => summary[label]?.[key] ?? {};
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const metaOf = (label: string): Meta => (summary[label]?._meta as unknown as Meta) ?? {};

// The measured table order in docs/EVAL.md's generated block (Kev-0.8B, Kev-0.8B fine-tuned, Kev-4B, Kev-4B fine-tuned).
const MODELS: ReadonlyArray<readonly [string, string]> = [
  ['kev-0.8b', 'Kev-0.8B'],
  ['kev-0.8b-ft', 'Kev-0.8B fine-tuned'],
  ['kev-4b', 'Kev-4B'],
  ['kev-4b-ft', 'Kev-4B fine-tuned'],
];

/** One fine-tune record from RUN.txt, train.log and Kev's training_config.json (the summary-md.ts sources). */
function fineTune(dir: string) {
  const run = readFileSync(join(dir, 'RUN.txt'), 'utf8');
  const log = readFileSync(join(dir, 'train.log'), 'latin1').replace(/\r/g, '\n');
  const cfg = JSON.parse(readFileSync(join(dir, 'training_config.json'), 'utf8')) as { args?: { epochs?: number; lr?: number } };
  return {
    method: 'LoRA',
    epochs: cfg.args?.epochs ?? Number(/--epochs (\S+)/.exec(run)?.[1]),
    lr: cfg.args?.lr ?? Number(/--lr (\S+)/.exec(run)?.[1]),
    records_total: Number(/records=\s*(\d+)/.exec(run)?.[1]),
    records_used: Number(/(\d+) training requests/.exec(log)?.[1]),
    wall_s: Number(/wall_s=(\d+)/.exec(run)?.[1]),
  };
}

const models: Record<string, unknown> = {};
for (const [key, label] of MODELS) {
  const io = heldOut(key, 'instruction_override/test');
  const gd = heldOut(key, 'goal_deviation/test');
  const meta = metaOf(key);
  models[key] = {
    label,
    judge_source: meta.judge_source ?? null,
    instruction_override: { auroc: num(io.auroc) },
    goal_deviation: {
      auroc: num(gd.auroc),
      threshold: num(gd.threshold),
      recall: num(gd.recall_thr),
      recall_ci: Array.isArray(gd.recall_thr_ci) ? (gd.recall_thr_ci as number[]) : null,
      fpr: num(gd.fpr_thr),
    },
    latency: { p50_ms: num(meta.rtt_p50_ms), p95_ms: num(meta.rtt_p95_ms), n: num(meta.rtt_n) },
  };
}

// Promotion gate (plan §1, r2 §B): the rule lives in gate.js; here we only feed it the
// paired goal_deviation test predictions at each model's own calibrated threshold.
const ALPHA = 0.05;
function goalDeviationTestPreds(label: string): Map<string, { label: boolean; p: number | null }> {
  const map = new Map<string, { label: boolean; p: number | null }>();
  for (const line of readFileSync(join(out, `predictions-${label}.jsonl`), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as { item_id: string; question_id: string; split: string; label: boolean; signal: { type?: string; raw_probability?: number } | null };
    if (r.question_id !== 'goal_deviation' || r.split !== 'test') continue;
    map.set(r.item_id, { label: r.label, p: r.signal?.type === 'noul' ? (r.signal.raw_probability ?? null) : null });
  }
  return map;
}
function gateFor(base: string, ft: string) {
  const baseThr = num(heldOut(base, 'goal_deviation/test').threshold);
  const ftThr = num(heldOut(ft, 'goal_deviation/test').threshold);
  const basePreds = goalDeviationTestPreds(base);
  const ftPreds = goalDeviationTestPreds(ft);
  const items: Array<{ positive: boolean; correctBefore: boolean; correctAfter: boolean }> = [];
  for (const [id, b] of basePreds) {
    const f = ftPreds.get(id);
    if (!f || b.p == null || f.p == null || baseThr == null || ftThr == null) continue;
    items.push({ positive: b.label === true, correctBefore: b.p >= baseThr === b.label, correctAfter: f.p >= ftThr === f.label });
  }
  const d = decide({ items, alpha: ALPHA });
  return { vs: base, items: items.length, fixed: d.fixed, broke: d.broke, p: d.p, missed: d.missed, falseHolds: d.falseHolds, safetyOk: d.safetyOk, evidenceOk: d.evidenceOk, verdict: d.verdict, reason: d.reason, alpha: ALPHA };
}

const evidence = {
  generated_by: 'eval/run/showcase-json.ts',
  sources: { eval: out, 'ft_0.8b': ft, 'ft_4b': ft4b },
  hardware: 'Apple M4 Pro, MLX, bf16',
  test: {
    benchmark: 'AgentDojo',
    items: num(heldOut('kev-0.8b', 'goal_deviation/test').n),
    positives: {
      instruction_override: num(heldOut('kev-0.8b', 'instruction_override/test').positives),
      goal_deviation: num(heldOut('kev-0.8b', 'goal_deviation/test').positives),
    },
  },
  models,
  gate: { 'kev-0.8b-ft': gateFor('kev-0.8b', 'kev-0.8b-ft'), 'kev-4b-ft': gateFor('kev-4b', 'kev-4b-ft') },
  finetune: { 'kev-0.8b': fineTune(ft), 'kev-4b': fineTune(ft4b) },
  caveats: [
    'Eval v1 was confounded (low-authority presence predicted the label); kept for the record only.',
    'Dev goal_deviation scores are source-separable (positives from ASB, negatives from tau-bench); use the AgentDojo test rows.',
    'A residual style risk on AgentDojo test: every negative low-authority text is constructed and every positive is recorded, so a model that recognises constructed text could score well without doing the task.',
    'instruction_override has no fitted threshold (too few calibration negatives), so only AUROC is reported for it.',
    'Calibrations are recorded and not activated; live policy stays in experimental mode.',
    'Labels are derived from benchmark ground truth; some benign fillers are heuristic_derived; none are human-reviewed.',
    'No data exists for payee_relation or claim_support.',
    'The Kev-4B fine-tune does not beat the Kev-0.8B fine-tune on the held-out family (goal_deviation test AUROC 0.666 vs 0.961).',
  ],
  label_provenance: ['benchmark_ground_truth_derived', 'heuristic_derived'],
};

mkdirSync(dirname(json), { recursive: true });
writeFileSync(json, JSON.stringify(evidence, null, 2) + '\n');
console.log(`wrote ${json} (${Object.keys(models).length} models, ${Object.keys(evidence.finetune).length} fine-tunes)`);
