#!/usr/bin/env python3
"""Verify a wholesale code end to end on a throwaway Storefront cart (stdlib only).

  python3 scripts/wholesale-check.py WS25-LOCAL99 [--percent 25]

Builds an anonymous Storefront cart with one of every live variant that has a
retail (compare-at) price, applies the main code and its companions
(WS25-X, -G2, -G3, -G4, as the storefront cart does), and asserts that every
line costs 75% of retail to the cent. A cart is not store data and is never
checked out. Exit 1 on any difference. Customer eligibility is enforced only
at checkout, so this does not prove the customer limit.
Reads SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_TOKEN, SHOPIFY_STOREFRONT_API_VERSION (+ the Admin token for prices).
"""
import argparse, json, sys, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wholesale_lib import GROUPS, WHOLESALE_PERCENT, live_variants, load_env, slot_code  # noqa: E402

CART = """mutation($lines:[CartLineInput!]!,$codes:[String!]){cartCreate(input:{lines:$lines,discountCodes:$codes}){
  cart{discountCodes{code applicable} lines(first:100){nodes{quantity merchandise{... on ProductVariant{sku}} cost{totalAmount{amount}}}}}
  userErrors{message}}}"""


def check(env, code, percent=WHOLESALE_PERCENT):
    """Return a list of problem strings (empty when every line is 75% of retail)."""
    variants = live_variants(env)
    ids = {v["sku"]: v for v in variants}
    url = f"https://{env['SHOPIFY_STORE_DOMAIN']}/api/{env.get('SHOPIFY_STOREFRONT_API_VERSION', '2026-07')}/graphql.json"
    req = urllib.request.Request(url, json.dumps({"query": CART, "variables": {
        "lines": [{"merchandiseId": v["id"], "quantity": 1} for v in variants],
        "codes": [slot_code(code, n) for n in range(1, GROUPS + 1)]}}).encode(),
        {"X-Shopify-Storefront-Access-Token": env["SHOPIFY_STOREFRONT_TOKEN"], "Content-Type": "application/json"})
    out = json.loads(urllib.request.urlopen(req, timeout=60).read())
    if out.get("errors") or out["data"]["cartCreate"]["userErrors"]:
        return [f"cart error: {json.dumps(out.get('errors') or out['data']['cartCreate']['userErrors'])[:300]}"]
    cart = out["data"]["cartCreate"]["cart"]
    problems = []
    if not any(c["code"].upper() == code.upper() and c["applicable"] for c in cart["discountCodes"]):
        problems.append(f"main code {code} not applicable")
    for line in cart["lines"]["nodes"]:
        sku = line["merchandise"]["sku"]
        v = ids.get(sku)
        paid = float(line["cost"]["totalAmount"]["amount"])
        want = round(v["retail"] * (1 - percent / 100), 2)
        if v and v["price"] <= want:
            want = v["price"]  # already cheaper than wholesale: no code applies
        if abs(paid - want) > 0.0101:
            problems.append(f"{sku}: pays {paid:.2f}, want {want:.2f}")
    return problems


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("code")
    a.add_argument("--percent", type=float, default=WHOLESALE_PERCENT)
    o = a.parse_args()
    problems = check(load_env(), o.code.upper(), o.percent)
    for p in problems:
        print("PROBLEM", p)
    print("wholesale-check OK" if not problems else f"wholesale-check FAILED: {len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
