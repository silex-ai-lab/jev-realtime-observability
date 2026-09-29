# 2026-09-29 work plan, batch 1: P0 cleanup, review queue, labels, policy lifecycle

Fleet run (`herdr-agent-fleet`) over tasks T1, T2, T3, T4, T5 and T9 of
`skills/jev-work-plan/plans/2026-09-29.md`. T6, T7, T8 build on T4/T5 and go in a later batch;
T10 (gpu) and T11 (pg) need hardware this machine does not have.

**Plan version:** v3 · **Repo HEAD at planning:** `ee9732a` · **Review base (`BASE`):** `0687397` (the plan commit).

## Roster

| Seat | Agent | Pane |
|---|---|---|
| planner | Claude Code (Opus 5.5) | `wP:p1` |
| coder-deepseek | OpenCode, `deepseek/deepseek-reasoner` | `wP:p2` |
| reviewer-codex | Codex CLI 0.157.1 | `wP:p3` |

Default roster; no change authorised or needed.

## Machine state at planning

`npm run typecheck` clean; `npm test` 156 tests, 154 pass, 0 fail, 2 skip (live-Kev opt-in; and
the raw-manifest check, because `eval/sources/raw/` is not fetched on this machine). No Kev
running, no `.env`. Nothing in this batch needs Kev.

## Design decisions (reviewers: please judge these)

D1. **Route modules instead of one growing `server/api/index.ts`.** T4, T5 and T9 all add routes.
Two writers on one file collide, so F0 moves the shared HTTP helpers into `server/api/http.ts`
and gives `index.ts` a dispatch seam: `server/api/policies.ts` and `server/api/reviews.ts` each
export `handle(ctx, req, res, url): Promise<boolean>` (true = handled). The two existing policy
routes (`GET /v1/policies/active`, `POST /v1/policies/drafts`) move unchanged into
`policies.ts`. Likewise new storage goes into new files (`server/storage/reviews.ts`,
`server/storage/policies.ts`); `repos.ts` is not edited by anyone. This deviates from the file
lists in the day plan, which named `index.ts` and `repos.ts`.

D2. **Which decisions open a review task.** Original decisions only (`replay_of IS NULL`; policy-only
and model re-eval replays never open one) whose `recommended` is `HOLD` or `REVIEW`. On the
**preflight path only** also `UNKNOWN`, because preflight maps it to `hold_for_review` and an action is
actually held. The worker never opens a task for `UNKNOWN`, in any mode (in gate mode it still decides
read tools and `post_generation`, which are never held); in
shadow mode `UNKNOWN` (the evidence gate's answer to missing or stale evidence on a low-impact
action) does not open one: nothing is held, and it would flood the queue. The task is inserted in the **same transaction** as the decision, in the
worker and in preflight. A unique index on `(tenant_id, decision_id)` (migration
`0004_reviews_labels.sql`) makes redelivery idempotent (`ON CONFLICT DO NOTHING`).

D3. **What resolving does, and does not do.** `POST /v1/reviews/:id/resolve`
`{ "outcome": "allow"|"deny", "answers": { question_id: value } }` (admin only): in one transaction,
with the task row locked (`SELECT … FOR UPDATE`), it checks the task is `open` (else 409), sets
`resolved_allow|resolved_deny`, writes one `labels` row per answer
(`evidence_class = human_reviewed`, `ref = snapshot_id` of the decision, `source = review:<review_id>`),
writes an audit row, and appends an outbox record (`kind: review`). Nothing consumes it yet; the review panel (T8) will.
It **does not** release, execute or re-issue a held gate action: no control is minted and no
decision changes. Releasing held actions is a separate feature, not in this batch. Answers are
optional per question but each key must be a rubric question asked in that decision's
evaluation (or any rubric question if the decision had no evaluation), and each value is
validated by the T5 validator.

D4. **Label value validation (T5), shared with D3.** `noul` → boolean; `choice` → one of the
question's `criteria` keys; `score` → one of the `criteria` levels (string). `ref` must resolve to
an evaluation id or a snapshot id **of the caller's tenant**, else 404. `evidence_class` is one of the
three in the table CHECK; `human_reviewed` only from the admin role (403 otherwise). In
`AUTH_MODE=none` the caller acts as admin (`auth()` returns `roles[0]`), which matches "no login =
full access on loopback". `POST /v1/labels` is **admin-only for every evidence class** (reader → 403
in keys mode); nothing in this batch needs a non-admin label writer. `GET /v1/labels?ref=&question_id=`
(reader/admin), tenant-scoped, newest first, capped at 500.

