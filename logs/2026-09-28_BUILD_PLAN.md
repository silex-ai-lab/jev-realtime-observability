# Jev real-time agent observability — open-source build plan (v0.1)

Author: Claude (planner) · 2026-09-28 · Status: **v0.1 — draft, in review**
Repo: `jev-realtime-observability` (local; created at `github.com/silex-ai-lab/` only after the plan gate passes) · Review base: *recorded at Step 5*

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
| D6 | **The Jev view is ≤ 1,024 tokens** (state + longest question) by default, configurable. | Kev was trained on states of at most 384 tokens and at most 1,024 for state plus one question, and accuracy drops on long documents (Kev README "Length", "Limitations"). | Tighter than the RFC's 2–4k |
| D7 | **Backend in TypeScript on Node 25**: native type stripping, no build step. Dependencies are few (`@electric-sql/pglite`, `pg`, `zod`, `@opentelemetry/*`); tests use `node --test`. Python appears only through Kev's own CLI (serve, train, benchmark), managed by `uv`. | RFC §3 asks for a TS backend. One language for the product. | as RFC |
| D8 | **The agent driver is `scripted_driver` in P0.** An `llm_agent_driver` targets any OpenAI-compatible endpoint (a local `mlx_lm.server` or a key). If none is configured, the UI shows *not configured*; it is never faked. | No LLM API key exists here. Running a local instruct model is optional (T9). | RFC §4 |

## 2. Claim discipline (the reviewers' first axis)

- Four provenance dimensions are stored and shown on every record (RFC §2): `source_mode` (demo / live_sandbox_shadow / live_sandbox_gate), `judge_source` (**kev-local:<model@revision>** / typesafe:<model> / stub / none), `tool_environment` (sandbox) and `enforcement_mode` (shadow / gate).
  - **"Jev" in the UI means the protocol.** The actual model is always named. Kev answers are never labelled "Jev". The About page states that Kev is an open reimplementation, not TypeSafe's model.
- **Every latency is measured** with a monotonic clock (`performance.now()` / `process.hrtime.bigint()`), per stage (RFC §11.1). No latency is simulated outside `web/` demo mode.
- **Kev's published accuracy, Brier and latency numbers** are quoted only in the About page and docs, as *Kev's own reported results*.
  - Our numbers come only from our eval runs, with their `runs/` artefact path.
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

## 5. Milestones in this run

- **M0 — trusted interfaces:**
  - contracts, rubrics, migrations;
  - the `/v1/systemone` client and validator, tested against **recorded real Kev responses**;
  - the Kev server running locally.
- **M1 — real shadow loop:** the runner → events/OTLP → snapshot → rules → Kev → persisted signal → SSE → the existing Live UI and Inspector; scenarios S1–S6 and S9 on sandbox tools, all real executions.
- **M2 — evidence and evaluation:**
  - the outcome verifier (state machine) and the three replay kinds;
  - measured metrics (RFC §11.1: `ingest_to_signal_ms`, `judge_http_rtt_ms`, capture, semantic and enforcement coverage);
  - the open-data eval: B0, B2 on Kev-4B, and B2-ft after fine-tuning;
  - S7 and S8.
- **M3 — sandbox gate:**
  - preflight with a 600 ms total and 400 ms Jev budget (RFC §6.5), binding, idempotency, HOLD on missing required signals, and receipts;
  - a demonstration that a denied payment leaves no ledger row.
- **Not in this run:** M4 customer shadow, policy publish approval workflow UI (Studio keeps draft→validate→replay→publish with versioning but single-user), OCSF/ACS export, HA, multi-tenant auth beyond API keys per tenant.

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
- **Fine-tune:**
  - `kev.train --init_from jaredpalmer/kev-0.8b`, LoRA, local on the M4 Pro (Kev's README: "the Mac path works but is slow for Qwen3.5 bases"); then Kev-4B if the 0.8B run finishes in a reasonable wall time.
  - Every run records its config, data hashes, wall time and eval results.
  - **A result of "no gain" is reported as such** (Kev's README notes that small datasets can fall inside the noise).
  - Modal or cloud GPUs are used only with the user's go-ahead, since they cost money.
- **Eval report:**
  - per question and per source family: accuracy, PR, Brier, ECE, abstention, `judge_http_rtt_ms` p50/p95 on this machine, and bootstrap CIs;
  - B0 vs B2 vs B2-ft (and B1 only if an LLM judge is configured);
  - **incremental recall over B0** as a separate line (RFC §11.1 `jev_incremental_recall`).

## 7. Tasks and ownership (literal paths)

- **T0, foundation (planner, first, alone):**
  - `package.json`, `tsconfig.json`, `contracts/**`, `rubrics/**`;
  - `server/storage/migrations/0001_init.sql`;
  - interface stubs for every `server/*` module;
  - `docs/CONTRACTS.md`, `docs/IMPLEMENTATION_BACKLOG.md`, `LICENSE`, `NOTICE`, `.gitignore`.
  - Acceptance: `node --test` runs; the contract schemas validate golden fixtures; migrations apply on PGlite.
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
  - Acceptance: S1–S6 and S9 run end to end with real Kev; the SSE resumes after a restart; the UI shows the four provenance dimensions.
- **T3, verification suite (Codex, build slice):**
  - `tests/e2e/**`, `tests/security/**`, `tests/probe/**`.
  - Acceptance:
    - the hard veto is invariant to thresholds;
    - no "check A, execute B" (digest mismatch → not executed);
    - replaying a payment never re-executes (idempotency);
    - tenant isolation;
    - a timeout on a high-impact tool gives HOLD with no ledger row;
    - policy-only replay makes zero judge calls (asserted by a call counter);
    - accepted events survive a restart;
    - UI probes: provenance labels present, and no "Jev" label on a Kev answer.
  - Each security probe is proven able to fail.
- **T4, open-data pipeline (DeepSeek, after T1):** `eval/sources/**`, `eval/convert/**`, `eval/splits/**`, `docs/EVAL.md` (the data section).
- **T5, eval runner and fine-tune (planner, after T4):** `eval/run/**`, `eval/finetune/**`, `docs/EVAL.md` (the results section).
- **T6, deploy and docs (planner):** `deploy/**`, `README.md`, `docs/ARCHITECTURE.md`, `docs/THIRD_PARTY.md`.

Rules:
- Each seat edits only its own paths. Contract problems are reported, not routed around.
- `third_party/kev` lives **outside the repo** (`~/workplace/Silex/third_party/kev`, pinned commit recorded). A `scripts/kev-serve.sh` script starts it.

## 8. Acceptance for the code gate

- `npm test` passes: unit, contract, integration and security.
- The e2e suite passes against a live Kev server.
- UI probes pass.
- The eval report is generated from `eval/run` with its artefacts.
- A recorded demo run (event log, snapshots, raw Kev responses, receipts, outcomes) is committed under `runs/demo-<date>/`, sanitised; there is no customer data anywhere.
- The README states exactly what is real (Kev inference, sandbox tool execution, measured latency) and what is not (hosted Jev unless keyed, human gold labels, real money or email).

## 9. Publishing

- **Public repo:**
  - created at `github.com/silex-ai-lab/jev-realtime-observability` (name to confirm);
  - licence Apache-2.0;
  - `NOTICE` credits Kev (Apache-2.0) and each dataset.
- **When:**
  - repo creation and the first push of the plan and scaffold happen after the plan gate passes;
  - implementation commits are pushed only after the code gate passes.
- **Never pushed:** model weights (they stay on HF, referenced by revision) and raw third-party data (fetched by script).

## Review record

*(Round tables are appended here.)*
