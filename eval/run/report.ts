// Builds the Gate B evaluation report from predictions (plan §6):
//   node eval/run/report.ts --out runs/eval-2026-09-28 --labels kev-0.8b,kev-4b[,kev-0.8b-ft]
// Per question × split: B0 vs each judge. Thresholds are fitted on the calibration split only and then
// frozen for dev/test (RFC §12.2). Labels are derived from benchmark ground truth, not human-reviewed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EvalItem } from '../../contracts/eval.ts';
import type { Signal } from '../../contracts/judge.ts';
import { b0Answer, B0_DESCRIPTION } from './b0.ts';
import { binaryMetrics, bootstrapCI, chooseThreshold, ruleOfThree } from './metrics.ts';
import questionsJson from '../../rubrics/jev-questions.v1.json' with { type: 'json' };

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const out = arg('out')!, labels = (arg('labels') ?? '').split(',').filter(Boolean);
const items = new Map(readFileSync(arg('items', 'eval/splits/items.jsonl')!, 'utf8').split('\n').filter(Boolean).map(l => { const it = EvalItem.parse(JSON.parse(l)); return [it.item_id, it]; }));

// Risk option for choice questions: which option counts as the positive ("risky") class.
const RISK: Record<string, string> = { payee_relation: 'different_entity', claim_support: 'contradicted' };
type Pred = { item_id: string; split: string; source: string; question_id: string; type: string; label: boolean | string | number; status: string; signal: Signal | null; rtt_ms: number | null };
const load = (l: string): Pred[] => { const p = join(out, `predictions-${l}.jsonl`); return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x)) : []; };

const isPos = (qid: string, y: Pred['label']) => (typeof y === 'boolean' ? y : RISK[qid] ? y === RISK[qid] : null);
const probPos = (qid: string, s: Signal | null): number | null => {
  if (!s) return null;
  if (s.type === 'noul') return s.raw_probability;
  if (RISK[qid] && s.probabilities) return s.probabilities[RISK[qid]] ?? null;
  return null;
};
const fmt = (v: number | null | undefined, d = 3) => (v == null ? '—' : v.toFixed(d));
const ci = (c: [number, number] | null) => (c ? `[${c[0].toFixed(3)}, ${c[1].toFixed(3)}]` : '—');

const questions = Object.keys((questionsJson as { questions: Record<string, unknown> }).questions);
const lines: string[] = [];
const calibrations: Record<string, unknown>[] = [];
const summary: Record<string, unknown> = {};
lines.push(`# Gate B evaluation report`, '', `Generated ${new Date().toISOString()} from \`${out}\`.`, '');
lines.push(`- **Labels** are *derived from each benchmark's own ground truth* (evidence class \`benchmark_ground_truth_derived\` unless marked), **not human-reviewed**. RFC §12.2's two-reviewer gold set was not produced.`);
lines.push(`- **Thresholds** are chosen on the **calibration** split only (lowest threshold with precision ≥ 0.9, else max-F1) and frozen before dev and test are read. The 0.5 column is shown for reference.`);
lines.push(`- **${B0_DESCRIPTION}**`);
lines.push(`- **Latency** is judge HTTP round trip on this machine (Apple M4 Pro, MLX, bf16), measured by the client; it is not a vendor SLA.`);
lines.push(`- **Not measured:** B1 (LLM judge) and B3 (judge + slow path), since no LLM judge is configured (plan D9); TypeSafe's hosted Jev (no key).`, '');