D5. **Policy lifecycle (T9).** States: `draft → published → active → retired`.
- **Per-tenant versions.** Today `policy_versions.policy_version` is a global primary key, so the
  bootstrap row `policy-a1` can exist for only one tenant: `activePolicy()` swallows the second
  tenant's insert failure and caches `DEFAULT_POLICY` for a tenant with no active row (Codex r1).
  Migration `0005_policy_lifecycle.sql` changes the key to `(tenant_id, policy_version)`, adds a partial unique index
  `ON policy_versions (tenant_id) WHERE status = 'active'` (at most one active per tenant), and creates
  `policy_activations (tenant_id, from_version, to_version, actor, at)`. Version names and existing
  rows are unchanged; `decisions.policy_version` has no foreign key.
- **Bootstrap.** New `ensureActivePolicy(q, tenantId)` in `server/storage/policies.ts`: inside the
  tenant policy lock, inserts `DEFAULT_POLICY` as that tenant's `active` row if it has none
  (`ON CONFLICT DO NOTHING`, no swallowed errors), then returns the active row. It is the single source
  of the bootstrap row (no SQL backfill that could drift from `DEFAULT_POLICY`). Fast path: a plain read
  first; the lock is taken only when no active row exists, so steady-state policy reads don't serialise. `activePolicy()`,
  draft creation, publish, activate and rollback all call it first, so activating before any GET works.
- **Lock.** Every lifecycle write runs in one transaction that starts with
  `pg_advisory_xact_lock(hashtext('policy/' || tenant_id))` (the worker already uses this idiom), then
  reads the active row, then compares. The stale check happens **after** the lock, so two switches with
  the same `expected_active_version` serialise: exactly one succeeds, the other gets 409.
- `POST /v1/policies/:version/publish` (admin): only a `draft` of the caller's tenant; re-validates the
  body; → `published`; otherwise 409 `not_draft`. No route changes a body after publish (the test
  asserts the stored body is byte-equal after later activate and rollback).
- `POST /v1/policies/:version/activate` `{ expected_active_version }` (admin): 409
  `stale_active_version` on mismatch; the target must be `published` or `retired`; old active →
  `retired`, target → `active`; one `policy_activations` row and one audit row.
- `POST /v1/policies/rollback` `{ expected_active_version }` (admin): activates the `from_version` of the
  newest activation whose `to_version` is the current active one, same checks; 409
  `nothing_to_roll_back` when there is none.
- **Route matching.** Any non-empty `policy_version` is valid today (`policy beta` included), and drafts
  append `+draft-<8 hex>`. So the routes match **one encoded path segment**
  (`^/v1/policies/([^/]+)/(publish|activate)$`) and `decodeURIComponent` it exactly once (a malformed
  escape → 400). Every stored name stays addressable; the draft route is unchanged. Test: a draft of
  base `policy beta/ü` (space, slash, non-ASCII) round-trips through publish and activate via its encoded
  name, as does a plain `+draft-` name.
- **Cache.** `activePolicy()` caches per tenant in `app.ts`. F0 adds `invalidatePolicy(tenantId)` to
  `ApiDeps`; the policy routes call it after commit. Invalidation alone races (Codex r2): a read that
  started before the switch could fill the cache with the old policy after the invalidation. So the
  cache keeps a per-tenant **generation**: `invalidatePolicy` increments it; `activePolicy` records the
  generation before its read and only stores the result if the generation is unchanged. Test
  (deterministic, via a test hook that pauses a cache fill between read and store): start a read, let an
  activate commit and invalidate, release the read; the next `GET /v1/policies/active`, the next worker
  decision and the next preflight all carry the new `policy_version`; same for rollback. Worker and preflight share the same function, so
  the next decision reads the new policy. This assumes one server process, which is the only
  deployment today; the plan says so and does not claim multi-replica consistency.
