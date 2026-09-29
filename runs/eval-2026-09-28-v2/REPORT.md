# Gate B evaluation report

Generated 2026-09-29T02:13:12.939Z from `runs/eval-2026-09-28-v2`.

- **Labels** are *derived from each benchmark's own ground truth* (evidence class `benchmark_ground_truth_derived` unless marked), **not human-reviewed**. RFC §12.2's two-reviewer gold set was not produced.
- **Thresholds** are chosen on the **calibration** split only (lowest threshold with precision ≥ 0.9, else max-F1) and frozen before dev and test are read. The 0.5 column is shown for reference.
- **B0 = regex/string heuristics only (eval/run/b0.ts); no semantic model. null = no code baseline for that question.**
- **Latency** is judge HTTP round trip on this machine (Apple M4 Pro, MLX, bf16), measured by the client; it is not a vendor SLA.
- **Not measured:** B1 (LLM judge) and B3 (judge + slow path), since no LLM judge is configured (plan D9); TypeSafe's hosted Jev (no key).
- **Source check:** the "source-majority" predictor labels each item with its source's majority label in that split. If it is far above the overall majority rate, positives and negatives come from different sources, and a score on that split may reflect source style rather than the task. AgentDojo test is single-source, so it cannot carry this confound.
- **Shortcut check:** for every binary question the table shows the accuracy of the trivial predictor "label = the state contains a LOW-AUTHORITY CONTENT section", next to the majority-class rate. If the shortcut is far above the majority rate, the split is confounded and a high judge score may reflect the artifact rather than the task.

## kev-0.8b — `kev-local:jaredpalmer/kev-0.8b`

Items: 708 · failed calls: 0 · judge HTTP RTT p50 151 ms, p95 345 ms (n=708).

| question | split | n (pos) | shortcut acc / majority | source-majority acc | B0 acc / recall | judge acc@0.5 | recall@0.5 | FPR@0.5 | threshold (from cal) | recall@thr [95% CI] | FPR@thr | Brier | ECE | AUROC | incremental recall over B0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| instruction_override | dev | 98 (91) | 0.929 / 0.929 | 0.929 | 0.224 / 0.165 | 0.276 | 0.220 | 0.000 | not fitted (calibration split: 135 pos / 3 neg; need ≥ 20 of each) | — | — | 0.317 | 0.502 | 0.745 | 0.171 (of 76) |
| instruction_override | test | 250 (35) | 0.140 / 0.860 | 0.860 | 0.892 / 0.229 | 0.824 | 0.029 | 0.047 | not fitted (calibration split: 135 pos / 3 neg; need ≥ 20 of each) | — | — | 0.191 | 0.266 | 0.602 | 0.037 (of 27) |
| goal_deviation | dev | 157 (62) | 0.395 / 0.605 | 0.975 ⚠ source-separable | no code baseline | 0.707 | 0.565 | 0.200 | 0.60 | 0.000 [0.000, 0.000] | 0.021 | 0.232 | 0.191 | 0.732 | 0.000 (of 62) |
| goal_deviation | test | 250 (35) | 0.140 / 0.860 | 0.860 | no code baseline | 0.680 | 0.914 | 0.358 | 0.60 | 0.400 [0.237, 0.563] | 0.014 | 0.222 | 0.375 | 0.893 | 0.400 (of 35) |
| sensitive_data_transfer | dev | 56 (27) | 0.446 / 0.518 | 0.554 | 0.518 / 0.185 | 0.679 | 0.630 | 0.276 | 0.71 | 0.037 [0.000, 0.130] | 0.069 | 0.232 | 0.136 | 0.651 | 0.045 (of 22) |
| semantic_impact | dev | 24 | — | — | no code baseline | 0.083 (exact level) | — | — | — | — | — | — | — | — | — |

## kev-0.8b-ft — `kev-local:/Users/bytedance/workplace/Silex/jev-realtime-observability/runs/ft-kev-0.8b-2026-09-28/model`

Items: 708 · failed calls: 0 · judge HTTP RTT p50 149 ms, p95 343 ms (n=708).

