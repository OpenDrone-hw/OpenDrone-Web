"""Shared helpers of wholesale-onboard.py and wholesale-sync.py (stdlib only).

A retailer pays WHOLESALE_PERCENT off RETAIL (a variant's compare-at price),
whatever preorder price step the variant is on. Shopify takes a percentage off
the live price, so one code cannot do it: each retailer gets one customer-limited
code per price group, percentage = 1 - (1 - rate) * compare_at / price, scoped
to the variants of that group. Slot 1 is the code the retailer types
(WS25-FPV24); slots 2 to 4 are WS25-FPV24-G2 .. -G4 and the cart sends all of
them (app/lib/wholesale-codes.ts).
"""
import json, os, re, time, urllib.request
from pathlib import Path

WHOLESALE_PERCENT = 25.0  # standard wholesale rate off retail (founder 2026-10-29); the one place to change it
GROUPS = 4                # same number as WHOLESALE_GROUPS in app/lib/wholesale-codes.ts
DECIMALS = 4  # Shopify stores a discount percentage with 4 decimals (0.166667 reads back as 0.1667)
PCT_TOLERANCE = 5e-5
EXEMPTION = "EU_REVERSE_CHARGE_EXEMPTION_RULE"
EU = set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split())
# Standard VAT rate (percent) per EU member state, as of 29 Oct 2026. Source: the 2026 rate tables of
# https://www.eurofiscalis.com/en/vat-rates-in-ue/ and https://www.numeral.com/blog/eu-vat-rates (consistent for all 27
# states; HU 27, FI 25.5, EE 24, SK 23 and LU 17 confirmed by a search of five 2026 tables; RO 21 is the usual 2026 figure,
# older tables say 19: verify before the first Romanian retailer). Cross-checked against the VAT lines of this shop's
# own paid orders (DE 19, FI 25.5, FR 20, IE 23, IT 22, LT 21, NL 21, PL 23, PT 23, SE 25, SI 22, CZ 21, BG 20). The
# European Commission points to the Member States' TEDB database for the official figures.
EU_VAT = {"AT": 20, "BE": 21, "BG": 20, "HR": 25, "CY": 19, "CZ": 21, "DK": 25, "EE": 24, "FI": 25.5, "FR": 20,
          "DE": 19, "GR": 24, "HU": 27, "IE": 23, "IT": 22, "LV": 21, "LT": 21, "LU": 17, "MT": 18, "NL": 21,
          "PL": 23, "PT": 23, "RO": 21, "SK": 23, "SI": 22, "ES": 21, "SE": 25}
CODE_RE = re.compile(r"^(WS(\d{1,2})-[A-Z0-9]{2,16})(?:-G([2-4]))?$")


def load_env():
    env = dict(os.environ)
    p = Path(__file__).resolve().parent.parent / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip("'\""))
    for k in ("SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_API_TOKEN"):
        if not env.get(k):
            raise SystemExit(f"missing {k}")
    return env


def gql(env, query, variables=None):
    url = f"https://{env['SHOPIFY_STORE_DOMAIN']}/admin/api/{env.get('SHOPIFY_ADMIN_API_VERSION', '2026-01')}/graphql.json"
    req = urllib.request.Request(
        url, json.dumps({"query": query, "variables": variables or {}}).encode(),
        {"X-Shopify-Access-Token": env["SHOPIFY_ADMIN_API_TOKEN"], "Content-Type": "application/json"})
    for attempt in range(6):  # a throttled READ is retried; a mutation is never retried here
        out = json.loads(urllib.request.urlopen(req, timeout=60).read())
        throttled = any((e.get("extensions") or {}).get("code") == "THROTTLED" for e in out.get("errors") or [])
        if not throttled or query.lstrip().startswith("mutation") or attempt == 5:
            break
        time.sleep(2 + attempt * 2)
    if out.get("errors"):
        raise SystemExit(f"shopify error: {json.dumps(out['errors'])[:400]}")
    return out["data"]


def user_errors(payload):
    if payload.get("userErrors"):
        raise SystemExit(f"shopify userErrors: {json.dumps(payload['userErrors'])}")


def slot_code(main, slot):
    return main if slot == 1 else f"{main}-G{slot}"


