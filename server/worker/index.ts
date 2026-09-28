// Evaluation worker (RFC §3.1 observation path, §6.5, §9.1). In-process, leased jobs,
// crash-safe: a job is only marked done in the same transaction that stores its records.
import { randomUUID } from 'node:crypto';
import type { Db } from '../storage/db.ts';
import * as repos from '../storage/repos.ts';
import type { JudgeClient, JudgeCallResult } from '../judges/index.ts';
import { evaluateRules } from '../rules/index.ts';
import { assembleSnapshot, RUBRIC } from '../state/index.ts';
import { decide, type PolicyBody } from '../policy/index.ts';
import { judgeSourceOf, type EvaluationRecord } from '../../contracts/judge.ts';
import type { Provenance } from '../../contracts/common.ts';
import type { AuthorityReader } from '../../sandbox/index.ts';

export interface WorkerDeps {
  db: Db;
  judge: JudgeClient | null;
  authority: AuthorityReader;
  policy: (tenantId: string) => Promise<PolicyBody>;
  provenance: (judgeSource: string | null) => Provenance;
  leaseMs: number;
  concurrency: number;
  onChange: () => void;
}

export interface Worker {
  start(): void;
  wake(): void;
  /** Processes until no job is ready and none is in flight. */
  drain(): Promise<void>;
  stop(): Promise<void>;
}

const nowIso = () => new Date().toISOString();

