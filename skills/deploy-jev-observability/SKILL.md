---
name: deploy-jev-observability
description: Deploy jev-realtime-observability (the Jev-protocol agent observability server, its live console, and the local Kev judge) onto a new host, check it, and run a sandbox smoke test. Use when asked to deploy, install, set up, move or run this project on another machine or server (Linux with an NVIDIA GPU, or an Apple Silicon Mac), to run the demo on one 24 GB Mac (Kev-0.8B, scripts/demo-up.sh), to enable gate mode, to point it at a real PostgreSQL, or to diagnose a deployment whose /readyz reports the judge or database as degraded.
---

# Deploy jev-realtime-observability on another host

This skill deploys **one host running two processes**:
- **the Kev judge**: `jaredpalmer/kev` serving the System One protocol on `127.0.0.1:8009`;
- **the server**: the API, the worker, the SSE stream and the live console on `127.0.0.1:8787`.

Storage is an embedded PostgreSQL (PGlite) under `DATA_DIR`. A real PostgreSQL can replace it via `DATABASE_URL`.

Every command below is run from the repo root unless stated. Helper scripts are in this skill's `scripts/` and `templates/` directories.

## 0. Decide before you start

| Question | Default | Notes |
|---|---|---|
| Judge model | `jaredpalmer/kev-4b` | Kev's README lists it for a 32 GB Mac, an L40S or an H100 (it is too slow on an L4). `jaredpalmer/kev-0.8b` runs on an L4 or any Apple Silicon Mac. **On a 24 GB Mac use Kev-0.8B**: serving Kev-4B was measured at a 16 GB peak footprint (`runs/mem-2026-09-30/footprint.txt`). The demo uses Kev-0.8B in any case. |
| Shadow or gate | shadow (`SOURCE_MODE=live_sandbox_shadow`) | Gate mode enforces write and payment tools in the **sandbox only**. Read `docs/GATE.md` first. |
| Storage | PGlite in `DATA_DIR` | Set `DATABASE_URL` for a real PostgreSQL. It runs the same migrations. Single replica only; no HA. |
| Login (authentication) | **off** (`AUTH_MODE=none`) | With login off, anyone who can reach the port has full access (they can view everything and start runs), so the server refuses a non-loopback `HOST` unless `ALLOW_UNAUTHENTICATED_REMOTE=1`. **Set `AUTH_MODE=keys` for any shared or remote deployment.** |
| Who can reach the console | only localhost | Expose it through a TLS reverse proxy (step 6), with `AUTH_MODE=keys`. Never bind `0.0.0.0` without TLS: API keys travel in headers. |

**Hard constraints that come from the code (do not work around them):**
- **The judge must run on the same host, bound to `127.0.0.1`.** For `JUDGE_BACKEND=kev-local` the server sends no credential to the judge (`server/config.ts`). A Kev reachable over a network would therefore be unauthenticated. Remote judges are not supported by this build.
- **The gate judge needs its own accelerator headroom.** On a shared, saturated GPU, gate preflights run out of their 400 ms judge budget and fail closed (benign payments are held). See `docs/GATE.md`.
- **Hosted Jev:** `JUDGE_BACKEND=typesafe` with `TYPESAFE_API_KEY` uses TypeSafe's hosted Jev instead of Kev. That path is supported by config but has never been run against the real service, so smoke-test it before relying on it.
- **Sandbox only.** No real money or real email is involved: the tools write to the `sandbox` schema. Do not point the gateway at production systems.

## Quick path: run the demo on one Mac with 24 GB

The demo (the live consoles with the SOC and AP scenarios, plus the simulated `/demo/` page) runs on **one Apple Silicon Mac with 24 GB of memory**.
- **Judge:** it needs only the **Kev-0.8B** judge.
- **Measured footprint:** the whole stack peaked at about 6 GB (`runs/mem-2026-09-30/footprint.txt`, macOS `footprint`, phys_footprint including unified/Metal memory).
  - Kev-0.8B: 3.6 GB peak.
  - Each console server: about 1.2 GB peak.
  - The OTLP sink: under 0.1 GB.
