// Canonical JSON (sorted object keys, no whitespace) and sha256 digests.
// The single implementation used for args digests, request hashes and content digests,
// so the SDK, the gateway, preflight and the judge client always agree.
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortDeep(x);
    }
    return out;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError('non-finite number in canonical JSON');
  return v;
}

export const sha256 = (s: string): string => 'sha256:' + createHash('sha256').update(s).digest('hex');
export const digestOf = (value: unknown): string => sha256(canonicalJson(value));
