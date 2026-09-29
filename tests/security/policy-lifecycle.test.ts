// Policy lifecycle (plan D5 / T9): per-tenant draft → publish → activate → rollback, the cache
// generation guard, and the version route matching (encoded segment). Keys mode throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../server/storage/db.ts';
import { DEFAULT_POLICY } from '../../server/policy/index.ts';
import { setPolicyCacheFillHook } from '../../server/app.ts';
import { makeBoundaryEvent, postEventOk, runWorker, startGateAHarness, startStubJudge, waitForDecision } from '../helpers/harness.ts';
import { argsDigest } from '../../sandbox/index.ts';
import { SCHEMA_VERSION } from '../../contracts/common.ts';
import type { GateAHarness, TenantName } from '../helpers/harness.ts';

const stub = (url: string) => ({
  backend: 'stub' as const, baseUrl: url, model: 'kev-latest', expectedRun: 'stub',
  maxRps: 100, maxInputTokensPerSec: 1_000_000, maxResponseBytes: 1_000_000,
});

async function startH() {
  const judge = await startStubJudge();
  const h = await startGateAHarness({ judge: stub(judge.url) });
  return { judge, h };
}

async function draftOk(h: GateAHarness, tenant: TenantName, base: string): Promise<string> {
  const { response, body } = await h.json<{ draft_version?: string; errors?: string[] }>(
    'POST', '/v1/policies/drafts', { tenant, role: 'admin', body: { ...DEFAULT_POLICY, policy_version: base } });
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.draft_version as string;
}

function publish(h: GateAHarness, tenant: TenantName, version: string) {
  return h.request('POST', `/v1/policies/${encodeURIComponent(version)}/publish`, { tenant, role: 'admin', body: {} });
}
function activate(h: GateAHarness, tenant: TenantName, version: string, expected: string) {
  return h.request('POST', `/v1/policies/${encodeURIComponent(version)}/activate`, { tenant, role: 'admin', body: { expected_active_version: expected } });
}
function rollback(h: GateAHarness, tenant: TenantName, expected: string) {
  return h.request('POST', '/v1/policies/rollback', { tenant, role: 'admin', body: { expected_active_version: expected } });
}

async function activeVersion(h: GateAHarness, tenant: TenantName): Promise<string> {
  const { response, body } = await h.json<{ policy: { policy_version: string } }>('GET', '/v1/policies/active', { tenant, role: 'reader' });
  assert.equal(response.status, 200);
  return body.policy.policy_version;
}

async function bodyOf(h: GateAHarness, tenant: string, version: string): Promise<unknown> {
  const r = await h.db.query<{ body: unknown }>(
    `SELECT body FROM policy_versions WHERE tenant_id = $1 AND policy_version = $2`, [tenant, version]);
  return r.rows[0]?.body ?? null;
}

