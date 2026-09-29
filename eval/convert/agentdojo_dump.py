#!/usr/bin/env python3
"""Dump AgentDojo default-suite tasks (banking / slack / workspace) with their ground-truth tool
calls to JSON for the TypeScript converter. Run via uv against the pinned PyPI version, e.g.:

    uvx --from agentdojo==0.1.35 python eval/convert/agentdojo_dump.py <out.json>

Deterministic for a pinned agentdojo version. Only user/injection tasks and their ground-truth
FunctionCall lists are emitted (no environment data), so the output is redistributable under the
repo's MIT licence.
"""
import json
import sys

from agentdojo.task_suite.load_suites import get_suite

BENCHMARK_VERSION = "v1.2.2"


def dump_calls(calls):
    out = []
    for c in calls:
        if hasattr(c, "function"):
            out.append({"function": c.function, "args": c.args})
        elif isinstance(c, dict):
            out.append({"function": c.get("function"), "args": c.get("args", {})})
    return out


def dump_suite(suite):
    injections = suite.get_injection_vector_defaults()
    try:
        env = suite.load_and_inject_default_environment(injections)
        # Benign environment: every injection placeholder filled with a benign (empty) value, so the
        # dumped data is the suite's own environment with no injected instruction.
        benign_env = suite.load_and_inject_default_environment({k: "" for k in injections})
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"failed to load {suite.name} environment: {exc}")

    benign_files = {}
    for name in ("filesystem", "cloud_drive"):
        container = getattr(benign_env, name, None)
        if container is None:
            continue
        files = getattr(container, "files", None)
        if files is None:
            continue
        if isinstance(files, dict):
            for key, val in files.items():
                content = val if isinstance(val, str) else (getattr(val, "content", None) if hasattr(val, "content") else None)
                if content is not None:
                    benign_files[str(key)] = str(content)
        else:
            for f in files:
                key = getattr(f, "id_", None) or getattr(f, "filename", None) or getattr(f, "file_path", None)
                content = getattr(f, "content", None)
                if key is not None and content is not None:
                    benign_files[str(key)] = str(content)
    benign_environment = json.dumps(benign_env.model_dump(), default=str, sort_keys=True)[:1500]

    def benign_context_for(calls):
        parts = []
        for c in calls:
            fn = c.function if hasattr(c, "function") else (c.get("function") if isinstance(c, dict) else None)
            args = c.args if hasattr(c, "args") else (c.get("args", {}) if isinstance(c, dict) else {})
            if fn in ("read_file", "get_file_by_id", "read_file_by_id"):
                key = args.get("file_path") or args.get("file_id") or args.get("file_name")
                if key is not None and str(key) in benign_files:
                    parts.append(benign_files[str(key)])
        if parts:
            return "\n".join(parts)
        return benign_environment

    user_tasks = []
    for tid, task in suite.user_tasks.items():
        pre = task.init_environment(env.model_copy(deep=True))
        calls = task.ground_truth(pre)
        dumped = dump_calls(calls)
        user_tasks.append({
            "id": task.ID,
            "prompt": task.PROMPT,
            "ground_truth_output": getattr(task, "GROUND_TRUTH_OUTPUT", ""),
            "calls": dumped,
            "benign_context": benign_context_for(calls),
        })

    injection_tasks = []
    for tid, task in suite.injection_tasks.items():
        pre = env.model_copy(deep=True)
        calls = task.ground_truth(pre)
        injection_tasks.append({
            "id": task.ID,
            "goal": task.GOAL,
            "ground_truth_output": getattr(task, "GROUND_TRUTH_OUTPUT", ""),
            "calls": dump_calls(calls),
        })

    return {"injection_defaults": injections, "user_tasks": user_tasks, "injection_tasks": injection_tasks}


def main():
    out = sys.argv[1]
    data = {
        "banking": dump_suite(get_suite(BENCHMARK_VERSION, "banking")),
        "slack": dump_suite(get_suite(BENCHMARK_VERSION, "slack")),
        "workspace": dump_suite(get_suite(BENCHMARK_VERSION, "workspace")),
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
