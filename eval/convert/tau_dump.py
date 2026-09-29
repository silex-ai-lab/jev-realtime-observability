#!/usr/bin/env python3
"""Dump tau-bench tasks (retail + airline) to JSON for the TypeScript converter.

tau-bench defines tasks as Python: retail uses pydantic `Task(...)`/`Action(name=..., kwargs={...})`
calls, airline's `tasks.py` uses plain dicts with `"arguments"`. This script parses the source with
the stdlib `ast` module only (no tau_bench / pydantic import, no network), so it is deterministic
for a pinned commit. Usage: python3 eval/convert/tau_dump.py <repo> <out.json>
"""
import ast
import json
import os
import sys


def lit(node):
    if node is None:
        return None
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, (ast.List, ast.Tuple)):
        return [lit(e) for e in node.elts]
    if isinstance(node, ast.Dict):
        return {lit(k): lit(v) for k, v in zip(node.keys, node.values)}
    if isinstance(node, ast.Call):
        out = {}
        for k in node.keywords:
            if k.arg:
                out[k.arg] = lit(k.value)
        pos = [lit(a) for a in node.args]
        if pos:
            out["__args__"] = pos
        return out
    if isinstance(node, ast.Name) and node.id in ("True", "False", "None"):
        return {"True": True, "False": False, "None": None}[node.id]
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant):
        return -node.operand.value
    if isinstance(node, ast.JoinedStr):
        parts = []
        for v in node.values:
            if isinstance(v, ast.Constant):
                parts.append(str(v.value))
            elif isinstance(v, ast.FormattedValue):
                parts.append(lit(v.value))
        return "".join(str(p) for p in parts)
    raise ValueError("unsupported literal: " + ast.dump(node)[:120])


def tasks_in(filepath):
    src = open(filepath, encoding="utf-8").read()
    tree = ast.parse(src)
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and (t.id.upper().startswith("TASK") or t.id == "tasks"):
                    val = lit(node.value)
                    if isinstance(val, list):
                        out.extend(val)
    return out


def normalize(tasks):
    result = []
    for task in tasks:
        if not isinstance(task, dict) or "instruction" not in task:
            continue
        actions = []
        for a in task.get("actions") or []:
            if isinstance(a, dict) and ("name" in a or "__args__" in a):
                name = a.get("name")
                if name is None and a.get("__args__"):
                    name = a["__args__"][0]
                params = a.get("kwargs") or a.get("arguments") or {}
                if not isinstance(params, dict):
                    params = {}
                actions.append({"name": name, "params": params})
        result.append({"instruction": task["instruction"], "actions": actions})
    return result


def main():
    repo, out = sys.argv[1], sys.argv[2]
    suites = {
        "retail": [
            "tau_bench/envs/retail/tasks_train.py",
            "tau_bench/envs/retail/tasks_dev.py",
            "tau_bench/envs/retail/tasks_test.py",
        ],
        # airline `tasks.py` is the full task list; `tasks_test.py` is a duplicate copy of it
        # (the airline env has no separate train/dev files). Merging both would double-count the
        # test tasks and leak identical judge-view states across splits.
        "airline": [
            "tau_bench/envs/airline/tasks.py",
        ],
    }
    data = {}
    for family, files in suites.items():
        merged = []
        for rel in files:
            path = os.path.join(repo, rel)
            if not os.path.exists(path):
                continue
            merged.extend(normalize(tasks_in(path)))
        data[family] = merged
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
