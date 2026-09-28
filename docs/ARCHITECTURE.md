# Architecture (Gate A)

This implements RFC §3 in one process. The RFC is in [`../logs/2026-09-28_RFC_v0.1_source_gpt.md`](../logs/2026-09-28_RFC_v0.1_source_gpt.md) and the plan in [`../logs/2026-09-28_BUILD_PLAN.md`](../logs/2026-09-28_BUILD_PLAN.md).

```
scripted driver ── sdk.emit() ──► POST /v1/events ─┐
      │            OTel span ───► POST /v1/traces ─┤ ingest: validate, tenant from key, identity digest,
      │                                            │ event + evaluation job in ONE transaction → 202
      ▼                                            ▼
 tool gateway ──► sandbox.* tables          PostgreSQL (PGlite or DATABASE_URL)
 (own limits,                                      │ leased job
  approvals,                                       ▼
  allowlist,                          worker: snapshot (only events received ≤ this one,
  idempotency)                                authoritative sandbox records; code facts)
                                              → hard rules (pure over facts)
                                              → decided? skip judge; queue a low-priority diagnostic
                                              → else JudgeClient → /v1/systemone (Kev) → validator
                                              → policy.decide (RFC §7 order) → snapshot, evaluation,
                                                decision, outbox in ONE transaction
                                                   │
                         GET /v1/stream (SSE, cursor resume, short-lived single-use token)
                                                   ▼
                                     web/ live console (renders records only)
```

## Invariants and where they live

| Invariant (RFC) | Where it is enforced | Test |
|---|---|---|
| A hard rule cannot be overridden by the model (§7) | `policy.decide` step 2 runs before any semantic step; replays reuse the stored `rule_results` | `tests/unit/policy`, `tests/security/policy-replay` |
| Missing evidence is not "no risk"; a judge failure is not "low risk" (§2) | `decide` steps 3–4: `HOLD` / `ALERT`, `judge_unavailable`, a coverage gap | `tests/unit/policy`, `tests/security/judge-failure` |
| Uncalibrated signals never act (§7) | `semantic.mode = experimental`; `calibrated` requires a known calibration id | `tests/unit/policy` |
| No "future knowledge" in a snapshot (§5.5) | the assembler filters history to `received_at ≤` the event | `tests/unit/state` |
| Judge identity comes from `/v1/models`, never from the model name (plan §0) | `JudgeClient.describe()` → `judge_source` | `tests/contract/foundation` |
| Keys never leak (§6.4, §13) | hashed keys; errors scrubbed; the stream uses short-lived tokens | `tests/security/canary` |
| Accepted events are never silently lost (§9.1) | event and job in one tx; leases; outbox cursor | `tests/security/reliability` |
| Tenant isolation (§9.2) | tenant derived from the key; every repo query is tenant-scoped; cross-tenant → 404 | `tests/security/tenant-isolation` |
| Policy-only replay makes zero model calls (§10) | `/v1/replays` reads stored snapshots and signals only; the `judge_calls` ledger | `tests/security/policy-replay` |

## Measured, not asserted

- `ingest_to_signal_ms`: the difference between `received_at` and the moment of commit, both taken in the same process.
- Stage durations use `performance.now()`.
- `judge_http_rtt_ms` is measured by the client, including reading the full body.
- `vendor_latency_ms` is what the judge server reports about itself; it is not our measurement.
