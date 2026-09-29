// Runs one judge over eval items through the production JudgeClient (same validator, same wire
// questions) and writes raw per-question predictions. No metrics here; see report.ts.
//   node eval/run/run.ts --judge http://127.0.0.1:8009 --expect jaredpalmer/kev-4b --label kev-4b \
//        --splits calibration,dev,test --out runs/eval-2026-09-28 [--items eval/splits/items.jsonl] [--limit N]
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createJudgeClient } from '../../server/judges/index.ts';
import { judgeSourceOf } from '../../contracts/judge.ts';
import { EvalItem } from '../../contracts/eval.ts';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const judgeUrl = arg('judge')!, label = arg('label')!, out = arg('out')!, expect = arg('expect');
const splits = new Set((arg('splits', 'calibration,dev,test') ?? '').split(','));
const limit = Number(arg('limit', '0'));
const itemsPath = arg('items', 'eval/splits/items.jsonl')!;
if (!judgeUrl || !label || !out) throw new Error('--judge, --label and --out are required');

const items = readFileSync(itemsPath, 'utf8').split('\n').filter(Boolean).map(l => EvalItem.parse(JSON.parse(l))).filter(i => splits.has(i.split));
const todo = limit ? items.slice(0, limit) : items;
mkdirSync(out, { recursive: true });
const predPath = join(out, `predictions-${label}.jsonl`);
const done = new Set(existsSync(predPath) ? readFileSync(predPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).item_id as string) : []);

const client = createJudgeClient({ backend: 'kev-local', baseUrl: judgeUrl, model: 'kev-latest', expectedRun: expect, maxRps: 20, maxInputTokensPerSec: 1e6, maxResponseBytes: 1 << 20 },
  { ledger: async () => undefined });
const served = await client.describe();
if (!served) throw new Error(`judge at ${judgeUrl} did not describe itself`);
writeFileSync(join(out, `meta-${label}.json`), JSON.stringify({ label, judge_source: judgeSourceOf(served), served, items_file: itemsPath, splits: [...splits], n: todo.length, started_at: new Date().toISOString() }, null, 1));
console.log(`${label}: ${judgeSourceOf(served)} · ${todo.length} items (${done.size} already done)`);

let i = 0, t0 = performance.now();
const queue = todo.filter(it => !done.has(it.item_id));
async function worker() {
  for (;;) {
    const it = queue.shift(); if (!it) return;
    const req = { model: 'kev-latest', state: it.state, questions: Object.fromEntries(it.questions.map(q => [q.question_id, q.question])) };
    const r = await client.call(req, [], { tenantId: 'eval', evaluationId: null, caller: 'eval', deadlineMs: 60_000, retry429: true });
    const rows = it.questions.map(q => ({ item_id: it.item_id, split: it.split, source: it.source, family: it.family, question_id: q.question_id,
      type: q.question.type, label: q.label, status: r.status, signal: r.signals[q.question_id] ?? null, rtt_ms: r.judge_http_rtt_ms }));
    appendFileSync(predPath, rows.map(x => JSON.stringify({ ...x, item_id: it.item_id })).join('\n') + '\n');
    if (++i % 50 === 0) console.log(`  ${i}/${queue.length + i} · ${((performance.now() - t0) / i).toFixed(0)} ms/item`);
  }
}
await Promise.all([worker(), worker()]);
console.log(`${label}: done ${i} items in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
