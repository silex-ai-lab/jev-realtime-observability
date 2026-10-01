// T (learning-loop showcase): the committed learning-evidence.json regenerates byte-identically from the
// run artefacts, and its key values match the generated Results block in docs/EVAL.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JSON_PATH = 'web/demo/data/learning-evidence.json';

const evidence = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as {
  test: { benchmark: string; items: number; positives: Record<string, number> };
  models: Record<string, {
    instruction_override: { auroc: number };
    goal_deviation: { auroc: number; threshold: number | null; recall: number; recall_ci: [number, number] | null; fpr: number };
    latency: { p50_ms: number; p95_ms: number; n: number };
  }>;
  finetune: Record<string, { method: string; epochs: number; lr: number; records_total: number; records_used: number; wall_s: number }>;
  label_provenance: string[];
};

// The generated Results block in docs/EVAL.md (3-decimal AUROC/recall/fpr; whole-ms latency). These are the
// documented values the JSON must reproduce; they are the only hand-pinned numbers in this test.
const EXPECTED: Record<string, { io: number; gd: number; thr: number | null; recall: number; fpr: number; p50: number; p95: number }> = {
  'kev-0.8b':    { io: 0.602, gd: 0.893, thr: 0.60, recall: 0.400, fpr: 0.014, p50: 151, p95: 345 },
  'kev-0.8b-ft': { io: 0.973, gd: 0.961, thr: 0.01, recall: 0.800, fpr: 0.009, p50: 149, p95: 343 },
  'kev-4b':      { io: 0.792, gd: 0.541, thr: 0.47, recall: 0.286, fpr: 0.209, p50: 857, p95: 2001 },
  'kev-4b-ft':   { io: 0.953, gd: 0.666, thr: 0.01, recall: 0.229, fpr: 0.126, p50: 913, p95: 2117 },
};

test('learning-evidence.json regenerates byte-identically from the run artefacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-showcase-'));
  const out = join(dir, 'learning-evidence.json');
  execFileSync(process.execPath, [
    'eval/run/showcase-json.ts',
    '--out', 'runs/eval-2026-09-28-v2',
    '--ft', 'runs/ft-kev-0.8b-2026-09-28',
    '--ft4b', 'runs/ft-kev-4b-2026-09-29',
    '--json', out,
  ], { stdio: 'pipe' });
  assert.equal(readFileSync(out, 'utf8'), readFileSync(JSON_PATH, 'utf8'), 'regenerated JSON must equal the committed file');
});

test('learning-evidence.json key values match the docs/EVAL.md generated block', () => {
  assert.equal(evidence.test.benchmark, 'AgentDojo');
  assert.equal(evidence.test.items, 250);
  assert.deepEqual(evidence.test.positives, { instruction_override: 35, goal_deviation: 35 });

  assert.deepEqual(Object.keys(evidence.models), Object.keys(EXPECTED), 'model set');
  for (const [key, exp] of Object.entries(EXPECTED)) {
    const m = evidence.models[key];
    assert.equal(m.instruction_override.auroc.toFixed(3), exp.io.toFixed(3), `${key} instruction_override AUROC`);
    assert.equal(m.goal_deviation.auroc.toFixed(3), exp.gd.toFixed(3), `${key} goal_deviation AUROC`);
    assert.equal(m.goal_deviation.threshold, exp.thr, `${key} goal_deviation threshold`);
    assert.equal(m.goal_deviation.recall.toFixed(3), exp.recall.toFixed(3), `${key} goal_deviation recall`);
    assert.equal(m.goal_deviation.fpr.toFixed(3), exp.fpr.toFixed(3), `${key} goal_deviation FPR`);
    assert.ok(Array.isArray(m.goal_deviation.recall_ci) && m.goal_deviation.recall_ci!.length === 2, `${key} recall CI present`);
    assert.equal(Math.round(m.latency.p50_ms), exp.p50, `${key} latency p50`);
    assert.equal(Math.round(m.latency.p95_ms), exp.p95, `${key} latency p95`);
    assert.equal(m.latency.n, 708, `${key} latency n`);
  }

  // The fine-tune wall times and record counts the EVAL.md block quotes (39 min / 164 min; 1223 → 1183).
  assert.equal(evidence.finetune['kev-0.8b'].records_total, 1223);
  assert.equal(evidence.finetune['kev-0.8b'].records_used, 1183);
  assert.equal(evidence.finetune['kev-0.8b'].wall_s, 2346);   // 39 min
  assert.equal(evidence.finetune['kev-4b'].records_total, 1223);
  assert.equal(evidence.finetune['kev-4b'].records_used, 1183);
  assert.equal(evidence.finetune['kev-4b'].wall_s, 9867);      // 164 min
  for (const key of ['kev-0.8b', 'kev-4b']) {
    assert.equal(evidence.finetune[key].method, 'LoRA');
    assert.equal(evidence.finetune[key].epochs, 2);
  }

  assert.deepEqual(evidence.label_provenance, ['benchmark_ground_truth_derived', 'heuristic_derived']);
});
