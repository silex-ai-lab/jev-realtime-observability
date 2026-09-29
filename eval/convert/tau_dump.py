#!/usr/bin/env python3
"""Dump tau-bench tasks (retail + airline) to JSON for the TypeScript converter.

tau-bench defines tasks as Python: retail uses pydantic `Task(...)`/`Action(name=..., kwargs={...})`
calls, airline's `tasks.py` uses plain dicts with `"arguments"`. This script parses the source with
the stdlib `ast` module only (no tau_bench / pydantic import, no network), so it is deterministic
for a pinned commit. Usage: python3 eval/convert/tau_dump.py <repo> <out.json>

For each task it also emits a `benign_record` — the retrieved order / user / reservation record text
that the task's ground-truth actions read, taken from the benchmark's own data files — plus a
`benign_record_source` of "recorded" (found in the data files) or "constructed" (not found).
"""
import ast
import json
import os
import re
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


def load_data(repo, family):
    base = os.path.join(repo, "tau_bench", "envs", family, "data")
    out = {}
    for name in ("users.json", "orders.json", "products.json", "reservations.json", "flights.json"):
        path = os.path.join(base, name)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                out[name] = json.load(f)
    return out


def render_order(order):
    items = []
    for it in order.get("items") or []:
        items.append("%s ($%s)" % (it.get("name"), it.get("price")))
    return "Order %s for %s: %s" % (order.get("order_id"), order.get("user_id"), "; ".join(items))


def render_user(user):
    name = (user.get("name") or {})
    addr = (user.get("address") or {})
    return "User %s: %s %s, %s, %s %s" % (
        user.get("email", ""),
        name.get("first_name", ""), name.get("last_name", ""),
        addr.get("city", ""), addr.get("state", ""), addr.get("zip", ""),
    )


def render_reservation(res):
    flights = res.get("flights") or []
    legs = ["%s %s" % (f.get("flight_number"), f.get("date")) for f in flights]
    return "Reservation %s: %s -> %s, %s, %s" % (
        res.get("reservation_id"), res.get("origin"), res.get("destination"),
        res.get("flight_type"), ", ".join(legs),
    )


def benign_record(family, task, data):
    """Return (record_text, source) for the record the task's ground-truth actions read."""
    instruction = task["instruction"]
    actions = task["actions"] or []

    def first_kwarg(name):
        for a in actions:
            if a["name"] == name and isinstance(a["params"], dict) and a["params"].get(name.split("_")[1] if "_" in name else ""):
                return a["params"]
            if a["name"] == name and isinstance(a["params"], dict):
                # generic: return the first scalar value keyed by an id-ish name
                for k in ("order_id", "reservation_id", "user_id", "id"):
                    if k in a["params"] and isinstance(a["params"][k], str):
                        return {k: a["params"][k]}
        return None

    orders = data.get("orders.json", {})
    users = data.get("users.json", {})
    reservations = data.get("reservations.json", {})

    # retail: order record via get_order_details
    for a in actions:
        if a["name"] == "get_order_details" and isinstance(a["params"], dict):
            oid = a["params"].get("order_id")
            if oid in orders:
                return render_order(orders[oid]), "recorded"
    # airline: reservation record via get_reservation_details
    for a in actions:
        if a["name"] == "get_reservation_details" and isinstance(a["params"], dict):
            rid = a["params"].get("reservation_id")
            if rid in reservations:
                return render_reservation(reservations[rid]), "recorded"

    # fall back to an order/reservation id found anywhere in the instruction
    m = re.search(r"#[A-Z0-9]+", instruction)
    if m and m.group(0) in orders:
        return render_order(orders[m.group(0)]), "recorded"
    m = re.search(r"\b[A-Z0-9]{6}\b", instruction)
    if m and m.group(0) in reservations:
        return render_reservation(reservations[m.group(0)]), "recorded"

    # fall back to a user record by email / id pattern
    for a in actions:
        if a["name"] == "get_user_details" and isinstance(a["params"], dict):
            uid = a["params"].get("user_id")
            if uid in users:
                return render_user(users[uid]), "recorded"
    m = re.search(r"\b[a-z]+_[a-z]+_\d+\b", instruction)
    if m and m.group(0) in users:
        return render_user(users[m.group(0)]), "recorded"

    # constructed fallback: a benign record-shaped line from the instruction
    return "Retrieved record for this task: " + instruction.strip()[:160], "constructed"


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
        fdata = load_data(repo, family)
        merged = []
        for rel in files:
            path = os.path.join(repo, rel)
            if not os.path.exists(path):
                continue
            for task in normalize(tasks_in(path)):
                record, source = benign_record(family, task, fdata)
                merged.append({
                    "instruction": task["instruction"],
                    "actions": task["actions"],
                    "benign_record": record,
                    "benign_record_source": source,
                })
        data[family] = merged
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