def live_variants(env):
    """Active variants: id, sku, price, retail.

    Retail is the compare-at price while a preorder step is below it, else the price itself: at the retail step
    app/lib/shopify-price-tier.ts clears the compare-at (same rule as its `retail`), and such a variant still gets
    the wholesale rate."""
    d = gql(env, '{productVariants(first:100,query:"sku:OPEN*"){nodes{id sku price compareAtPrice product{status}}}}')
    out = []
    for v in d["productVariants"]["nodes"]:
        if v["product"]["status"] != "ACTIVE":
            continue
        price = float(v["price"])
        compare = float(v["compareAtPrice"]) if v["compareAtPrice"] else None
        out.append({"id": v["id"], "sku": v["sku"], "price": price, "retail": compare if compare and compare > price else price})
    return sorted(out, key=lambda v: v["sku"])


def divisor(country, exempt):
    """What the gross retail price is divided by for this customer: 1 for everyone except a reverse-charge customer.

    Shopify keeps a tax-inclusive price unchanged for a tax-exempt customer (no VAT line, same gross price; Shopify help,
    "Tax overrides and exemptions": the customer "will still be charged the full listed product price"). Reverse charge
    means the retailer pays NET prices and accounts for VAT at home, so the price base becomes retail / (1 + the standard
    VAT rate of the retailer's country). Non-EU retailers stay on the gross price (founder pricing choice)."""
    if not exempt:
        return 1.0
    if country not in EU_VAT:
        raise SystemExit(f"reverse charge for {country!r}: no standard VAT rate in EU_VAT")
    return 1 + EU_VAT[country] / 100


def customer_country(customer):
    """The EU country of a reverse-charge customer: tag country-XX, else the VAT ID on the onboarding note line."""
    for t in customer.get("tags") or []:
        if t.startswith("country-") and len(t) == 10:
            return t[-2:].upper()
    m = re.search(r"VAT ([A-Z]{2})[A-Z0-9]", customer.get("note") or "")
    return ("GR" if m.group(1) == "EL" else m.group(1)) if m else None


def customer_divisor(customer):
    exempt = EXEMPTION in (customer.get("taxExemptions") or [])
    return divisor(customer_country(customer), exempt) if exempt else 1.0


def tax_pricing_problem(env):
    """None when every market keeps a constant tax-inclusive price (the premise of divisor()), else the reason.
    With dynamic tax-inclusive pricing Shopify may strip VAT itself and the net price would be discounted twice."""
    d = gql(env, "{shop{taxesIncluded} markets(first:50){nodes{name priceInclusions{inclusiveTaxPricingStrategy}}}}")
    if not d["shop"]["taxesIncluded"]:
        return "shop prices exclude tax"
    for m in d["markets"]["nodes"]:
        strategy = (m.get("priceInclusions") or {}).get("inclusiveTaxPricingStrategy")
        if strategy not in (None, "INCLUDES_TAXES_IN_PRICE"):
            return f"market {m['name']} uses {strategy}"
    return None


def groups(variants, rate_percent, divisor_=1.0):
    """Price groups: list of {pct, variants}, largest group first (slot 1).

    pct = 1 - (1 - rate) * retail / divisor / price. A variant whose live price is at or
    under the wholesale price gets no code (it is already cheaper)."""
    target = (1 - rate_percent / 100) / divisor_
    by = {}
    for v in variants:
        pct = round(1 - target * v["retail"] / v["price"], DECIMALS)
        if pct > 0:
            by.setdefault(pct, []).append(v)
    out = [{"pct": p, "variants": vs} for p, vs in by.items()]
    out.sort(key=lambda g: (-len(g["variants"]), g["pct"]))
    if len(out) > GROUPS:
        raise SystemExit(f"{len(out)} price groups, at most {GROUPS} fit the cart's codes")
    return out


def rounding_check(group, rate_percent, max_qty=50, divisor_=1.0):
    """(worst per unit, worst per line) deviation in cents of the final price from
    rate x retail with the 4-decimal percentage, after Shopify rounds the
    discount of a line to cents (assumed: half up). Per unit is what a single
    unit costs more or less than 75% of retail; per line grows with quantity."""
    unit = line_worst = 0.0
    for v in group["variants"]:
        want_unit = v["retail"] * (1 - rate_percent / 100) / divisor_
        unit = max(unit, abs(v["price"] - round(v["price"] * group["pct"] + 1e-9, 2) - want_unit) * 100)
        for q in range(1, max_qty + 1):
            line = round(q * v["price"], 2)
            final = line - round(line * group["pct"] + 1e-9, 2)
            line_worst = max(line_worst, abs(final - q * want_unit) * 100)
    return unit, line_worst