for (const l of labels) {
  const meta = existsSync(join(out, `meta-${l}.json`)) ? JSON.parse(readFileSync(join(out, `meta-${l}.json`), 'utf8')) : {};
  lines.push(`## ${l} — \`${meta.judge_source ?? '?'}\``, '');
  const preds = load(l);
  const rtts = preds.filter((p, i, a) => a.findIndex(x => x.item_id === p.item_id) === i).map(p => p.rtt_ms).filter((v): v is number => v != null).sort((a, b) => a - b);
  const pct = (q: number) => rtts.length ? rtts[Math.max(0, Math.ceil(q * rtts.length) - 1)] : null;
  lines.push(`Items: ${new Set(preds.map(p => p.item_id)).size} · failed calls: ${new Set(preds.filter(p => p.status !== 'ok' && p.status !== 'partial').map(p => p.item_id)).size} · judge HTTP RTT p50 ${fmt(pct(0.5), 0)} ms, p95 ${fmt(pct(0.95), 0)} ms (n=${rtts.length}).`, '');
  lines.push(`| question | split | n (pos) | B0 acc / recall | judge acc@0.5 | recall@0.5 | FPR@0.5 | threshold (from cal) | recall@thr [95% CI] | FPR@thr | Brier | ECE | AUROC | incremental recall over B0 |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const qid of questions) {
    const qp = preds.filter(p => p.question_id === qid);
    if (!qp.length) continue;
    const bin = (xs: Pred[]) => xs.map(p => ({ p: probPos(qid, p.signal), y: isPos(qid, p.label) })).filter((x): x is { p: number | null; y: boolean } => x.y != null);
    const cal = bin(qp.filter(p => p.split === 'calibration')).filter((x): x is { p: number; y: boolean } => x.p != null);
    const isBinary = qp.some(p => isPos(qid, p.label) != null);
    // Fitting needs both classes in quantity; with fewer than MIN_PER_CLASS of either, a threshold would be noise.
    const MIN_PER_CLASS = 20;
    const calPos = cal.filter(x => x.y).length, calNeg = cal.length - calPos;
    const thr = isBinary && calPos >= MIN_PER_CLASS && calNeg >= MIN_PER_CLASS ? chooseThreshold(cal) : null;
    const notFitted = isBinary && !thr ? `not fitted (calibration split: ${calPos} pos / ${calNeg} neg; need ≥ ${MIN_PER_CLASS} of each)` : null;
    if (thr) calibrations.push({ calibration_id: `cal-${l}-${qid}`, judge_source: meta.judge_source, rubric_id: 'ap-runtime-semantic:v1', extractor_version: 'eval-format/1', question_id: qid,
      method: 'threshold_only', params: { risk_option: RISK[qid] ?? null }, review_at: thr.threshold, rule: thr.rule,
      fitted_on: { split: 'calibration', n: cal.length, sources: [...new Set(qp.filter(p => p.split === 'calibration').map(p => p.source))] }, eval_ref: out, created_at: new Date().toISOString() });
    for (const split of ['dev', 'test']) {
      const sp = qp.filter(p => p.split === split);
      if (!sp.length) continue;
      if (!isBinary) {
        // score (semantic_impact): exact-level accuracy
        const acc = sp.filter(p => p.signal?.probabilities && Object.entries(p.signal.probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] === String(p.label)).length / sp.length;
        lines.push(`| ${qid} | ${split} | ${sp.length} | no code baseline | ${fmt(acc)} (exact level) | — | — | — | — | — | — | — | — | — |`);
        continue;
      }
      const pts = bin(sp);
      const m5 = binaryMetrics(pts, 0.5);
      const mt = thr ? binaryMetrics(pts, thr.threshold) : null;
      const recallCI = thr ? bootstrapCI(pts, xs => binaryMetrics(xs, thr.threshold).recall) : null;
      const b0 = sp.map(p => { const it = items.get(p.item_id)!; const a = b0Answer(qid, it.state); return { a, y: isPos(qid, p.label), p }; });
      const b0Has = b0.some(x => x.a != null);
      const b0Pos = (a: boolean | string | null) => (typeof a === 'boolean' ? a : RISK[qid] ? a === RISK[qid] : false);
      const b0Acc = b0Has ? b0.filter(x => b0Pos(x.a) === x.y).length / b0.length : null;
      const positives = b0.filter(x => x.y);
      const b0Recall = b0Has && positives.length ? positives.filter(x => b0Pos(x.a)).length / positives.length : null;
      const missedByB0 = positives.filter(x => !b0Has || !b0Pos(x.a));
      const t = thr?.threshold ?? 0.5;
      const incr = missedByB0.length ? missedByB0.filter(x => (probPos(qid, x.p.signal) ?? -1) >= t).length / missedByB0.length : null;
      const fprNote = mt && mt.fp === 0 && (mt.fp + mt.tn) > 0 ? ` (0 of ${mt.fp + mt.tn}; ≤ ${fmt(ruleOfThree(mt.fp + mt.tn))} one-sided 95%)` : '';
      lines.push(`| ${qid} | ${split} | ${pts.length} (${m5.positives}) | ${b0Has ? `${fmt(b0Acc)} / ${fmt(b0Recall)}` : 'no code baseline'} | ${fmt(m5.accuracy)} | ${fmt(m5.recall)} | ${fmt(m5.false_positive_rate)} | ${thr ? fmt(thr.threshold, 2) : (notFitted ?? 'not fitted')} | ${mt ? `${fmt(mt.recall)} ${ci(recallCI)}` : '—'} | ${mt ? fmt(mt.false_positive_rate) + fprNote : '—'} | ${fmt(m5.brier)} | ${fmt(m5.ece)} | ${fmt(m5.auroc)} | ${incr == null ? '—' : `${fmt(incr)} (of ${missedByB0.length})`} |`);
      (summary[l] ??= {} as Record<string, unknown>) as Record<string, unknown>;
      (summary[l] as Record<string, unknown>)[`${qid}/${split}`] = { n: pts.length, positives: m5.positives, acc05: m5.accuracy, recall_thr: mt?.recall ?? null, fpr_thr: mt?.false_positive_rate ?? null, auroc: m5.auroc, brier: m5.brier, ece: m5.ece, b0_acc: b0Acc, b0_recall: b0Recall, incremental_recall: incr, threshold: thr?.threshold ?? null };
    }
  }
  lines.push('');
}
lines.push(`## Questions without training data`, '', `\`payee_relation\` and \`claim_support\` have no source in the open datasets (plan §6), so any fine-tune result on them is *no training data*, not a fine-tune effect.`, '');
writeFileSync(join(out, 'REPORT.md'), lines.join('\n'));
writeFileSync(join(out, 'calibrations.json'), JSON.stringify(calibrations, null, 1));
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(`wrote ${join(out, 'REPORT.md')} (${calibrations.length} calibrations)`);
