# Jev real-time agent observability — open-source build plan (v0.3)

Author: Claude (planner) · 2026-09-28 · Status: **v0.3 — APPROVED by all three seats in round 3 (plan commit `0aab813`): DEEPSEEK: PLAN-APPROVED · CODEX: PLAN-APPROVED · PLANNER (claude): PLAN-APPROVED.**
Repo: `jev-realtime-observability` (local; created at `github.com/silex-ai-lab/` only after the plan gate passes) · Review base for Gate A: `f9bcc05` (code-gate diffs are taken against it)

**Request (user, 2026-09-28):** "我需要真实的构建一个 opensource 的 realtime agent observability 的 Jev 实现，请根据 gpt 给的 design plan ~/Downloads/jev_desgin_plan_cn.md 在 github.com/silex-ai-lab/ 下面新建一个 repo，目录按需求构建，做这个真实的环境搭建，jev 实现可以利用或者参考这里面的 github 资源：https://github.com/logicrw/awesome-jev-projects/blob/main/README.zh-CN.md，telemetry 的数据可以收集开源数据来做训练、微调或者推理，方案 review 通过后直接开始实现。"

**Sources.**
- **RFC:** the GPT design `Jev_design_plan_cn.md` (RFC v0.1, 2026-09-28), kept verbatim in `logs/2026-09-28_RFC_v0.1_source_gpt.md` and cited below as **RFC §N**.
  - The RFC names four companion files: `contracts.ts`, `jev-questions.v1.json`, `rubric-manifest.v1.json` and `IMPLEMENTATION_BACKLOG.md`. **None was provided**, so this plan authors them (T0).
- **awesome-jev-projects:** the zh-CN list, read 2026-09-28.
- **Verified at source (2026-09-28)** for every external claim below:
  - the GitHub API for licences, stars and push dates;
  - the Kev README;
  - the Hugging Face API for the model licence.

## 0. Pre-plan spike (measured on this machine, 2026-09-28; n=3, not a benchmark)

- Kev cloned at `jaredpalmer/kev@3e1cd3b` into `~/workplace/Silex/third_party/kev` (outside this repo); `uv sync --extra serve`; `python -m kev.serve --run jaredpalmer/kev-4b --port 8009`.
- **`/v1/models`** reports: backend mlx, device mps, bf16, base `Qwen/Qwen3.5-4B-Base`, LoRA 16, fitted temperature 2.406, HF snapshot `139fdd94…`. **It serves the same model under both names, `kev-latest` and `jev-latest`.** So provenance must come from `/v1/models` (`run`, `base`, revision, temperature), never from the model name in the request or response (§2).
- **One AP request** (payee relation Choice + instruction_override Noul + goal_deviation Noul, 236 input tokens), raw files in `runs/spike-2026-09-28/`:
  - HTTP round trip 1,864 ms cold, then 289 ms twice (state cache hit); answers identical across all three.
  - `payee_relation` = `different_entity` 0.711 (same 0.039, insufficient 0.250).
  - **`instruction_override` = 0.296 on a plainly injected vendor note**, and `goal_deviation` = 0.484.
  - Off-the-shelf Kev-4B therefore under-detects this injection. That is the concrete reason for the open-data fine-tune and eval (§6), and why semantic policy stays shadow-only until it is calibrated (§4).
- The response shape matches the RFC §6.3 mapping: Noul → `noul` only, no confidence; Choice → `choice` + `confidence` + `probabilities`; plus `usage` and `latency_ms`.

## 1. Decisions (and where this deviates from the RFC)