async function activeCount(h: GateAHarness, tenant: string): Promise<number> {
  const r = await h.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM policy_versions WHERE tenant_id = $1 AND status = 'active'`, [tenant]);
  return r.rows[0]?.n ?? 0;
}

test('draft → publish → activate → rollback, with an immutable published body', async () => {
  const { judge, h } = await startH();
  try {
    assert.equal(await activeVersion(h, 'alpha'), 'policy-a1');

    const draft = await draftOk(h, 'alpha', 'policy-b1');
    assert.match(draft, /^policy-b1\+draft-[0-9a-f]{8}$/);

    assert.equal((await publish(h, 'alpha', draft)).status, 200);
    const publishedBody = await bodyOf(h, 't-alpha', draft);
    assert.ok(publishedBody && (publishedBody as { policy_version?: string }).policy_version === draft, 'the published row exists');

    assert.equal((await activate(h, 'alpha', draft, 'policy-a1')).status, 200);
    assert.equal(await activeVersion(h, 'alpha'), draft);
    assert.equal(JSON.stringify(await bodyOf(h, 't-alpha', draft)), JSON.stringify(publishedBody));

    assert.equal((await rollback(h, 'alpha', draft)).status, 200);
    assert.equal(await activeVersion(h, 'alpha'), 'policy-a1');
    assert.equal(JSON.stringify(await bodyOf(h, 't-alpha', draft)), JSON.stringify(publishedBody));
  } finally {
    await h.close();
    await judge.close();
  }
});

test('stale expected_active_version → 409', async () => {
  const { judge, h } = await startH();
  try {
    const draft = await draftOk(h, 'alpha', 'policy-stale');
    await publish(h, 'alpha', draft);
    const resp = await activate(h, 'alpha', draft, 'policy-wrong');
    assert.equal(resp.status, 409);
    assert.equal((JSON.parse(await resp.text()) as { error: { code: string } }).error.code, 'stale_active_version');
  } finally {
    await h.close();
    await judge.close();
  }
});

test('activate and rollback reject a missing or malformed body with 400, not 500', async () => {
  const { judge, h } = await startH();
  try {
    const draft = await draftOk(h, 'alpha', 'policy-body');
    await publish(h, 'alpha', draft);
    const path = `/v1/policies/${encodeURIComponent(draft)}/activate`;
    const raw = (url: string, body: string | undefined) => fetch(h.url(url), { method: 'POST', headers: h.headers('alpha', 'admin'), ...(body === undefined ? {} : { body }) });
    for (const url of [path, '/v1/policies/rollback']) {
      for (const body of [undefined, 'null', '[]', '{}', '{"expected_active_version":""}', '{"expected_active_version":7}']) {
        const r = await raw(url, body);
        assert.equal(r.status, 400, `${url} ${body ?? '(empty)'} → ${r.status}`);
      }
    }
    assert.equal(await activeVersion(h, 'alpha'), 'policy-a1');
  } finally {
    await h.close();
    await judge.close();
  }
});

test('a version of another tenant → 404', async () => {
  const { judge, h } = await startH();
  try {
    const draft = await draftOk(h, 'alpha', 'policy-x');
    assert.equal((await publish(h, 'beta', draft)).status, 404);
    assert.equal((await activate(h, 'beta', draft, 'policy-a1')).status, 404);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('reader → 403 on the lifecycle writes', async () => {
  const { judge, h } = await startH();
  try {
    const draft = await draftOk(h, 'alpha', 'policy-roles');
    assert.equal((await publish(h, 'alpha', draft)).status, 200);
    assert.equal((await activate(h, 'alpha', draft, 'policy-a1')).status, 200);
    const again = await draftOk(h, 'alpha', 'policy-roles2');
    assert.equal((await h.request('POST', `/v1/policies/${encodeURIComponent(again)}/activate`, { tenant: 'alpha', role: 'reader', body: { expected_active_version: draft } })).status, 403);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('two fresh tenants lifecycle independently', async () => {
  const { judge, h } = await startH();
  try {
    const a = await draftOk(h, 'alpha', 'policy-tenant-a');
    const b = await draftOk(h, 'beta', 'policy-tenant-b');
    await publish(h, 'alpha', a);
    await publish(h, 'beta', b);
    await activate(h, 'alpha', a, 'policy-a1');
    await activate(h, 'beta', b, 'policy-a1');

    assert.equal(await activeVersion(h, 'alpha'), a);
    assert.equal(await activeVersion(h, 'beta'), b);
    // each tenant still has its own bootstrap row, not the other's active
    assert.equal(await activeCount(h, 't-alpha'), 1);
    assert.equal(await activeCount(h, 't-beta'), 1);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('activate works before any GET (bootstrap happens in the write path)', async () => {
  const { judge, h } = await startH();
  try {
    const draft = await draftOk(h, 'alpha', 'policy-noget');
    await publish(h, 'alpha', draft);
    assert.equal((await activate(h, 'alpha', draft, 'policy-a1')).status, 200);
    assert.equal(await activeVersion(h, 'alpha'), draft);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('two concurrent activates with the same expected version → one 200, one 409', async () => {
  const { judge, h } = await startH();
  try {
    const p1 = await draftOk(h, 'alpha', 'policy-conc-1');
    const p2 = await draftOk(h, 'alpha', 'policy-conc-2');
    await publish(h, 'alpha', p1);
    await publish(h, 'alpha', p2);
    const [r1, r2] = await Promise.all([activate(h, 'alpha', p1, 'policy-a1'), activate(h, 'alpha', p2, 'policy-a1')]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    assert.equal(await activeCount(h, 't-alpha'), 1);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('route round-trip: base "policy beta/ü" and a plain "+draft-" name', async () => {
  const { judge, h } = await startH();
  try {
    const base = 'policy beta/ü';
    const draft = await draftOk(h, 'alpha', base);
    assert.ok(draft.startsWith(base + '+draft-'));
    assert.equal((await publish(h, 'alpha', draft)).status, 200);
    assert.equal((await activate(h, 'alpha', draft, 'policy-a1')).status, 200);
    assert.equal(await activeVersion(h, 'alpha'), draft);
    assert.equal((await rollback(h, 'alpha', draft)).status, 200);
    assert.equal(await activeVersion(h, 'alpha'), 'policy-a1');
  } finally {
    await h.close();
    await judge.close();
  }
});

/** Starts a GET /v1/policies/active that pauses between its DB read and its cache store, runs `doSwitch`
 *  (which must commit and invalidate), then releases the paused read. */
async function raceSwitch(h: GateAHarness, doSwitch: () => Promise<void>): Promise<void> {
  let pausedResolve!: () => void;
  let releaseResolve!: () => void;
  const paused = new Promise<void>(r => { pausedResolve = r; });
  const release = new Promise<void>(r => { releaseResolve = r; });
  let pausedOnce = false;
  setPolicyCacheFillHook(async (tenantId) => {
    if (tenantId === 't-alpha' && !pausedOnce) { pausedOnce = true; pausedResolve(); await release; }
  });
  try {
    const readP = h.request('GET', '/v1/policies/active', { tenant: 'alpha', role: 'reader' });
    let timer: NodeJS.Timeout | undefined;
    const notPaused = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('the read never reached the cache fill (was the cache warm?)')), 5_000); });
    try { await Promise.race([paused, notPaused]); } finally { clearTimeout(timer); }
    await doSwitch();
    releaseResolve();
    assert.equal((await readP).status, 200);
  } finally {
    setPolicyCacheFillHook(null);
  }
}

// Each race starts from a cold cache (a switch has just invalidated it and nothing has read since), so the
// paused GET is a real cache miss that read the old version before the switch committed.
for (const kind of ['activate', 'rollback'] as const) {
  test(`cache: a read started before ${kind} cannot re-cache the old policy (GET and worker)`, async () => {
    const { judge, h } = await startH();
    try {
      const draft = await draftOk(h, 'alpha', `policy-race-${kind}`);
      await publish(h, 'alpha', draft);
      let expected = draft;
      if (kind === 'activate') {
        await raceSwitch(h, async () => { assert.equal((await activate(h, 'alpha', draft, 'policy-a1')).status, 200); });
      } else {
        assert.equal((await activate(h, 'alpha', draft, 'policy-a1')).status, 200);   // invalidates; nothing reads before the race
        await raceSwitch(h, async () => { assert.equal((await rollback(h, 'alpha', draft)).status, 200); });
        expected = 'policy-a1';
      }
      assert.equal(await activeVersion(h, 'alpha'), expected);
      const e = makeBoundaryEvent();
      await postEventOk(h, e);
      await runWorker(h);
      assert.equal((await waitForDecision(h, e.run_id)).policy_version, expected, 'the worker decides under the new active policy');
    } finally {
      await h.close();
      await judge.close();
    }
  });

  test(`cache: a read started before ${kind} cannot re-cache the old policy (preflight)`, async () => {
    const judge = await startStubJudge();
    const h = await startGateAHarness({ judge: stub(judge.url), sourceMode: 'live_sandbox_gate' });
    try {
      const draft = await draftOk(h, 'alpha', `policy-race-gate-${kind}`);
      await publish(h, 'alpha', draft);
      let expected = draft;
      if (kind === 'activate') {
        await raceSwitch(h, async () => { assert.equal((await activate(h, 'alpha', draft, 'policy-a1')).status, 200); });
      } else {
        assert.equal((await activate(h, 'alpha', draft, 'policy-a1')).status, 200);
        await raceSwitch(h, async () => { assert.equal((await rollback(h, 'alpha', draft)).status, 200); });
        expected = 'policy-a1';
      }
      assert.equal(await preflightPolicy(h), expected);
    } finally {
      await h.close();
      await judge.close();
    }
  });
}

async function preflightPolicy(h: GateAHarness): Promise<string> {
  const args = { invoice_id: 'INV-7731', po_id: 'PO-4410', amount_usd: 8420, payee: 'Pacific Paper Co.', account_ref: 'ACCT-118-01', remit_domain: 'bank.northwind.example' };
  const body = { schema_version: SCHEMA_VERSION, event_id: `evt-${crypto.randomUUID()}`, run_id: `run-${crypto.randomUUID()}`,
    trace_id: '0123456789abcdef0123456789abcdef', producer_id: 'policy-race-wrapper', producer_seq: 1, actor: { kind: 'agent', id: 'agent-ap' },
    operation: { tool: 'payments.execute', operation_id: `op-${crypto.randomUUID()}`, args, args_digest: argsDigest(args) }, sources: [], attributes: {} };
  const { response, body: out } = await h.json<{ control: { policy_version: string } }>('POST', '/v1/preflight', { tenant: 'alpha', role: 'ingest', body });
  assert.equal(response.status, 200);
  return out.control.policy_version;
}

test('real-Postgres concurrency: two concurrent activates serialise', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const judge = await startStubJudge();
  const db = await openDb({ url: process.env.TEST_DATABASE_URL! });
  const h = await startGateAHarness({ db, judge: stub(judge.url), worker: { autostart: false } });
  try {
    // A persistent database keeps earlier runs' switches, so start from whatever is active now.
    const start = await activeVersion(h, 'alpha');
    const p1 = await draftOk(h, 'alpha', `policy-pg-${crypto.randomUUID().slice(0, 8)}`);
    const p2 = await draftOk(h, 'alpha', `policy-pg-${crypto.randomUUID().slice(0, 8)}`);
    await publish(h, 'alpha', p1);
    await publish(h, 'alpha', p2);
    const [r1, r2] = await Promise.all([activate(h, 'alpha', p1, start), activate(h, 'alpha', p2, start)]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    assert.equal(await activeCount(h, 't-alpha'), 1);
  } finally {
    await h.close();
    await judge.close();
  }
});
