"""python3 scripts/test_wholesale_lib.py : the pure price maths of wholesale_lib.py (stdlib unittest, no network)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wholesale_lib as L  # noqa: E402

V = [{"id": "a", "sku": "FC", "price": 35.10, "retail": 39.0},   # 10% step
     {"id": "b", "sku": "RX", "price": 16.80, "retail": 21.0},   # 20% step
     {"id": "c", "sku": "AT", "price": 39.0, "retail": 39.0}]    # at retail


class Maths(unittest.TestCase):
    def test_gross_groups_land_on_75_percent_of_retail(self):
        for g in L.groups(V, 25.0):
            for v in g["variants"]:
                self.assertAlmostEqual(v["price"] * (1 - g["pct"]), 0.75 * v["retail"], places=2)

    def test_reverse_charge_groups_land_on_net_75_percent(self):
        d = L.divisor("ES", True)
        self.assertAlmostEqual(d, 1.21)
        for g in L.groups(V, 25.0, d):
            for v in g["variants"]:
                self.assertAlmostEqual(v["price"] * (1 - g["pct"]), 0.75 * v["retail"] / 1.21, places=2)
        fc = next(g for g in L.groups(V, 25.0, d) if any(v["sku"] == "FC" for v in g["variants"]))
        self.assertEqual(round(35.10 - round(35.10 * fc["pct"], 2), 2), 24.17)

    def test_non_eu_retailer_pays_75_percent_of_its_market_base_price(self):
        # International market: base before tax = list / 1.21 on price and compare-at. Divisor 1 (not exempt).
        intl = [{**v, "price": round(v["price"] / 1.21, 2), "retail": round(v["retail"] / 1.21, 2)} for v in V]
        for g in L.groups(intl, 25.0, L.divisor("CH", False)):
            for v in g["variants"]:
                paid = round(v["price"] - round(v["price"] * g["pct"] + 1e-9, 2), 2)
                self.assertAlmostEqual(paid, round(0.75 * v["retail"], 2), delta=0.011)
                self.assertLess(paid, 0.75 * v["retail"] * 1.21 - 0.5)  # not 75% of a VAT-inclusive price

    def test_not_exempt_or_non_eu_stays_gross(self):
        self.assertEqual(L.divisor("ES", False), 1.0)
        self.assertEqual(L.divisor("AU", False), 1.0)
        with self.assertRaises(SystemExit):
            L.divisor("AU", True)

    def test_customer_country_and_divisor(self):
        c = {"tags": ["wholesale"], "taxExemptions": [L.EXEMPTION], "note": "2026-10-29 VAT ESY3837488K VIES valid"}
        self.assertEqual(L.customer_country(c), "ES")
        self.assertAlmostEqual(L.customer_divisor(c), 1.21)
        self.assertEqual(L.customer_country({"tags": ["country-de"], "note": ""}), "DE")
        self.assertEqual(L.customer_country({"tags": [], "note": "VAT EL123456789 VIES valid"}), "GR")
        self.assertEqual(L.customer_divisor({"tags": ["wholesale"], "taxExemptions": [], "note": ""}), 1.0)

    def test_every_eu_state_has_a_rate(self):
        self.assertEqual(set(L.EU_VAT), L.EU)

    def test_rounding_per_unit_is_within_a_cent(self):
        d = L.divisor("ES", True)
        for g in L.groups(V, 25.0, d):
            self.assertLess(L.rounding_check(g, 25.0, 50, d)[0], 1.0)




class LiveVariantsTest(unittest.TestCase):
    def test_a_variant_at_the_retail_step_has_no_compare_at_and_keeps_its_price_as_retail(self):
        nodes = [{"id": "a", "sku": "OPENFC-LITE-3030", "price": "39.00", "compareAtPrice": None, "product": {"status": "ACTIVE"}},
                 {"id": "b", "sku": "OPENFC-LITE-2020", "price": "26.10", "compareAtPrice": "29.00", "product": {"status": "ACTIVE"}},
                 {"id": "c", "sku": "OPENOLD", "price": "9.00", "compareAtPrice": None, "product": {"status": "ARCHIVED"}}]
        real = L.gql
        L.gql = lambda env, q, v=None: {"productVariants": {"nodes": nodes}}
        try:
            got = {v["sku"]: v["retail"] for v in L.live_variants({})}
        finally:
            L.gql = real
        self.assertEqual(got, {"OPENFC-LITE-3030": 39.0, "OPENFC-LITE-2020": 29.0})

class MarketPricesTest(unittest.TestCase):
    def test_live_variants_with_a_country_reads_that_markets_prices(self):
        nodes = [{"id": "b", "sku": "OPENFC-LITE-2020", "title": "Pre-order", "price": "26.10", "compareAtPrice": "29.00",
                  "product": {"status": "ACTIVE"}, "ctx": {"price": {"amount": "21.57"}, "compareAtPrice": {"amount": "23.97"}}}]
        seen = []
        real = L.gql
        L.gql = lambda env, q, v=None: seen.append(q) or {"productVariants": {"nodes": nodes}}
        try:
            got = L.live_variants({}, "CH")
        finally:
            L.gql = real
        self.assertIn("contextualPricing(context:{country:CH})", seen[0])
        self.assertEqual((got[0]["price"], got[0]["retail"]), (21.57, 23.97))

    def test_base_price_problem_needs_the_international_decrease(self):
        def fake(adj):
            return lambda env, q, v=None: {"markets": {"nodes": [{"handle": "international", "catalogs": {"nodes": [
                {"priceList": {"currency": "EUR", "parent": {"adjustment": adj}}}] if adj else []}}]}}
        real = L.gql
        try:
            L.gql = fake({"type": "PERCENTAGE_DECREASE", "value": 17.3554})
            self.assertIsNone(L.base_price_problem({}))
            L.gql = fake(None)
            self.assertIn("VAT-inclusive", L.base_price_problem({}))
        finally:
            L.gql = real

    def test_every_retailer_country_tag_is_its_market(self):
        self.assertEqual(L.market_country({"tags": ["wholesale", "country-ch"], "note": ""}), "CH")
        self.assertIsNone(L.market_country({"tags": ["wholesale"], "note": ""}))


class BothLanesAndExpiredSlots(unittest.TestCase):
    LANES = [{"id": "pre", "sku": "OPENFC-LITE-2020", "title": "20x20 / Pre-order", "price": 26.10, "retail": 29.0},
             {"id": "now", "sku": "OPENFC-LITE-2020", "title": "20x20 / Buy now", "price": 29.0, "retail": 29.0},
             {"id": "pre30", "sku": "OPENFC-LITE-3030", "title": "30x30 / Pre-order", "price": 39.0, "retail": 39.0}]

    def test_buy_now_and_pre_order_of_one_sku_each_land_on_75_percent(self):
        seen = set()
        for g in L.groups(self.LANES, 25.0):
            for v in g["variants"]:
                seen.add(v["id"])
                self.assertAlmostEqual(round(v["price"] - round(v["price"] * g["pct"] + 1e-9, 2), 2), round(0.75 * v["retail"], 2))
        self.assertEqual(seen, {"pre", "now", "pre30"})

    def test_an_expired_slot_is_planned_and_updated_without_an_end(self):
        want = {"pct": 0.25, "variants": self.LANES[1:]}
        expired = {"id": "gid://d/3", "status": "EXPIRED", "customers": ["c"], "pct": 0.25, "variants": ["now", "pre30"]}
        self.assertEqual(L.plan_slot(expired, want, ["c"]), "update")
        calls = []

        def fake(env, q, v=None):
            calls.append((q, v))
            if "codeDiscountNodeByCode" in q:
                return {"codeDiscountNodeByCode": {"id": "gid://d/3", "codeDiscount": {"status": "ACTIVE", "title": "t"}}}
            key = "discountCodeBasicUpdate" if "Update" in q else "discountCodeActivate"
            return {key: {"userErrors": []}}
        real = L.gql
        L.gql = fake
        try:
            L.apply_slot({}, "update", expired, "Wholesale X G3", "WS25-X-G3", want, ["c"], "2026-11-14T00:00:00Z")
        finally:
            L.gql = real
        update = next(v for q, v in calls if "discountCodeBasicUpdate" in q)
        self.assertIn("endsAt", update["i"])
        self.assertIsNone(update["i"]["endsAt"])
        self.assertFalse(any("discountCodeActivate" in q for q, _ in calls))  # already ACTIVE on read back

    def test_label_names_the_lane(self):
        self.assertEqual(L.label(self.LANES[1]), "OPENFC-LITE-2020 (20x20 / Buy now)")


if __name__ == "__main__":
    unittest.main()