| # | Decision | Why | RFC relation |
|---|---|---|---|
| D1 | **A new standalone repo**, not the `silex-mockup/jev-observability/` subdirectory. The existing static UI is copied in as `web/`, with its demo engine kept demo-only. | User instruction. The mockup site stays as it is. | RFC §15 layout, re-rooted |
| D2 | **The judge is a pluggable `JudgeBackend` behind one `/v1/systemone` client.** The default is **Kev** (`jaredpalmer/kev`, Apache-2.0, ★7.6k, pushed 2026-09-28): open weights (Kev-0.8B/4B/9B/27B, HF `jaredpalmer/kev-4b` licence apache-2.0, not gated), served locally with the *same API as TypeSafe System One*. **TypeSafe hosted Jev** is the second backend, enabled only when `TYPESAFE_API_KEY` exists (none is configured today). A `stub` backend exists **only in tests** and is labelled as such. | This is the open, real, locally runnable implementation. The same client and validator serve both, so switching to hosted Jev is a config change. | RFC §6 assumed hosted Jev only |
| D3 | **Fine-tuning is in scope**, as a LoRA fine-tune of a released Kev checkpoint via Kev's own `kev.train --init_from`, on labels converted from open datasets. We never train a Jev from scratch. | The user asked for training or fine-tuning on open data. | RFC §0 listed "自建 Jev 权重训练" as out of scope; the user's instruction overrides it. It stays limited to adapter fine-tunes |
| D4 | **Storage: PostgreSQL dialect via PGlite** (embedded Postgres in WASM, `@electric-sql/pglite`) for dev and CI. The **same SQL migrations** run on a real Postgres when `DATABASE_URL` is set, and `deploy/compose.yaml` ships Postgres plus an OTel Collector for real deployments. | This Mac has no Docker or Postgres (checked). The RFC wants Postgres semantics, and PGlite gives them without a system install. | RFC §3 Postgres, kept; the single-replica statement stays |
| D5 | **OTLP intake:** an in-process OTLP/HTTP **JSON** receiver at `/v1/traces` normalises spans. The Collector config is shipped but optional. The runner exports spans with the official `@opentelemetry/*` SDK. | No Collector binary here. The receiver uses the official protobuf-JSON shape, and golden payloads are tested. | RFC §9.2/§14 |
| D6 | **The judge view is ≤ 1,024 tokens** (state + longest question) by default, configurable **per backend**. The default is tuned for Kev; the `typesafe` backend may raise it (hosted Jev accepts 32k). | Kev was trained on states of at most 384 tokens and at most 1,024 for state plus one question, and accuracy drops on long documents (Kev README "Length", "Limitations"). | Tighter than the RFC's 2–4k |
| D7 | **Backend in TypeScript on Node 25**: native type stripping, no build step. Dependencies are few (`@electric-sql/pglite`, `pg`, `zod`, `@opentelemetry/*`); tests use `node --test`. Python appears only through Kev's own CLI (serve, train, benchmark), managed by `uv`. | RFC §3 asks for a TS backend. One language for the product. | as RFC |
| D8 | **The agent driver is `scripted_driver` in P0.** An `llm_agent_driver` targets any OpenAI-compatible endpoint (a local `mlx_lm.server` or a key). If none is configured, the UI shows *not configured*; it is never faked. | No LLM API key exists here. Running a local instruct model is a later, optional task (not in Gates A–C). | RFC §4 |
| D9 | **Baselines B1 and B3 are deferred** (RFC §12.1). Both need a configured LLM judge or slow path, which does not exist here (D8). Wherever they appear, the UI and report render them as **"not measured"**, never as 0% or blank. | No LLM judge is configured. | RFC §12.1 reduced to B0, B2, B2-ft, with the gap labelled |
| D10 | **Delivery in three gated stages (A, B, C)**, each with its own code review and push (§5). | Round-1 scope objection (Codex 2). | RFC milestones M0–M3 kept; gating split |

## 2. Claim discipline (the reviewers' first axis)

- **In docs and the UI, "judge view" or "Jev-protocol view" is used, never a bare "Jev view".** The README headline and the GitHub repo description say: *"Jev-protocol judge; default model is the open-source Kev, not TypeSafe's Jev."*
- **awesome-jev projects are credited as references only** (docs/THIRD_PARTY.md), unless actually integrated (only Kev is).
- Four provenance dimensions are stored and shown on every record (RFC §2): `source_mode` (demo / live_sandbox_shadow / live_sandbox_gate), `judge_source` (**kev-local:<model@revision>** / typesafe:<model> / stub / none), `tool_environment` (sandbox) and `enforcement_mode` (shadow / gate).
  - **"Jev" in the UI means the protocol.** The actual model is always named. Kev answers are never labelled "Jev". The About page states that Kev is an open reimplementation, not TypeSafe's model.
- **Every latency is measured** with a monotonic clock (`performance.now()` / `process.hrtime.bigint()`), per stage (RFC §11.1). No latency is simulated outside `web/` demo mode.
- **Kev's published accuracy, Brier and latency numbers** are quoted only in the About page and docs, as *Kev's own reported results*.
  - Our numbers come only from our eval runs, with their `runs/` artefact path.
- **Every label records its evidence class**: `benchmark_ground_truth_derived`, `heuristic_derived` or `human_reviewed`. This run produces only the first two.
- **Dataset labels are weak labels derived from each benchmark's own ground truth**, with the mapping documented per source (§6).
  - Reports say "derived labels", not "human-reviewed".
  - The RFC's two-reviewer gold labels (§12.2) are **not** produced in this run; the report says so.
- **Cost:**
  - `kev-local` has no per-call price. Compute time is recorded, and no dollar figure is invented.
  - The TypeSafe cost is computed only from response `usage` and a dated price record.
- **No hidden chain-of-thought** is collected. No real money, no real email and no internet tools are involved (RFC §0, §4).

## 3. Architecture (RFC §3, trimmed to one process + Kev)