- Every query filters by `tenant_id`; a version of another tenant answers 404.
- **Tests.** In PGlite: two fresh tenants each read, draft, publish, activate and roll back
  independently; activate before any GET; two concurrent activates with the same expected version →
  one 200, one 409, one active row. PGlite runs transactions one at a time, so that test proves the
  stale check, **not** Postgres row-lock behaviour. The same concurrency test also runs against real
  PostgreSQL when `TEST_DATABASE_URL` is set, and is skipped otherwise (no Postgres on this machine; the
  skip is reported, not claimed as a pass).

D6. **`FAULT_INJECTION` default (T2).** F1's fault is applied in **two** places: preflight (already
behind `faultInjection`) and the shadow worker (`server/worker/index.ts:114`, unconditional today;
Codex r1, DeepSeek r1). F0 adds `faultInjection` to `WorkerDeps`, guards the worker's fault with it, and
passes `opts.faultInjection ?? true` from `app.ts` (no behaviour change yet). T2 then flips the
default: `server/config.ts` reads `FAULT_INJECTION === '1'`, and `app.ts` defaults to `false` for both
worker and preflight. `tests/helpers/harness.ts` gets a `faultInjection` option defaulting to `true`,
because the sandbox tests (and the opt-in `gate-a-live-kev` F1 check) exercise F1 on purpose.
Behavioural tests, with `createApp` built directly: shadow and gate, injection off and on, plus
`appOptionsFromEnv()` with the variable unset → off. The recorded gate runs in `docs/GATE.md` are not
regenerated; they were recorded with injection on and say so.

## Tasks and file ownership

Rule: touch only the files in your own list. If you need a change elsewhere, report it instead.

| ID | Owner | Task | Files (only these) | Acceptance |
|---|---|---|---|---|
| F0 | planner | Foundation: `http.ts` helpers, dispatch seam, move the two policy routes into `policies.ts`, empty `reviews.ts`; `invalidatePolicy` in `ApiDeps`; worker `faultInjection` dep and guard (D6). Migrations are created by their owners | `server/api/index.ts`, new `server/api/http.ts`, new `server/api/policies.ts`, new `server/api/reviews.ts`, `server/worker/index.ts` (the fault guard and dep only), `server/app.ts` (pass-through of both only) | typecheck + full `npm test` green, no behaviour change; checkpoint commit before DeepSeek starts |
| T2 | deepseek | `FAULT_INJECTION` off by default (D6) | `server/config.ts`, `server/app.ts` (the `faultInjection` defaults only), `deploy/env.example`, `skills/deploy-jev-observability/SKILL.md`, `tests/helpers/harness.ts` (the option only), new `tests/integration/fault-injection.test.ts`, F1 text in `docs/USER_MANUAL.md` | unset env → F1 `fault: judge_timeout` shortens neither the worker's nor preflight's budget; `FAULT_INJECTION=1` → both do; four behavioural cases + env default tested; manual says how to enable F1 |
| T3 | deepseek | Live console row cap | `web/js/live.js`, new `tests/probe/live-evict.html` (+ probe runner line if needed in `tests/probe/run-probes.ts`) | 600 synthetic rows → DOM ≤ 500 rows; selected row survives eviction; no JS errors; headless check result in the page title |
| T9 | deepseek | Policy lifecycle (D5) | `server/api/policies.ts` (after F0), new `server/storage/policies.ts`, new `server/storage/migrations/0005_policy_lifecycle.sql`, `server/policy/index.ts` (only if needed), `server/app.ts` (`activePolicy` and its cache only), new `tests/security/policy-lifecycle.test.ts` | all D5 tests; draft→publish→activate changes `GET /v1/policies/active`; stale `expected_active_version` → 409; rollback restores previous; published body immutable; cross-tenant version → 404; keys mode: reader → 403; real-PG concurrency test skipped unless `TEST_DATABASE_URL` |
| T5 | planner | Label API (D4), admin-only | `server/api/reviews.ts`, new `server/storage/reviews.ts`, new `contracts/labels.ts`, new `tests/integration/labels.test.ts` | value validated per type; unknown/other-tenant ref → 404; `human_reviewed` only from admin (keys mode) |
| T4 | planner | Review queue (D2, D3) | `server/api/reviews.ts`, `server/storage/reviews.ts`, new `server/storage/migrations/0004_reviews_labels.sql`, `server/worker/index.ts`, `server/api/preflight.ts`, `contracts/stream.ts` (add `review` kind), new `tests/integration/reviews.test.ts` | HOLD in shadow and in gate mode each create exactly one open task, also on redelivery; resolve writes labels, closes task, audit row; resolving twice → 409; replays open none; reader → 403 / admin → 200 in keys mode; tenant isolation |
| C | planner | Contracts doc for T4, T5, T9 | `docs/CONTRACTS.md` (new §10) | every new route, body, status code and table documented |
| T1 | planner | Backlog to real state | `docs/IMPLEMENTATION_BACKLOG.md` | every row has a status with a commit sha; rows for T4–T11 of the day plan |
| L | planner | Run record | this file, `logs/README.md`, `skills/jev-work-plan/plans/2026-09-29.md` | Step 8 of the fleet skill; day plan statuses + Log line |

