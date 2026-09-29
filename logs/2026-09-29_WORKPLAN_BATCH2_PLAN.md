# 2026-09-29 work plan, batch 2: label export, sampler, review panel, Kev-0.8B fine-tune rerun

Fleet run (`herdr-agent-fleet`) over tasks T6, T7, T8 and T10 of
`skills/jev-work-plan/plans/2026-09-29.md`, on top of batch 1
(`logs/2026-09-29_WORKPLAN_BATCH1_PLAN.md`, merged at `44cc93b`).

**Plan version:** v3 · **Repo HEAD at planning:** `44cc93b` · **Review base (`BASE`):** `7c9dae4` (the plan commit).

## Roster

Same as batch 1: planner Claude Code (Opus 5.5), `coder-deepseek` (OpenCode, `deepseek/deepseek-reasoner`),
`reviewer-codex` (Codex CLI 0.157.1). No change.

## Scope changes the user decided (2026-09-29)

- **This machine is an Apple M5 Pro with 24 GB**, under the day plan's `gpu` bar (32 GB+ Mac). The user said
  to use the smaller model: **T10 fine-tunes Kev-0.8B instead of Kev-4B**, and the T8 screenshot runs against
  **Kev-0.8B** (the day plan assumed Kev-4B on 8009).
- **T11 stays `todo`**: no PostgreSQL or Docker on this machine, and no install was authorised.

## Machine facts

- Kev cloned to `~/workplace/Silex/third_party/kev` at the pinned `3e1cd3b`, `uv sync --extra serve` done;
  Kev-0.8B served on `127.0.0.1:8010`.
- The fine-tune weights of 2026-09-28 are not in git and not on this machine.
- `timeout` (GNU coreutils) is **not installed** here, and `eval/finetune/finetune.sh` calls it.

## Design decisions (reviewers: please judge these)

D1. **T6 export format.** `eval/export/labels-to-kev.ts --tenant <id> --out <dir> [--as-of <iso>]` reads the DB
(`DATABASE_URL`, or a PGlite `--data-dir`). One output record per **snapshot** that has at least one label:
`{ "state": <snapshot.judge_view.state>, "questions": { <qid>: { ...RUBRIC wire question, "label": <v> } } }`,
the exact shape of `eval/splits/kev-train.jsonl`. Label encoding follows that file: `noul` → boolean, `choice`
→ the criteria key, `score` → the **index** of the level in `criteria` (our API stores the level string).
Labels whose `ref` is an evaluation id are mapped to that evaluation's snapshot. When one snapshot has
several labels for one question, the newest `human_reviewed` wins, else the newest of any class; conflicting
`human_reviewed` answers for the same (snapshot, question) drop that question and are counted in the manifest.
Labels of another tenant are never read.

D2. **T6 splits, determinism, leakage.** Time-based by the snapshot's `created_at`: oldest 70 % train, next
10 % calibration, newest 20 % test, cut on **state groups**: snapshots whose `judge_view.state` text is byte-identical form one group, and the
whole group goes to the split of its **earliest** snapshot (so a state first seen in training can never reappear
in calibration or test, and the cut stays temporal for first occurrences). Groups, not snapshots, are what the
70/10/20 cut counts. The manifest records how many snapshots were moved by grouping. The exporter then
**asserts** that no `state` text appears in two splits and fails if it does. The **test split keeps only `human_reviewed` questions**; a test snapshot with none left is dropped and
counted. Records are sorted by (`created_at`, `snapshot_id`), JSON is written with sorted keys, and
`manifest.json` holds per-split counts, per-question positive/negative counts, dropped counts, the tenant, the
`--as-of` cut (default: now, recorded) and the sha256 of each file. The same DB and `--as-of` give
byte-identical output (tested). Acceptance fixture: three snapshots with identical state text dated in the
train, calibration and test periods land together in train, and the grouping count is 2. Output goes under `runs/`; the manifest and counts may be committed, the
JSONL files are gitignored (they hold tenant data).

