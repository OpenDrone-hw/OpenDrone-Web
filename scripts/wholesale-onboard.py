#!/usr/bin/env python3
"""Onboard one approved wholesale retailer in Shopify (stdlib only).

Checks the VAT number in VIES, finds or creates the Shopify customer by email,
tags it `wholesale`, sets the EU reverse charge tax exemption only when VIES says
the number is valid and the country is an EU member other than BE, and creates
the retailer's personal codes: WS<rate>-<NAME> plus one companion per extra
price group (see wholesale_lib.py), each limited to this customer.

Dry run by default: reads Shopify and VIES, prints the planned writes, writes
nothing. `--apply` writes, then reads everything back and checks it.

  python3 scripts/wholesale-onboard.py --email buyer@example.eu --country ES \
      --vat ESY1234567X --company "Example SL" [--slug EXAMPLE] [--percent 25]
  ... --apply

Reads SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN, SHOPIFY_ADMIN_API_VERSION
from .env (or the environment). Needs read/write_customers and
read/write_discounts. The token is never printed. After a price step changes,
`wholesale-sync.py` re-points the groups.
"""
import argparse, json, re, sys, urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wholesale_lib import (EU, EXEMPTION, GROUPS, WHOLESALE_PERCENT, apply_slot, gql, groups,  # noqa: E402
                           live_variants, load_env, plan_slot, read_code, rounding_check, slot_code, user_errors)

VIES = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{cc}/vat/{num}"


def vies_check(country, vat):
    """Return (valid, detail). Only a clear isValid=true counts as valid."""
    prefix = "EL" if country == "GR" else country
    num = re.sub(r"[\s.\-]", "", vat).upper()
    for p in (prefix, country):
        if num.startswith(p):
            num = num[len(p):]
            break
    try:
        d = json.loads(urllib.request.urlopen(urllib.request.Request(
            VIES.format(cc=prefix, num=num), headers={"Accept": "application/json"}), timeout=30).read())
    except (urllib.error.URLError, ValueError, TimeoutError) as e:
        return False, {"error": f"VIES unreachable: {e}"}
    return d.get("isValid") is True, {k: d.get(k) for k in ("isValid", "userError", "name", "address", "requestDate")} | {"queried": f"{prefix}{num}"}


def find_customer(env, email):
    d = gql(env, 'query($q:String!){customers(first:5,query:$q){nodes{id email tags taxExempt taxExemptions note}}}',
            {"q": f'email:"{email}"'})
    for c in d["customers"]["nodes"]:
        if (c["email"] or "").lower() == email.lower():
            return c
    return None


