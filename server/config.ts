// Environment configuration for server/main.ts. Secrets come only from the environment and are
// never printed. See deploy/env.example.
import type { AppOptions } from './app.ts';
import type { JudgeConfig } from './judges/index.ts';

const env = (k: string, d?: string) => process.env[k] ?? d;

export function judgeFromEnv(): JudgeConfig | null {
  const backend = env('JUDGE_BACKEND', 'kev-local');
  if (backend === 'none') return null;
  if (backend === 'typesafe') {
    const apiKey = env('TYPESAFE_API_KEY');
    if (!apiKey) throw new Error('JUDGE_BACKEND=typesafe needs TYPESAFE_API_KEY');
    return { backend: 'typesafe', baseUrl: env('JUDGE_BASE_URL', 'https://api.typesafe.ai')!, apiKey, model: env('JUDGE_MODEL', 'jev-1.13.0')!,
      expectedRun: env('JUDGE_EXPECTED_RUN'), maxRps: Number(env('JUDGE_MAX_RPS', '10')), maxInputTokensPerSec: Number(env('JUDGE_MAX_TPS', '40000')), maxResponseBytes: 262_144 };
  }
  return { backend: 'kev-local', baseUrl: env('JUDGE_BASE_URL', 'http://127.0.0.1:8009')!, model: env('JUDGE_MODEL', 'kev-latest')!,
    expectedRun: env('JUDGE_EXPECTED_RUN', 'jaredpalmer/kev-4b'), maxRps: Number(env('JUDGE_MAX_RPS', '10')),
    maxInputTokensPerSec: Number(env('JUDGE_MAX_TPS', '40000')), maxResponseBytes: 262_144 };
}

/** Gate C: a separate judge for /v1/preflight. It must have its own accelerator: sharing one GPU with the
 *  shadow judge makes preflight exceed its 400 ms judge budget and fail closed (docs/GATE.md). */
export function gateJudgeFromEnv(): JudgeConfig | null | undefined {
  const url = env('GATE_JUDGE_BASE_URL');
  if (!url) return undefined;   // undefined = reuse the main judge
  return { backend: 'kev-local', baseUrl: url, model: env('GATE_JUDGE_MODEL', 'kev-latest')!, expectedRun: env('GATE_JUDGE_EXPECTED_RUN', 'jaredpalmer/kev-0.8b'),
    maxRps: Number(env('JUDGE_MAX_RPS', '10')), maxInputTokensPerSec: Number(env('JUDGE_MAX_TPS', '40000')), maxResponseBytes: 262_144 };
}

export function appOptionsFromEnv(): AppOptions {
  const need = (k: string) => { const v = env(k); if (!v || v.length < 16) throw new Error(`${k} must be set (≥16 chars)`); return v; };
  return {
    judge: judgeFromEnv(),
    gateJudge: gateJudgeFromEnv(),
    sourceMode: env('SOURCE_MODE', 'live_sandbox_shadow') === 'live_sandbox_gate' ? 'live_sandbox_gate' : 'live_sandbox_shadow',
    tenants: [{ tenant_id: env('TENANT_ID', 't-demo')!, name: env('TENANT_NAME', 'Demo tenant (fictional)')!,
      keys: { ingest: need('INGEST_KEY'), reader: need('READER_KEY'), gateway: need('GATEWAY_KEY'), admin: need('ADMIN_KEY') } }],
    worker: { autostart: true, concurrency: Number(env('WORKER_CONCURRENCY', '2')) },
    port: Number(env('PORT', '8787')),
    host: env('HOST', '127.0.0.1'),
  };
}
