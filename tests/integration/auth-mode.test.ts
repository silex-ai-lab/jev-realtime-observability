// Authentication is optional: AUTH_MODE=none (default) needs no key; AUTH_MODE=keys requires one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.ts';
import { appOptionsFromEnv } from '../../server/config.ts';

const k = (r: string) => `${r}-auth-mode-key-000000000`;
const tenants = [{ tenant_id: 't-a', name: 'A', keys: { ingest: k('i'), reader: k('r'), gateway: k('g'), admin: k('a') } }];

test('default (no auth option): no key needed, the page learns the mode, admin actions work', async () => {
  const app = await createApp({ judge: null, sourceMode: 'live_sandbox_shadow', tenants, worker: { autostart: false }, web: false, mirrorOtlp: false });
  try {
    assert.deepEqual(await (await fetch(`${app.url}/v1/auth`)).json(), { mode: 'none' });
    assert.equal((await fetch(`${app.url}/v1/runs`)).status, 200);
    const r = await fetch(`${app.url}/v1/sandbox/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: 'S3' }) });
    assert.equal(r.status, 202);
    assert.equal((await fetch(`${app.url}/v1/stream/tokens`, { method: 'POST' })).status, 200);
  } finally { await app.close(); }
});

test("auth: 'keys' still rejects missing and wrong keys", async () => {
  const app = await createApp({ auth: 'keys', judge: null, sourceMode: 'live_sandbox_shadow', tenants, worker: { autostart: false }, web: false, mirrorOtlp: false });
  try {
    assert.deepEqual(await (await fetch(`${app.url}/v1/auth`)).json(), { mode: 'keys' });
    assert.equal((await fetch(`${app.url}/v1/runs`)).status, 401);
    assert.equal((await fetch(`${app.url}/v1/runs`, { headers: { authorization: 'Bearer wrong-key-0000000000' } })).status, 401);
    assert.equal((await fetch(`${app.url}/v1/runs`, { headers: { authorization: `Bearer ${k('r')}` } })).status, 200);
    assert.equal((await fetch(`${app.url}/v1/sandbox/runs`, { method: 'POST', headers: { authorization: `Bearer ${k('r')}`, 'content-type': 'application/json' }, body: '{"scenario":"S3"}' })).status, 403);
  } finally { await app.close(); }
});

test('without authentication, a non-loopback host is refused unless explicitly allowed', async () => {
  await assert.rejects(() => createApp({ host: '0.0.0.0', judge: null, sourceMode: 'live_sandbox_shadow', tenants, worker: { autostart: false }, web: false }),
    /authentication is off/);
});

test('env: AUTH_MODE defaults to none and needs no keys; AUTH_MODE=keys requires them', () => {
  const saved = { ...process.env };
  try {
    for (const v of ['AUTH_MODE', 'INGEST_KEY', 'READER_KEY', 'GATEWAY_KEY', 'ADMIN_KEY']) delete process.env[v];
    process.env.JUDGE_BACKEND = 'none';
    assert.equal(appOptionsFromEnv().auth, 'none');
    process.env.AUTH_MODE = 'keys';
    assert.throws(() => appOptionsFromEnv(), /must be set .* when AUTH_MODE=keys/);
  } finally { process.env = saved; }
});