def main_code(percent, slug, company, email):
    """The mailed pattern: WS<percent>-<NAME>, e.g. WS25-FPV24."""
    name = re.sub(r"[^A-Z0-9]", "", (slug or company or email.split("@")[0]).upper())[:16] or "RETAIL"
    return f"WS{percent:g}".replace(".", "") + f"-{name}"


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("--email", required=True)
    a.add_argument("--country", required=True, help="ISO 3166-1 alpha-2 of the company")
    a.add_argument("--vat", default="", help="VAT ID as given in the application")
    a.add_argument("--company", default="")
    a.add_argument("--percent", type=float, default=WHOLESALE_PERCENT,
                   help="rate off retail (default %(default)g, WHOLESALE_PERCENT)")
    a.add_argument("--slug", default="", help="name part of the code, WS<percent>-<SLUG> (default: company)")
    a.add_argument("--code", default="", help="exact main code, to recreate one already mailed (e.g. WS25-FPV24)")
    a.add_argument("--apply", action="store_true", help="write to Shopify (default: dry run)")
    o = a.parse_args()
    env = load_env()
    email, cc = o.email.strip().lower(), o.country.strip().upper()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    valid, vies = (False, None)
    if o.vat:
        valid, vies = vies_check(cc, o.vat) if cc in EU else (False, {"skipped": "non-EU country, VIES not applicable"})
    exempt = bool(valid and cc in EU and cc != "BE")
    why = ("VIES valid and EU country other than BE" if exempt else
           "BE: Belgian retailers pay 21% VAT" if cc == "BE" else
           "non-EU: export, no exemption needed" if cc not in EU else
           "no VAT number given" if not o.vat else "VIES did not confirm the number")

    cust = find_customer(env, email)
    tags = sorted(set((cust or {}).get("tags") or []) | {"wholesale"} | ({"reverse-charge"} if exempt else set()))
    exemptions = sorted(set((cust or {}).get("taxExemptions") or []) | ({EXEMPTION} if exempt else set()))
    cust_input = {"email": email, "tags": tags, **({"taxExemptions": exemptions} if exempt else {})}
    old_note = ((cust or {}).get("note") or "").strip()
    lines = [old_note] if old_note else []
    if exempt:
        lines.append(f"{now[:10]} VAT {vies['queried']} VIES valid")
    if o.company and not cust:
        lines.append(f"Wholesale: {o.company}")
    if lines != ([old_note] if old_note else []):
        cust_input["note"] = "\n".join(lines)

    main = o.code.strip().upper() or main_code(o.percent, o.slug, o.company, email)
    gs = groups(live_variants(env), o.percent)
    cids = [cust["id"]] if cust else ["<new customer id>"]
    slots = []
    for n in range(1, GROUPS + 1):
        code = slot_code(main, n)
        want = gs[n - 1] if n <= len(gs) else None
        existing = read_code(env, code)
        slots.append((n, code, want, existing, plan_slot(existing, want, cids) if cust else ("create" if want else "none")))

    print(f"mode: {'APPLY' if o.apply else 'DRY RUN (no writes)'}")
    print(f"VIES: {json.dumps(vies)}")
    print(f"tax exemption: {'SET ' + EXEMPTION if exempt else 'NOT set'} ({why})")
    print(f"customer: {'found ' + cust['id'] if cust else 'will be created'} (tags {(cust or {}).get('tags')}, exemptions {(cust or {}).get('taxExemptions')})")
    print(f"planned write 1: {'customerUpdate' if cust else 'customerCreate'} {json.dumps(cust_input)}")
    print(f"planned writes 2..: {o.percent:g}% off retail, {len(gs)} price group(s)")
    for n, code, want, existing, action in slots:
        if want:
            skus = ",".join(v["sku"] for v in want["variants"])
            print(f"  slot {n} {code}: {action} percentage={want['pct']} (rounding worst {rounding_check(want, o.percent):.1f} cent) variants={skus}")
        else:
            print(f"  slot {n} {code}: {action} (no group)")
    if not o.apply:
        print("\ndry run: nothing written. Re-run with --apply after the founder's go.")
        return

    if cust:
        r = gql(env, 'mutation($i:CustomerInput!){customerUpdate(input:$i){customer{id} userErrors{field message}}}',
                {"i": {"id": cust["id"], **{k: v for k, v in cust_input.items() if k != "email"}}})["customerUpdate"]
    else:
        r = gql(env, 'mutation($i:CustomerInput!){customerCreate(input:$i){customer{id} userErrors{field message}}}',
                {"i": cust_input})["customerCreate"]
    user_errors(r)
    cid = r["customer"]["id"]
    for n, code, want, existing, _ in slots:
        action = plan_slot(existing, want, [cid])
        apply_slot(env, action, existing, f"Wholesale {o.company or email} G{n}", code, want, [cid], now)

    c = find_customer(env, email)
    ok = bool(c and "wholesale" in c["tags"] and (EXEMPTION in c["taxExemptions"]) == exempt)
    for n, code, want, _, _ in slots:
        got = read_code(env, code)
        good = (plan_slot(got, want, [c["id"]]) == "none") if got or want else True
        print(f"read back slot {n} {code}: {'OK' if good else 'MISMATCH'}")
        ok = ok and good
    print(f"read back customer {c['id']} tags={c['tags']} exemptions={c['taxExemptions']}")
    print("read back OK" if ok else "READ BACK MISMATCH")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
