---
name: deploy-jev-observability
description: Deploy jev-realtime-observability (the Jev-protocol agent observability server, its live console, and the local Kev judge) onto a new host, check it, and run a sandbox smoke test. Use when asked to deploy, install, set up, move or run this project on another machine or server (Linux with an NVIDIA GPU, or an Apple Silicon Mac), to enable gate mode, to point it at a real PostgreSQL, or to diagnose a deployment whose /readyz reports the judge or database as degraded.
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
| Judge model | `jaredpalmer/kev-4b` | Kev's README lists it for a 32 GB Mac, an L40S or an H100 (it is too slow on an L4). `jaredpalmer/kev-0.8b` runs on an L4 or any Apple Silicon Mac. |
| Shadow or gate | shadow (`SOURCE_MODE=live_sandbox_shadow`) | Gate mode enforces write and payment tools in the **sandbox only**. Read `docs/GATE.md` first. |
| Storage | PGlite in `DATA_DIR` | Set `DATABASE_URL` for a real PostgreSQL. It runs the same migrations. Single replica only; no HA. |
| Login (authentication) | **off** (`AUTH_MODE=none`) | With login off, anyone who can reach the port has full access (they can view everything and start runs), so the server refuses a non-loopback `HOST` unless `ALLOW_UNAUTHENTICATED_REMOTE=1`. **Set `AUTH_MODE=keys` for any shared or remote deployment.** |
| Who can reach the console | only localhost | Expose it through a TLS reverse proxy (step 6), with `AUTH_MODE=keys`. Never bind `0.0.0.0` without TLS: API keys travel in headers. |

**Hard constraints that come from the code (do not work around them):**
- **The judge must run on the same host, bound to `127.0.0.1`.** For `JUDGE_BACKEND=kev-local` the server sends no credential to the judge (`server/config.ts`). A Kev reachable over a network would therefore be unauthenticated. Remote judges are not supported by this build.
- **The gate judge needs its own accelerator headroom.** On a shared, saturated GPU, gate preflights run out of their 400 ms judge budget and fail closed (benign payments are held). See `docs/GATE.md`.
- **Hosted Jev:** `JUDGE_BACKEND=typesafe` with `TYPESAFE_API_KEY` uses TypeSafe's hosted Jev instead of Kev. That path is supported by config but has never been run against the real service, so smoke-test it before relying on it.
- **Sandbox only.** No real money or real email is involved: the tools write to the `sandbox` schema. Do not point the gateway at production systems.

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
