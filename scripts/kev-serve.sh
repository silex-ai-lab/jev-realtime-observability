#!/usr/bin/env bash
# Starts the default judge: Kev (jaredpalmer/kev, Apache-2.0), an open model family that serves
# the TypeSafe System One API. It is NOT TypeSafe's Jev. Kev lives outside this repo.
# Pinned: jaredpalmer/kev@3e1cd3bb588a388a06827443380befece23e68c7 (clone it to $KEV_DIR and 'uv sync --extra serve').
set -euo pipefail
KEV_DIR="${KEV_DIR:-$HOME/workplace/Silex/third_party/kev}"
KEV_RUN="${KEV_RUN:-jaredpalmer/kev-4b}"
KEV_PORT="${KEV_PORT:-8009}"
cd "$KEV_DIR"
exec uv run --extra serve python -m kev.serve --run "$KEV_RUN" --port "$KEV_PORT"
