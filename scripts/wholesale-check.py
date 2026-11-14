#!/usr/bin/env python3
"""Verify a wholesale code end to end on a throwaway Storefront cart (stdlib only).

  python3 scripts/wholesale-check.py WS25-LOCAL99 [--percent 25]

Builds an anonymous Storefront cart with one of every live variant, both lanes
of a board (Buy now and Pre-order share a SKU, so lines are matched by variant id), applies the main code and its companions
(WS25-X, -G2, -G3, -G4) with the site's own cartDiscountCodesUpdate mutation,
read from app/lib/shopify-storefront.ts (so a mutation Shopify rejects fails here too), and asserts that every
line costs 75% of retail to the cent (--net-country ES: 75% of retail net of 21% Spanish VAT, for a reverse-charge retailer). A cart is not store data and is never
checked out. Exit 1 on any difference. Customer eligibility is enforced only
at checkout, so this does not prove the customer limit.
Reads SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_TOKEN, SHOPIFY_STOREFRONT_API_VERSION (+ the Admin token for prices).
"""
import argparse, json, re, sys, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wholesale_lib import GROUPS, WHOLESALE_PERCENT, divisor, label, live_variants, load_env, slot_code  # noqa: E402

CART = """mutation($lines:[CartLineInput!]!){cartCreate(input:{lines:$lines}){cart{id} userErrors{message}}}"""
READ = """query($id:ID!){cart(id:$id){discountCodes{code applicable}
  lines(first:100){nodes{quantity merchandise{... on ProductVariant{id sku}} cost{totalAmount{amount}}}}}}"""
SITE = Path(__file__).resolve().parent.parent / "app/lib/shopify-storefront.ts"


def site_mutation():
    """The storefront's cartDiscountCodesUpdate document, as the cart sends it."""
    m = re.search(r"CART_DISCOUNT_CODES_UPDATE_MUTATION = `#graphql(.*?)`;", SITE.read_text(), re.S)
    if not m:
        raise SystemExit(f"CART_DISCOUNT_CODES_UPDATE_MUTATION not found in {SITE}")
    return m.group(1)


def check(env, code, percent=WHOLESALE_PERCENT, divisor_=1.0):
    """Return a list of problem strings (empty when every line is 75% of retail; of NET retail for a reverse-charge customer)."""
    variants = live_variants(env)
    ids = {v["id"]: v for v in variants}  # by variant id: Buy now and Pre-order share a SKU
    url = f"https://{env['SHOPIFY_STORE_DOMAIN']}/api/{env.get('SHOPIFY_STOREFRONT_API_VERSION', '2026-07')}/graphql.json"

    def sf(query, variables):
        req = urllib.request.Request(url, json.dumps({"query": query, "variables": variables}).encode(),
            {"X-Shopify-Storefront-Access-Token": env["SHOPIFY_STOREFRONT_TOKEN"], "Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=60).read())

    out = sf(CART, {"lines": [{"merchandiseId": v["id"], "quantity": 1} for v in variants]})
    if out.get("errors") or out["data"]["cartCreate"]["userErrors"]:
        return [f"cart error: {json.dumps(out.get('errors') or out['data']['cartCreate']['userErrors'])[:300]}"]
    cart_id = out["data"]["cartCreate"]["cart"]["id"]
    out = sf(site_mutation(), {"cartId": cart_id, "discountCodes": [slot_code(code, n) for n in range(1, GROUPS + 1)]})
    if out.get("errors") or out["data"]["cartDiscountCodesUpdate"]["userErrors"]:
        return [f"site code mutation rejected: {json.dumps(out.get('errors') or out['data']['cartDiscountCodesUpdate']['userErrors'])[:300]}"]
    cart = sf(READ, {"id": cart_id})["data"]["cart"]
    problems = []
    if not any(c["code"].upper() == code.upper() and c["applicable"] for c in cart["discountCodes"]):
        problems.append(f"main code {code} not applicable")
    for line in cart["lines"]["nodes"]:
        v = ids.get(line["merchandise"]["id"])
        if not v:
            problems.append(f"{line['merchandise']['sku']}: cart line for a variant not in the live list")
            continue
        paid = float(line["cost"]["totalAmount"]["amount"])
        want = round(v["retail"] * (1 - percent / 100) / divisor_, 2)
        if v["price"] <= want:
            want = v["price"]  # already cheaper than wholesale: no code applies
        if abs(paid - want) > 0.0101:
            problems.append(f"{label(v)}: pays {paid:.2f}, want {want:.2f}")
    return problems


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("code")
    a.add_argument("--percent", type=float, default=WHOLESALE_PERCENT)
    a.add_argument("--net-country", default="", help="reverse-charge retailer's EU country: expect 75%% of retail net of its VAT")
    o = a.parse_args()
    problems = check(load_env(), o.code.upper(), o.percent, divisor(o.net_country.upper(), True) if o.net_country else 1.0)
    for p in problems:
        print("PROBLEM", p)
    print("wholesale-check OK" if not problems else f"wholesale-check FAILED: {len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
