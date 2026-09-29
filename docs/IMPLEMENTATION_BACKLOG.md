# Implementation backlog

The RFC (§15) names this file. It tracks the approved plans' tasks; the plans are authoritative:
the build plan `logs/2026-09-28_BUILD_PLAN.md` (Gates A–C) and the dated work plans in
`skills/jev-work-plan/plans/`. Status is `done (<sha>)`, `todo`, `partial: …` or `blocked: …`;
the sha is the commit that finished the task (for a reviewed gate, the commit that closed its
last review round).

## Build (Gates A–C, 2026-09-28)

| Gate | Task | Owner | Status |
|---|---|---|---|
| A | T0 foundation: contracts, rubrics, migrations, db bootstrap, stubs, docs | planner | done (`0bd5e14`, seed `999a42b`) |
| A | T1 judges (client, validator, limiter), rules, repos, sandbox (schema, seed, authority, gateway, tools), stub judge helper | deepseek | done (`11e71df`, review fixes `3caafd6`) |
| A | T2 app, api, ingest (events + OTLP JSON), state assembler, policy (shadow), worker, SSE, sdk, scripted driver, scenarios S1–S4 S6 F1, web live adapter | planner | done (`11e71df`, review fixes `3caafd6`) |
| A | T3 security + e2e + UI probes (shadow loop), each proven able to fail | codex | done (`11e71df`); gate record `9699d8b` |
| B | Outcome verifier (S5, S9), model re-eval + sandbox re-exec replay, metrics, open-data pipeline, B0/B2 eval, bounded fine-tune, S7 S8 | deepseek, planner, codex | done (`0d6c247`, `cddd80b`, fixes `0b99c1a`, `be2f5c4`); gate record `de9d7b8` |
| C | Preflight gate, binding, revocation, receipts, F1-gate | deepseek, planner, codex | done (`abf9b84`, `6d85186`, fixes `77a91cd`, `d0aead2`); gate record `5ff9ddc` |

## After the build

| Task | Status |
|---|---|
| Deploy skill (`skills/deploy-jev-observability`) | done (`6ac7be2`) |
| User manual with screenshots | done (`e714e88`) |
| Optional login, `AUTH_MODE=none\|keys` (default none) | done (`2900165`) |
| Judge notes (`docs/judge/`) | done (`b03c6d8`) |
| `jev-work-plan` skill and the 2026-09-29 plan | done (`ee9732a`) |

## Work plan 2026-09-29 (`skills/jev-work-plan/plans/2026-09-29.md`)

Batch 1 (T1–T5, T9) is a reviewed fleet run, unanimous on revision `8c5825e0`; review fixes in `89ccf2d`: `logs/2026-09-29_WORKPLAN_BATCH1_PLAN.md`.

| ID | Task | Status |
|---|---|---|
| T1 | This backlog brought up to date | done (`3cd5b9c`) |
| T2 | `FAULT_INJECTION` off by default, worker and preflight | done (`f01332a`) |
| T3 | Live console evicts old rows, keeps the selected row | done (`fa2e1ba`) |
| T4 | Review queue backend | done (`5b8249e`) |
| T5 | Label API | done (`5b8249e`) |
| T6 | Export labels to Kev training JSONL | todo |
| T7 | Active-learning sampler | todo |
| T8 | Review panel in the live console | todo |
| T9 | Policy lifecycle: publish, activate, rollback | done (`e000676`) |
| T10 | Kev-4B fine-tune on the open-data split | todo (needs a GPU) |
| T11 | Gate row-lock tests on real PostgreSQL | todo (needs PostgreSQL) |