```
sandbox runner (scripted | llm driver)
  ├─ sdk.captureBoundary() ──► POST /v1/events ──► PG: events + evaluation_jobs (same tx) ──► 202
  ├─ OTel SDK spans ─────────► POST /v1/traces (OTLP JSON) ──► normaliser ──► events
  ├─ sdk.preflight() [M3] ───► POST /v1/preflight ──► rules + required Jev signals (deadline) ──► ControlDecision (bound)
  └─ tool gateway (holds sandbox creds; verifies ControlDecision; idempotency) ──► sandbox ERP / vendor / ledger / mail sink
worker (in-process, leased jobs) ──► snapshot assembler ──► hard rules ──► JudgeBackend(/v1/systemone) ──► validator ──► policy compiler
                                  └─► signals + outbox (same tx) ──► GET /v1/stream (SSE, cursor resume) ──► web/ Live, Inspector
outcome verifier (read-only creds) ──► ledger/mail sink ──► outcome events (pending → verified_* / mismatch / unknown_after_deadline)
Kev server: third_party/kev `python -m kev.serve` on 127.0.0.1:8009 (MLX on Apple Silicon)
```

### Repo layout

```
contracts/      TS types + zod schemas: BoundaryEvent, DecisionSnapshot, EvaluationRecord, Signal, ControlDecision,
                ExecutionReceipt, OutcomeObservation, PolicyVersion; OTLP golden payloads
rubrics/        jev-questions.v1.json, rubric-manifest.v1.json (RFC §6.2 question set + applicability)
server/
  api/ ingest/ state/ rules/ judges/ policy/ worker/ outcomes/ storage/   (RFC §15 names)
sdk/            captureBoundary(), preflight() wrapper
sandbox/        schema + seed (synthetic AP data), tool gateway, scripted_driver, llm_agent_driver, scenarios S1–S9, F1
web/            existing UI (Live/Replay/Studio/About) + datasource adapter (demo | live SSE)
eval/
  sources/      manifest.json (repo, pinned commit, licence, sha256) + fetch script; raw data git-ignored
  convert/      per-source converters → snapshot+question+label JSONL
  splits/       dev / calibration / test by source family (RFC §12.2), committed if licence allows
  run/          baselines B0 (rules), B2 (Kev), B2-ft (fine-tuned Kev), B1 (LLM judge, only if configured), report
  finetune/     kev.train wrapper, configs, run records
deploy/         compose.yaml (postgres, otel-collector, kev), otel-collector.yaml, env.example (no keys)
tests/          unit, contract, integration, e2e, security invariants, UI probes
docs/           ARCHITECTURE, CONTRACTS, EVAL, IMPLEMENTATION_BACKLOG.md, THIRD_PARTY.md
logs/           this plan, RFC source, review record
LICENSE (Apache-2.0), NOTICE (Kev, datasets, OTel)
```

## 4. Decision semantics (RFC §7, implemented as written)

Order:
1. auth, tenant, scope, schema or idempotency failure → reject;
2. authoritative hard-rule violation → BLOCK/STOP, not overridable;
3. required evidence missing, stale or unverified → HOLD/UNKNOWN;
4. required Jev signal unavailable, invalid, or no applicable calibration → degrade by the registry's impact floor, never "safe";
5. calibrated semantic signal in an intervention band → REVIEW (sandbox HOLD in gate);
6. otherwise "no configured risk found" (never "safe").

Further rules:
- **Before fitting, semantic policy is shadow-only.** Thresholds exist only once `eval/` has fitted them on the calibration split. Until then the UI shows raw probabilities and "uncalibrated".
- **Hard veto returns immediately.** An optional diagnostic Jev call goes to a low-priority queue, off the gate latency.
- **Gate binding (RFC §7.1):** a ControlDecision carries tenant, run, tool, operation ID, canonical args digest, versions, expiry and nonce. The tool gateway re-verifies before executing and writes a receipt; `not_executed` is the only thing shown as "prevented".
- **Replay (RFC §10):** three kinds.
  - Policy-only: reuses the stored answers; zero model calls.
  - Model re-evaluation: a new evaluation ID.
  - Sandbox re-execution: a new run and new idempotency keys.

## 5. Delivery: three gates, each reviewed and pushed separately (D10)

Every gate runs its own code review, with unanimous `IMPL-APPROVED` required on its diff, and ends with a push to the public repo. A later gate never re-opens an approved one, except through its own review.

**Gate A: M0 + M1, the real shadow loop.**
- Contents:
  - contracts, rubrics, migrations and storage bootstrap;
  - the `/v1/systemone` client and validator, tested on recorded real Kev responses;
  - the runner (`scripted_driver`) → `/v1/events` and OTLP JSON → snapshot → hard rules → Kev → persisted signal and outbox → SSE → the existing UI's Live and Inspector in live mode, with the four provenance dimensions;
  - sandbox tools executing for real against the PGlite sandbox schema.
