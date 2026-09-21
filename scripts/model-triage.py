#!/usr/bin/env python3
"""
model-triage.py — weekly health check for all zen models.

For every whitelisted model id it fires a tiny real completion through the
bridge and detects which model actually serves it. Then it rebuilds the
catalog:

  zen_live_free      = ids that served AS THEMSELVES (big-pickle always kept)
  remap_to_zen_live  = dead ids -> a live target (previous manual target kept
                       if still alive, else nearest same-family live model,
                       else big-pickle / muse-spark)

Context limits and aliases (fast/fastest/speed) are preserved untouched.

The updated catalog is written to the repo copies and deployed to every
location the bridge may load it from, then the bridge is restarted so the
new mapping is live.

Usage:
  model-triage.py [--dry-run] [--quiet]

Exit codes: 0 = ok (or nothing changed), 1 = bridge unreachable / unsafe,
2 = catalog updated (used for scripting awareness; cron ignores it).
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
import subprocess
from datetime import date

HOME = os.path.expanduser("~")
SHARE = os.path.join(HOME, ".local/share/opencode")
SERVEHOME_SHARE = os.path.join(SHARE, "servehome/.local/share/opencode")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
BRIDGE = "http://127.0.0.1:1343"

QUIET = "--quiet" in sys.argv
DRY_RUN = "--dry-run" in sys.argv

ALIASES = {"fast": "big-pickle", "fastest": "big-pickle", "speed": "big-pickle"}

# family hints: prefer remapping within the same model family
FAMILY_HINTS = {
    "ling": ["ling-3.0-flash-fin-free", "ling-3.0-flash-free", "ling-2.6-flash-free"],
    "mimo": ["mimo-v2.5-free", "mimo-v2-pro-free", "mimo-v2-flash-free"],
    "minimax": ["minimax-m2.5-free", "minimax-m3-free", "minimax-m2.1-free"],
    "nemotron": ["nemotron-3-ultra-free", "nemotron-3.5-lightning-free", "nemotron-3-super-free"],
}

FALLBACK_ORDER = ["big-pickle", "muse-spark-1.3-contributor-free", "mimo-v2.5-free", "ling-3.0-flash-fin-free"]


def log(msg):
    if not QUIET:
        print(msg, flush=True)


def http_json(path, body=None, timeout=80):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BRIDGE + path,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def load_catalog():
    for p in [
        os.path.join(SERVEHOME_SHARE, "models-catalog.json"),
        os.path.join(SHARE, "models-catalog.json"),
        os.path.join(REPO_DIR, "models-catalog.json"),
    ]:
        try:
            return json.load(open(p)), p
        except Exception:
            continue
    sys.exit("model-triage: no models-catalog.json found")


def test_model(model):
    """Return (served_as_self, served_model, sample)."""
    try:
        t0 = time.time()
        j = http_json(
            "/v1/chat/completions",
            {"model": model, "messages": [{"role": "user", "content": "Reply with exactly: OK"}], "max_tokens": 10},
            timeout=80,
        )
        ms = int((time.time() - t0) * 1000)
        served = j.get("model") or ""
        text = (((j.get("choices") or [{}])[0]).get("message") or {}).get("content") or ""
        ok = served == model and text.strip() and not text.strip().startswith("[zen:")
        return ok, served, text.strip()[:24], ms
    except Exception as e:
        return False, "error", str(e)[:40], 0


def family_of(model):
    for fam in FAMILY_HINTS:
        if model.startswith(fam):
            return fam
    return None


def pick_target(dead, manual_target, live):
    if manual_target and manual_target in live:
        return manual_target
    fam = family_of(dead)
    if fam:
        for cand in FAMILY_HINTS[fam]:
            if cand in live and cand != dead:
                return cand
    for cand in FALLBACK_ORDER:
        if cand in live:
            return cand
    return None


def main():
    # 0) bridge must be alive
    try:
        http_json("/health", timeout=10)
    except Exception as e:
        print(f"model-triage: bridge not reachable ({e}) — leaving catalog untouched", file=sys.stderr)
        return 1

    catalog, loaded_from = load_catalog()
    whitelist = catalog.get("whitelist_31") or []
    old_live = catalog.get("zen_live_free") or []
    old_remap = catalog.get("remap_to_zen_live") or {}
    if not whitelist:
        sys.exit("model-triage: whitelist_31 empty — nothing to do")

    log(f"model-triage: testing {len(whitelist)} models via {BRIDGE} …")

    # 1) test every model, paced to avoid burst limits
    results = {}
    for i, m in enumerate(whitelist):
        ok, served, sample, ms = test_model(m)
        results[m] = {"ok": ok, "served": served, "sample": sample, "ms": ms}
        log(f"  {'SELF     ' if ok else 'DEAD/REM '} {m:34s} -> {served:34s} {ms:>6d}ms  {sample}")
        if i < len(whitelist) - 1:
            time.sleep(2)

    live = [m for m in whitelist if results[m]["ok"]]
    dead = [m for m in whitelist if not results[m]["ok"]]

    # 2) safety: need a usable core before rewriting anything
    if not live or ("big-pickle" not in live and len(live) < 2):
        print("model-triage: too few live models — NOT rewriting catalog (gateway outage?)", file=sys.stderr)
        return 1
    if "big-pickle" not in live:
        # keep the anchor even if one probe failed
        live.insert(0, "big-pickle")

    # 3) build new mapping
    new_live = [m for m in old_live if results.get(m, {}).get("ok")]
    for m in live:
        if m not in new_live:
            new_live.append(m)
    new_live = [m for m in new_live if m in whitelist or m in old_live]
    if "big-pickle" not in new_live:
        new_live.insert(0, "big-pickle")

    live_set = set(new_live)
    new_remap = dict(ALIASES)
    changed_targets = []
    for m in dead:
        target = pick_target(m, old_remap.get(m), live_set)
        if target and target != m:
            new_remap[m] = target
            if old_remap.get(m) != target:
                changed_targets.append(f"{m} -> {target}")
        elif m in old_remap:
            new_remap[m] = old_remap[m]  # keep old entry rather than losing it

    # 4) write catalog if changed
    old_pairs = {k: v for k, v in old_remap.items()}
    catalog_changed = (set(new_live) != set(old_live)) or (new_remap != old_pairs)

    catalog["zen_live_free"] = new_live
    catalog["remap_to_zen_live"] = new_remap
    catalog["updated"] = str(date.today())
    catalog["note"] = (
        "Free OpenCode zen model ids. zen_live_free = verified serving as themselves "
        f"(auto-triaged {date.today()}). Everything else remaps to a verified-live model; "
        "the bridge falls back automatically if a remapped id fails on the gateway."
    )

    summary = {
        "ts": int(time.time() * 1000),
        "day": str(date.today()),
        "tested": len(whitelist),
        "self": len([m for m in whitelist if results[m]["ok"]]),
        "live": new_live,
        "remapped": {m: new_remap[m] for m in new_remap if m not in ALIASES},
        "changedTargets": changed_targets,
        "results": {m: {"served": r["served"], "ms": r["ms"]} for m, r in results.items()},
    }

    log("")
    log(f"model-triage: {len(new_live)} live, {len(dead)} remapped, changed targets: {len(changed_targets)}")
    for c in changed_targets:
        log(f"  remap changed: {c}")

    if DRY_RUN:
        log("model-triage: dry-run — catalog NOT written")
        return 0

    if not catalog_changed:
        log("model-triage: no changes — catalog untouched")
        try:
            os.makedirs(SHARE, exist_ok=True)
            json.dump(summary, open(os.path.join(SHARE, "model-triage-last.json"), "w"), indent=1)
        except Exception:
            pass
        return 0

    targets = [
        os.path.join(REPO_DIR, "models-catalog.json"),
        os.path.join(REPO_DIR, "config/models-catalog.json"),
        os.path.join(SHARE, "models-catalog.json"),
        os.path.join(SERVEHOME_SHARE, "models-catalog.json"),
        os.path.join(HOME, ".opencode/models-catalog.json"),
    ]
    for p in targets:
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w") as f:
                json.dump(catalog, f, indent=2)
                f.write("\n")
            log(f"model-triage: wrote {p}")
        except Exception as e:
            log(f"model-triage: WARN could not write {p}: {e}")

    try:
        json.dump(summary, open(os.path.join(SHARE, "model-triage-last.json"), "w"), indent=1)
    except Exception:
        pass

    # 5) restart bridge so the new mapping is live
    try:
        subprocess.run(["systemctl", "--user", "restart", "zen-bridge.service"], check=False, timeout=60)
        log("model-triage: zen-bridge restarted with new catalog")
    except Exception as e:
        log(f"model-triage: WARN bridge restart failed: {e}")

    return 2


if __name__ == "__main__":
    sys.exit(main())
