// Types for web/js/verdict.js (a browser module, imported by the unit tests).
export type StepKind = 'gated' | 'ungated' | 'statement';
export interface Part { text: string; level: string }
export interface LineInput { mode: string; kind: StepKind | string; recommended?: string | null; decidedBy?: string; receiptStatus?: string; controlAction?: string; impact?: string }
export interface Decision { recommended?: string | null; decided_by?: string; rule_results?: Array<{ verdict: string; reason: string }>; reasons?: string[] }
export const STEP_KINDS: StepKind[];
export function callKind(x: { mode: string; controlAction?: string; impact?: string }): 'gated' | 'ungated';
export function decisionPart(x: { mode: string; kind: StepKind | string; recommended?: string | null; decidedBy?: string }): Part;
export function executionPart(receiptStatus?: string | null): Part;
export function isContradiction(x: { kind: StepKind | string; controlAction?: string; receiptStatus?: string }): boolean;
export function lineVerdict(x: LineInput): { text: string; tone: string; contradiction: boolean };
export function whyLine(decision: Decision | null | undefined): { reasons: string[]; source: string; passedNote: string | null } | null;
export function claimTimeLines(decision: Decision | null | undefined): string[];
export function summarize(calls: Array<{ receiptStatus?: string; controlAction?: string }>): { calls: number; ran: number; didNotRun: number; stoppedBySilex: number; didNotRunOther: number; failed: number; pending: number };
