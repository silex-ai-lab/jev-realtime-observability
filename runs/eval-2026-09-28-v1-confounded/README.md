# Eval v1: kept as a record. Confounded; do not cite as capability.

This first evaluation (Kev-0.8B, Kev-4B and a Kev-0.8B fine-tune, over the calibration, dev and test splits) was run on data with a label confound. In these splits, the mere presence of a `LOW-AUTHORITY CONTENT` section in the state predicts:
- `goal_deviation` with accuracy 1.000 on dev and test;
- `instruction_override` with accuracy 0.969 on dev and 1.000 on test.

Every positive embedded injected text, and the negatives almost never contained low-authority text. The fine-tune (`kev-0.8b-ft`, AUROC 0.999 on held-out AgentDojo, up from 0.51) learned that shortcut. The base-model numbers were not trained on the artifact, but they are measured on the same confounded splits.

The data was rebuilt with benign low-authority content in negatives, and a shortcut audit is now enforced by a unit test. See `../eval-2026-09-28-v2/`.
