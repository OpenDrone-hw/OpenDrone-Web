#!/usr/bin/env python3
"""Retailer orders that need a sales invoice in Kyte, and what to type there (stdlib only).

Every paid order of a customer tagged `wholesale` gets one sales invoice in the
company's name (docs/wholesale.md, Invoice). Consumers get none. Kyte has no API,
so the invoice is made by hand; this script removes the guesswork:

  python3 scripts/wholesale-invoice.py                 # paid retailer orders without the tag `invoiced`
  python3 scripts/wholesale-invoice.py 1507            # the invoice fields for order #1507
  python3 scripts/wholesale-invoice.py 1507 --done 20260005 [--apply]
                                                       # tag the order `invoiced`, note the Kyte number

Amounts come from the order itself (after discounts, VAT as charged at checkout),
so the invoice total equals what the retailer paid. --done is a dry run without
--apply. Reads SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_API_TOKEN from .env
(needs read_orders, read_customers, write_orders). The token is never printed.
"""
import argparse, re, sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wholesale_lib import EU, EXEMPTION, gql, load_env  # noqa: E402

DONE_TAG = "invoiced"
CENT = Decimal("0.01")
MONEY = "shopMoney{amount}"
ORDER_FIELDS = f"""id name createdAt processedAt displayFinancialStatus cancelledAt tags note taxesIncluded
  discountCodes currencyCode
  customer{{id email tags taxExemptions note
    vat: metafield(namespace:"wholesale", key:"vat_number"){{value}}
    company: metafield(namespace:"wholesale", key:"company"){{value}}}}
  billingAddress{{company name address1 address2 zip city countryCodeV2}}
  shippingAddress{{company name address1 address2 zip city countryCodeV2}}
  lineItems(first:100){{nodes{{sku name quantity currentQuantity discountedUnitPriceAfterAllDiscountsSet{{{MONEY}}}
    taxLines{{rate priceSet{{{MONEY}}}}}}}}}
  shippingLines(first:10){{nodes{{title discountedPriceSet{{{MONEY}}} taxLines{{rate priceSet{{{MONEY}}}}}}}}}
  currentTotalPriceSet{{{MONEY}}} totalRefundedSet{{{MONEY}}}"""

# What the invoice says about VAT, per case (docs/wholesale.md, VAT per case and Invoice)
TEXT_REVERSE = ("Intracommunautaire levering van goederen, vrijgesteld van btw (art. 39bis, 1e lid, 1 WBTW; "
                "art. 138 Richtlijn 2006/112/EG). Btw verlegd: de afnemer voldoet de btw.")
TEXT_EXPORT = "Uitvoer buiten de EU, vrijgesteld van btw (art. 39, par. 1 WBTW)."


def money(node):
    return Decimal(node["shopMoney"]["amount"])


def vat_number(customer):
    if (customer.get("vat") or {}).get("value"):
        return customer["vat"]["value"]
    m = re.findall(r"VAT ([A-Z]{2}[0-9A-Z]+) VIES valid", customer.get("note") or "")
    return m[-1] if m else None


def company_name(order):
    c = order["customer"] or {}
    if (c.get("company") or {}).get("value"):
        return c["company"]["value"]
    b = order["billingAddress"] or {}
    if b.get("company"):
        return b["company"]
    m = re.findall(r"Wholesale: (.+)", c.get("note") or "")
    return m[-1].strip() if m else None


def retailer_orders(env):
    out, after = [], None
    while True:
        d = gql(env, """query($a:String){customers(first:50, after:$a, query:"tag:wholesale"){pageInfo{hasNextPage endCursor}
          nodes{orders(first:100, sortKey:CREATED_AT){nodes{name processedAt displayFinancialStatus cancelledAt tags
          currentTotalPriceSet{shopMoney{amount currencyCode}}}} email}}}""", {"a": after})["customers"]
        for c in d["nodes"]:
            for o in c["orders"]["nodes"]:
                out.append((o, c["email"]))
        if not d["pageInfo"]["hasNextPage"]:
            return out
        after = d["pageInfo"]["endCursor"]


def find_order(env, number):
    name = "#" + str(number).lstrip("#")
    nodes = gql(env, f'query($q:String){{orders(first:5, query:$q){{nodes{{{ORDER_FIELDS}}}}}}}', {"q": f"name:{name}"})["orders"]["nodes"]
    nodes = [o for o in nodes if o["name"] == name]
    if not nodes:
        raise SystemExit(f"order {name} not found")
    return nodes[0]


def lines_of(order):
    """(description, qty, net unit, net total, vat rate %, vat amount) per line, then shipping."""
    incl = order["taxesIncluded"]
    rows = []
    for li in order["lineItems"]["nodes"]:
        qty = li["currentQuantity"]  # after order edits and removals
        if not qty:
            continue
        gross = money(li["discountedUnitPriceAfterAllDiscountsSet"]) * qty
        tax = (sum((money(t["priceSet"]) for t in li["taxLines"]), Decimal(0)) * qty / li["quantity"]).quantize(CENT, ROUND_HALF_UP)
        rate = sum((Decimal(str(t["rate"])) for t in li["taxLines"]), Decimal(0)) * 100
        net = gross - tax if incl else gross
        rows.append((f'{li["name"]} ({li["sku"]})', qty, (net / qty).quantize(Decimal("0.0001")), net, rate, tax))
    for s in order["shippingLines"]["nodes"]:
        gross = money(s["discountedPriceSet"])
        tax = sum((money(t["priceSet"]) for t in s["taxLines"]), Decimal(0))
        rate = sum((Decimal(str(t["rate"])) for t in s["taxLines"]), Decimal(0)) * 100
        net = gross - tax if incl else gross
        if gross:
            rows.append((f'Verzending: {s["title"]}', 1, net, net, rate, tax))
    return rows


