// Label export (T6, plan batch 2 D1/D2): turns human/other labels into Kev training JSONL.
//   node eval/export/labels-to-kev.ts --tenant <id> --out <dir> [--as-of <iso>] [--data-dir <dir>]
//   (set DATABASE_URL for a real PostgreSQL; --data-dir for a PGlite directory)
// One record per snapshot that has at least one label, shaped exactly like eval/splits/kev-train.jsonl:
//   { "state": <judge_view.state>, "questions": { <qid>: { ...wire, "label": <v> } } }
// Label encoding: noul → boolean; choice → the criteria key; score → the index of the level in criteria.
// Splits are time-based on the snapshot's created_at (70/10/20), cut on state groups: snapshots whose
// judge-view state is byte-identical form one group that goes to its earliest snapshot's split, so a state
// first seen in training can never reappear in calibration or test. The test split keeps only
// human_reviewed questions. Deterministic: same DB and --as-of give byte-identical output.
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { openDb, migrate, type Db } from '../../server/storage/db.ts';
import { canonicalJson, sha256 } from '../../contracts/canonical.ts';
import { wireQuestion } from '../convert/common.ts';
import type { WireQuestion } from '../../contracts/judge.ts';
import type { DecisionSnapshot } from '../../contracts/snapshot.ts';
import type { EvidenceClass } from '../../contracts/labels.ts';

type Split = 'train' | 'calibration' | 'test';
const RISK: Record<string, string> = { payee_relation: 'different_entity', claim_support: 'contradicted' };

export interface ExportOptions { tenant: string; asOf: string }
export interface ExportResult {
  manifest: Record<string, unknown>;
  train: string;         // JSONL content, exactly as written to train.jsonl
  calibration: string;
  test: string;
}

interface RawLabel { value: boolean | string; evidence_class: EvidenceClass; created_at: string; label_id: string }
interface Resolved { value: boolean | string; evidence_class: EvidenceClass }
type Resolution = Resolved | { conflict: true };

const byNewest = (a: RawLabel, b: RawLabel): number =>
  b.created_at.localeCompare(a.created_at) || a.label_id.localeCompare(b.label_id);

/** The newest human_reviewed wins; else the newest of any class. Conflicting human_reviewed answers drop it. */
function resolveLabels(labels: RawLabel[]): Resolution {
  const human = labels.filter(l => l.evidence_class === 'human_reviewed');
  if (human.length) {
    const distinct = new Set(human.map(l => JSON.stringify(l.value)));
    if (distinct.size > 1) return { conflict: true };
    const newest = [...human].sort(byNewest)[0];
    return { value: newest.value, evidence_class: 'human_reviewed' };
  }
  const newest = [...labels].sort(byNewest)[0];
  return { value: newest.value, evidence_class: newest.evidence_class };
}

/** noul → boolean; choice → the key; score → the index of the level in criteria. */
function encodeValue(qid: string, value: boolean | string): boolean | string | number {
  const q = wireQuestion(qid);
  if (q.type === 'score') return q.criteria.indexOf(value as string);
  return value;
}

