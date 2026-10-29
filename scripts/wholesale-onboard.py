#!/usr/bin/env python3
"""Onboard one approved wholesale retailer in Shopify (stdlib only).

Checks the VAT number in VIES, finds or creates the Shopify customer, tags it
`wholesale`, sets the EU reverse charge tax exemption only when VIES says the
number is valid and the country is an EU member other than BE, and creates a
discount code WS<rate>-<NAME> for that customer only (default 25% off,
WHOLESALE_PERCENT).

Dry run by default: reads Shopify and VIES, prints the planned writes, writes
nothing. `--apply` writes, then reads everything back and checks it.

  python3 scripts/wholesale-onboard.py --email buyer@example.eu --country ES \
      --vat ESY1234567X --company "Example SL" [--slug EXAMPLE] [--percent 25]
  ... --apply

Reads SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN, SHOPIFY_ADMIN_API_VERSION
from .env (or the environment). Needs read/write_customers and
read/write_discounts. The token is never printed.
"""
import argparse, json, os, re, sys, urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path

EU = set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split())
WHOLESALE_PERCENT = 25.0  # standard wholesale rate off retail (founder 2026-10-29); the one place to change it
EXEMPTION = "EU_REVERSE_CHARGE_EXEMPTION_RULE"
VIES = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{cc}/vat/{num}"


def load_env():
    env = dict(os.environ)
    p = Path(__file__).resolve().parent.parent / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip("'\""))
    return env


def gql(env, query, variables=None):
    url = f"https://{env['SHOPIFY_STORE_DOMAIN']}/admin/api/{env.get('SHOPIFY_ADMIN_API_VERSION', '2026-01')}/graphql.json"
    req = urllib.request.Request(
        url, json.dumps({"query": query, "variables": variables or {}}).encode(),
        {"X-Shopify-Access-Token": env["SHOPIFY_ADMIN_API_TOKEN"], "Content-Type": "application/json"})
    out = json.loads(urllib.request.urlopen(req, timeout=30).read())
    if out.get("errors"):
        raise SystemExit(f"shopify error: {json.dumps(out['errors'])[:400]}")
    return out["data"]


def user_errors(payload):
    errs = payload.get("userErrors") or []
    if errs:
        raise SystemExit(f"shopify userErrors: {json.dumps(errs)}")


def vies_check(country, vat):
    """Return (valid, detail). Only a clear isValid=true counts as valid."""
    prefix = "EL" if country == "GR" else country
    num = re.sub(r"[\s.\-]", "", vat).upper()
    if num.startswith(prefix):
        num = num[len(prefix):]
    elif num.startswith(country):
        num = num[len(country):]
    try:
        raw = urllib.request.urlopen(urllib.request.Request(
            VIES.format(cc=prefix, num=num), headers={"Accept": "application/json"}), timeout=30).read()
        d = json.loads(raw)
    except (urllib.error.URLError, ValueError, TimeoutError) as e:
        return False, {"error": f"VIES unreachable: {e}"}
    return d.get("isValid") is True, {k: d.get(k) for k in ("isValid", "userError", "name", "address", "requestDate")} | {"queried": f"{prefix}{num}"}


def find_customer(env, email):
    d = gql(env, 'query($q:String!){customers(first:5,query:$q){nodes{id email tags taxExempt taxExemptions note defaultAddress{company}}}}',
            {"q": f'email:"{email}"'})
    for c in d["customers"]["nodes"]:
        if (c["email"] or "").lower() == email.lower():
            return c
    return None


def code_for(percent, slug, company, email):
    """The mailed pattern: WS<percent>-<NAME>, e.g. WS25-FPV24."""
    name = re.sub(r"[^A-Z0-9]", "", (slug or company or email.split("@")[0]).upper())[:16] or "RETAIL"
    pct = f"{percent:g}".replace(".", "")
    return f"WS{pct}-{name}"


