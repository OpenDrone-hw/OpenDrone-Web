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

if __name__ == "__main__":
    unittest.main()