export async function exportLabelsToKev(db: Db, opts: ExportOptions): Promise<ExportResult> {
  const { tenant, asOf } = opts;

  const snapQ = await db.query<{ snapshot_id: string; body: unknown; created_at: string }>(
    `SELECT snapshot_id, body, created_at::text AS created_at FROM snapshots WHERE tenant_id = $1 AND created_at <= $2::timestamptz`,
    [tenant, asOf]);
  const snapshotById = new Map(snapQ.rows.map(r => [r.snapshot_id, { body: r.body as DecisionSnapshot, created_at: r.created_at }]));

  const labelQ = await db.query<{ label_id: string; ref: string; question_id: string; value: unknown; evidence_class: EvidenceClass; created_at: string }>(
    `SELECT label_id, ref, question_id, value, evidence_class, created_at::text AS created_at FROM labels WHERE tenant_id = $1 AND created_at <= $2::timestamptz`,
    [tenant, asOf]);

  const evalQ = await db.query<{ evaluation_id: string; snapshot_id: string }>(
    `SELECT evaluation_id, snapshot_id FROM evaluations WHERE tenant_id = $1`, [tenant]);
  const evalToSnapshot = new Map(evalQ.rows.map(r => [r.evaluation_id, r.snapshot_id]));

  // Labels → (snapshot, question) → labels. A label whose ref is an evaluation id is mapped to its snapshot;
  // a ref that is neither a snapshot nor an evaluation of this tenant is dropped (never read another tenant).
  const bySnapshotQuestion = new Map<string, Map<string, RawLabel[]>>();
  for (const l of labelQ.rows) {
    let snapId: string | null = snapshotById.has(l.ref) ? l.ref : (evalToSnapshot.get(l.ref) ?? null);
    if (!snapId || !snapshotById.has(snapId)) continue;
    let m = bySnapshotQuestion.get(snapId);
    if (!m) { m = new Map(); bySnapshotQuestion.set(snapId, m); }
    let list = m.get(l.question_id);
    if (!list) { list = []; m.set(l.question_id, list); }
    list.push({ value: l.value as boolean | string, evidence_class: l.evidence_class, created_at: l.created_at, label_id: l.label_id });
  }

  interface Question { wire: WireQuestion; label: boolean | string | number; human: boolean }
  interface ExportRecord { snapshot_id: string; created_at: string; state: string; questions: Record<string, Question> }

  const records: ExportRecord[] = [];
  let conflicting = 0;
  for (const [snapId, questions] of bySnapshotQuestion) {
    const snap = snapshotById.get(snapId)!;
    const out: Record<string, Question> = {};
    for (const [qid, labels] of questions) {
      const r = resolveLabels(labels);
      if ('conflict' in r) { conflicting++; continue; }
      out[qid] = { wire: wireQuestion(qid), label: encodeValue(qid, r.value), human: r.evidence_class === 'human_reviewed' };
    }
    if (Object.keys(out).length) records.push({ snapshot_id: snapId, created_at: snap.created_at, state: snap.body.judge_view.state, questions: out });
  }

  records.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.snapshot_id.localeCompare(b.snapshot_id));

  // State groups: snapshots with identical judge-view state form one group, assigned to its earliest snapshot.
  const groups = new Map<string, ExportRecord[]>();
  for (const r of records) {
    const g = groups.get(r.state);
    if (g) g.push(r); else groups.set(r.state, [r]);
  }
  const orderedGroups = [...groups.values()].sort((a, b) => a[0].created_at.localeCompare(b[0].created_at) || a[0].snapshot_id.localeCompare(b[0].snapshot_id));
  const movedByGrouping = records.length - orderedGroups.length;

  const G = orderedGroups.length;
  const trainCount = Math.floor(G * 0.7);
  const calCount = Math.floor(G * 0.1);
  const splitOf = (i: number): Split => (i < trainCount ? 'train' : i < trainCount + calCount ? 'calibration' : 'test');

  const assigned: Array<{ record: ExportRecord; split: Split }> = [];
  orderedGroups.forEach((g, i) => { const s = splitOf(i); for (const r of g) assigned.push({ record: r, split: s }); });

  // Leakage assert: after grouping, no state text may appear in two splits.
  const stateSplit = new Map<string, Split>();
  for (const a of assigned) {
    const prior = stateSplit.get(a.record.state);
    if (prior && prior !== a.split) throw new Error(`state text appears in both ${prior} and ${a.split} (leakage)`);
    stateSplit.set(a.record.state, a.split);
  }

  const lines: Record<Split, string[]> = { train: [], calibration: [], test: [] };
  const splitCounts: Record<Split, number> = { train: 0, calibration: 0, test: 0 };
  const perQuestion: Record<string, Record<string, { positive: number; negative: number; total: number }>> = {};
  let testWithoutHuman = 0;

  for (const a of assigned) {
    let questions = a.record.questions;
    if (a.split === 'test') {
      const kept = Object.entries(questions).filter(([, q]) => q.human);
      if (!kept.length) { testWithoutHuman++; continue; }
      questions = Object.fromEntries(kept);
    }
    const rec = { state: a.record.state, questions: Object.fromEntries(Object.entries(questions).map(([qid, q]) => [qid, { ...q.wire, label: q.label }])) };
    lines[a.split].push(canonicalJson(rec));
    splitCounts[a.split]++;

    for (const [qid, q] of Object.entries(questions)) {
      const cell = ((perQuestion[qid] ??= {})[a.split] ??= { positive: 0, negative: 0, total: 0 });
      cell.total++;
      const w = wireQuestion(qid);
      if (w.type === 'noul') { if (q.label === true) cell.positive++; else cell.negative++; }
      else if (w.type === 'choice' && RISK[qid] != null) { if (q.label === RISK[qid]) cell.positive++; else cell.negative++; }
    }
  }

  const content = (xs: string[]): string => (xs.length ? xs.join('\n') + '\n' : '');
  const train = content(lines.train), calibration = content(lines.calibration), test = content(lines.test);

  const manifest: Record<string, unknown> = {
    tenant,
    as_of: asOf,
    splits: splitCounts,
    moved_by_grouping: movedByGrouping,
    per_question: perQuestion,
    dropped: { conflicting, test_without_human_reviewed: testWithoutHuman },
    files: { 'train.jsonl': sha256(train), 'calibration.jsonl': sha256(calibration), 'test.jsonl': sha256(test) },
  };
  return { manifest, train, calibration, test };
}

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** Tenant JSONL must never land somewhere git would pick up: inside the repo only runs/exports/ is allowed
 *  (ignored by .gitignore at any depth); outside the repo any directory is fine. Returns an error or null. */
