import unittest
from unittest.mock import patch

from services import cache_ledger_service as module
from services.cache_ledger_service import CacheLedgerEvent, CacheLedgerService


class CacheLedgerServiceTest(unittest.TestCase):
    def setUp(self):
        module._events_fallback.clear()
        module._solutions_fallback.clear()

    @patch("services.cache_ledger_service._test_mysql_connection", return_value=False)
    def test_records_events_and_aggregates_stats_without_mysql(self, _mysql):
        service = CacheLedgerService()
        service.record(CacheLedgerEvent(
            cache_layer="L0",
            cache_key="read:file",
            status="hit",
            scene_type="autocode",
            user_id="u1",
            token_saved_estimate=120,
            latency_saved_ms=30,
        ))
        service.record(CacheLedgerEvent(
            cache_layer="L0",
            cache_key="read:other",
            status="miss",
            scene_type="autocode",
            user_id="u1",
        ))

        stats = service.stats(scene_type="autocode", user_id="u1")

        self.assertEqual(stats["total"], 2)
        self.assertEqual(stats["hits"], 1)
        self.assertEqual(stats["byLayer"]["L0"]["hitRate"], 0.5)
        self.assertEqual(stats["tokenSaved"], 120)

    @patch("services.cache_ledger_service._test_mysql_connection", return_value=False)
    def test_prompt_context_returns_stable_prefix_and_key(self, _mysql):
        service = CacheLedgerService()
        first = service.stable_prompt_context(
            tenant_id="t1",
            user_id="u1",
            session_id="s1",
            model="m1",
            provider="openai",
            context_version="v1",
            system_prompt="system",
            stable_context={"tools": ["search"], "rules": ["stable"]},
        )
        second = service.stable_prompt_context(
            tenant_id="t1",
            user_id="u1",
            session_id="s1",
            model="m1",
            provider="openai",
            context_version="v1",
            system_prompt="system",
            stable_context={"rules": ["stable"], "tools": ["search"]},
        )

        self.assertEqual(first["prompt_cache_key"], second["prompt_cache_key"])
        self.assertIn("system", first["stable_context_prefix"])
        self.assertGreaterEqual(len(module._events_fallback), 2)

    @patch("services.cache_ledger_service._test_mysql_connection", return_value=False)
    def test_solution_cache_can_be_saved_and_searched(self, _mysql):
        service = CacheLedgerService()
        saved = service.save_solution({
            "scene_type": "chat",
            "tenant_id": "tenant",
            "title": "Fix cached token parsing",
            "tech_stack": "Java Spring",
            "error_excerpt": "cachedInputTokens missing",
            "root_cause": "usage payload not propagated",
            "validation_result": "passed",
        })

        results = service.search_solutions(query="cachedInputTokens", scene_type="chat", tenant_id="tenant")

        self.assertTrue(saved["fingerprint"])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["title"], "Fix cached token parsing")


if __name__ == "__main__":
    unittest.main()
