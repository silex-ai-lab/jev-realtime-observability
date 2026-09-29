// Shared HTTP helpers for the API route modules (index.ts, policies.ts, reviews.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Role = 'ingest' | 'reader' | 'gateway' | 'admin';
export type AuthFn = (req: IncomingMessage, roles: Role[]) => Promise<{ tenant_id: string; role: Role }>;

const MAX_BODY = 1 << 20;
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(s);
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'body too large'); chunks.push(c as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { throw new HttpError(400, 'bad_json', 'invalid JSON'); }
}