export function createWorker(d: WorkerDeps): Worker {
  let running = false, inFlight = 0;
  const waiters: Array<() => void> = [];

  async function tick(): Promise<boolean> {
    const job = await d.db.tx(q => repos.leaseJob(q, d.leaseMs));
    if (!job) return false;
    inFlight++;
    try {
      if (Date.parse(job.not_after) < Date.now()) await expire(job.tenant_id, job.job_id, job.event_id, 'deadline passed before evaluation');
      else if (job.kind === 'diagnostic') await diagnostic(job.tenant_id, job.job_id, job.event_id);
      else await realtime(job.tenant_id, job.job_id, job.event_id);
    } catch (e) {
      await d.db.tx(q => repos.failJob(q, job.job_id, (e as Error).message.slice(0, 500), job.attempts < 3));
    } finally {
      inFlight--;
      d.onChange();
    }
    return true;
  }

  async function expire(tenantId: string, jobId: string, eventId: string, reason: string) {
    await d.db.tx(async q => {
      await repos.expireJob(q, jobId, reason);
      const ev = await repos.getEvent(q, tenantId, eventId);
      await repos.appendOutbox(q, { tenant_id: tenantId, kind: 'evaluation_expired', ref_id: eventId, run_id: ev?.run_id ?? null, payload: { event_id: eventId, reason } });
      await repos.appendOutbox(q, { tenant_id: tenantId, kind: 'coverage_gap', ref_id: eventId, run_id: ev?.run_id ?? null, payload: { event_id: eventId, gap: 'realtime evaluation expired', reason } });
    });
  }

  function served() {
    const m = d.judge?.served() ?? null;
    return { model: m, source: m ? judgeSourceOf(m) : null };
  }

  function evaluationRecord(tenantId: string, eventId: string, snapshotId: string, kind: EvaluationRecord['kind'],
    qids: string[], req: string[], r: JudgeCallResult | null, status: EvaluationRecord['status'], evaluationId: string, startedAt: string): EvaluationRecord {
    const s = served();
    return {
      evaluation_id: evaluationId, tenant_id: tenantId, event_id: eventId, snapshot_id: snapshotId, kind,
      rubric_id: RUBRIC.rubric_id, question_ids: qids, required_question_ids: req,
      judge_source: r?.served_model ? judgeSourceOf(r.served_model) : s.source, served_model: r?.served_model ?? s.model,
      request_hash: r?.request_hash ?? '', client_request_id: r?.client_request_id ?? `none-${evaluationId}`,
      vendor_request_id: r?.vendor_request_id ?? null, status: r?.status ?? status, http_status: r?.http_status ?? null,
      attempts: r?.attempts ?? 0, judge_http_rtt_ms: r?.judge_http_rtt_ms ?? null, vendor_latency_ms: r?.vendor_latency_ms ?? null,
      usage: r?.usage ?? null, billing: r?.billing ?? 'none', signals: r?.signals ?? {}, errors: r?.errors ?? [],
      started_at: startedAt, finished_at: nowIso(),
    };
  }

  async function realtime(tenantId: string, jobId: string, eventId: string) {
    const t0 = performance.now();
    const policy = await d.policy(tenantId);
    const ev = await repos.getEvent(d.db, tenantId, eventId);
    if (!ev) { await d.db.tx(q => repos.failJob(q, jobId, 'event not found', false)); return; }
    const history = await repos.listRunEvents(d.db, tenantId, ev.run_id, ev.received_at, 500);
    const a = await assembleSnapshot({ tenantId, event: ev, history, authority: d.authority, judgeViewMaxTokens: policy.judge_view_max_tokens,
      judgeModel: d.judge?.config.model ?? 'none', now: new Date() });
    const tSnap = performance.now();
    const rules = evaluateRules(a.snapshot);
    const tRules = performance.now();
    const hardDecided = rules.some(r => r.verdict === 'STOP' || r.verdict === 'BLOCK' || r.verdict === 'HOLD');
    const evaluationId = `eval-${randomUUID()}`;
    const startedAt = nowIso();
    let evaluation: EvaluationRecord | null = null;
    let judgeRtt: number | null = null;
    if (hardDecided) {
      // Hard rule decided: return without waiting for the judge (RFC §6.5). A separate low-priority
      // diagnostic evaluation may run later; it never changes this decision.
      evaluation = null;
    } else if (!a.judgeRequest) {
      evaluation = evaluationRecord(tenantId, eventId, a.snapshot.snapshot_id, 'realtime', [], [], null, 'ok', evaluationId, startedAt);
    } else if (!d.judge) {
      evaluation = evaluationRecord(tenantId, eventId, a.snapshot.snapshot_id, 'realtime', a.questionIds, a.requiredQuestionIds, null, 'not_configured', evaluationId, startedAt);
    } else {
      // Sandbox fault injection (F1): a 1 ms budget makes the real HTTP call to the judge abort.
      const fault = ev.attributes?.fault === 'judge_timeout';
      const r = await d.judge.call(a.judgeRequest, a.requiredQuestionIds,
        { tenantId, evaluationId, caller: 'realtime', deadlineMs: fault ? 1 : policy.judge_deadline_ms, retry429: !fault });
      judgeRtt = r.judge_http_rtt_ms;
      evaluation = evaluationRecord(tenantId, eventId, a.snapshot.snapshot_id, 'realtime', a.questionIds, a.requiredQuestionIds, r, r.status, evaluationId, startedAt);
    }
    const tJudge = performance.now();
    const judgeSource = evaluation?.judge_source ?? served().source;
    const decision = decide({
      snapshot: a.snapshot, rules, evaluation, policy, provenance: d.provenance(judgeSource),
      decisionId: `dec-${randomUUID()}`, now: nowIso(),
      timings: {
        ingest_to_signal_ms: null,        // filled below, just before commit
        snapshot_ms: tSnap - t0, rules_ms: tRules - tSnap, judge_http_rtt_ms: judgeRtt, policy_ms: null,
      },
    });
    decision.timings.policy_ms = performance.now() - tJudge;
    // Same process received the event, so wall-clock difference is on one clock (RFC §11.1 note).
    decision.timings.ingest_to_signal_ms = Date.now() - Date.parse(ev.received_at);
    const committed = await d.db.tx(async q => {
      // Idempotent completion: if a lease expired mid-evaluation and another slot already decided this
      // event, record nothing new (the judge call is still in the ledger; RFC §9.1: no exactly-once inference).
      const prior = await q.query(`SELECT 1 FROM decisions WHERE tenant_id = $1 AND event_id = $2 AND replay_of IS NULL LIMIT 1`, [tenantId, eventId]);
      if (prior.rows.length) { await repos.completeJob(q, jobId); return false; }
      await repos.insertSnapshot(q, a.snapshot);
      if (evaluation) await repos.insertEvaluation(q, evaluation);
      await repos.insertDecision(q, decision, null);
      await repos.completeJob(q, jobId);
      if (evaluation) await repos.appendOutbox(q, { tenant_id: tenantId, kind: 'evaluation', ref_id: evaluation.evaluation_id, run_id: ev.run_id, payload: evaluationPayload(evaluation) });
      await repos.appendOutbox(q, { tenant_id: tenantId, kind: 'decision', ref_id: decision.decision_id, run_id: ev.run_id, payload: { ...decision, run_id: ev.run_id, boundary: ev.boundary, tool: ev.operation?.tool ?? null } });
      for (const g of decision.coverage_gaps) await repos.appendOutbox(q, { tenant_id: tenantId, kind: 'coverage_gap', ref_id: eventId, run_id: ev.run_id, payload: { event_id: eventId, gap: g } });
      if (hardDecided && d.judge && a.judgeRequest) await repos.enqueueJob(q, tenantId, eventId, 'diagnostic', 10, new Date(Date.now() + policy.realtime_ttl_ms).toISOString());
      return true;
    });
    if (!committed) return;
  }

  async function diagnostic(tenantId: string, jobId: string, eventId: string) {
    const policy = await d.policy(tenantId);
    const ev = await repos.getEvent(d.db, tenantId, eventId);
    if (!ev || !d.judge) { await d.db.tx(q => repos.completeJob(q, jobId)); return; }
    const history = await repos.listRunEvents(d.db, tenantId, ev.run_id, ev.received_at, 500);
    const a = await assembleSnapshot({ tenantId, event: ev, history, authority: d.authority, judgeViewMaxTokens: policy.judge_view_max_tokens,
      judgeModel: d.judge.config.model, now: new Date() });
    if (!a.judgeRequest) { await d.db.tx(q => repos.completeJob(q, jobId)); return; }
    const evaluationId = `eval-${randomUUID()}`;
    const startedAt = nowIso();
    const r = await d.judge.call(a.judgeRequest, a.requiredQuestionIds, { tenantId, evaluationId, caller: 'diagnostic', deadlineMs: policy.judge_deadline_ms * 2, retry429: true });
    const evaluation = evaluationRecord(tenantId, eventId, a.snapshot.snapshot_id, 'diagnostic', a.questionIds, a.requiredQuestionIds, r, r.status, evaluationId, startedAt);
    await d.db.tx(async q => {
      await repos.insertSnapshot(q, a.snapshot);
      await repos.insertEvaluation(q, evaluation);
      await repos.completeJob(q, jobId);
      await repos.appendOutbox(q, { tenant_id: tenantId, kind: 'evaluation', ref_id: evaluation.evaluation_id, run_id: ev.run_id, payload: evaluationPayload(evaluation) });
    });
  }

  // Each slot leases and processes independently, so a slow judge call does not stall the other slots.
  let idleSlots = 0;
  const wakers = new Set<() => void>();
  async function slot() {
    while (running) {
      const got = await tick().catch(() => false);
      if (got) continue;
      idleSlots++;
      if (idleSlots === d.concurrency && inFlight === 0) waiters.splice(0).forEach(w => w());
      await new Promise<void>(res => { const t = setTimeout(done, 250); function done() { clearTimeout(t); wakers.delete(done); res(); } wakers.add(done); });
      idleSlots--;
    }
  }

  return {
    start() { if (running) return; running = true; for (let i = 0; i < d.concurrency; i++) void slot(); },
    wake() { for (const w of [...wakers]) w(); },
    async drain() {
      if (running) { this.wake(); await new Promise<void>(res => waiters.push(res)); return; }
      while (await tick()) { /* until empty */ }
      while (inFlight > 0) await new Promise(r => setTimeout(r, 10));
    },
    async stop() { running = false; this.wake(); while (inFlight > 0) await new Promise(r => setTimeout(r, 10)); },
  };
}

/** Evaluation as streamed: everything except request internals. */
export function evaluationPayload(e: EvaluationRecord): Record<string, unknown> {
  return {
    evaluation_id: e.evaluation_id, event_id: e.event_id, snapshot_id: e.snapshot_id, kind: e.kind, status: e.status,
    judge_source: e.judge_source, question_ids: e.question_ids, required_question_ids: e.required_question_ids,
    signals: e.signals, judge_http_rtt_ms: e.judge_http_rtt_ms, vendor_latency_ms: e.vendor_latency_ms,
    usage: e.usage, billing: e.billing, errors: e.errors,
  };
}
