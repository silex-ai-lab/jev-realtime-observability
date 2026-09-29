---
name: jev-work-plan
description: Resume or continue the dated work plan for jev-realtime-observability on any machine. Use when asked to resume today's (or a given day's) plan, continue the todo list, pick the next task, or record progress for this project. Reads plans/<date>.md in this skill, checks the machine, runs the next open task, and writes status back so another machine can pick up where this one stopped.
---

# Resume the jev-realtime-observability work plan

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
- lists the open tasks from the newest plan.

Then fix what it reports:
- **Behind `origin`:** `git pull --ff-only` before anything else.
- **No `node_modules`:** `npm ci`.
- **No `.env`:** it is never in git. Create it from `deploy/env.example` with fresh random keys. The steps are in `skills/deploy-jev-observability/SKILL.md` step 4.
- **No Kev:** only the tasks marked `needs: kev` require it. Start it with `skills/deploy-jev-observability/SKILL.md` step 3.

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

## Rules that carry over from the build

- Push to `main` only with a green `npm test`. Larger changes (a new API, a migration, a UI panel) may use a branch and the three-seat review from the `herdr-agent-fleet` skill, if that machine has it. Otherwise note in the Log that the change was not reviewed.
- Semantic signals stay `experimental`: no task may let a judge signal block or change a live recommendation unless its plan entry says so explicitly.
- Login is optional (`AUTH_MODE=none` by default, loopback only). New endpoints must go through `auth()` with the correct roles, so that `AUTH_MODE=keys` keeps working, and they need a test in keys mode.