D3. **T7 sampler.** `POST /v1/reviews/sample { budget? }` (admin, default budget 20, max 100) opens review tasks
for original decisions that have none yet. Only **valid** evidence counts: an evaluation with status `ok` or
`partial`, and a signal with a non-null `raw_probability`; failed, timed-out or missing signals never qualify.
Only the **risk questions**, where "yes" means risk, are compared: `instruction_override`, `goal_deviation`,
`sensitive_data_transfer`. `claim_asserts_completion` is excluded: "yes" there means a completion claim, not a
risk. Three classes, in priority order, newest first within a class:
1. `uncertain`: a realtime evaluation where a risk question that the decision **required** (non-empty
   `required_question_ids`) has `raw_probability` in [0.3, 0.7].
2. `judge_flags_unruled_risk` (a **heuristic contrast**, not a proof of disagreement): no rule returned
   HOLD/BLOCK/STOP for the decision, and a realtime answer to a risk question is ≥ 0.7. The opposite
   direction (a rule held it, the judge saw low risk) is **not** sampled: rules such as missing approval check
   facts the judge doesn't, so both can be right.
3. `cross_judge_disagreement`: two valid evaluations of the **same `snapshot_id`** (so the same frozen judge
   input; in practice `realtime` or `diagnostic` vs. `model_reeval`, which reuses the stored snapshot) with
   **different `served_model` run identities**, whose answers to the same risk question fall on opposite sides of
   0.5. Same-model re-asks and evaluations of different snapshots never count.
Each opened task records `sample_reason`, `path: 'sampler'`, and `evaluation_id` = the evaluation that caused the
sampling (for class 3, the newer one), so the panel and resolve use its question set. It uses the unique
`(tenant_id, decision_id)` index, so it never duplicates a task, open or resolved. Tenant-scoped, one transaction;
the response lists `{ review_id, decision_id, reason }`.
Acceptance fixtures (seeded rows): positives for each class; negatives for a benign completion claim
(`claim_asserts_completion` 0.9), a missing-approval HOLD with low risk answers, an empty required set, failed or
null signals, a same-model re-ask, and two evaluations of different snapshots.

D4. **T8 review panel.** A card under the stream: open tasks (from `GET /v1/reviews`), refreshed on the
`review` and `decision` SSE kinds; selecting one loads `GET /v1/reviews/:id` and shows the tool, the
decision and its reasons, **the frozen snapshot's judge view** (`snapshot.judge_view.state`, the exact text the
judge saw), the judge's answers per question (probability or option, labelled **uncalibrated**), and an input
per question (`noul`: yes/no/skip; `choice`: its options or skip; `score`: its levels or skip).
**Which questions** (F0, one function `reviewQuestions(task)` used by both `GET /v1/reviews/:id` and resolve):
the `question_ids` of the evaluation **recorded in the task body** when it has any; otherwise every rubric
question. The task body's `evaluation_id` is fixed when the task opens, so the set cannot change between viewing
and resolving (a diagnostic evaluation that arrives later is ignored; it judged a separately assembled snapshot).
S4's hard-rule HOLD, which has no evaluation, always gets the whole rubric. The panel shows only answers from
the task's own evaluation. Regression test: GET the S4 task, insert a diagnostic evaluation with a narrower
question set for the same event, resolve with a question outside that set → 200.
`GET /v1/reviews/:id` gains `questions: { <qid>: <wire question> }` (instructions and criteria from the rubric),
so the browser needs no rubric of its own. **Allow** and **Deny** resolve with the non-skipped answers.
The panel states that resolving records labels and **does not release the held action**. In
`AUTH_MODE=keys` resolving needs the admin key (the panel says so and disables the buttons without one);
in `none` it works directly. Styles reuse `web/css/live.css` tokens. The resolve call, like the existing
admin calls, uses the key held in memory only.

