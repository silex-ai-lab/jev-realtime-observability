# Contracts (T0 foundation, Gate A)

Plan: [`../logs/2026-09-28_BUILD_PLAN.md`](../logs/2026-09-28_BUILD_PLAN.md) v0.3 (approved `0aab813`). RFC: [`../logs/2026-09-28_RFC_v0.1_source_gpt.md`](../logs/2026-09-28_RFC_v0.1_source_gpt.md).
This file plus `contracts/*.ts`, `rubrics/*.json`, `server/storage/migrations/*.sql` and the stub signatures in
`server/judges/index.ts`, `server/rules/index.ts`, `server/storage/repos.ts` and `sandbox/index.ts` are the contract.
**If something here is wrong, report it; don't route around it.**

## 1. Language rules (Node 25 native type stripping; checked by `npm run typecheck`)

- Run `.ts` directly with `node` (no build). Imports use explicit `.ts` extensions.
- **Erasable syntax only** (`erasableSyntaxOnly`): no `enum`, no `namespace`, no parameter properties, no `import x = require()`.
  Use `as const` objects or string unions (zod enums) instead of `enum`.
- `verbatimModuleSyntax`: type-only imports must be `import type`.
- Dependencies: `zod` (v4), `@electric-sql/pglite`, `pg`, `@opentelemetry/*`. Anything else needs a note in the report.
- Tests: `node --test` only. Files `tests/{unit,contract,integration,security,e2e}/**/*.test.ts`.
- Time: durations use `performance.now()`; timestamps are ISO strings from `new Date().toISOString()`.
- Secrets: an API key (tenant keys, judge key) must never appear in a log line, an error message, a stored
  row other than as a sha256 hash, an HTTP response body, an SSE payload or a query string.

## 2. Files and owners (Gate A)

| Paths | Owner |
|---|---|
| `package.json`, `tsconfig.json`, `.npmrc`, `contracts/**`, `rubrics/**`, `server/storage/{db.ts,migrations/**}`, `docs/CONTRACTS.md`, `docs/IMPLEMENTATION_BACKLOG.md`, `LICENSE`, `NOTICE`, `scripts/kev-serve.sh` | planner (T0; frozen after dispatch) |
| `server/judges/**`, `server/rules/**`, `server/storage/repos.ts`, `sandbox/{index.ts,schema.sql,seed.ts,authority.ts,gateway.ts,tools/**}`, `tests/helpers/stub-judge-server.ts`, `tests/unit/{judges,rules,repos,sandbox}/**` | deepseek (T1) |
| `server/{app.ts,main.ts,config.ts}`, `server/{api,ingest,state,policy,worker}/**`, `sdk/**`, `sandbox/{drivers,scenarios}/**`, `web/**`, `tests/unit/{state,policy,ingest}/**`, `tests/integration/**` | planner (T2) |
| `tests/security/**`, `tests/e2e/**`, `tests/probe/**`, `tests/helpers/{harness.ts,canary.ts}` | codex (T3) |

`contracts/canonical.ts` (`canonicalJson`, `sha256`, `digestOf`) is the only digest implementation:
`argsDigest(args) = digestOf(args)`, `requestHash(req) = digestOf(req)`, event `content_digest = digestOf(body)`.

## 3. Real judge responses

`contracts/fixtures/kev/` holds requests and responses recorded from the local Kev-4B server
(`jaredpalmer/kev-4b`, MLX, bf16) — `ap-*` (choice + 2 noul) and `score-*` (score + noul), plus `/v1/models`.
Validator tests start from these and mutate them (missing required answer, NaN, sum ≠ 1, unknown option,
legend mismatch, oversized body, wrong type, model identity mismatch).

## 4. App factory (T2 provides; T3 and integration tests use)