def stacking(env, percent):
    """Live price vs compare-at (retail). The code applies to the live price."""
    d = gql(env, '{productVariants(first:100,query:"sku:OPEN*"){nodes{sku price compareAtPrice product{status}}}}')
    rows, over = [], []
    for v in d["productVariants"]["nodes"]:
        if v["product"]["status"] != "ACTIVE" or not v["compareAtPrice"]:
            continue
        price, retail = float(v["price"]), float(v["compareAtPrice"])
        final = price * (1 - percent / 100)
        off = 1 - final / retail
        rows.append((v["sku"], retail, price, final, off * 100))
        if off * 100 > percent + 0.5:
            over.append(v["sku"])
    return rows, over


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("--email", required=True)
    a.add_argument("--country", required=True, help="ISO 3166-1 alpha-2 of the company")
    a.add_argument("--vat", default="", help="VAT ID as given in the application")
    a.add_argument("--company", default="")
    a.add_argument("--percent", type=float, default=WHOLESALE_PERCENT,
                   help="rate off the live price (default %(default)g, WHOLESALE_PERCENT)")
    a.add_argument("--slug", default="", help="name part of the code, WS<percent>-<SLUG> (default: company)")
    a.add_argument("--code", default="", help="exact code, to recreate one already mailed (e.g. WS25-FPV24)")
    a.add_argument("--accept-stacking", action="store_true",
                   help="allow --apply although the code would stack on preorder prices")
    a.add_argument("--apply", action="store_true", help="write to Shopify (default: dry run)")
    o = a.parse_args()
    env = load_env()
    for k in ("SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_API_TOKEN"):
        if not env.get(k):
            raise SystemExit(f"missing {k}")
    email, cc = o.email.strip().lower(), o.country.strip().upper()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # 1. VIES and the exemption decision
    valid, vies = (False, None)
    if o.vat:
        if cc in EU:
            valid, vies = vies_check(cc, o.vat)
        else:
            vies = {"skipped": "non-EU country, VIES not applicable"}
    exempt = bool(valid and cc in EU and cc != "BE")
    why = ("VIES valid and EU country other than BE" if exempt else
           "BE: Belgian retailers pay 21% VAT" if cc == "BE" else
           "non-EU: export, no exemption needed" if cc not in EU else
           "no VAT number given" if not o.vat else "VIES did not confirm the number")

    # 2. Shopify state
    cust = find_customer(env, email)
    code = o.code.strip().upper() or code_for(o.percent, o.slug, o.company, email)
    existing = gql(env, 'query($c:String!){codeDiscountNodeByCode(code:$c){id}}', {"c": code})["codeDiscountNodeByCode"]
    rows, over = stacking(env, o.percent)

    tags = sorted(set((cust or {}).get("tags") or []) | {"wholesale"} | ({"reverse-charge"} if exempt else set()))
    exemptions = sorted(set((cust or {}).get("taxExemptions") or []) | ({EXEMPTION} if exempt else set()))
    note_line = f"{now[:10]} VAT {vies['queried']} VIES valid" if exempt else None
    cust_input = {"email": email, "tags": tags, **({"taxExemptions": exemptions} if exempt else {})}
    if note_line:
        cust_input["note"] = ((cust or {}).get("note") or "").strip() + ("\n" if (cust or {}).get("note") else "") + note_line
    if o.company and not cust:
        cust_input["note"] = (cust_input.get("note", "") + "\n" if cust_input.get("note") else "") + f"Wholesale: {o.company}"

    print(f"mode: {'APPLY' if o.apply else 'DRY RUN (no writes)'}")
    print(f"VIES: {json.dumps(vies)}")
    print(f"tax exemption: {'SET ' + EXEMPTION if exempt else 'NOT set'} ({why})")
    print(f"customer: {'found ' + cust['id'] if cust else 'will be created'} (current tags {(cust or {}).get('tags')}, exemptions {(cust or {}).get('taxExemptions')})")
    print(f"planned write 1: {'customerUpdate' if cust else 'customerCreate'} {json.dumps(cust_input)}")
    print(f"planned write 2: {'discount code ' + code + ' already exists (' + existing['id'] + '), skipped' if existing else 'discountCodeBasicCreate code=' + code + f' percentage={o.percent / 100} items=all customers=[this customer only] combinesWith=none appliesOncePerCustomer=false'}")
    print(f"\nstacking check, code on live price (retail = compare-at):")
    print(f"{'sku':20}{'retail':>8}{'live':>8}{'wholesale':>10}{'off retail':>11}")
    for sku, retail, price, final, off in sorted(rows):
        print(f"{sku:20}{retail:8.2f}{price:8.2f}{final:10.2f}{off:10.1f}%" + ("  OVER" if sku in over else ""))
    if over:
        print(f"\nWARNING: {len(over)} SKU(s) end below {100 - o.percent:.0f}% of retail because the preorder step stacks with the code.")

    if not o.apply:
        print("\ndry run: nothing written. Re-run with --apply after the founder's go.")
        return
    if over and not o.accept_stacking:
        raise SystemExit("refusing --apply: stacking on preorder prices (see table). Add --accept-stacking only on the founder's go.")

    # 3. Writes
    if cust:
        r = gql(env, 'mutation($i:CustomerInput!){customerUpdate(input:$i){customer{id} userErrors{field message}}}',
                {"i": {"id": cust["id"], **{k: v for k, v in cust_input.items() if k != "email"}}})["customerUpdate"]
    else:
        r = gql(env, 'mutation($i:CustomerInput!){customerCreate(input:$i){customer{id} userErrors{field message}}}',
                {"i": cust_input})["customerCreate"]
    user_errors(r)
    cid = r["customer"]["id"]
    if not existing:
        r = gql(env, 'mutation($i:DiscountCodeBasicInput!){discountCodeBasicCreate(basicCodeDiscount:$i){codeDiscountNode{id} userErrors{field message}}}', {"i": {
            "title": f"Wholesale {o.company or email}", "code": code, "startsAt": now, "appliesOncePerCustomer": False,
            "context": {"customers": {"add": [cid]}},
            "customerGets": {"value": {"percentage": o.percent / 100}, "items": {"all": True}},
            "combinesWith": {"productDiscounts": False, "orderDiscounts": False, "shippingDiscounts": True}}})["discountCodeBasicCreate"]
        user_errors(r)

    # 4. Read back
    c = find_customer(env, email)
    d = gql(env, 'query($c:String!){codeDiscountNodeByCode(code:$c){id codeDiscount{... on DiscountCodeBasic{status context{... on DiscountCustomers{customers{id}}} customerGets{value{... on DiscountPercentage{percentage}}}}}}}', {"c": code})["codeDiscountNodeByCode"]["codeDiscount"]
    ok = (c and "wholesale" in c["tags"] and (EXEMPTION in c["taxExemptions"]) == exempt
          and d["status"] == "ACTIVE" and [x["id"] for x in d["context"]["customers"]] == [c["id"]]
          and abs(d["customerGets"]["value"]["percentage"] - o.percent / 100) < 1e-9)
    print(f"\nread back: customer {c['id']} tags={c['tags']} exemptions={c['taxExemptions']}; code {code} {d['status']} "
          f"customers={[x['id'] for x in d['context']['customers']]} percentage={d['customerGets']['value']['percentage']}")
    print("read back OK" if ok else "READ BACK MISMATCH")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
