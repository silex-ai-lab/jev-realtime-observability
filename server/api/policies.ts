// Policy routes (docs/CONTRACTS.md §5, §10): active policy, drafts, and the publish/activate/rollback lifecycle.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as repos from '../storage/repos.ts';
import { validatePolicy } from '../policy/index.ts';
import { HttpError, readJson, send, type AuthFn } from './http.ts';
import type { ApiDeps } from './index.ts';
import {
  bootstrapActivePolicy,
  ensureActivePolicy,
  getPolicyVersion,
  insertActivation,
  lockPolicy,
  newestActivationTo,
  setPolicyStatus,
} from '../storage/policies.ts';

const PUBLISH = /^\/v1\/policies\/([^/]+)\/publish$/;
const ACTIVATE = /^\/v1\/policies\/([^/]+)\/activate$/;

/** One encoded path segment, decoded exactly once. A malformed escape → 400. */
function decodeVersion(encoded: string): string {
  try { return decodeURIComponent(encoded); }
  catch { throw new HttpError(400, 'bad_version', 'malformed version escape'); }
}

/** The optimistic-check body of activate and rollback: `{ expected_active_version: non-empty string }`, else 400. */
async function expectedVersion(req: IncomingMessage): Promise<string> {
  const body = await readJson(req);
  const v = body && typeof body === 'object' ? (body as { expected_active_version?: unknown }).expected_active_version : undefined;
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'bad_request', 'body must be { "expected_active_version": "<version>" }');
  return v;
}

/** Returns true when the request was one of this module's routes. */
export async function handle(d: ApiDeps, auth: AuthFn, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname, m = req.method ?? 'GET';
  if (m === 'GET' && p === '/v1/policies/active') {
    const a = await auth(req, ['reader', 'admin']);
    send(res, 200, { policy: await d.activePolicy(a.tenant_id) });
    return true;
  }
  if (m === 'POST' && p === '/v1/policies/drafts') {
    const a = await auth(req, ['admin']);
    const v = validatePolicy(await readJson(req));
    if (!v.ok) { send(res, 400, { ok: false, errors: v.errors }); return true; }
    const draft_version = `${v.policy.policy_version}+draft-${randomUUID().slice(0, 8)}`;
    await d.db.tx(async q => {
      await ensureActivePolicy(q, a.tenant_id);
      await repos.insertPolicyVersion(q, { policy_version: draft_version, tenant_id: a.tenant_id, base_version: v.policy.policy_version, status: 'draft', body: { ...v.policy, policy_version: draft_version }, actor: 'admin-key' });
      await repos.audit(q, a.tenant_id, 'admin-key', 'policy_draft', { draft_version });
    });
    send(res, 200, { ok: true, errors: [], draft_version });
    return true;
  }
  if (m === 'POST' && p === '/v1/policies/rollback') {
    const a = await auth(req, ['admin']);
    const expected = await expectedVersion(req);
    const outcome = await d.db.tx(async q => {
      await lockPolicy(q, a.tenant_id);
      const active = await bootstrapActivePolicy(q, a.tenant_id);
      if (active.policy_version !== expected) return { code: 'stale_active_version' as const };
      const prev = await newestActivationTo(q, a.tenant_id, active.policy_version);
      if (!prev) return { code: 'nothing_to_roll_back' as const };
      const target = await getPolicyVersion(q, a.tenant_id, prev.from_version);
      if (!target) return { code: 'not_found' as const };
      if (target.status !== 'retired') return { code: 'bad_target' as const };
      await setPolicyStatus(q, a.tenant_id, active.policy_version, 'retired');
      await setPolicyStatus(q, a.tenant_id, prev.from_version, 'active');
      await insertActivation(q, a.tenant_id, active.policy_version, prev.from_version, 'admin-key');
      await repos.audit(q, a.tenant_id, 'admin-key', 'policy_rollback', { from: active.policy_version, to: prev.from_version });
      return { code: 'ok' as const, from: active.policy_version, to: prev.from_version };
    });
    if (outcome.code === 'not_found') throw new HttpError(404, 'not_found', 'rollback target version missing');
    if (outcome.code === 'stale_active_version') throw new HttpError(409, 'stale_active_version', 'active policy changed since the given expected version');
    if (outcome.code === 'nothing_to_roll_back') throw new HttpError(409, 'nothing_to_roll_back', 'no prior activation to roll back to');
    if (outcome.code === 'bad_target') throw new HttpError(409, 'bad_target', 'rollback target must be retired');
    d.invalidatePolicy(a.tenant_id);
    send(res, 200, { ok: true, active_version: outcome.to, previous_version: outcome.from });
    return true;
  }
  const pub = PUBLISH.exec(p);
  if (m === 'POST' && pub) {
    const a = await auth(req, ['admin']);
    const version = decodeVersion(pub[1]);
    const outcome = await d.db.tx(async q => {
      await lockPolicy(q, a.tenant_id);
      await bootstrapActivePolicy(q, a.tenant_id);
      const row = await getPolicyVersion(q, a.tenant_id, version);
      if (!row) return { code: 'not_found' as const };
      if (row.status !== 'draft') return { code: 'not_draft' as const };
      const v = validatePolicy(row.body);
      if (!v.ok) return { code: 'invalid_policy' as const, errors: v.errors };
      await setPolicyStatus(q, a.tenant_id, version, 'published');
      await repos.audit(q, a.tenant_id, 'admin-key', 'policy_publish', { version });
      return { code: 'ok' as const };
    });
    if (outcome.code === 'not_found') throw new HttpError(404, 'not_found', 'no such policy version');
    if (outcome.code === 'not_draft') throw new HttpError(409, 'not_draft', 'only a draft can be published');
    if (outcome.code === 'invalid_policy') throw new HttpError(400, 'invalid_policy', outcome.errors.join('; '));
    send(res, 200, { ok: true, version, status: 'published' });
    return true;
  }
  const act = ACTIVATE.exec(p);
  if (m === 'POST' && act) {
    const a = await auth(req, ['admin']);
    const version = decodeVersion(act[1]);
    const expected = await expectedVersion(req);
    const outcome = await d.db.tx(async q => {
      await lockPolicy(q, a.tenant_id);
      const active = await bootstrapActivePolicy(q, a.tenant_id);
      if (active.policy_version !== expected) return { code: 'stale_active_version' as const };
      const target = await getPolicyVersion(q, a.tenant_id, version);
      if (!target) return { code: 'not_found' as const };
      if (target.status !== 'published' && target.status !== 'retired') return { code: 'bad_target' as const };
      await setPolicyStatus(q, a.tenant_id, active.policy_version, 'retired');
      await setPolicyStatus(q, a.tenant_id, version, 'active');
      await insertActivation(q, a.tenant_id, active.policy_version, version, 'admin-key');
      await repos.audit(q, a.tenant_id, 'admin-key', 'policy_activate', { from: active.policy_version, to: version });
      return { code: 'ok' as const, from: active.policy_version, to: version };
    });
    if (outcome.code === 'not_found') throw new HttpError(404, 'not_found', 'no such policy version');
    if (outcome.code === 'stale_active_version') throw new HttpError(409, 'stale_active_version', 'active policy changed since the given expected version');
    if (outcome.code === 'bad_target') throw new HttpError(409, 'bad_target', 'target must be published or retired');
    d.invalidatePolicy(a.tenant_id);
    send(res, 200, { ok: true, active_version: outcome.to, previous_version: outcome.from });
    return true;
  }
  return false;
}
