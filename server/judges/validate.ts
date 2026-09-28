// Pure response validation (RFC §6.4) and request hashing for the /v1/systemone client.
import type { Signal, SystemOneRequest, WireQuestion } from '../../contracts/judge.ts';
import { digestOf } from '../../contracts/canonical.ts';

/** sha256:<hex> of canonical JSON (sorted keys) of the request. */
export function requestHash(req: SystemOneRequest): string {
  return digestOf(req);
}

type Answer = Record<string, unknown>;
const isObj = (v: unknown): v is Answer => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function nullSignal(questionId: string, type: Signal['type']): Signal {
  return {
    question_id: questionId, type, raw_probability: null, choice: null, probabilities: null,
    vendor_confidence: null, score: null, legend: null, margin_local: null, p_calibrated: null, calibration_id: null,
  };
}

interface OneResult { signal: Signal | null; error: string | null }

function validateOne(questionId: string, q: WireQuestion, answer: unknown): OneResult {
  const fail = (error: string): OneResult => ({ signal: null, error });
  if (!isObj(answer) || answer.type !== q.type) return fail(`expected a ${q.type} answer`);

  if (q.type === 'noul') {
    const n = answer.noul;
    if (!finite(n) || n < 0 || n > 1) return fail('noul not a finite number in [0,1]');
    const s = nullSignal(questionId, 'noul');
    s.raw_probability = n;
    s.margin_local = Math.abs(2 * n - 1);
    return { signal: s, error: null };
  }

  if (q.type === 'choice') {
    const criteriaKeys = Object.keys(q.criteria);
    const probs = answer.probabilities;
    if (!isObj(probs)) return fail('missing probabilities');
    const probKeys = Object.keys(probs);
    const keySet = new Set(probKeys);
    if (keySet.size !== criteriaKeys.length || !criteriaKeys.every(k => keySet.has(k)))
      return fail('option set does not match the request criteria');
    const values: number[] = [];
    for (const k of criteriaKeys) {
      const v = probs[k];
      if (!finite(v) || v < 0 || v > 1) return fail(`probability for ${k} is not finite in [0,1]`);
      values.push(v);
    }
    const sum = values.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.01) return fail(`probabilities sum ${sum} not within 0.01 of 1`);
    // choice = argmax (derived from the distribution, never the vendor's label)
    let best = 0;
    for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
    const sorted = [...values].sort((a, b) => b - a);
    const s = nullSignal(questionId, 'choice');
    s.choice = criteriaKeys[best];
    s.probabilities = Object.fromEntries(criteriaKeys.map((k, i) => [k, values[i]]));
    s.vendor_confidence = finite(answer.confidence) ? answer.confidence : null;
    s.margin_local = sorted[0] - (sorted[1] ?? 0);
    return { signal: s, error: null };
  }

  // score
  const n = q.criteria.length;
  const legend = answer.legend;
  const probs = answer.probabilities;
  if (!isObj(legend)) return fail('missing legend');
  const expected = Array.from({ length: n }, (_, i) => String(i));
  for (let i = 0; i < n; i++) if (legend[String(i)] !== q.criteria[i]) return fail(`legend level ${i} does not match criteria`);
  const legendKeys = Object.keys(legend);
  if (legendKeys.length !== n || !expected.every(k => legendKeys.includes(k))) return fail('legend levels do not match criteria');
  if (!isObj(probs)) return fail('missing probabilities');
  const probKeys = Object.keys(probs);
  if (probKeys.length !== n || !expected.every(k => probKeys.includes(k))) return fail('probabilities not over "0".."n-1"');
  const values: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = probs[String(i)];
    if (!finite(v) || v < 0 || v > 1) return fail(`probability for ${i} is not finite in [0,1]`);
    values.push(v);
  }
  const score = answer.score;
  if (!finite(score) || score < 0 || score > n - 1) return fail(`score out of range [0, ${n - 1}]`);
  const sorted = [...values].sort((a, b) => b - a);
  const s = nullSignal(questionId, 'score');
  s.score = score;
  s.legend = Object.fromEntries(expected.map((k, i) => [k, String(legend[k])]));
  s.probabilities = Object.fromEntries(expected.map((k, i) => [k, values[i]]));
  s.vendor_confidence = finite(answer.confidence) ? answer.confidence : null;
  s.margin_local = sorted[0] - (sorted[1] ?? 0);
  return { signal: s, error: null };
}

/**
 * RFC §6.4 validation of one raw response against its request. Pure.
 * - noul: finite 0..1 → raw_probability; vendor_confidence null; margin_local |2p-1|.
 * - choice: option set equals request criteria keys; probabilities finite, sum 1 ± 0.01; choice = argmax.
 * - score: legend levels match request criteria; probabilities over "0".."n-1"; score in [0, n-1].
 * - a missing/invalid REQUIRED answer → status invalid_response (never 0 risk); optional ones → partial.
 * - p_calibrated and calibration_id are always null here (calibration is policy's job).
 */
export function validateResponse(req: SystemOneRequest, raw: unknown, requiredQuestionIds: string[]):
  { status: 'ok' | 'partial' | 'invalid_response'; signals: Record<string, Signal>; errors: string[] } {
  const errors: string[] = [];
  const signals: Record<string, Signal> = {};
  const required = new Set(requiredQuestionIds);

  const answers: Answer = isObj(raw) && isObj((raw as { answers?: unknown }).answers)
    ? (raw as { answers: Answer }).answers
    : {};

  let hasRequiredFailure = false;
  let hasOptionalFailure = false;

  for (const [qid, question] of Object.entries(req.questions)) {
    const result = validateOne(qid, question, answers[qid]);
    if (result.signal) {
      signals[qid] = result.signal;
    } else {
      if (required.has(qid)) hasRequiredFailure = true;
      else hasOptionalFailure = true;
      errors.push(`question ${qid}: ${result.error}`);
    }
  }

  const status = hasRequiredFailure ? 'invalid_response' : (hasOptionalFailure ? 'partial' : 'ok');
  return { status, signals, errors };
}
