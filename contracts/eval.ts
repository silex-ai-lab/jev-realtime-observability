// Open-data evaluation items (plan §6). One item = one decision-time state + one or more labelled
// questions, in a shape that maps 1:1 to Kev's training JSONL and to a /v1/systemone request.
import { z } from 'zod';
import { EvidenceClass } from './common.ts';
import { WireQuestion } from './judge.ts';

export const EvalSource = z.enum(['injecagent', 'agentdojo', 'asb', 'toolemu', 'taubench', 'sandbox']);
export type EvalSource = z.infer<typeof EvalSource>;
export const Split = z.enum(['train', 'calibration', 'dev', 'test']);

export const LabelledQuestion = z.object({
  question_id: z.string(),                       // a rubric id from rubrics/jev-questions.v1.json
  question: WireQuestion,                        // exactly the rubric wire object (not rephrased per item)
  label: z.union([z.boolean(), z.string(), z.number().int()]),   // noul: boolean; choice: option; score: level index
  evidence_class: EvidenceClass,
  derivation: z.string(),                        // one line: how the label follows from the source's ground truth
});

export const EvalItem = z.object({
  item_id: z.string(),                           // "<source>:<family>:<template_id>:<n>"
  source: EvalSource,
  family: z.string(),                            // e.g. "dh" / "ds" (InjecAgent), suite name (AgentDojo)
  template_id: z.string(),                       // splitting key: no template in two splits (RFC §12.2)
  split: Split,
  boundary: z.enum(['pre_input', 'pre_tool', 'post_generation']),
  state: z.string().max(8000),                   // the judge view text, built by the shared formatter (eval/convert/format.ts)
  questions: z.array(LabelledQuestion).min(1),
  provenance: z.object({ repo: z.string(), commit: z.string(), file: z.string(), locator: z.string(), licence: z.string() }),
});
export type EvalItem = z.infer<typeof EvalItem>;

/** A fitted calibration for one (judge_source, rubric, extractor, question). Gate B writes these; policy may reference them. */
export const Calibration = z.object({
  calibration_id: z.string(),
  judge_source: z.string(),
  rubric_id: z.string(),
  extractor_version: z.string(),
  question_id: z.string(),
  method: z.enum(['platt', 'isotonic', 'threshold_only']),
  params: z.record(z.string(), z.unknown()),
  review_at: z.number().min(0).max(1),           // intervention band chosen on the calibration split
  fitted_on: z.object({ split: z.literal('calibration'), n: z.number().int(), sources: z.array(z.string()) }),
  eval_ref: z.string(),                          // path of the eval run that produced it
  created_at: z.string(),
});
export type Calibration = z.infer<typeof Calibration>;
