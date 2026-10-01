---
name: jev-work-plan
description: Resume or continue the dated work plan for jev-runtime-observability on any machine. Use when asked to resume the jev work plan (today's or a given day's), continue the todo list, pick the next task, or record progress for this project. Reads the newest plans/<date>.md in this skill, checks what this machine can run (Node, Kev, GPU class, PostgreSQL), runs the next open task, and writes status back so another machine can pick up where this one stopped.
---

# Resume the jev-runtime-observability work plan

## Where things stand (update this when a plan closes)

Last updated 2026-10-01, at jev `main` `040f9c8` plus this skill update, and silex-mockup `main` `fe51c44`. Nothing is in progress: no open branch, no undeployed change, no pending review. Both repos are pushed, and their local `main` equals `origin/main`.

**Renamed 2026-09-30:** this repo was `jev-realtime-observability`. It is now `silex-ai-lab/jev-runtime-observability`, checked out at `~/workplace/Silex/jev-runtime-observability`. GitHub redirects the old URL.
- The live references were updated: `package.json`, READMEs, these skills, the deploy templates, the server banner, the guide, and the mockup's sync tool, `VENDORED.json` and READMEs.
- Dated `logs/`, `runs/` and the day plans keep the old name as written.
- An older clone only needs `git remote set-url origin https://github.com/silex-ai-lab/jev-runtime-observability.git`.

- **Day plans:**
  - No day plan is open.
  - [`plans/2026-09-30.md`](plans/2026-09-30.md) (N1–N6) is finished. Its one suggested follow-up is a 4B-specific fine-tune recipe, because the Kev-4B fine-tune (N2) did not match the 0.8B one on held-out goal_deviation.
  - [`plans/2026-09-29.md`](plans/2026-09-29.md) (T1–T10) is closed.