- Scenarios S1–S4, S6, and F1 in its shadow form: a judge timeout produces `evaluation.expired` and a `coverage_gap`, never "safe".
- Policy-only replay with zero model calls.
- T3 shadow-loop security tests.
- `npm test` plus e2e against live Kev.

**Gate B: M2, evidence and evaluation.**
- The outcome verifier state machine, with S5 and S9.
- Model re-evaluation replay and sandbox re-execution replay.
- Measured metrics (RFC §11.1).
- The open-data pipeline (§6) and S7/S8.
- **Blocking deliverable:** B0 and B2 on a pinned, licence-checked eval slice. B2 runs on **both Kev-0.8B and Kev-4B**, so any fine-tune has a same-base baseline. Results are per question, and questions with no training source are marked as such.
- **Fine-tune (B2-ft): a bounded attempt, not a gate condition.**
  - A time box of 3 h local wall time, on Kev-0.8B first. Kev-4B is tried only if the 0.8B run finished inside that box, and it gets its own 3 h box.
  - The report states whichever outcome happened: completed with its result (gain or no gain), or *not completed locally*, with the reason.
  - Cloud GPUs (Modal) only with the user's go-ahead.

**Gate C: M3, the sandbox gate.**
- `/v1/preflight` with a 600 ms total and 400 ms judge budget (RFC §6.5).
- Binding, nonce, expiry and idempotency; revocation; HOLD on missing required signals; execution receipts.
- F1 in its gate form: a high-impact timeout gives HOLD with no ledger row.
- T3 gate security tests.

**Not in this effort:**
- M4 customer shadow;
- a policy-publish approval workflow UI (Studio keeps draft → validate → replay → publish, with versioning, single-user);
- OCSF and ACS export; HA; multi-tenant auth beyond per-tenant API keys;
- the `llm_agent_driver` running on a local instruct model (only its "not configured" path ships);
- B1 and B3 (D9).

## 6. Open-data pipeline (the user's "收集开源数据来做训练、微调或者推理")

| Source (licence at repo level, checked) | Use | Mapped questions and label derivation |
|---|---|---|
| InjecAgent `uiuc-kang-lab/InjecAgent` (MIT) | train/cal/test | `instruction_override`: attacker instruction in a tool response → true; benign tool response → false. `sensitive_data_transfer`: the data-stealing attack class, at the tool call that sends data → true |
| AgentDojo `ethz-spylab/agentdojo` (MIT) | test (held-out family) | the banking / slack / workspace suites: injection tasks vs user tasks → `instruction_override`, `goal_deviation` (a tool call that serves the injection goal, not the user goal) |
| ASB `agiresearch/ASB` (MIT) | train/cal | attack tools and tasks → `instruction_override`, `goal_deviation` |
| ToolEmu `ryoungj/ToolEmu` (Apache-2.0) | cal/test | risky-toolkit cases → `semantic_impact` ordering, `sensitive_data_transfer` where the case states it |
| tau-bench `sierra-research/tau-bench` (MIT) | benign negatives | retail and airline tasks as benign `goal_deviation=false`; `claim_asserts_completion` on agent final messages where the task outcome is recorded |
| Excluded: R-Judge (`Lordog/R-Judge`) | — | no licence declared |

