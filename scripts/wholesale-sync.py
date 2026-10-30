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
import argparse, importlib.util, json, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wholesale_lib import (CODE_RE, GROUPS, apply_slot, customer_divisor, gql, groups, live_variants, load_env,  # noqa: E402
                           plan_slot, read_code, slot_code, tax_pricing_problem)


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


def all_codes(env):
    """{code: {main, slot, id, customers, status}} for every wholesale code."""
    found, after = {}, None
    while True:
        d = gql(env, "query($a:String){codeDiscountNodes(first:50,after:$a){pageInfo{hasNextPage endCursor} nodes{id codeDiscount{... on DiscountCodeBasic{status codes(first:1){nodes{code}} context{... on DiscountCustomers{customers{id}}}}}}}}", {"a": after})["codeDiscountNodes"]
        for n in d["nodes"]:
            cd = n["codeDiscount"] or {}
            for c in cd.get("codes", {}).get("nodes", []):
                m = CODE_RE.match(c["code"])
                if m:
                    found[c["code"]] = {"main": m.group(1), "slot": int(m.group(3) or 1), "id": n["id"],
                                        "status": cd.get("status"), "customers": [x["id"] for x in (cd.get("context") or {}).get("customers", [])]}
        if not d["pageInfo"]["hasNextPage"]:
            return found
        after = d["pageInfo"]["endCursor"]


def tagged_customers(env):
    out, after = {}, None
    while True:
        d = gql(env, 'query($a:String){customers(first:100,after:$a,query:"tag:wholesale"){pageInfo{hasNextPage endCursor} nodes{id tags}}}', {"a": after})["customers"]
        for c in d["nodes"]:
            out[c["id"]] = c["tags"]
        if not d["pageInfo"]["hasNextPage"]:
            return out
        after = d["pageInfo"]["endCursor"]


def health(env):
    """Problems as [{kind, ref, detail}]; ids and codes only, never an email."""
    problems = []
    codes = all_codes(env)
    mains = {c["main"] for c in codes.values()}
    owners = {}
    for code, c in codes.items():
        if c["slot"] > 1 and c["main"] not in codes:
            problems.append({"kind": "orphan-code", "ref": code, "detail": "group code without its main code"})
        if c["status"] == "ACTIVE" and not c["customers"]:
            problems.append({"kind": "orphan-code", "ref": code, "detail": "active code limited to no customer"})
        for cid in c["customers"]:
            owners.setdefault(cid, set()).add(c["main"])
    tagged = tagged_customers(env)
    for cid in tagged:
        if cid not in owners:
            problems.append({"kind": "customer-without-code", "ref": cid, "detail": "tagged wholesale but no wholesale code is limited to it"})
    for cid in owners:
        if cid not in tagged:
            problems.append({"kind": "code-without-tag", "ref": cid, "detail": "has wholesale codes but no wholesale tag"})
    drift = run(env, False)
    if drift:
        problems.append({"kind": "price-drift", "ref": "wholesale-sync", "detail": f"{drift} slot(s) differ from the live price groups; run wholesale-sync.py --apply"})
    chk = importlib.util.spec_from_file_location("wholesale_check", Path(__file__).resolve().parent / "wholesale-check.py")
    mod = importlib.util.module_from_spec(chk)
    chk.loader.exec_module(mod)
    tax = tax_pricing_problem(env)
    if tax:
        problems.append({"kind": "tax-pricing", "ref": "shop", "detail": f"{tax}: reverse-charge net prices assume constant tax-inclusive prices"})
    for main in sorted(mains):
        owner = codes[main]["customers"][0] if main in codes and codes[main]["customers"] else None
        div = divisor_of(env, owner) if owner else 1.0
        if env.get("SHOPIFY_STOREFRONT_TOKEN"):
            for p in mod.check(env, main, float(CODE_RE.match(main).group(2)), div):
                problems.append({"kind": "cart-check", "ref": main, "detail": p})
        else:
            problems.append({"kind": "cart-check", "ref": main, "detail": "SHOPIFY_STOREFRONT_TOKEN missing, cart not checked"})
    return problems


def divisor_of(env, customer_id):
    """The price-base divisor of a retailer (VAT of a reverse-charge customer's country, else 1)."""
    c = gql(env, "query($id:ID!){customer(id:$id){tags taxExemptions note}}", {"id": customer_id})["customer"]
    return customer_divisor(c or {})


def run(env, apply_):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    variants = live_variants(env)
    diffs = 0
    for main, rate in sorted(retailers(env).items()):
        first = read_code(env, main)
        if not first or not first["customers"]:
            print(f"{main}: main code missing or without customer, skipped")
            continue
        div = divisor_of(env, first["customers"][0])
        gs = groups(variants, rate, div)
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
    a.add_argument("--health", action="store_true",
                   help="read only: every wholesale customer has codes, codes match the price groups, no orphan codes, carts price at 75%% of retail; prints HEALTH <json>, exit 1 on a problem")
    o = a.parse_args()
    env = load_env()
    if o.health:
        problems = health(env)
        print("HEALTH " + json.dumps(problems, sort_keys=True))
        print(f"wholesale health: {len(problems)} problem(s)")
        sys.exit(1 if problems else 0)
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
