# Plan: a promotion gate that knows about luck, and a model history — r1

Date 2026-10-01 · branch `lineage-gate` (jev), then silex-mockup · roster: planner Claude, `reviewer-codex`, `coder-deepseek`; both gates unanimous. Codex builds most of it (user's staffing).

**User request:**
- "proceed with 1 and 2, please make sure the demo UI should be simple and easy to understand, if passed all review, start coding."
- Item 1 is a statistics-aware three-outcome promotion gate (KEEP / NEAR-MISS / DISCARD).
- Item 2 is a champion lineage across retrain rounds.

Both are adapted from AutoScientists (mims-harvard/AutoScientists `c71a923`):
- `ROLE-GPU.md` Step 7.0, the multi-seed gate with NEAR-MISS;
- the champion promotion and dead-end records.

AutoScientists contains no RL, and this plan claims none.

## 0. Today (on `main`, `cdb755e`)
- The Learning loop tab (`web/demo/js/learning/*`) has a pass/fail gate: "missed attacks and false holds not up, one strictly down", on 11 authored held-out variants per agent. There is one candidate (v2) and one optional failed retrain.
- The UI has six stage cards, a review inbox, Train and Gate panels, before/after tiles, and the measured card.
- **Measured data:** `runs/eval-2026-09-28-v2/predictions-*.jsonl` holds per-item predictions. The planner's paired check on the goal_deviation AgentDojo test (250 items, each model at its own calibrated threshold; it reproduces recall 0.40 → 0.80) gives:

  | pair | fixed | broke | one-sided exact sign test | missed attacks |
  |---|---|---|---|---|
  | Kev-0.8B → fine-tuned | 17 | 2 | p ≈ 0.0004 | down (recall 0.40 → 0.80) |
  | Kev-4B → fine-tuned | 24 | 8 | p ≈ 0.0035 | **up** (recall 0.286 → 0.229) |

  These are planner figures to be re-derived by the generator (§2). They are not typed into any page.

## 1. The gate (one rule, used by the demo and the measured card)

A challenger is compared with the current champion on the same held-out items. The checks run in order:

1. **Safety check:** missed attacks must not rise, and false holds must not rise. If either rises, the verdict is **DISCARD**, with "made <metric> worse".
2. **Evidence check:** count the items the challenger **fixed** (champion wrong, challenger right) and **broke** (the reverse). Compute the chance of seeing at least that many fixes by luck, a one-sided exact sign test on the fixed + broke items with α = 0.05, fixed before any run.
   - fixed > broke and chance ≤ 5 %: **KEEP**. The challenger becomes the champion.
   - fixed > broke but chance > 5 %: **NEAR-MISS**. "Looks better but could be luck; the champion stays; collect more labels."
   - fixed ≤ broke: **DISCARD**.

**Plain-language output, always the same three lines:** Safety ✓/✗ (with the two before → after fractions); "Fixed X · Broke Y"; "Chance this is luck: Z %". The verdict word is shown big, with one sentence.

## 2. What the user sees (simple first)

The Learning loop tab is reorganised, top to bottom:

1. **Lede and controls:**
   - the lede is one line: "Reviewers label held actions → Kev is retrained → a gate decides whether the new version may replace the old one.";
   - the "Simulated toy model · measured evidence below" line and the "What is simulated" disclosure;
   - **Play the loop** and **Reset**.
2. **Model history**, the main visual: a horizontal row of version nodes. Play the loop produces exactly three rounds:
   - **v1 · released**: the starting champion.
   - **Round 1:** a challenger trained on the first, small batch of reviewer labels. **NEAR-MISS**: better, but too few fixes to rule out luck; v1 stays.
   - **Round 2:** a challenger trained on all the correct labels so far. **KEEP**: it becomes **v2**, the champion.
   - **Round 3:** a challenger trained on v2's labels plus a batch from "a careless reviewer" (mislabelled goal_deviation answers). **DISCARD** by the safety check; v2 stays, and the batch is "set aside for re-review".

   Each node has a coloured verdict chip (KEEP green, NEAR-MISS amber, DISCARD red), a one-line reason and the label count. The champion carries a crown or "active" marker. Clicking a node shows its gate card (3).

   **All outcomes are computed by the gate.** The batches are authored, and the page says so ("rounds are a scripted exercise that shows each gate outcome").
3. **Gate decision card** for the selected round: the verdict word, the three lines from §1, and one sentence.
4. **Before and after** (existing tiles and bars): v1 compared with the current champion.
5. **"Do it yourself"** (collapsed by default): the existing manual inbox, answers, Train, failed-retrain toggle and Gate controls. A manual run uses the same §1 gate and appends to the same history.
6. **Measured evidence card** (existing) gains "Would this gate promote it?", one row per fine-tune:
   - "Kev-0.8B fine-tuned: **KEEP**. Fixed 17 · Broke 2 · chance of luck < 0.1 % · missed attacks down."
   - "Kev-4B fine-tuned: **DISCARD**. Fewer false alarms, but more missed attacks (safety check)."

   The numbers come from the generated JSON.

**Removed for simplicity:** the six numbered stage cards become a compact one-line stepper (Review → Labels → Train → Gate → Promote) that highlights during Play. The separate Train and Gate panels move into "Do it yourself".

**Honesty additions** (in "What is simulated" and in the About tab):
- the rounds reuse one small authored held-out set, and real systems refresh their held-out set, because repeated testing on one set can overfit it;
- the sign test is on a handful of authored items;
- the measured rows are one paired comparison on one benchmark split, using benchmark labels, not reviewers.

## 3. Code (owners)

**jev, branch `lineage-gate`:**
- **DeepSeek (mechanical):**
  - extend `eval/run/showcase-json.ts` to emit `gate{ "kev-0.8b-ft": {...}, "kev-4b-ft": {...} }`, each with `vs`, `items`, `fixed`, `broke`, `p_one_sided`, `missed_attacks{before, after}`, `false_holds{before, after}` (positives and negatives at each model's own threshold), `verdict` (computed with the §1 rule) and `alpha`;
  - the rule lives in one small pure module, `web/demo/js/learning/gate.js` (owned by DeepSeek), shared by the generator and the demo, so the demo and the measured card cannot disagree;
  - tests: the drift test is extended; the values must match an independent recomputation from the predictions files; and unit tests of `gate.js` cover the edge cases (0 discordant, ties, the safety veto, α boundary).
- **Codex (build):**
  - the curriculum batches: round 1 = a small subset of the teaching examples, round 2 = all of them, round 3 = all plus a mislabelled batch (authored examples, labelled as such);
  - the session as a lineage (champion pointer; each round a frozen candidate with its verdict, and only KEEP moves the champion);
  - the UI restructure in §2, and the `gate.js` use;
  - probes: **DEMO-GATE-*** for each domain, checking:
    - that Play yields NEAR-MISS, KEEP, DISCARD in that order;
    - that only KEEP moves the champion;
    - the gate-card lines recomputed independently from the envelopes;
    - clicking a node;
    - Reset;
    - "Do it yourself" collapsed by default;
    - the measured rows equal the JSON;
    - 390 px with no overflow, the history wrapping or scrolling inside its row;
    - no JS errors.
  - The existing DEMO-LEARN-* checks are updated to the new structure.
- **Planner:** docs (USER_MANUAL §12, SUMO beat 7a, claims rows, guide §9 with screenshots, in both repos), the skill, screenshots.

**silex-mockup** (after the jev gate): Codex re-syncs the vendored demo and adds the two "Would this gate promote it?" verdict chips (from JSON) to the "The judge learns from your reviewers" card, replacing the Kev-4B sentence; S21 is updated.

## 4. Acceptance
- **jev:**
  - typecheck 0; `npm test` 0 fail;
  - demo-probes all PASS, three consecutive runs;
  - the AP fixture is byte-identical (Live is unchanged);
  - `gate.js` is the only implementation of the rule.
- **mockup:** unit 20/20; probes 21/21 (S21 updated); live read-back after deploy.
- **Screenshots for the user:** the model history after Play (both agents), each verdict's gate card, the collapsed "Do it yourself", the measured "Would this gate promote it?" rows, the mockup card, and 390 px.
- **Constraints carried over from the 2026-09-30 plan:**
  - the learner constants are not tuned to held-out results;
  - every number is computed;
  - the honesty lines stay.
