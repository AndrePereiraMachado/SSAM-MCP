import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import anvil_cli
import worker_process

class WorkerClientTests(unittest.TestCase):
    def test_state_file_failure_does_not_hide_a_responsive_worker(self):
        with patch.object(anvil_cli, "_request", return_value={"ok": True, "data": {"pid": 123}}), patch.object(worker_process, "remember", side_effect=PermissionError()):
            self.assertEqual(123, anvil_cli.ping()["pid"])

    def test_busy_worker_is_used_without_cold_fallback(self):
        with patch.object(anvil_cli, "ensure_worker", return_value={"busy": True}), patch.object(anvil_cli, "_request", return_value={"ok": True}) as request, patch.object(anvil_cli.subprocess, "run") as cold:
            self.assertEqual("worker", anvil_cli.run(["apply"])["via"])
            self.assertEqual(1, request.call_count)
            cold.assert_not_called()

    def test_unknown_outcome_is_never_replayed(self):
        with patch.object(anvil_cli, "ensure_worker", return_value={"busy": False}), patch.object(anvil_cli, "_request", side_effect=ConnectionResetError("lost")) as request:
            with self.assertRaisesRegex(RuntimeError, "outcome is unknown"):
                anvil_cli.run(["deliver"])
            self.assertEqual(1, request.call_count)

    def test_only_explicit_not_executed_response_retries(self):
        replies = [{"ok": False, "retryable": True, "executed": False}, {"ok": True}]
        with patch.object(anvil_cli, "ensure_worker", return_value={"pid": 123}) as ensure, patch.object(anvil_cli, "_request", side_effect=replies) as request:
            self.assertTrue(anvil_cli.run(["apply"])["ok"])
            self.assertEqual(2, request.call_count)
            self.assertEqual(2, ensure.call_count)

    def test_connection_refusal_before_submission_is_retryable(self):
        with patch.object(anvil_cli, "ensure_worker", return_value={"pid": 123}), patch.object(anvil_cli, "_request", side_effect=[ConnectionRefusedError(), {"ok": True}]) as request:
            self.assertTrue(anvil_cli.run(["apply"])["ok"])
            self.assertEqual(2, request.call_count)

    def test_cold_opt_out_is_preserved(self):
        with patch.dict(anvil_cli.os.environ, {"ANVIL_WORKER": "0"}), patch.object(anvil_cli, "ensure_worker") as ensure, patch.object(anvil_cli.subprocess, "run") as process:
            process.return_value.stdout = '{"ok":true}'
            process.return_value.stderr = ''
            self.assertEqual("process", anvil_cli.run(["inspect"])["via"])
            ensure.assert_not_called()

    def test_startup_lock_recovers_dead_owner_and_removes_own_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            local = pathlib.Path(temp)
            lock = local / "worker-1234.lock"
            lock.write_text(json.dumps({"pid": 987654321, "birth": "dead"}))
            with worker_process.startup_lock(local, 1234, wait=1):
                self.assertTrue(lock.exists())
            self.assertFalse(lock.exists())

    def test_pid_reuse_cannot_authorize_termination(self):
        # Current process is always alive; a wrong creation identity must be refused before TerminateProcess.
        self.assertFalse(worker_process.terminate_known(worker_process.os.getpid(), "not-the-process-birth"))

if __name__ == "__main__":
    unittest.main()
