---
name: jev-work-plan
description: Resume or continue the dated work plan for jev-realtime-observability on any machine. Use when asked to resume the jev work plan (today's or a given day's), continue the todo list, pick the next task, or record progress for this project. Reads the newest plans/<date>.md in this skill, checks what this machine can run (Node, Kev, GPU class, PostgreSQL), runs the next open task, and writes status back so another machine can pick up where this one stopped.
---

# Resume the jev-realtime-observability work plan

## Where things stand (update this when a plan closes)

- **Current plan:** [`plans/2026-09-30.md`](plans/2026-09-30.md). It was created 2026-09-29 at `3d16c9f` and nothing in it has started. Its open tasks:
  - N1: real-PostgreSQL concurrency tests (`needs: pg`);
  - N2: a Kev-4B fine-tune (`needs: gpu, kev`);
  - N3–N6: follow-ups that review recorded (any machine).
- **Closed:** [`plans/2026-09-29.md`](plans/2026-09-29.md). T1–T10 are done in two reviewed fleet runs (`logs/2026-09-29_WORKPLAN_BATCH1_PLAN.md`, `…BATCH2_PLAN.md`). T10 was a Kev-0.8B rerun, by the user's decision on a 24 GB Mac.

## Quick resume on a new host

```bash
git clone https://github.com/silex-ai-lab/jev-realtime-observability.git && cd jev-realtime-observability
npm ci && npm run typecheck && npm test          # expect 0 fail; 3 skips are normal (see the plan's Context)
bash skills/jev-work-plan/scripts/resume-check.sh # what this host can run, and the open tasks
```

Then pick a task this host can run:
- **any host:** N3–N6;
- **Postgres available** (or Docker, or the user OKs an install): N1;
- **32 GB+ Apple Silicon or a datacenter GPU:** N2, which needs the Kev checkout at `~/workplace/Silex/third_party/kev` (deploy skill step 3).

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
- runs `git fetch` and says whether the local branch is behind or ahead of `origin`;
- checks `node_modules`, `.env`, and whether Kev answers on 8009 and 8010;
- checks the Kev checkout and its pinned commit (`3e1cd3b`);
- checks the hardware against the `gpu` bar (Apple Silicon RAM ≥ 32 GB, or an NVIDIA GPU);
- checks for PostgreSQL, Docker and `TEST_DATABASE_URL` (`pg`), and for GNU `timeout`. Without it, `finetune.sh` uses `eval/finetune/timebox.pl`;
- lists the open tasks from the newest plan (any `| <letter><number> |` row not `done`).

Then fix what it reports:
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