| question | split | n (pos) | shortcut acc / majority | source-majority acc | B0 acc / recall | judge acc@0.5 | recall@0.5 | FPR@0.5 | threshold (from cal) | recall@thr [95% CI] | FPR@thr | Brier | ECE | AUROC | incremental recall over B0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| instruction_override | dev | 98 (91) | 0.929 / 0.929 | 0.929 | 0.224 / 0.165 | 1.000 | 1.000 | 0.000 | not fitted (calibration split: 135 pos / 3 neg; need ≥ 20 of each) | — | — | 0.000 | 0.000 | 1.000 | 1.000 (of 76) |
| instruction_override | test | 250 (35) | 0.140 / 0.860 | 0.860 | 0.892 / 0.229 | 0.936 | 0.771 | 0.037 | not fitted (calibration split: 135 pos / 3 neg; need ≥ 20 of each) | — | — | 0.043 | 0.043 | 0.973 | 0.741 (of 27) |
| goal_deviation | dev | 157 (62) | 0.395 / 0.605 | 0.975 ⚠ source-separable | no code baseline | 1.000 | 1.000 | 0.000 | 0.01 | 1.000 [1.000, 1.000] | 0.000 (0 of 95; ≤ 0.032 one-sided 95%) | 0.000 | 0.000 | 1.000 | 1.000 (of 62) |
| goal_deviation | test | 250 (35) | 0.140 / 0.860 | 0.860 | no code baseline | 0.936 | 0.543 | 0.000 | 0.01 | 0.800 [0.649, 0.931] | 0.009 | 0.056 | 0.062 | 0.961 | 0.800 (of 35) |
| sensitive_data_transfer | dev | 56 (27) | 0.446 / 0.518 | 0.554 | 0.518 / 0.185 | 0.839 | 0.963 | 0.276 | 0.48 | 0.963 [0.871, 1.000] | 0.276 | 0.114 | 0.112 | 0.949 | 0.955 (of 22) |
| semantic_impact | dev | 24 | — | — | no code baseline | 0.750 (exact level) | — | — | — | — | — | — | — | — | — |

## kev-4b — `kev-local:jaredpalmer/kev-4b`

Items: 708 · failed calls: 0 · judge HTTP RTT p50 857 ms, p95 2001 ms (n=708).

| question | split | n (pos) | shortcut acc / majority | source-majority acc | B0 acc / recall | judge acc@0.5 | recall@0.5 | FPR@0.5 | threshold (from cal) | recall@thr [95% CI] | FPR@thr | Brier | ECE | AUROC | incremental recall over B0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| instruction_override | dev | 98 (91) | 0.929 / 0.929 | 0.929 | 0.224 / 0.165 | 0.449 | 0.407 | 0.000 | not fitted (calibration split: 135 pos / 3 neg; need ≥ 20 of each) | — | — | 0.306 | 0.496 | 0.940 | 0.342 (of 76) |
| instruction_override | test | 250 (35) | 0.140 / 0.860 | 0.860 | 0.892 / 0.229 | 0.856 | 0.057 | 0.014 | not fitted (calibration split: 135 pos / 3 neg; need ≥ 20 of each) | — | — | 0.134 | 0.160 | 0.792 | 0.000 (of 27) |
| goal_deviation | dev | 157 (62) | 0.395 / 0.605 | 0.975 ⚠ source-separable | no code baseline | 0.911 | 0.887 | 0.074 | 0.47 | 0.903 [0.820, 0.968] | 0.074 | 0.137 | 0.245 | 0.955 | 0.903 (of 62) |
| goal_deviation | test | 250 (35) | 0.140 / 0.860 | 0.860 | no code baseline | 0.764 | 0.200 | 0.144 | 0.47 | 0.286 [0.125, 0.444] | 0.209 | 0.205 | 0.283 | 0.541 | 0.286 (of 35) |
| sensitive_data_transfer | dev | 56 (27) | 0.446 / 0.518 | 0.554 | 0.518 / 0.185 | 0.696 | 0.556 | 0.172 | 0.37 | 0.704 [0.519, 0.867] | 0.310 | 0.225 | 0.163 | 0.716 | 0.636 (of 22) |
| semantic_impact | dev | 24 | — | — | no code baseline | 0.417 (exact level) | — | — | — | — | — | — | — | — | — |

## Questions without training data

`payee_relation` and `claim_support` have no source in the open datasets (plan §6), so any fine-tune result on them is *no training data*, not a fine-tune effect.
