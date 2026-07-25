import unittest
import json
from unittest.mock import patch

from services import task_repository


class _FakeCursor:
    def __init__(self):
        self.executed_sql = ""
        self.executed_params = ()

    def execute(self, sql, params=None):
        self.executed_sql = sql
        self.executed_params = params or ()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class _FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.closed = False

    def cursor(self):
        return self._cursor

    def close(self):
        self.closed = True


class TaskRepositoryPersistenceContractTest(unittest.TestCase):
    def test_autonomy_intervention_and_completion_fields_are_persisted(self):
        required_json_fields = {
            "pending_confirmation",
            "pending_user_input",
            "interventions",
            "completion_report",
            "active_intent_route",
            "active_execution_plan",
            "task_capability_profile",
            "retrieval_plan",
            "retrieval_guard",
        }

        self.assertTrue(required_json_fields.issubset(set(task_repository.PERSISTED_JSON_FIELDS)))

        task = {
            "id": "task-persist-contract",
            "title": "Persist intervention state",
            "description": "Ensure strong autonomy task state survives restart",
            "project_type": "unknown",
            "status": "waiting_user_input",
            "autonomy_mode": "strong",
            "pending_user_input": {"question": "need credentials"},
            "interventions": [{"type": "hard_blocker"}],
            "completion_report": {"requirements_coverage": ["covered"]},
            "events": [{"type": "intervention_opened"}],
        }

        compacted = task_repository._compact_task_for_persistence(task)

        self.assertEqual(compacted["autonomy_mode"], "strong")
        self.assertEqual(compacted["pending_user_input"]["question"], "need credentials")
        self.assertEqual(compacted["interventions"][0]["type"], "hard_blocker")
        self.assertEqual(compacted["completion_report"]["requirements_coverage"], ["covered"])

    def test_save_task_writes_new_autonomy_fields_to_mysql_payload(self):
        cursor = _FakeCursor()
        conn = _FakeConnection(cursor)
        task = {
            "id": "task-save-contract",
            "title": "Save autonomy state",
            "description": "Persist intervention and completion report fields",
            "project_type": "unknown",
            "status": "waiting_user_input",
            "progress": 42,
            "workspace_id": "ws-save-contract",
            "autonomy_mode": "strong",
            "agents": ["general"],
            "logs": [],
            "commit_history": [],
            "command_history": [],
            "phase_reviews": [],
            "pipeline_runs": [],
            "events": [{"type": "intervention_opened"}],
            "pending_user_input": {"question": "need credentials"},
            "interventions": [{"type": "hard_blocker"}],
            "completion_report": {"requirements_coverage": ["covered"]},
            "active_execution_plan": {"validation_plan": [{"command": "npm run build"}]},
        }

        try:
            with patch.object(task_repository, "_test_mysql_connection", return_value=True), patch.object(
                task_repository, "_get_connection", return_value=conn
            ):
                task_repository.save_task(task)
        finally:
            task_repository._memory_fallback.pop(task["id"], None)

        sql = cursor.executed_sql
        params = cursor.executed_params
        self.assertIn("autonomy_mode", sql)
        self.assertIn("pending_user_input", sql)
        self.assertIn("completion_report", sql)
        self.assertEqual(sql.count("%s"), len(params))
        self.assertEqual(params[12], "strong")
        self.assertEqual(json.loads(params[38])["question"], "need credentials")
        self.assertEqual(json.loads(params[39])[0]["type"], "hard_blocker")
        self.assertEqual(json.loads(params[40])["requirements_coverage"], ["covered"])
        self.assertEqual(json.loads(params[42])["validation_plan"][0]["command"], "npm run build")


if __name__ == "__main__":
    unittest.main()