D5. **T10 as a rerun of the Kev-0.8B fine-tune (user's scope change).** A 2026-09-28 Kev-0.8B fine-tune
already exists and is in the `docs/EVAL.md` generated block. This rerun **does not replace** that record. It
answers: does the recipe reproduce on a second machine? Steps:
- make `finetune.sh` portable: use `timeout`, else `gtimeout`, else a `perl` alarm wrapper whose SIGALRM exit
  is mapped to 124, so a time-out is still reported as `not_completed_locally`;
- run `finetune.sh 0.8b` inside the 3 h box → `runs/ft-kev-0.8b-2026-09-29/` (`RUN.txt`, `train.log`, the
  trainer's own config/metrics files if it writes them; weights gitignored);
- serve the new weights alone; run `eval/run/run.ts` on **calibration, dev and test** (as on 2026-09-28) with
  label `kev-0.8b-ft-rerun` into `runs/eval-2026-09-29-ft-rerun/`, then `eval/run/report.ts` there. With the
  calibration split present, the report's fitted thresholds mean what they meant on 09-28: fitted on
  calibration, recorded, **not enabled**;
- **provenance fix** (Codex r1): `report.ts` hardcodes "Apple M4 Pro, MLX, bf16". `run.ts` now records the host
  CPU (`os.cpus()[0].model`) and the served model's `runtime` (compute backend, dtype, device, as `describe()`
  returns them) in `meta-<label>.json`, and `report.ts` prints them from the meta, falling back to the old
  string only when the meta has no host. Test: regenerating the 09-28 report gives the committed `REPORT.md`
  except its generation-timestamp line (compared with that one line normalised). The rerun report also says in its header that it is a reproduction check of the
  09-28 recipe on another machine;
- `docs/EVAL.md` gets one sentence linking to that generated report; no number is typed into a doc, and the
  existing generated block and its drift test are untouched.
If the run fails or times out, that is recorded as the result.

D6. **Kev and the GPU.** The judge (Kev-0.8B on 8010) and the fine-tune compete for the same GPU. T8's
screenshot is taken before T10 starts; Kev is stopped during training and the fine-tuned model is served
alone for its eval.

## Tasks and file ownership

Rule: touch only the files in your own list; report a needed change elsewhere instead of making it.

| ID | Owner | Task | Files (only these) | Acceptance |
|---|---|---|---|---|
| F0 | planner | Foundation for T7 and T8: `openSampledReviewTask(q, decision, ctx, reason, evaluationId)` in `server/storage/reviews.ts`; `sample_reason` and `path: 'sampler'` in `ReviewTask`; `reviewQuestions(task)` used by `GET /v1/reviews/:id` (new `questions` field) and resolve (D4); stub `sampleForReview(db, tenantId, budget)` in new `server/labeling/index.ts` returning `[]`; route `POST /v1/reviews/sample` | `server/storage/reviews.ts`, `contracts/labels.ts`, new `server/labeling/index.ts` (stub only), `server/api/reviews.ts`, `tests/integration/reviews.test.ts` | typecheck + `npm test` green; an S4 task's `questions` are the whole rubric and resolving it with a noul, a choice and a score answer writes three labels; committed before DeepSeek starts |
| T6 | deepseek | Label export (D1, D2) | new `eval/export/labels-to-kev.ts`, new `tests/unit/eval/export.test.ts`, a new "Exporting labels" section in `docs/EVAL.md` **outside** the generated block, `.gitignore` (the export JSONL only) | byte-identical rerun; only `human_reviewed` in test; no snapshot or state text in two splits; score label is an index; conflict and drop counts in the manifest; output validates against the shape of `eval/splits/kev-train.jsonl`; tenant isolation |
| T7 | deepseek | Sampler (D3) | `server/labeling/index.ts` (after F0), new `tests/integration/sampler.test.ts` | every D3 positive and negative fixture; exact picks per class and in order; budget caps; a second call opens nothing new; replays never sampled; another tenant's decisions never sampled; the task's `evaluation_id` is the sampling evaluation; reader → 403 in keys mode |
| T8 | planner | Review panel (D4); shows the frozen judge view | `web/index.html`, `web/js/live.js`, `web/css/live.css`, `tests/probe/run-probes.ts` (a new probe), `docs/USER_MANUAL.md` (new section + screenshot under `docs/manual/`) | CDP probe: an S4 (shadow) run opens a task, the panel lists it with the judge view, answering a noul, a choice and a score question and denying writes those labels (checked via `GET /v1/labels`) and the task leaves the open list, no JS errors; the same in keys mode with the admin key and, without it, the buttons are disabled; screenshot against Kev-0.8B |
| T10 | planner | Kev-0.8B fine-tune rerun (D5, D6) | `eval/finetune/finetune.sh`, `eval/run/run.ts` (host in meta), `eval/run/report.ts` (host from meta, rerun header), new `tests/unit/eval/report-host.test.ts`, `runs/ft-kev-0.8b-2026-09-29/` (no weights), `runs/eval-2026-09-29-ft-rerun/`, one linking sentence in `docs/EVAL.md` | the run record exists whatever the result; the 09-28 REPORT.md regenerates byte-identically; if completed, the rerun report names this machine's CPU, backend and dtype and says it is a reproduction check; the EVAL drift test passes unchanged |
| C | planner | `docs/CONTRACTS.md` §10.4 (sampler), backlog, day plan, run record | `docs/CONTRACTS.md`, `docs/IMPLEMENTATION_BACKLOG.md`, `skills/jev-work-plan/plans/2026-09-29.md`, this file, `logs/README.md` | Step 8 of the fleet skill |

`docs/EVAL.md` has two writers (T6 section, T10 sentence) at different places; T10's sentence is added after T6
is committed, so the edits are sequential.

Order: F0 (alone, committed) → DeepSeek T6 and T7 in parallel with planner T8 → T10 (GPU, after T8's
screenshot) → C.

## Out of scope

T11 (no Postgres here); releasing held actions on review; a Kev-4B fine-tune (user's decision for this
machine); enabling any calibration from the rerun (the report fits and records
thresholds on the calibration split, as on 09-28; none is activated in policy).

## Review record

### Round-1 objections → changes

| Objection (who) | Change |
|---|---|
| S4's hard-rule task has no evaluation, so the panel would show no questions and no label could be written; the browser has no wire definitions (Codex 1) | D4: `reviewQuestions(task)` (evaluation → newest valid diagnostic → whole rubric) for GET and resolve; GET returns `questions` with the wire definitions; panel shows the frozen judge view; F0 owns it with an S4 noul+choice+score test |
| Identical state text can straddle splits (Codex 2; DeepSeek 2) | D2: state groups go to the split of their earliest snapshot; exporter asserts no state in two splits; boundary-spanning fixture |
| Rule/judge class confused "yes" with risk and independent checks with contradiction (Codex 3) | D3: risk questions only (claim excluded); class renamed `judge_flags_unruled_risk`, one direction, called a heuristic; valid non-null evidence only; negatives for benign claim, approval HOLD, empty required set, failed signals |
| Two-judge class didn't require the same input or distinct models (Codex 4; DeepSeek 1 on impossible pairs) | D3: same `snapshot_id` and different `served_model` runs; renamed `cross_judge_disagreement`; negatives for same model and different snapshots |
| `report.ts` hardcodes M4 Pro; a test-only run would show calibration thresholds (Codex 5; DeepSeek 4 wants all splits) | D5: run calibration, dev and test as on 09-28; host recorded in meta and printed by the report, old report byte-identical; rerun header; T10 owns `run.ts`/`report.ts` |
| Sampled task should carry the evaluation that caused it (DeepSeek 3) | D3: `evaluation_id` = sampling evaluation |
| No separate metrics artefact from `finetune.sh` (DeepSeek 4) | D5 wording |
| Required noul seed must be non-empty (DeepSeek 5) | D3 empty-required-set negative fixture |

### Round-2 objections → changes

| Objection (who) | Change |
|---|---|
| The diagnostic fallback can narrow the question set between GET and resolve (Codex 1) | D4: the set comes only from the evaluation fixed in the task body, else the whole rubric; later diagnostics ignored; GET → diagnostic → resolve regression; F0 row unchanged (S4 = whole rubric) |
| Out-of-scope said "no fitting" while D5 fits thresholds (Codex 2) | Out of scope now excludes only *enabling* a calibration; fitting and recording is in scope |
| (Codex, non-blocking) use `describe().runtime`; the report has a timestamp, so it can't be byte-identical | D5 wording and the comparison normalises the timestamp line |
| (DeepSeek r2, non-blocking) with a judge, S4 lands in the diagnostic tier; the report timestamp; `runtime` is a folded string | Moot after the Codex fix (no diagnostic tier: S4 always gets the whole rubric, judge or not); timestamp line normalised; D5 uses `runtime` |

### Plan gate verdicts (plan v3)

| Seat | r1 (v1) | r2 (v2) | r3 (v3) |
|---|---|---|---|
| coder-deepseek | PLAN-APPROVED (5 notes) | PLAN-APPROVED (3 notes) | **PLAN-APPROVED** (1 note: the whole-rubric fallback offers post-generation questions on a pre_tool decision; skippable, kept) |
| reviewer-codex | PLAN-REJECTED (5) | PLAN-REJECTED (2) | **PLAN-APPROVED** |
| planner (claude) | — | — | **PLANNER (claude): PLAN-APPROVED** on v3 |

## Code review

### Code round 1 (diff revision `a12aa7e9`) → changes

Verdicts: coder-deepseek **IMPL-APPROVED** (3 non-blocking notes); reviewer-codex **IMPL-REJECTED** (2 blocking). The T10 run was still training and not in this diff.

| Defect (who) | Change |
|---|---|
| The perl time box returned 0 for a signal death (recorded as `completed`) and could wait forever on a child ignoring TERM (Codex 1) | New `eval/finetune/timebox.pl`: 124 only when the deadline passes, 128+N for a signal death, TERM to the process group then KILL after a grace period; `tests/unit/eval/timebox.test.ts` covers success, non-zero exit, signal death, deadline, and a TERM-resistant child. The fine-tune already running was started with the old inline wrapper; its result is read from `train.log` as well as the exit code |
| `.gitignore` covered one directory level under `runs/`, so a nested export could be committed (Codex 2) | The exporter refuses any in-repo `--out` outside `runs/exports/`; `.gitignore` has `runs/exports/**/*.jsonl`; tests check refused paths, nested ignores, the manifest staying trackable, committed eval predictions staying tracked, and the CLI exit code |
| (Codex, non-blocking) sampled tasks wrote no outbox record | Each sampled task appends a `review` outbox record; tested |
| (Codex, non-blocking) document the sampler's scaling limit | CONTRACTS §10.4 "Limit" |
| (DeepSeek 2) the exporter migrated a live Postgres | Migrates only a PGlite `--data-dir` |
| (DeepSeek 1) push sampler predicates into SQL | Recorded as the follow-up in CONTRACTS §10.4 |
| (DeepSeek 3) show score answers by level name | Not changed in this batch: the panel shows the judge's `score` number as returned, labelled uncalibrated; showing its `legend` label is a cosmetic follow-up |

### Code round 2 (diff revision `91a8d7e6`) → changes

Verdicts: coder-deepseek **IMPL-APPROVED** (2 non-blocking notes); reviewer-codex **IMPL-REJECTED** (1 blocking). Both judged the recovered T10 run record honest and sufficient and advised against repeating the run.

| Defect (who) | Change |
|---|---|
| `outputPathError` treated an in-repo directory named `..tenant-export` as outside the repository (a string prefix, not a path component), so its JSONL would not be ignored (Codex 1) | Checks the component (`rel === '..'` or starts with `..` + separator); regressions for `..tenant-export` and `runs/..x`, and a CLI check that the refused run writes nothing |
| (DeepSeek 1, repeated) score answers by legend label | Stays a cosmetic follow-up, as recorded in round 1 |
