# Change log

Newest first. The plan and its review record live in this folder.

## 2026-09-28 — Gate A: the real shadow loop

[Plan v0.3 and the full review record](2026-09-28_BUILD_PLAN.md) · source RFC: [`2026-09-28_RFC_v0.1_source_gpt.md`](2026-09-28_RFC_v0.1_source_gpt.md).

- **The pipeline:** agent boundary events (SDK and OTLP/HTTP JSON) → a frozen decision-time snapshot → authoritative code rules → typed Noul, Choice and Score questions to a judge over the System One protocol → a policy decision (RFC §7 order) → a persisted outbox → an SSE live console.
- **The judge:** the open-source **Kev-4B** (`jaredpalmer/kev-4b`), served locally on MLX. It is **not** TypeSafe's Jev. Hosted Jev is supported by config and has not been run (no key).
- **Shadow only:** semantic signals are uncalibrated, recorded and shown, and never change a recommendation. No action is enforced.
- **Scenarios** S1–S4, S6 and F1 execute real tools in a sandbox schema whose tools enforce their own limits, approvals and allowlist. F1 aborts a real judge call and the payment is held.
- **Three-seat review** (Claude planner, DeepSeek, Codex):
  - plan approved in round 3;
  - code: round 1 rejected on conflict detection; **round 2 approved unanimously** (`4f4a7d6`).
- **Left for Gate B / C:** outcome verification, the open-data eval and fine-tune, the pre-tool gate.