- **Done since then** (outside the day plans; each is a reviewed three-seat fleet run, recorded in `logs/` and listed in `logs/README.md`):
  1. **Sumo Logic demo:** SOC domain SOC1–SOC5, synthetic acceptance report, OTLP export. The run-book and talk track are in `docs/demo/SUMO_DEMO.md`.
     - The Sumo meeting is **Monday 2026-10-05**. Sumo is a prospect with no account, so the demo exports to the local OTLP sink.
     - Records: `logs/2026-09-29_SUMO_DEMO_PLAN.md`.
  2. **Console Runs view** (`logs/2026-09-30_CONSOLE_UX_PLAN.md`):
     - plain-language run cards, with the Engineer view still available underneath;
     - Re-check (`model_reeval`), Run again (`POST /v1/sandbox/reexec`) and What-if (`policy_only`, flags only);
     - the demo page's Live tab on the same layout;
     - `scripts/demo-up.sh` / `demo-down.sh`, which run the whole demo on a 24 GB Mac with Kev-0.8B (about 6 GB measured). See USER_MANUAL §0.
  3. **Demo page SOC agent** (`logs/2026-09-30_DEMO_SOC_PLAN.md`):
     - `/demo/index.html?domain=soc`, with an `AP | SOC` switch in the header;
     - SOC1–SOC5 are simulated with the console's rules;
     - SOC5 is the one labelled difference: synthetic `goal_deviation` scores hold the 2nd and 3rd suspensions for review, while the live console does not block SOC5.
  4. **silex-mockup integration** (`silex-mockup/logs/2026-09-30_JEV_RUNTIME_VALIDATION_PLAN.md`, deployed to https://silex-mockup.vercel.app/#view=runtime-observation):
     - the site's left nav has a **Runtime Observation** view, between Enterprise World Model and System Validation, that embeds this demo. It started as a System Validation tab and was moved by `silex-mockup/logs/2026-09-30_RUNTIME_OBSERVE_VIEW_PLAN.md`; the old `#view=long-term&tab=runtime` link redirects;
     - the demo is vendored byte-for-byte in `silex-mockup/jev-runtime/` (currently from `9ca7ffe`);
     - this repo gained `?embed=1`, a validated `?back`, and the Runs view's `select(runId)`.
     - **Latest deploy:** silex-mockup `df267fa` (2026-09-30), live read-back 7/7. The view was first built as "Runtime Observe" and renamed to **Runtime Observation** at the user's request; its id and deep link are `runtime-observation`. The plan file keeps the old name (`RUNTIME_OBSERVE_VIEW_PLAN.md`), as dated records do. Every silex-mockup branch is merged into `main`.
     - **After any change to `web/demo`, `web/js/runs.js`, `verdict.js` or `web/css/runs.css`,** re-sync the mockup, then run its suites and deploy with the user's OK:

       ```bash
       node tools/sync-jev-runtime.mjs <this checkout> <commit>      # run in the silex-mockup repo
       node --test tests/site/*.test.mjs                            # 20/20
       node tests/site/run-site-probes.mjs                          # 21/21
       ```

       Its integrity test fails on any local edit. A push to silex-mockup `main` is a public deploy (Vercel serves within about 15 s). Re-check the live site afterwards:

       ```bash
       node tests/site/run-site-probes.mjs --base https://silex-mockup.vercel.app   # 9/9 (S1, S3, S4, S5, S13, S14, S17, S20, S21)
       ```

     - The older AP-only `silex-mockup/jev-observability/` stays live, unchanged, and is marked superseded.
  5. **Plain-language guide** (Chinese, 13 screenshots; §9 is the Learning loop) to every demo page and the mockup's Runtime Observation view. Identical copies are in this repo (`docs/demo/guide/`) and in silex-mockup (`docs/jev-runtime-guide/`).
     - When the demo UI changes, retake the screenshots and update both copies together. The screenshots were taken with headless Chrome at 1440 × 900 through the Chrome DevTools Protocol; the helper script was a session scratch file and is not in either repo. Keep screenshots in the session scratch directory and show them inline. Do not copy screenshot sets to ~/Desktop; the user does not want them there.
     - Its numbers are simulated, with ±0.04 jitter, and the guide says so.
  6. **Learning loop showcase** (`logs/2026-09-30_LEARNING_LOOP_SHOWCASE_PLAN.md`, deployed 2026-10-01). The user called it the best selling point: "human judgment → align Kev to it → self-improving Kev".
     - **Demo:** a `?tab=learning` tab with **Play the loop**. A simulated logistic correction is trained on authored examples, then gated on 11 unseen variants per agent. By default, missed attacks fall 4/4 → 0/4 in both agents, actions sent to a person fall 3/10 → 1/10 (SOC), and one stays wrong.
     - **Measured card:** the real Kev-0.8B fine-tune, recall 0.40 → 0.80 at FPR 0.014 → 0.009 on held-out AgentDojo. It comes from `web/demo/data/learning-evidence.json`, generated by `eval/run/showcase-json.ts` and drift-tested. After re-running an eval, regenerate it, then re-sync the mockup.
     - **Honesty rules on every surface:** benchmark labels, not customer reviewers; LoRA, not RL; human-label training and production promotion are future work.
     - **Mockup:** Runtime Observation has a "The judge learns from your reviewers" card with **Try the loop** (S21).
  7. **silex-mockup floating left nav** (`silex-mockup/logs/2026-09-30_FLOATING_NAV_PLAN.md`, deployed 2026-09-30). The nav is hidden by default. A ChatGPT-style sidebar icon docks or hides it, the choice is remembered, and hovering the left edge peeks it. Probes: S20; `nav()` docks through the real icon.
- **Open follow-ups** (non-blocking review notes, not done; details at the end of each log):
  - **Console** (`CONSOLE_UX_PLAN` code gate):
    - `/v1/sandbox/reexec` takes its rate slot before the run lookup;
    - the compatibility `/v1/replays kind: sandbox_reexec` path skips the sandbox budget;
    - What-if only reaches the ≤ 50 runs the Runs view keeps;
    - Run again jumps to the new run, so its "started" note is not seen.
  - **Demo SOC:**
    - the `QUESTIONS_BY_AGENT` lookup should use `Object.hasOwn`;
    - separate stop and watch counters for mixed-mode runs.
  - **Model:** the 4B fine-tune recipe (above).
  - **Mockup Runtime Observation view:** every Run waits for the six-step animation (about 1.6 s), even when the frame is ready. That is fine for a demo; a faster path is possible.
- **silex-mockup** (`~/workplace/Silex/silex-mockup`, https://github.com/silex-security/silex-mockup):
  - serve it locally with `python3 -m http.server 8797 --bind 127.0.0.1`;
  - tests: `node --test tests/site/*.test.mjs` (20/20) and `node tests/site/run-site-probes.mjs` (21/21).
- **Test baseline at `efce258`** (`77dc838` only adds docs):
  - `npm test`: 280 tests, 276 pass, 0 fail, 4 skip; with `TEST_DATABASE_URL`, 1 skip.
  - Probes, which need a Kev on 8010 (0.8B) or 8009:

    | command | expected |
    |---|---|
    | `npm run probe` (`KEV_URL=http://127.0.0.1:8010 KEV_EXPECT=jaredpalmer/kev-0.8b`) | 8/8 |
    | `node tests/probe/soc-probes.ts` | 7/7 |
    | `node tests/probe/ui-runs-probes.ts` | 29/29 |
    | `node tests/probe/demo-probes.ts` | 24/24 |

## Quick resume on a new host

```bash
git clone https://github.com/silex-ai-lab/jev-runtime-observability.git && cd jev-runtime-observability
npm ci && npm run typecheck && npm test          # expect 0 fail; 4 skips are normal without PostgreSQL
bash skills/jev-work-plan/scripts/resume-check.sh # what this host can run, and the open tasks
bash scripts/demo-up.sh                            # the whole demo (Kev-0.8B, two consoles, OTLP sink); stop with demo-down.sh
```

- **Consoles:**
  - gate: http://127.0.0.1:8791/
  - watch-only: http://127.0.0.1:8790/
- **Demo page:**
  - AP: http://127.0.0.1:8791/demo/index.html
  - SOC: http://127.0.0.1:8791/demo/index.html?domain=soc

**On another machine,** clone silex-mockup next to this repo (`git clone https://github.com/silex-security/silex-mockup.git ../silex-mockup`) if the work touches the demo, since its vendored copy must be re-synced.

Then pick the next work:
- **Meeting prep:** rehearse `docs/demo/SUMO_DEMO.md` before 2026-10-05. Take a follow-up from the list above only if the user asks.
- **New day plan:** create `plans/<date>.md` from the follow-ups above, with the user's priorities. The 4B fine-tune needs 32 GB+ Apple Silicon or a datacenter GPU, plus the Kev checkout at `~/workplace/Silex/third_party/kev` (deploy skill step 3).

**Fleet notes** (`herdr-agent-fleet`):
- **Staffing (user, 2026-10-01):** give Codex more of the build, including features and probes; DeepSeek reviews and does mechanical slices. Between unrelated tasks, start fresh sessions (`/new` in both panes).
- **Codex outside its workspace:** when its pane runs in silex-mockup and the work is in the jev repo, it stages files in /tmp and installs them with a script. Read the script before approving; it should only copy assigned paths.
- **Check exit codes directly.** `cmd | tail -1 && git commit` commits even when `cmd` fails, because the pipe's status is `tail`'s. That happened once on 2026-09-30 (jev `60b99da`). Use `cmd > log; echo exit=$?`.
- **Codex in its sandbox:**
  - It asks before writing files outside its working repo (silex-mockup) and before running probe runners on localhost. Approve its own assigned files and runner prefix only.
  - Its session can drop mid-review ("Conversation interrupted"). Re-prompt it with the findings it already printed.
- OpenCode's permission prompt wraps the path across lines. To auto-approve scratch reads, strip newlines and the box characters before matching the scratch path.
- A domain or UI change to the demo keeps AP behaviour pinned by `tests/fixtures/demo-ap-envelopes.json`. Re-capture it only from unchanged code (`tests/fixtures/capture-demo-ap.mjs`).

## How the plans work

The plans live in this skill's `plans/` folder, one file per day, named `YYYY-MM-DD.md`. **The plan file is the state.** Git is the only thing shared between machines, so whatever is not written into the plan file and pushed is lost to the next machine.

## 1. Find the plan

- If the user names a date, open `plans/<date>.md`.
- Otherwise open the newest file in `plans/`.
- Read it in full: the **Context** section, the task table and the **Log** at the bottom.

## 2. Check the machine

```bash
bash skills/jev-work-plan/scripts/resume-check.sh
```

The script:
- checks Node ≥ 23.6;
- checks that `origin` is the renamed repo. An old clone fails with the fix: `git remote set-url origin https://github.com/silex-ai-lab/jev-runtime-observability.git`. It also warns about an old folder name, and fails on skill links in `~/.claude/skills` / `~/.codex/skills` that point to the old path;
- runs `git fetch` and says whether the local branch is behind or ahead of `origin`;
- checks `node_modules`, `.env`, and whether Kev answers on 8009 and 8010;
- checks the Kev checkout and its pinned commit (`3e1cd3b`);
- checks the hardware against the `gpu` bar (Apple Silicon RAM ≥ 32 GB, or an NVIDIA GPU);
- checks for PostgreSQL, Docker and `TEST_DATABASE_URL` (`pg`), and for GNU `timeout`. Without it, `finetune.sh` uses `eval/finetune/timebox.pl`;
- lists the open tasks from the newest plan (any `| <letter><number> |` row not `done`).

Then fix what it reports:
- **`origin` still uses the old name** (`jev-realtime-observability`): `git remote set-url origin https://github.com/silex-ai-lab/jev-runtime-observability.git`, then `git fetch`. If the folder still has the old name, renaming it is optional; if you do, re-link the skills with `ln -sfn <new path>/skills/<skill> ~/.claude/skills/<skill>`.
- **Behind `origin`:** `git pull --ff-only` before anything else.
- **No `node_modules`:** `npm ci`.
- **No `.env`:** it is never in git. Create it from `deploy/env.example` with fresh random keys. The steps are in `skills/deploy-jev-observability/SKILL.md` step 4.
- **No Kev:** only the tasks marked `needs: kev` require it. Start it with `skills/deploy-jev-observability/SKILL.md` step 3. By convention:
  - Kev-4B on 8009;
  - Kev-0.8B on 8010;
  - an ad-hoc fine-tuned model on 8011 (`KEV_RUN=$PWD/runs/ft-…/model`).

  The probes check the served identity: `KEV_URL=http://127.0.0.1:8010 KEV_EXPECT=jaredpalmer/kev-0.8b npm run probe`.

### Capability decisions that need the user

- **Under the `gpu` bar:** don't substitute a smaller model (Kev-0.8B for Kev-4B) without asking. On 2026-09-29 the user said yes for that run only.
- **Installing anything:** PostgreSQL, Docker, Homebrew packages or Python packages beyond `uv sync` in the Kev checkout. Ask first.
- **Product decisions:** anything the plan lists under "Needs a user decision first".

Before starting, run `npm run typecheck && npm test`; it must be green. If it is red on a fresh clone, record that in the Log and fix it first.

## 3. Pick and run a task

- Take the first task whose status is `todo` and whose `needs` this machine meets. Mark it `doing (<host>, <date>)`, commit and push the plan file. That tells other machines it is taken.
- Stay inside the task's file list. Check its acceptance criteria literally.
- **Every number in a doc is generated, never typed** (this repo drift-tests generated blocks).
- **Never commit `.env`, `.data/`, raw eval data or model weights** (see `.gitignore`).
- Commit with a message naming the task id, for example `T4: review queue API`.

## 4. Record state after every task (not only at the end)

In the plan file:
- set the task's status to `done (<short sha>)`, `blocked: <reason>` or `partial: <what is left>`;
- append a Log line: date, host, task, what changed, test result (pass/fail/skip counts), and anything the next machine must know.

Then commit the plan file together with the code and **push**. If the session may end at any moment, a pushed `partial:` is worth more than an unpushed `done`.

## 5. When the day's plan is finished or abandoned

Leave unfinished tasks as `todo` or `partial:`. The next day's plan copies them forward and adds a link back to this file.

## Rules learned on 2026-09-29

- **Never edit a script while a job started from it is still running.** Bash reads scripts as it executes. An edit to `finetune.sh` mid-run broke its epilogue, and the fine-tune's exit code was lost. Put a fix in a new file, or wait for the job to end.
- **Long jobs:**
  - run them in the background with their own record directory (`runs/<kind>-<date>/`);
  - stop the Kev judge before a fine-tune, since both use the same GPU;
  - serve a fine-tuned model alone for its eval.
- **A time-out, an OOM or a failure is a result.** Record it in the run's `RUN.txt` and the Log. Don't hide it or retry silently.
- **Label exports hold tenant data.** Inside the repo, write them only under `runs/exports/`, where `.gitignore` covers every JSONL at any depth.
- **Before pushing a reviewed change,** check that the code equals what reviewers approved. `git diff <base> <approved-commit> | git hash-object --stdin` must equal the reviewed revision, and only record files may differ after it. Quote pathspecs like `':!logs'`; an unquoted one silently makes `git diff` print nothing.
- **Fleet runs** (`herdr-agent-fleet`): OpenCode asks for access to the review scratch directory on each read. Answer "Allow once" after checking the path. Codex asks to run tests outside its sandbox, because they bind 127.0.0.1. Approve each test command once.

## Rules that carry over from the build

- Push to `main` only with a green `npm test`. Larger changes (a new API, a migration, a UI panel) may use a branch and the three-seat review from the `herdr-agent-fleet` skill, if that machine has it. Otherwise note in the Log that the change was not reviewed.
- Semantic signals stay `experimental`: no task may let a judge signal block or change a live recommendation unless its plan entry says so explicitly.
- Login is optional (`AUTH_MODE=none` by default, loopback only). New endpoints must go through `auth()` with the correct roles, so that `AUTH_MODE=keys` keeps working, and they need a test in keys mode.
