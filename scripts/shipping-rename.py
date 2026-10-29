#!/usr/bin/env python3
"""Rename the international shipping rates to "Standard shipping (bpost)" (stdlib only).

The non-EU zones ("International preorder allowance N") name every weight-band
rate "Preorder: ships by 31 Mar 2027, delivery by 30 Apr 2027". Batch-1 FC and
ESC stock now serves those zones too (content/preorders.json regions), so the
rate must not carry a date: the date lives on the line properties and the order,
as it does for the EU zones. Only the NAME changes; price and weight conditions
are untouched. The US zone is not touched. No code reads rate names (checked:
app/lib/international-shipping.ts reads price and weight only), so the order
relative to the storefront deploy does not matter.

Dry run by default: lists the renames. `--apply` renames zone by zone, then reads
every rate back (name changed, price and conditions identical) and exits non-zero
on a difference. Run again after a partial failure: renamed rates are skipped.
"""
import argparse, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wholesale_lib import gql, load_env, user_errors  # noqa: E402

NEW = "Standard shipping (bpost)"
ZONE_PREFIX = "International preorder allowance"
Q = """{ deliveryProfiles(first:10){nodes{id name default profileLocationGroups{locationGroup{id}
  locationGroupZones(first:100){nodes{zone{id name}
  methodDefinitions(first:12){nodes{id name active rateProvider{... on DeliveryRateDefinition{price{amount currencyCode}}}
  methodConditions{field operator conditionCriteria{... on Weight{value unit}}}}}}}}}}}"""


def read(env):
    d = gql(env, Q)["deliveryProfiles"]["nodes"]
    prof = next(p for p in d if p["default"])
    group = prof["profileLocationGroups"][0]
    zones = [z for z in group["locationGroupZones"]["nodes"] if z["zone"]["name"].startswith(ZONE_PREFIX)]
    return prof["id"], group["locationGroup"]["id"], zones


def fingerprint(m):
    return json.dumps([m["rateProvider"], m["methodConditions"], m["active"]], sort_keys=True)


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("--apply", action="store_true", help="write to Shopify (default: dry run)")
    o = a.parse_args()
    env = load_env()
    pid, gid, zones = read(env)
    before = {m["id"]: fingerprint(m) for z in zones for m in z["methodDefinitions"]["nodes"]}
    todo = {z["zone"]["id"]: [m for m in z["methodDefinitions"]["nodes"] if m["name"] != NEW] for z in zones}
    total = sum(len(v) for v in todo.values())
    print(f"mode: {'APPLY' if o.apply else 'DRY RUN (no writes)'}; {len(zones)} international zones, {total} rates to rename to {NEW!r}")
    for z in zones:
        ms = todo[z["zone"]["id"]]
        if ms:
            print(f"  {z['zone']['name']}: {len(ms)} rate(s) {sorted({m['name'] for m in ms})}")
    if not o.apply or not total:
        print("dry run: nothing written." if not o.apply else "nothing to rename.")
        return
    for z in zones:
        ms = todo[z["zone"]["id"]]
        if not ms:
            continue
        r = gql(env, "mutation($id:ID!,$p:DeliveryProfileInput!){deliveryProfileUpdate(id:$id,profile:$p){userErrors{field message}}}", {
            "id": pid, "p": {"locationGroupsToUpdate": [{"id": gid, "zonesToUpdate": [{
                "id": z["zone"]["id"], "methodDefinitionsToUpdate": [{"id": m["id"], "name": NEW} for m in ms]}]}]}})["deliveryProfileUpdate"]
        user_errors(r)
        print(f"renamed {len(ms)} in {z['zone']['name']}")
    _, _, after = read(env)
    bad = 0
    for z in after:
        for m in z["methodDefinitions"]["nodes"]:
            if m["name"] != NEW or fingerprint(m) != before.get(m["id"]):
                bad += 1
                print(f"MISMATCH {z['zone']['name']} {m['id']} name={m['name']!r}")
    print("read back OK" if not bad else f"READ BACK MISMATCH: {bad}")
    sys.exit(0 if not bad else 1)


if __name__ == "__main__":
    main()
