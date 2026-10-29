#!/usr/bin/env python3
"""Re-point every retailer's price-group codes after a preorder price step (stdlib only).

Finds the wholesale codes (WS<rate>-<NAME>, -G2 .. -G4), recomputes the price
groups from the live Shopify prices (compare-at is retail) and, per retailer,
creates, updates or deactivates the slots so the final price stays <rate> off
retail. Customers come from the existing main code; nothing else is read.

Dry run by default: prints the planned writes. `--apply` writes, then runs the
comparison again and exits non-zero if anything still differs. Idempotent, safe
to run daily (operations/tools/jobs.json "wholesale-sync").
"""
import argparse, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wholesale_lib import (CODE_RE, GROUPS, apply_slot, gql, groups, live_variants, load_env,  # noqa: E402
                           plan_slot, read_code, slot_code)


def retailers(env):
    """{main code: rate percent} for every wholesale code in the store."""
    found, after = {}, None
    while True:
        d = gql(env, "query($a:String){codeDiscountNodes(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{codeDiscount{... on DiscountCodeBasic{codes(first:1){nodes{code}}}}}}}", {"a": after})["codeDiscountNodes"]
        for n in d["nodes"]:
            for c in (n["codeDiscount"] or {}).get("codes", {}).get("nodes", []):
                m = CODE_RE.match(c["code"])
                if m:
                    found[m.group(1)] = float(m.group(2))
        if not d["pageInfo"]["hasNextPage"]:
            return found
        after = d["pageInfo"]["endCursor"]


def run(env, apply_):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    variants = live_variants(env)
    diffs = 0
    for main, rate in sorted(retailers(env).items()):
        gs = groups(variants, rate)
        first = read_code(env, main)
        if not first or not first["customers"]:
            print(f"{main}: main code missing or without customer, skipped")
            continue
        for n in range(1, GROUPS + 1):
            code = slot_code(main, n)
            want = gs[n - 1] if n <= len(gs) else None
            existing = first if n == 1 else read_code(env, code)
            action = plan_slot(existing, want, first["customers"])
            if action == "none":
                continue
            diffs += 1
            detail = f"percentage={want['pct']} variants={','.join(v['sku'] for v in want['variants'])}" if want else ""
            print(f"{'APPLY' if apply_ else 'PLAN '} {code}: {action} {detail}")
            if apply_:
                apply_slot(env, action, existing, f"Wholesale {main} G{n}", code, want, first["customers"], now)
    return diffs


def main():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument("--apply", action="store_true", help="write to Shopify (default: dry run)")
    o = a.parse_args()
    env = load_env()
    print(f"mode: {'APPLY' if o.apply else 'DRY RUN (no writes)'}")
    diffs = run(env, o.apply)
    if not diffs:
        print("all wholesale codes match the live prices")
    if o.apply and diffs:
        left = run(env, False)
        print("read back OK" if not left else f"READ BACK MISMATCH: {left} slot(s) still differ")
        sys.exit(0 if not left else 1)


if __name__ == "__main__":
    main()
