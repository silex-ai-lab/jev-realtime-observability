// Shared helpers for the eval converters (T4, deepseek). Deterministic, dependency-free.
// The planner owns eval/convert/format.ts (formatState) and contracts/eval.ts (EvalItem).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalItem, EvalSource } from '../../contracts/eval.ts';
import type { WireQuestion } from '../../contracts/judge.ts';

type Split = EvalItem['split'];
type LabelledQuestion = EvalItem['questions'][number];
type EvidenceClass = LabelledQuestion['evidence_class'];

const HERE = dirname(fileURLToPath(import.meta.url));
const RUBRIC_PATH = join(HERE, '..', '..', 'rubrics', 'jev-questions.v1.json');
/** Cloned, git-ignored third-party data (eval/sources/raw/<source>/), produced by eval/sources/fetch.ts. */
export const RAW_ROOT = join(HERE, '..', 'sources', 'raw');
/** Committed deterministic dumps of Python-defined tasks (eval/convert/fixtures/). */
export const FIXTURES_ROOT = join(HERE, 'fixtures');

export interface RubricQuestions { questions: Record<string, WireQuestion>; rubric_id: string }

let cached: RubricQuestions | null = null;
export function loadRubric(): RubricQuestions {
  if (!cached) {
    const raw = JSON.parse(readFileSync(RUBRIC_PATH, 'utf8')) as RubricQuestions;
    cached = raw;
  }
  return cached;
}

/** The exact wire object for a question id from rubrics/jev-questions.v1.json. */
export function wireQuestion(questionId: string): WireQuestion {
  const q = loadRubric().questions[questionId];
  if (!q) throw new Error(`unknown question id: ${questionId}`);
  return q;
}

/**
 * Deterministic split by (source, template_id): train 60% / calibration 20% / dev 20% (RFC §12.2).
 * AgentDojo is fully held out as the test family. A template never lands in more than one split
 * because the split is a pure function of (source, template_id).
 */
export function splitFor(source: string, templateId: string): Split {
  if (source === 'agentdojo') return 'test';
  const h = createHash('sha256').update(`${source}:${templateId}`).digest();
  const n = h[0] % 100; // 0..99
  if (n < 60) return 'train';
  if (n < 80) return 'calibration';
  return 'dev';
}

let seq = 0;
/** "<source>:<family>:<template_id>:<n>" — unique per item. */
export function itemId(source: string, family: string, templateId: string, n: number): string {
  return `${source}:${family}:${templateId}:${n}`;
}

/** The n-th element of a deterministic ordering, used only to cap sources below their full size. */
export function stablePick<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return xs.slice(0, n);
}

export interface Labelled {
  question_id: string;
  label: boolean | string | number;
  evidence_class: EvidenceClass;
  derivation: string;
}

export function labelledQuestion(questionId: string, label: boolean | string | number, evidenceClass: EvidenceClass, derivation: string): LabelledQuestion {
  return { question_id: questionId, question: wireQuestion(questionId), label, evidence_class: evidenceClass, derivation };
}

export interface ProvenanceInput {
  repo: string; commit: string; file: string; locator: string; licence: string;
}

export function makeItem(p: {
  source: EvalSource; family: string; templateId: string; n: number; split: Split; boundary: EvalItem['boundary'];
  state: string; questions: LabelledQuestion[]; provenance: ProvenanceInput;
}): EvalItem {
  return {
    item_id: itemId(p.source, p.family, p.templateId, p.n),
    source: p.source, family: p.family, template_id: p.templateId, split: p.split,
    boundary: p.boundary, state: p.state, questions: p.questions, provenance: p.provenance,
  };
}

export const BENCHMARK_GT = 'benchmark_ground_truth_derived' as const;
export const HEURISTIC = 'heuristic_derived' as const;

/**
 * Enforces the split invariant that identical judge-view states must never land in two splits
 * (fine-tuning on a state that also appears in a held-out split would inflate those numbers).
 *
 * Any two items of the same source whose `state` is byte-identical are merged onto one canonical
 * `template_id` (the lexicographically smallest among them, so the result is order-independent),
 * and every item's split and item_id are recomputed from that template_id. Splitting stays a pure
 * function of (source, template_id), so a template still never spans two splits.
 */
export function finalizeSplits(items: EvalItem[]): EvalItem[] {
  const sorted = [...items].sort((a, b) => a.item_id.localeCompare(b.item_id));
  const canonical = new Map<string, string>();   // `${source}\u0000${state}` -> canonical template_id
  const counters = new Map<string, number>();    // `${source}\u0000${family}\u0000${template}` -> n
  const out: EvalItem[] = [];
  for (const item of sorted) {
    const key = `${item.source}\u0000${item.state}`;
    const canon = canonical.get(key);
    const templateId = canon ?? item.template_id;
    if (canon === undefined) canonical.set(key, item.template_id);
    const g = `${item.source}\u0000${item.family}\u0000${templateId}`;
    const n = counters.get(g) ?? 0;
    counters.set(g, n + 1);
    out.push({
      ...item,
      template_id: templateId,
      split: splitFor(item.source, templateId),
      item_id: itemId(item.source, item.family, templateId, n),
    });
  }
  return out.sort((a, b) => a.item_id.localeCompare(b.item_id));
}