- **Not needed for the demo:** Kev-4B (16 GB peak when serving), fine-tuning, PostgreSQL and Docker.

**Prerequisites** (check them with step 1's `check-host.sh`):

| Need | Why | How |
|---|---|---|
| Apple Silicon Mac, macOS, 24 GB or more | Kev's Mac path is MLX; about 6 GB peak for the stack | — |
| Node ≥ 23.6 | the server runs TypeScript natively | `brew install node` |
| `uv`, and Python 3.12 or 3.13 | Kev runs under `uv` (`torch` has no 3.14 wheels) | `brew install uv` |
| git | clone this repo and Kev | `xcode-select --install` or `brew install git` |
| Internet on the first run | npm packages and the Kev-0.8B weights (Hugging Face) are downloaded once; later runs work offline with `HF_HUB_OFFLINE=1` | — |
| Free ports 8010, 8790, 8791 and 4318 on 127.0.0.1 | judge, watch-only console, gate console, OTLP sink | `lsof -iTCP:8791 -sTCP:LISTEN` |
| Free disk | models and caches (step 1 checks about 30 GB free) | — |

**Steps:**

```bash
# 1. The code and its dependencies
git clone https://github.com/silex-ai-lab/jev-realtime-observability.git && cd jev-realtime-observability
npm ci && npm run typecheck && npm test        # expect 0 fail
bash skills/deploy-jev-observability/scripts/check-host.sh

# 2. Kev at the pinned commit (docs/THIRD_PARTY.md), outside this repo
git clone https://github.com/jaredpalmer/kev.git ~/workplace/Silex/third_party/kev
git -C ~/workplace/Silex/third_party/kev checkout 3e1cd3b
(cd ~/workplace/Silex/third_party/kev && uv sync --extra serve)

# 3. Start everything (the first start downloads the Kev-0.8B weights)
bash scripts/demo-up.sh --reset                # KEV_DIR=/path/to/kev if you cloned it elsewhere

# 4. Open http://127.0.0.1:8791/ (gate), http://127.0.0.1:8790/ (watch-only),
#    http://127.0.0.1:8791/demo/index.html (simulated). "Run a scenario" → SOC1…SOC5.

# 5. Stop (the judge keeps running; add --kev to stop it too)
bash scripts/demo-down.sh
```

What `scripts/demo-up.sh` does:
- checks Node, `node_modules`, `uv` and the Kev checkout;
- reuses a Kev-0.8B already serving on 8010 (checking its identity), or starts one and waits up to 15 minutes for the first download;
- starts `scripts/otlp-sink.mjs` on 4318;
- starts a watch-only console on 8790 and a gate console on 8791, each with its own data dir under `.data/` (`--reset` re-seeds both), and the gate console exports to the sink.

Everything binds to 127.0.0.1 with login off (`AUTH_MODE=none`). That is only safe on your own machine; see step 4 before sharing a console. Logs and pids are in `.data/demo/`. `docs/demo/SUMO_DEMO.md` has the talk track.

**Do not on a 24 GB Mac:**
- serve Kev-4B next to the demo;
- run the Kev-4B fine-tune (`needs: gpu` in the work plan means 32 GB or more).

## 1. Check the host

```bash
bash skills/deploy-jev-observability/scripts/check-host.sh
```

It reports:
- Node (must be ≥ 23.6, for native TypeScript type stripping);
- `uv` and Python (3.12 or 3.13; `torch` has no 3.14 wheels);
- the GPU (`nvidia-smi` or Apple Silicon), memory and free disk (about 30 GB for models and caches);
- whether ports 8009 and 8787 are free;
- whether the npm registry and Hugging Face are reachable.

**Fix every `FAIL` before continuing.** A `WARN` needs a decision, for example the GPU being too small for Kev-4B (use Kev-0.8B).

If the machine's npm points at an unreachable internal mirror, the repo's own `.npmrc` already pins the public registry; do not change the global config.

## 2. Get the code and dependencies

```bash
git clone https://github.com/silex-ai-lab/jev-realtime-observability.git
cd jev-realtime-observability
npm ci                                   # uses package-lock.json and .npmrc
npm run typecheck && npm test            # expect all pass, 1-2 skipped (live Kev, raw eval data)
```

If `npm test` fails on a fresh host, stop and read the failure. Do not deploy a red build.

## 3. Install and start the Kev judge

The pinned Kev commit is recorded in `docs/THIRD_PARTY.md` and in `scripts/kev-serve.sh`.

```bash
git clone https://github.com/jaredpalmer/kev.git ~/kev && git -C ~/kev checkout <commit from docs/THIRD_PARTY.md>
(cd ~/kev && uv sync --extra serve)      # CUDA/ROCm on Linux, MLX on Apple Silicon
# Linux + CUDA only, recommended by Kev for Qwen3.5 speed:
(cd ~/kev && uv pip install flash-linear-attention)
KEV_DIR=~/kev KEV_RUN=jaredpalmer/kev-4b KEV_PORT=8009 npm run kev     # first start downloads the weights
```

- **Offline hosts:** copy the Hugging Face cache (`~/.cache/huggingface/hub/models--jaredpalmer--kev-4b` and its Qwen base model) from a machine that has it, and set `HF_HUB_OFFLINE=1`.
- **Check the judge** answers with the expected identity:

```bash
curl -s 127.0.0.1:8009/v1/models | python3 -c 'import sys,json;m=json.load(sys.stdin)["models"][0];print(m["run"],m["backend"],m["dtype"])'
```

  It must print `jaredpalmer/kev-4b …`. The model *name* (`kev-latest`, and also `jev-latest`) is not the identity; `run` is.
- **Gate mode with a separate gate judge:** start a second Kev on port 8010 with `KEV_RUN=jaredpalmer/kev-0.8b KEV_PORT=8010`.
- **Fine-tuned judge:** its weights are not in git. Copy `runs/ft-kev-0.8b-2026-09-28/model/` from the build machine and serve it with `KEV_RUN=/path/to/model`. Read `docs/EVAL.md` for what its numbers do and do not support.

## 4. Configure the server

```bash
cp deploy/env.example .env
chmod 600 .env
```

Edit `.env`:
- **Login:** `AUTH_MODE=none` (the default) needs no keys and is fine for a single-user localhost setup. For anything shared or reachable by others, set `AUTH_MODE=keys`.
- **Keys** (used only with `AUTH_MODE=keys`): set `INGEST_KEY`, `READER_KEY`, `GATEWAY_KEY` and `ADMIN_KEY` to **four different random values** of at least 16 characters each, for example from `openssl rand -hex 24`. The server stores only their sha256 hashes.
- **Storage:** set `DATA_DIR` to a persistent path (for example `/var/lib/jev-observability/pg`), **or** set `DATABASE_URL=postgres://…` for a real PostgreSQL. Only the server's own user may read it.
- **Judge:** keep `JUDGE_BACKEND=kev-local`, `JUDGE_BASE_URL=http://127.0.0.1:8009`, and `JUDGE_EXPECTED_RUN` equal to the model you started. On a mismatch, every evaluation records `model_mismatch`.
- **Gate mode:**
  - set `SOURCE_MODE=live_sandbox_gate`, `GATE_JUDGE_BASE_URL=http://127.0.0.1:8010` and `GATE_JUDGE_EXPECTED_RUN=jaredpalmer/kev-0.8b`;
  - `FAULT_INJECTION` is off by default; set `FAULT_INJECTION=1` only if you want F1's fault drill.
- **Leave `HOST=127.0.0.1`.** Step 6 handles outside access.

Never commit `.env`; it is git-ignored.

## 5. Start the server and run the smoke test

```bash
set -a && . ./.env && set +a && npm run server        # foreground, first time
```

Then, in another shell:

```bash
bash skills/deploy-jev-observability/scripts/smoke.sh     # reads .env for the keys and port
```

The smoke test checks, in order:
1. `/healthz`;
2. `/readyz` reports `db: ok` and `judge: ok` (`degraded` means the judge is unreachable or not answering; `not_configured` means `JUDGE_BACKEND=none`);
3. `/v1/judge` reports the expected `judge_source`;
4. it runs the S3 sandbox scenario (a payment over the limit), which must be decided `BLOCK` by the `amount_limit` rule;
5. it runs S1, which must produce judge evaluations with status `ok` from `kev-local:`;
6. `/v1/metrics` must answer.

It prints `SMOKE PASS` or the first failing check. It asks the server for its auth mode first, and needs `READER_KEY` and `ADMIN_KEY` only when the server runs `AUTH_MODE=keys`.

## 6. Run it as a service and expose it (optional)

- **Linux:** fill in the templates, then enable them:

```bash
sudo cp skills/deploy-jev-observability/templates/jev-kev.service /etc/systemd/system/
sudo cp skills/deploy-jev-observability/templates/jev-observability.service /etc/systemd/system/
sudoedit /etc/systemd/system/jev-*.service          # set User, WorkingDirectory, KEV_DIR, model
sudo systemctl daemon-reload && sudo systemctl enable --now jev-kev jev-observability
journalctl -u jev-observability -f
```

  The server unit waits for the Kev unit. `/readyz` reports `judge: degraded` until Kev has loaded.
- **macOS:** run both processes under `launchd` or a terminal multiplexer. There is no template, because MLX runs in the user session.
- **Outside access:** set **`AUTH_MODE=keys`**, then put a TLS reverse proxy (Caddy or nginx) in front of `127.0.0.1:8787`. With login off, the proxy would give everyone admin rights.
  - Proxy `/v1/stream` **without buffering**: nginx `proxy_buffering off;` and a long `proxy_read_timeout`. It is SSE.
  - Expose only the console and `/v1/*`; **never** expose the Kev port.
  - An example is in `templates/Caddyfile.example`.

## 7. After deploying

- **Keys:** give the reader key to people who watch the console, and the ingest key to agents or tool wrappers. The admin key starts sandbox runs and revokes controls; keep it off shared machines.
- **Watch:**
  - `/v1/metrics`: `gate.sdk_preflight_ms` and `judge_http_rtt_ms` (if the gate's p95 approaches 600 ms, the gate is failing closed), `capture_coverage` and `realtime_expired`;
  - `/readyz` for liveness.
- **Upgrades:** `git pull && npm ci && npm test`, then restart the server. Migrations apply on start and are idempotent. Back up `DATA_DIR` or the PostgreSQL database first.
- **The semantic policy stays `experimental`** (signals are recorded and never act). Turning on calibrated mode needs a calibration fitted on this deployment's own labelled data; see `docs/EVAL.md`.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `/readyz` judge `degraded` | Kev not started, still loading, or on another port | `curl 127.0.0.1:8009/v1/models`; the Kev logs |
| Every evaluation `model_mismatch` | `JUDGE_EXPECTED_RUN` differs from the served `run` | step 3's identity check |
| Many `evaluation_expired` / `realtime_expired` | the judge is too slow for the load | lower `WORKER_CONCURRENCY`, use a smaller model or a bigger GPU |
| Gate holds benign payments (`judge_unavailable`) | the gate judge is out of its 400 ms budget (a shared or saturated GPU, or a model too large) | `gate.sdk_preflight_ms` in `/v1/metrics`; give the gate judge its own GPU; use Kev-0.8B |
| `npm ci` hangs | the npm registry is unreachable | the repo `.npmrc` pins npmjs; check proxy settings |
| Console shows nothing | wrong reader key, or SSE buffered by a proxy | the browser devtools network tab for `/v1/stream`; `proxy_buffering off` |
