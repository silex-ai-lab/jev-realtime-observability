// Shared vocabulary for every record the system stores or streams.
// RFC §2 (modes, invariants) and §5 (four record kinds). Plan §2 (provenance).
import { z } from 'zod';

export const SCHEMA_VERSION = 'silex.obs/0.1';

export const Boundary = z.enum([
  'run_started', 'pre_input', 'post_generation', 'pre_tool', 'post_tool', 'outcome_observed', 'run_finished',
]);
export type Boundary = z.infer<typeof Boundary>;

/** Boundaries the worker evaluates. Lifecycle boundaries are stored and streamed only. */
export const EVALUATED_BOUNDARIES: readonly Boundary[] = ['pre_input', 'post_generation', 'pre_tool', 'post_tool'];

export const SourceMode = z.enum(['demo', 'live_sandbox_shadow', 'live_sandbox_gate']);
export const ToolEnvironment = z.enum(['sandbox', 'simulated']);
export const EnforcementMode = z.enum(['shadow', 'gate']);

/**
 * The four provenance dimensions stored on every record (RFC §2, plan §2).
 * judge_source names the model actually served, e.g. "kev-local:jaredpalmer/kev-4b@139fdd94",
 * taken from the judge's /v1/models, never from the request/response `model` name.
 */
export const Provenance = z.object({
  source_mode: SourceMode,
  judge_source: z.string().nullable(),
  tool_environment: ToolEnvironment,
  enforcement_mode: EnforcementMode,
});
export type Provenance = z.infer<typeof Provenance>;

export const Iso = z.string().refine(s => !Number.isNaN(Date.parse(s)), 'ISO-8601 timestamp');
export const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:~\-]+$/, 'id charset');
export const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Tool impact floor comes from the server's tool registry; a model can never lower it (RFC §6.2). */
export const Impact = z.enum(['read', 'write', 'payment']);
export type Impact = z.infer<typeof Impact>;

/** Authenticity and instruction authority are separate labels, set by the connector (RFC §5.3). */
export const Authenticity = z.enum(['verified', 'unverified']);
export const InstructionAuthority = z.enum(['system', 'user', 'none']);

export const EvidenceClass = z.enum(['benchmark_ground_truth_derived', 'heuristic_derived', 'human_reviewed']);
