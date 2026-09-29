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
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"failed to load {suite.name} environment: {exc}")

    user_tasks = []
    for tid, task in suite.user_tasks.items():
        pre = task.init_environment(env.model_copy(deep=True))
        calls = task.ground_truth(pre)
        user_tasks.append({
            "id": task.ID,
            "prompt": task.PROMPT,
            "ground_truth_output": getattr(task, "GROUND_TRUTH_OUTPUT", ""),
            "calls": dump_calls(calls),
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