def code_input(title, code, pct, variant_ids, customer_ids, starts_at):
    return {
        "title": title, "code": code, "startsAt": starts_at, "appliesOncePerCustomer": False,
        "context": {"customers": {"add": customer_ids}},
        "customerGets": {"value": {"percentage": pct},
                         "items": {"products": {"productVariantsToAdd": variant_ids}}},
        "combinesWith": {"productDiscounts": True, "orderDiscounts": False, "shippingDiscounts": True},
    }


CODE_FIELDS = """id codeDiscount{... on DiscountCodeBasic{title status startsAt endsAt codes(first:1){nodes{code}}
  context{... on DiscountCustomers{customers{id}}}
  customerGets{value{... on DiscountPercentage{percentage}} items{... on DiscountProducts{productVariants(first:100){nodes{id}}}}}}}"""


def read_code(env, code):
    n = gql(env, "query($c:String!){codeDiscountNodeByCode(code:$c){%s}}" % CODE_FIELDS, {"c": code})["codeDiscountNodeByCode"]
    if not n:
        return None
    d = n["codeDiscount"]
    return {
        "id": n["id"], "status": d["status"], "title": d["title"],
        "customers": sorted(c["id"] for c in (d.get("context") or {}).get("customers", [])),
        "pct": ((d.get("customerGets") or {}).get("value") or {}).get("percentage"),
        "variants": sorted(x["id"] for x in ((d.get("customerGets") or {}).get("items") or {}).get("productVariants", {}).get("nodes", [])),
    }


def plan_slot(existing, want, customer_ids):
    """Compare an existing slot code with the wanted group; return the action."""
    if want is None:
        return "deactivate" if existing and existing["status"] == "ACTIVE" else "none"
    if existing is None:
        return "create"
    same = (existing["status"] == "ACTIVE" and existing["customers"] == sorted(customer_ids)
            and existing["variants"] == sorted(v["id"] for v in want["variants"])
            and existing["pct"] is not None and abs(existing["pct"] - want["pct"]) < PCT_TOLERANCE)
    return "none" if same else "update"


def apply_slot(env, action, existing, title, code, want, customer_ids, starts_at):
    ids = sorted(v["id"] for v in want["variants"]) if want else []
    if action == "create":
        r = gql(env, "mutation($i:DiscountCodeBasicInput!){discountCodeBasicCreate(basicCodeDiscount:$i){codeDiscountNode{id} userErrors{field message}}}",
                {"i": code_input(title, code, want["pct"], ids, customer_ids, starts_at)})["discountCodeBasicCreate"]
        user_errors(r)
    elif action == "update":
        inp = code_input(title, code, want["pct"], ids, customer_ids, starts_at)
        inp.pop("code")  # the code itself does not change
        inp["customerGets"]["items"]["products"]["productVariantsToRemove"] = [v for v in existing["variants"] if v not in ids]
        inp["context"] = {"customers": {"add": [c for c in customer_ids if c not in existing["customers"]],
                                       "remove": [c for c in existing["customers"] if c not in customer_ids]}}
        r = gql(env, "mutation($id:ID!,$i:DiscountCodeBasicInput!){discountCodeBasicUpdate(id:$id,basicCodeDiscount:$i){codeDiscountNode{id} userErrors{field message}}}",
                {"id": existing["id"], "i": inp})["discountCodeBasicUpdate"]
        user_errors(r)
        if existing["status"] != "ACTIVE":
            r = gql(env, "mutation($id:ID!){discountCodeActivate(id:$id){userErrors{field message}}}", {"id": existing["id"]})["discountCodeActivate"]
            user_errors(r)
    elif action == "deactivate":
        r = gql(env, "mutation($id:ID!){discountCodeDeactivate(id:$id){userErrors{field message}}}", {"id": existing["id"]})["discountCodeDeactivate"]
        user_errors(r)