export function outputPathError(out: string): string | null {
  const rel = relative(REPO, resolve(out));
  // Outside the repository: a parent path component (not a name like '..x'), or, on Windows only, an absolute
  // result because `out` is on another drive (on POSIX `relative()` never returns an absolute path).
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return rel === join('runs', 'exports') || rel.startsWith(join('runs', 'exports') + sep) ? null
    : `inside the repository, --out must be under runs/exports/ (git-ignored); got ${rel || '.'}`;
}

function arg(k: string, d?: string): string | undefined { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; }

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const tenant = arg('tenant');
  const out = arg('out');
  const asOf = arg('as-of', new Date().toISOString())!;
  const dataDir = arg('data-dir');
  const url = process.env.DATABASE_URL;
  if (!tenant || !out) { console.error('usage: labels-to-kev.ts --tenant <id> --out <dir> [--as-of <iso>] [--data-dir <dir>]'); process.exit(2); }
  if (!url && !dataDir) { console.error('set DATABASE_URL or pass --data-dir'); process.exit(2); }
  const outErr = outputPathError(out);
  if (outErr) { console.error(outErr); process.exit(2); }

  const db = url ? await openDb({ url }) : await openDb({ dataDir });
  // A live PostgreSQL is migrated by the server; this read-only tool only migrates a local PGlite copy.
  if (!url) await migrate(db);
  try {
    const result = await exportLabelsToKev(db, { tenant, asOf });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'train.jsonl'), result.train);
    writeFileSync(join(out, 'calibration.jsonl'), result.calibration);
    writeFileSync(join(out, 'test.jsonl'), result.test);
    writeFileSync(join(out, 'manifest.json'), canonicalJson(result.manifest) + '\n');
    console.log(`exported ${JSON.stringify(result.manifest.splits)} (see ${out}/manifest.json)`);
  } finally {
    await db.close();
  }
}