Rules for this pipeline:
- **Licences:** the licence is re-checked **per data file** during fetch. If a dataset's data licence differs from the repo's code licence, that source is dropped from redistribution: it stays local-only, and the manifest says so.
- **Pinning:** `eval/sources/manifest.json` pins every source to a commit plus sha256.
- **Splits:** by **source family** and template (RFC §12.2). No template appears in both train and test. **AgentDojo is fully held out as the test family.**
- **Formats:** the converters emit Kev's training JSONL (`state`, `questions{…, label}`) and our eval format (snapshot + question + label + provenance).
- **Fine-tune (Gate B, bounded, §5):**
  - `kev.train --init_from jaredpalmer/kev-0.8b`, LoRA, local on the M4 Pro (Kev's README: "the Mac path works but is slow for Qwen3.5 bases"); then Kev-4B if the 0.8B run finishes in a reasonable wall time.
  - Every run records its config, data hashes, wall time and eval results.
  - **A result of "no gain" is reported as such** (Kev's README notes that small datasets can fall inside the noise).
  - Modal or cloud GPUs are used only with the user's go-ahead, since they cost money.
- **Eval report:**
  - per question and per source family: accuracy, PR, Brier, ECE, abstention, `judge_http_rtt_ms` p50/p95 on this machine, and bootstrap CIs;
  - B0 vs B2 (Kev-0.8B and Kev-4B) vs B2-ft (same base as its B2), with B1 and B3 shown as *not measured* (D9);
  - `payee_relation` and `claim_support` have no training source, so they are reported as *no training data*, not as a fine-tune result;
  - **incremental recall over B0** as a separate line (RFC §11.1 `jev_incremental_recall`).

## 7. Tasks and ownership (literal paths)

- **T0, foundation (planner, first, alone):**
  - `package.json`, `tsconfig.json`, `contracts/**`, `rubrics/**`;
  - `server/storage/migrations/0001_init.sql` and **`server/storage/db.ts`** (the PGlite / `pg` bootstrap);
  - interface stubs for every `server/*` module;
  - `docs/CONTRACTS.md`, `docs/IMPLEMENTATION_BACKLOG.md`, `LICENSE`, `NOTICE`, `.gitignore`.
  - **The Node 25 type-stripping subset** is stated in `docs/CONTRACTS.md` and checked by `tsc --noEmit` (with `erasableSyntaxOnly`, `verbatimModuleSyntax` and `allowImportingTsExtensions`): no `enum`, no `namespace`, no parameter properties, and type-only imports marked.
  - Acceptance: `node --test` runs; the contract schemas validate golden fixtures; migrations apply on PGlite; `tsc --noEmit` is clean.
- **T1, judges, rules, outcomes and sandbox core (DeepSeek):**
  - `server/judges/**`: the `/v1/systemone` client, the RFC §6.4 validator, the token and request limiter, the deadline/abort handling and the billing-unknown flag;
  - `server/rules/**`, `server/outcomes/**`;
  - `sandbox/{schema.sql,seed.ts,gateway.ts,tools/**}`;
  - `server/storage/repos/**`.
  - Acceptance: validator unit tests on recorded Kev responses, including malformed, missing, out-of-range and model-mismatch cases; the gateway refuses unbound or expired decisions; the verifier state machine is covered.
- **T2, server core and UI (planner):**
  - `server/{api,ingest,state,policy,worker}/**`;
  - `sdk/**`;
  - `sandbox/{drivers/**,scenarios/**}`;
  - `web/**`: copied UI + live adapter.
  - Acceptance: S1–S4, S6 and F1-shadow run end to end with real Kev (Gate A); S5, S9, S7 and S8 run end to end (Gate B); the gate path (Gate C). The SSE resumes after a restart, and the UI shows the four provenance dimensions.
- **T3, verification suite (Codex, build slice; the Gate A items in Gate A, the gate items in Gate C):**
  - `tests/e2e/**`, `tests/security/**`, `tests/probe/**`.
  - Acceptance:
    - the hard veto is invariant to thresholds;
    - no "check A, execute B" (digest mismatch → not executed);
    - replaying a payment never re-executes (idempotency);
    - tenant isolation;
    - **key handling:** a canary judge key never appears in UI, SSE, query strings, logs, exports or error bodies (RFC §6.4);
    - **authorisation revoked after the decision was issued → `not_executed`** (Gate C);
    - a timeout on a high-impact tool gives HOLD with no ledger row;
    - policy-only replay makes zero judge calls (asserted by a call counter);
    - accepted events survive a restart;
    - UI probes: provenance labels present, no "Jev" label on a Kev answer, and absent baselines rendered as "not measured".
  - Each security probe is proven able to fail.
- **T4, open-data pipeline (DeepSeek, after T1):** `eval/sources/**`, `eval/convert/**`, `eval/splits/**`, `docs/EVAL.md` (the data section).
- **T5, eval runner and fine-tune (planner, after T4):** `eval/run/**`, `eval/finetune/**`, `docs/EVAL.md` (the results section).
- **T6, deploy and docs (planner):** `deploy/**`, `README.md`, `docs/ARCHITECTURE.md`, `docs/THIRD_PARTY.md`.

Rules:
- Each seat edits only its own paths. Contract problems are reported, not routed around.
- `third_party/kev` lives **outside the repo** (`~/workplace/Silex/third_party/kev`, pinned commit recorded). A `scripts/kev-serve.sh` script starts it.

## 8. Acceptance (per gate; see §5 for which items belong to which gate)

- `npm test` passes: unit, contract, integration and security.
- The e2e suite passes against a live Kev server.
- UI probes pass.
- **Gate B:** the eval report is generated from `eval/run` with its artefacts. B0 and B2 are required; B2-ft is reported whatever its outcome.
- A recorded demo run is committed under `runs/demo-<date>/`, sanitised; there is no customer data anywhere. What it contains grows by gate: **Gate A** has events, snapshots, raw Kev responses, signals, outbox and UI probe results; **Gate B** adds outcomes and the eval artefacts; **Gate C** adds control decisions and execution receipts.
- The README states exactly what is real (Kev inference, sandbox tool execution, measured latency) and what is not (hosted Jev unless keyed, human gold labels, real money or email).

## 9. Publishing

- **Public repo:**
  - created at `github.com/silex-ai-lab/jev-realtime-observability` (name to confirm);
  - licence Apache-2.0;
  - `NOTICE` credits Kev (Apache-2.0) and each dataset.
- **When:**
  - repo creation and the first push of the plan and scaffold happen after the plan gate passes;
  - implementation commits are pushed only after that gate's code review passes (A, then B, then C).
- **Never pushed:** model weights (they stay on HF, referenced by revision) and raw third-party data (fetched by script).

## Review record

*(Round tables are appended here.)*

### Round 1 (plan v0.1, commit `24370b7`)

Verdicts: **CODEX: PLAN-REJECTED · DEEPSEEK: PLAN-APPROVED.**

**The one split, and how it was resolved.**
- Codex: M0–M3 in one gate is too broad, and a mandatory B2-ft makes the gate fail for wall-clock reasons. Cut to M0–M1, or make M2 and M3 separate gates.
- DeepSeek: don't cut scope, since the user asked for training and fine-tuning, but decouple the fine-tune from the gate.
- **Pick:** three gates, A/B/C, each with its own review and push. B2-ft becomes a bounded attempt reported whatever its outcome.
- **Why:** it removes Codex's reason to object (no single oversized gate, and no gate hostage to training time) and keeps DeepSeek's (every requested capability is still delivered in this effort).

| Objection or suggestion (who) | Change in v0.2 |
|---|---|
| Scope M0–M3 too broad for one gate (Codex 2, blocking) | §5 rewritten into Gates A/B/C; D10 |
| B2-ft makes the gate unbuildable (Codex 1, blocking; DeepSeek 3) | Gate B requires B0 + B2 only; B2-ft time-boxed at 3 h and reported whatever its outcome |
| B3 silently dropped (DeepSeek 1) | D9: B1 and B3 deferred, rendered "not measured" |
| Fine-tune base differs from the B2 base (DeepSeek 2) | B2 on both Kev-0.8B and Kev-4B; B2-ft compared on the same base |
| `payee_relation` and `claim_support` have no training source (DeepSeek 4) | Reported as "no training data" |
| Node 25 type-stripping subset (DeepSeek 5) | T0 states the subset; `tsc --noEmit` with `erasableSyntaxOnly` |
| No key-handling probe (DeepSeek 6) | T3 canary-key probe |
| `db.ts` bootstrap unowned (DeepSeek 7) | Assigned to T0 |
| No revocation test (DeepSeek 8) | T3 revoked-after-issue → `not_executed` (Gate C) |
| Absent baselines rendered as 0 (DeepSeek 9) | UI probe asserts "not measured" |
| The Jev/Kev framing must be unmissable (DeepSeek 10; Codex "judge view") | README headline and repo description sentence; "judge view" wording |
| D8's reference to a non-existent T9 (Codex) | Removed |
| Labels need an evidence class (Codex) | `benchmark_ground_truth_derived`, `heuristic_derived` or `human_reviewed` on every label |
| awesome-jev projects credited as references only (Codex) | §2 and docs/THIRD_PARTY.md |
| D6's default is Kev-tuned (DeepSeek, architecture note) | Noted: the 1,024-token default is per backend; the TypeSafe backend may raise it |

### Round 2 (plan v0.2, commit `b842b24`)

Verdicts: **CODEX: PLAN-APPROVED · DEEPSEEK: PLAN-APPROVED.** Consistency notes folded into v0.3, so a confirmation round is needed:

| Note (who) | Change in v0.3 |
|---|---|
| T2's acceptance still listed S5/S9, which are Gate B (Codex 1, DeepSeek 2) | T2's acceptance is split by gate |
| §8's demo run mentioned receipts and outcomes before their gates (Codex 2) | The demo-run contents are listed per gate |
| D-table out of order (Codex 3, DeepSeek 3) | Reordered D1–D10 |
| D6 per-backend note lived only in the review table (DeepSeek 1) | Moved into the D6 row |
| The Kev-4B fine-tune had no time box (DeepSeek 4) | Its own 3 h box, only if 0.8B finished inside its box |
| (planner, found while fixing) D6 still said "Jev view", contradicting the v0.2 wording rule | Changed to "judge view" |

A first attempt at this confirmation round went out while the v0.3 edit had failed. Both reviewers reported an empty diff, and that round is void. Round 3 below is the rerun on the real v0.3.

### Round 3 (plan v0.3, commit `0aab813`, confirmation rerun)

Verdicts: **DEEPSEEK: PLAN-APPROVED · CODEX: PLAN-APPROVED · PLANNER (claude): PLAN-APPROVED.** The plan text is frozen at `0aab813`.

Roster:
- planner: Claude (Opus 5.5);
- coder-deepseek: OpenCode, `deepseek/deepseek-v4-pro`;
- reviewer-codex: Codex CLI, `gpt-5.5`, pinned per session.

## Gate A implementation record

Built on branch `gate-a` from base `f9bcc05`:
- **T0 foundation:** `0bd5e14` (planner), plus `999a42b` (CONTRACTS §7: the fixed seed dataset).
- **T1** (DeepSeek): judges (client, validator, limiter), rules, repos, sandbox (schema, seed, authority, gateway, and tools with their own authorization), and the stub judge server. 53 unit tests plus one opt-in live-Kev test.
- **T2** (planner): app, API and SSE, ingest (events and OTLP JSON), state assembler, policy, worker, SDK with OTel mirror, scripted driver and scenarios, the live console, and `web/demo` (the old simulated UI, kept).
- **T3** (Codex, build slice): security suites (tenant isolation, key canary, replay invariance, zero-call replay, restart durability, dedup/conflict, judge failure), the live-Kev e2e, and UI probes (PASS/FAIL/SKIP). Each security test has a recorded mutation that makes it fail.

**Defects found before review (planner smoke against live Kev):**
- pre-execution rules firing on `post_tool`;
- staleness measured from queue time, so a backlog would produce false STOPs;
- run timeline missing evaluations (found by DeepSeek);
- worker slots not actually concurrent;
- non-idempotent completion under lease expiry, with a test proven both ways;
- KPIs mixing the judge path with the rule-only path, and counting failed calls as judge latency;
- probe P2 passing without evidence (found by the planner; fixed by Codex).

**Contract fixes found by DeepSeek:**
- a double body read in the harness;
- a replay test whose event never tripped `amount_limit`;
- an S2 expectation inconsistent with experimental mode.

### Code round 1 (HEAD `11e71df`, diff revision `0a6d4f6d52ef`)

Verdicts: **CODEX: IMPL-REJECTED · DEEPSEEK: IMPL-APPROVED.**

| Defect or note (who) | Change |
|---|---|
| The conflict digest covered only a subset of fields, so a changed task_goal, sources or result body under the same id was accepted as a duplicate (Codex 1, blocking) | `eventContentDigest` hashes everything except transport fields; the SDK mirror carries `tool_call_id`. `tests/integration/dedup.test.ts`: a real OTel-exporter mirror dedups with zero conflicts, and each content change returns 409. It fails against the old digest |
| A same-millisecond same-producer event could leak into a snapshot (DeepSeek 1) | seq tie-break in the assembler |
| Args were stored unredacted despite the contract (DeepSeek 2) | registry redaction at ingest; `args_digest` kept; tested |
| History kept the first N events, not the last N (DeepSeek 3) | DESC + reverse |
| Duplicate-decision TOCTOU on real Postgres (DeepSeek 4) | advisory lock in the completion transaction, plus migration 0002 unique index |
| Contract wording on `content_digest` (DeepSeek 5) | CONTRACTS §2 |
| The coverage KPI counted partial-with-required evaluations as uncovered (DeepSeek 6) | fixed |
| The UI never evicts rows (DeepSeek 7) | deferred (cosmetic) |

### Code round 2 (HEAD `2181838`, diff revision `4f4a7d618e396ad92019f8c0aea2fa40904400c1`, base `f9bcc05`)

**CODEX: IMPL-APPROVED · DEEPSEEK: IMPL-APPROVED · PLANNER (claude): IMPL-APPROVED.**

Evidence at this revision:
- `npm test`: 90 pass, 1 skip.
- Live e2e against Kev-4B: pass.
- UI probes with live Kev: 5/5.
- Demo run recorded on this code: `runs/demo-2026-09-28/`, with 10 raw Kev responses teed from real calls, 12 ledgered judge attempts (2 real F1 aborts), and a sandbox ledger with exactly the three payments that the tools' own authorization allows.

**Gate A outcome:** plan 3 rounds (unanimous in round 3); code 2 rounds. **Merged to `main` and pushed after the unanimous round 2.**

## Gate B implementation record

Built on branch `gate-b` from base `9699d8b`. T0-B: `a421543` (eval contract, shared eval formatter, migration 0003, CONTRACTS §8).

**T1-B and T4** (DeepSeek):
- read-time settlement; the gateway attempt log (the capture-coverage denominator);
- the outcome verifier (pending → verified_success / verified_failure / mismatch / unknown_after_deadline; append-only);
- the open-data pipeline: 5 sources pinned by commit and sha256, a fail-closed per-note licence check, 1,931 items, AgentDojo test-only, and state-level split hygiene.

**T2-B and T5** (planner):
- the worker ↔ verifier wiring, and a claim-vs-outcome report at post_generation;
- model_reeval, with a budget and a ledger, and sandbox_reexec (admin only);
- `/v1/metrics`;
- S5, S7, S8 and S9;
- the UI (outcomes, re-eval, server metrics);
- the eval runner, the report (thresholds fitted on the calibration split only), B0 heuristics, the bounded fine-tune launcher, and the generated EVAL results.

**T3-B** (Codex): outcome, replay, metrics and eval-hygiene tests, plus a live-Kev e2e for S5, S7, S8 and S9. Each has a recorded mutation that makes it fail.

**Findings during the build** (not in any plan; each is fixed and recorded):
1. Split leakage: tau-bench airline tasks were merged twice (DeepSeek), plus repeated AgentDojo calls. Identical states are now merged before splitting.
2. **Label confound: the presence of low-authority text alone predicted the label** (shortcut accuracy 1.000). The first fine-tune learned it (AgentDojo AUROC 0.999). Planner found it; eval v1 is kept as a record. Fix: benign low-authority content in negatives, with a shortcut audit enforced by a unit test.
3. **Source separability** of `goal_deviation` dev. The report now prints a source-majority check.
4. **Hand-typed numbers in `docs/EVAL.md`**, found by both reviewers in round 1. The results are now generated from committed artefacts and drift-tested.

### Result (generated from the committed artefacts)

<!-- generated by eval/run/summary-md.ts from runs/eval-2026-09-28-v2 and runs/ft-kev-0.8b-2026-09-28; do not edit by hand -->
Held-out items: calibration 245, dev 213, test 250 (test = AgentDojo, never seen in training).

**Fine-tune (B2-ft):** Kev-0.8B + LoRA, `--init_from jaredpalmer/kev-0.8b` (weights sha256 9b908623acb1…), 2 epochs, lr 2e-5 (from eval/finetune/finetune.sh), on 1223 train records of which Kev used 1183 (40 dropped as longer than its 384-token training context); wall time 39 min on MPS; completed inside the 3 h box.

**Held-out family (AgentDojo test).**

| model | instruction_override AUROC | goal_deviation AUROC | goal_deviation recall @ calibration threshold [95% CI] · FPR |
|---|---|---|---|
| B0 heuristics | acc 0.892, recall 0.229 | no code baseline | — |
| Kev-0.8B | 0.602 | 0.893 | 0.400 [0.237, 0.563] · 0.014 |
| Kev-4B | 0.792 | 0.541 | 0.286 [0.125, 0.444] · 0.209 |
| Kev-0.8B fine-tuned | 0.973 | 0.961 | 0.800 [0.649, 0.931] · 0.009 |

**Judge HTTP round trip on this machine** (from each prediction file):

| model | p50 | p95 | n |
|---|---|---|---|
| Kev-0.8B | 151 ms | 345 ms | 708 |
| Kev-4B | 857 ms | 2001 ms | 708 |
| Kev-0.8B fine-tuned | 149 ms | 343 ms | 708 |

<!-- /generated -->


The live policy stays in `experimental` mode, and the fitted calibrations are recorded but not activated. The reasons are in `docs/EVAL.md`: dev is source-separable; there is a residual constructed-versus-recorded style risk on AgentDojo test; and `instruction_override` has too few calibration negatives.

### Code rounds

| Round | HEAD | Verdicts | Blocking defects |
|---|---|---|---|
| 1 | `cddd80b` | CODEX: IMPL-REJECTED · DEEPSEEK: IMPL-REJECTED | hand-typed EVAL numbers that did not reproduce (both); fetch.ts note check a no-op (both); wrong record count (DeepSeek) |
| 2 | `0b99c1a` | CODEX: IMPL-APPROVED · DEEPSEEK: IMPL-REJECTED | `train.log` git-ignored, so the generated numbers were not reproducible in a fresh clone |
| 3 | `be2f5c4`, diff revision `5be009fd923863ef7b1c54a723bab20890e66a52`, base `9699d8b` | **CODEX: IMPL-APPROVED · DEEPSEEK: IMPL-APPROVED · PLANNER (claude): IMPL-APPROVED** | — |

Evidence at `be2f5c4`:
- `npm test`: 124 pass, 1 skip. A fresh clone gives 123 pass and 2 skips (the raw data is not fetched, and the live Kev test is opt-in).
- The live-Kev e2e for Gates A and B passes, and the UI probes are 5/5.

One reviewer claim was checked and was not a defect: Codex's round-1 note on the model re-eval UI field. The API does return `recommended` (`server/api/index.ts:232`).

**Gate B outcome:** 3 code rounds; **merged to `main` and pushed after the unanimous round 3.**
