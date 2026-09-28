# Implementation backlog

The RFC (§15) names this file. It tracks the approved plan's tasks per gate; the plan is authoritative.

| Gate | Task | Owner | Status |
|---|---|---|---|
| A | T0 foundation: contracts, rubrics, migrations, db bootstrap, stubs, docs | planner | done at dispatch |
| A | T1 judges (client, validator, limiter), rules, repos, sandbox (schema, seed, authority, gateway, tools), stub judge helper | deepseek | — |
| A | T2 app, api, ingest (events + OTLP JSON), state assembler, policy (shadow), worker, SSE, sdk, scripted driver, scenarios S1–S4 S6 F1, web live adapter | planner | — |
| A | T3 security + e2e + UI probes (shadow loop), each proven able to fail | codex | — |
| B | Outcome verifier (S5, S9), model re-eval + sandbox re-exec replay, metrics, open-data pipeline, B0/B2 eval, bounded fine-tune, S7 S8 | — | — |
| C | Preflight gate, binding, revocation, receipts, F1-gate | — | — |