def show(order):
    c = order["customer"] or {}
    if "wholesale" not in (c.get("tags") or []):
        print(f"warning: {order['name']} is not from a customer tagged wholesale")
    b = order["billingAddress"] or order["shippingAddress"] or {}
    country = (b.get("countryCodeV2") or "").upper()
    exempt = EXEMPTION in (c.get("taxExemptions") or [])
    vat = vat_number(c)
    case = ("reverse charge (EU, VIES valid)" if exempt else "Belgium, 21% VAT" if country == "BE" else
            "export (outside the EU)" if country and country not in EU else "EU without a valid VAT number: VAT as charged")
    rows = lines_of(order)
    net = sum((r[3] for r in rows), Decimal(0))
    tax = sum((r[5] for r in rows), Decimal(0))
    total = money(order["currentTotalPriceSet"])

    print(f"Order {order['name']}  status {order['displayFinancialStatus']}  paid/processed {order['processedAt'][:10]}"
          f"  codes {', '.join(order['discountCodes']) or '-'}")
    if order["cancelledAt"]:
        print("CANCELLED: no invoice")
    if DONE_TAG in order["tags"]:
        print(f"already tagged {DONE_TAG}: {order['note'] or ''}".rstrip())
    print()
    print("Customer (Kyte)")
    print(f"  Company      {company_name(order) or 'MISSING: ask the retailer'}")
    print(f"  VAT number   {vat or ('MISSING: ask the retailer' if country in EU else '- (outside the EU)')}")
    print(f"  Address      {', '.join(x for x in (b.get('address1'), b.get('address2'), b.get('zip'), b.get('city'), country) if x)}")
    print(f"  E-mail       {c.get('email')}")
    print(f"  Send via     {'Peppol (Belgian company)' if country == 'BE' else 'e-mail (PDF)'}")
    print()
    print(f"Invoice date  {order['processedAt'][:10]} (payment date)   VAT case: {case}")
    print(f"{'Description':58} {'Qty':>4} {'Unit excl.':>11} {'Total excl.':>12} {'VAT %':>6}")
    for d, q, unit, n, rate, _ in rows:
        print(f"{d[:58]:58} {q:>4} {unit:>11.4f} {n.quantize(CENT, ROUND_HALF_UP):>12} {rate.normalize():>6}")
    print(f"{'':58} {'':>4} {'Net':>11} {net.quantize(CENT):>12}")
    print(f"{'':58} {'':>4} {'VAT':>11} {tax.quantize(CENT):>12}")
    print(f"{'':58} {'':>4} {'Total':>11} {(net + tax).quantize(CENT):>12}  (Shopify total {total} {order['currencyCode']})")
    if abs(net + tax - total) > CENT:
        print("WARNING: lines do not add up to the Shopify total; check discounts before invoicing")
    if exempt:
        print(f"\nText on the invoice:\n  {TEXT_REVERSE}\n  Btw-nummer afnemer: {vat}")
    elif country and country not in EU:
        print(f"\nText on the invoice:\n  {TEXT_EXPORT}\n  Customs: describe each product by its function (controller board, motor driver board, ...).")
    print(f"\nPayment: paid in full via opendrone.be, order {order['name']}. Mark the invoice as paid.")
    if money(order["totalRefundedSet"]):
        print(f"Refunded {money(order['totalRefundedSet'])}: make a credit note in Kyte for that amount.")


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("order", nargs="?", help="order number, e.g. 1507")
    a.add_argument("--done", metavar="KYTE_NUMBER", help="tag the order invoiced and note this Kyte invoice number")
    a.add_argument("--apply", action="store_true")
    o = a.parse_args()
    env = load_env()

    if not o.order:
        todo = [(x, e) for x, e in retailer_orders(env)
                if x["displayFinancialStatus"] in ("PAID", "PARTIALLY_REFUNDED", "PARTIALLY_PAID")
                and not x["cancelledAt"] and DONE_TAG not in x["tags"]]
        for x, e in todo:
            t = x["currentTotalPriceSet"]["shopMoney"]
            print(f"{x['name']:>7}  {x['processedAt'][:10]}  {t['amount']:>9} {t['currencyCode']}  {e}")
        print(f"{len(todo)} retailer order(s) without a Kyte invoice")
        return

    order = find_order(env, o.order)
    if not o.done:
        show(order)
        return
    note = "\n".join(x for x in ((order["note"] or "").strip(), f"Kyte invoice {o.done}") if x)
    tags = sorted(set(order["tags"]) | {DONE_TAG})
    print(f"{'APPLY' if o.apply else 'DRY RUN'}: {order['name']} tags {tags}, note += 'Kyte invoice {o.done}'")
    if not o.apply:
        return
    r = gql(env, "mutation($i:OrderInput!){orderUpdate(input:$i){order{tags note} userErrors{message}}}",
            {"i": {"id": order["id"], "tags": tags, "note": note}})["orderUpdate"]
    if r["userErrors"] or DONE_TAG not in r["order"]["tags"]:
        raise SystemExit(f"failed: {r['userErrors']}")
    print("done")


if __name__ == "__main__":
    main()