Order: F0 (alone, committed) → DeepSeek T2, T3, T9 in parallel with planner T5 → T4 → C → T1 → L.

**`server/app.ts` handoff.** F0 edits it first (pass-through of `faultInjection` and a plain
`invalidatePolicy` that deletes the cache entry), and commits. After F0, `app.ts` belongs to DeepSeek
(T2's defaults, T9's cache semantics, generation counter and test hook). The same F0 → T9 handoff
applies to `server/api/policies.ts`.

## Out of scope for this batch

Releasing held gate actions on review; the review UI (T8); export (T6); sampler (T7); T10; T11.

## Review record

### Round-1 objections → changes

| Objection (who) | Change |
|---|---|
| Worker applies F1's fault unconditionally, so flipping the config default can't satisfy T2 (Codex, blocking; DeepSeek note 1) | D6 rewritten: F0 wires `faultInjection` into the worker; T2 flips both defaults; four behavioural tests plus env default |
| `policy-a1` bootstrap row is global; second tenant has no active row but is served the default; no bootstrap before activate (Codex, blocking; DeepSeek note 4) | D5: per-tenant key migration, `ensureActivePolicy` under a tenant advisory lock, at-most-one-active index, stale check after lock, two-tenant and concurrency tests, real-PG test skipped unless `TEST_DATABASE_URL`, PGlite limit stated |
| D6 claimed Gate C tests rely on fault injection; harness has no option (DeepSeek 2) | T2 owns the harness option; the new test builds `createApp` directly |
| Shadow `UNKNOWN` is the evidence gate, not a judge failure (DeepSeek 3) | D2 wording fixed; decision unchanged |
| Draft versions contain `+`, rejected by the id regex (DeepSeek 5) | D5 route matching |
| `review` outbox kind has no consumer yet (DeepSeek 6) | D3 says T8 will consume it |
| Which roles may write non-human labels (DeepSeek 7) | D4: `POST /v1/labels` admin-only |
| (planner) `activePolicy()` caches, so a switch would not take effect | D5 cache bullet; `invalidatePolicy` in F0 |

### Round-2 objections → changes

| Objection (who) | Change |
|---|---|
| Invalidate-after-commit lets a delayed old read repopulate the cache (Codex, blocking) | D5 cache: per-tenant generation guards the fill; deterministic race test across GET, worker and preflight |
| A valid base like `policy beta` makes a draft the route regex can't address (Codex, blocking) | D5 route: one encoded segment, decoded once; round-trip test with space, slash and non-ASCII |
| (DeepSeek r2, non-blocking, folded in) SQL backfill could drift from `DEFAULT_POLICY`; worker must never open `UNKNOWN` tasks; `app.ts` handoff unstated; read path takes a lock | Backfill dropped, `ensureActivePolicy` sole source; D2 says preflight-only; handoff paragraph added; lock only on the bootstrap path |

### Plan gate verdicts (plan v3)

| Seat | r1 (v1) | r2 (v2) | r3 (v3) |
|---|---|---|---|
| coder-deepseek | PLAN-APPROVED (7 notes) | PLAN-APPROVED (4 notes) | **PLAN-APPROVED** |
| reviewer-codex | PLAN-REJECTED (2) | PLAN-REJECTED (2) | **PLAN-APPROVED** |
| planner (claude) | — | — | **PLANNER (claude): PLAN-APPROVED** on v3 |

DeepSeek's r3 non-blocking notes are implementation guidance, passed to T9's owner, not plan
changes: give `policy_activations` a `bigserial` id and order rollback's lookup by it; keep the
cache-fill test hook a no-op unless a test installs it.
