// Policy routes (docs/CONTRACTS.md §5, §10): active policy, drafts, and the publish/activate/rollback lifecycle.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as repos from '../storage/repos.ts';
import { validatePolicy } from '../policy/index.ts';
import { readJson, send, type AuthFn } from './http.ts';
import type { ApiDeps } from './index.ts';

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
      await repos.insertPolicyVersion(q, { policy_version: draft_version, tenant_id: a.tenant_id, base_version: v.policy.policy_version, status: 'draft', body: { ...v.policy, policy_version: draft_version }, actor: 'admin-key' });
      await repos.audit(q, a.tenant_id, 'admin-key', 'policy_draft', { draft_version });
    });
    send(res, 200, { ok: true, errors: [], draft_version });
    return true;
  }
  return false;
}
