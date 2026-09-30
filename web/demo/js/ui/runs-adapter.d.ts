// Types for web/demo/js/ui/runs-adapter.js (a browser module, imported by the unit tests).
export interface SourceExcerpt {
  id: string;
  producer?: string;
  authenticity?: string;
  instruction_authority: string;
  excerpt?: string;
}
export interface Operation {
  tool: string | null;
  operation_id: string;
  args?: Record<string, unknown>;
}
export interface EventPayload {
  run_id: string;
  event_id: string;
  boundary: string;
  producer_seq: number;
  received_at: string;
  occurred_at: string;
  tool?: string | null;
  operation_id?: string;
  task_goal?: string;
  attributes?: Record<string, unknown>;
  sources?: SourceExcerpt[];
  operation?: Operation;
  text?: string | null;
}
export interface RuleResult {
  rule_id: string;
  verdict: string;
  reason: string;
  evidence_refs: string[];
  authoritative_source: string;
}
export interface DecisionPayload {
  decision_id: string;
  event_id: string;
  recommended: string;
  decided_by: string;
  reasons: string[];
  rule_results: RuleResult[];
  provenance: { source_mode: string; judge_source: string | null; tool_environment: string; enforcement_mode: string };
  replay_of: null;
}
export type StreamRecord =
  | { kind: 'event'; payload: EventPayload }
  | { kind: 'decision'; payload: DecisionPayload }
  | { kind: 'outcome'; payload: Record<string, unknown> };
export interface RunDetail {
  run_id: string;
  timeline: Array<{ event: EventPayload; evaluations: unknown[]; decisions: unknown[] }>;
}
export interface AdapterOptions {
  titles?: Record<string, string> | Map<string, string>;
}
export function toRunRecords(spans: unknown[], envelopes: unknown[], opts?: AdapterOptions): StreamRecord[];
export function toRunDetail(runId: string): RunDetail | null;