```ts
import { createApp } from '../server/app.ts';
const app = await createApp({
  db?: Db,                                  // default: in-memory PGlite, migrated + sandbox seeded
  judge: JudgeConfig | null,                // null → judge 'not_configured' (evaluations record it; never "safe")
  sourceMode: 'live_sandbox_shadow',
  tenants: [{ tenant_id: 't-alpha', name: 'Alpha', keys: { ingest: 'k1…', reader: 'k2…', gateway: 'k3…', admin: 'k4…' } }],
  worker: { autostart: boolean, leaseMs?: number, realtimeTtlMs?: number },
  port?: number,                            // 0 = ephemeral; app.url has the bound URL
});
app.url; app.db; app.judge; app.worker.drain(): Promise<void>  // process until no ready job
await app.close();
```

## 5. HTTP API (Gate A). All bodies JSON. Auth: `Authorization: Bearer <tenant key>`

| Method, path | Role | Behaviour |
|---|---|---|
| `POST /v1/events` | ingest | Body: one `BoundaryEvent` or `{ "events": [...] }` (≤ 100). Tenant from the key; a `tenant_id` in the body is rejected (400). Each event is persisted **with its evaluation job in one transaction** before `202 { accepted: [{ event_id, status: "inserted"|"duplicate" }] }`. Same id + different content → `409` and an audit row. |
| `POST /v1/traces` | ingest | OTLP/HTTP JSON `ExportTraceServiceRequest`. Spans carrying `silex.event_id` and `silex.boundary` attributes are normalised into `BoundaryEvent`s (`ingest_path: otlp`); an SDK event with the same `source_event_id` is deduplicated. Returns `200 {}`. |
| `GET /v1/runs`, `GET /v1/runs/:run_id` | reader | Runs; a run's timeline of events with their evaluations and decisions. Tenant-scoped. |
| `GET /v1/evaluations/:evaluation_id` | reader | `{ snapshot, evaluation, decisions }`. |
| `POST /v1/stream/tokens` | reader | `{ token, expires_in: 60 }`: a short-lived, single-tenant stream token (EventSource cannot send headers; long-lived keys never go in a query string). |
| `GET /v1/stream?token=…&cursor=…` | token | SSE from the persisted outbox. `id:` = cursor; resumes from `Last-Event-ID` or `cursor`. Events: `event`, `evaluation`, `decision`, `coverage_gap`, `evaluation_expired`, `run`. |
| `GET /v1/judge` | reader | `{ configured, served_model, judge_source, backend }` from `/v1/models`. |
| `GET /v1/policies/active` | reader | The active policy version and body. |
| `POST /v1/policies/drafts` | admin | Validate a draft; `{ ok, errors, draft_version }`. Does not activate (activation is Gate B). |
| `POST /v1/replays` | reader | `{ kind: "policy_only", decision_ids: [...], policy: <draft body> }` → new decisions with `replay_of`. **Zero judge calls** (reuses stored snapshots, rule results and signals). Other kinds → `501` until Gate B. |
| `POST /v1/sandbox/runs` | admin | `{ scenario: "S1"…"S6"|"F1" }` → starts a scripted sandbox run in-process; `202 { run_id }`. Rate-limited. |
| `GET /healthz`, `GET /readyz` | none | `readyz` = `{ db: "ok", judge: "ok"|"degraded"|"not_configured" }`. |

Errors: `{ error: { code, message } }`. `401` bad or missing key, `403` wrong role, `404` not found **or other tenant's record** (never leak existence).

## 6. Test helpers

- `tests/helpers/stub-judge-server.ts` (T1): `startStubJudge({ models?, respond?(req) => {status, body, delayMs?} }) → { url, calls: SystemOneRequest[], close() }`.
  A real HTTP server speaking `/v1/systemone` and `/v1/models`, so the production client path is exercised.
  Its `/v1/models` reports `backend: "stub"`; it is only ever used by tests.
- `tests/helpers/harness.ts` (T3): starts `createApp` with two tenants and returns keys + helpers.
