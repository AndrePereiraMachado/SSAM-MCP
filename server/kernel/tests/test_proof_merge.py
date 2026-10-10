import contextlib
import io
import pathlib
import sys
import unittest
from unittest.mock import patch, MagicMock
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import proof_merge

class ProofMergeTests(unittest.TestCase):
    def run_proof(self, result, extra=()):
        bridge = MagicMock()
        with patch.object(sys, "argv", ["proof_merge", "--module", "Headless_UI", "--job", "tests/jobs/service-action.json", *extra]), patch.object(proof_merge, "AnvilBridge", return_value=bridge), patch.object(proof_merge.anvil_cli, "run", return_value=result) as run, contextlib.redirect_stdout(io.StringIO()):
            code = proof_merge.main()
        return code, bridge, run

    def test_wrapper_forwards_to_deliver_without_own_merge_or_snapshot(self):
        code, bridge, run = self.run_proof({"ok": True, "data": {"delivered": True}}, ["--producer", "Producer=.local/test.oml", "--checks", "A,B"])
        self.assertEqual(0, code)
        argv = run.call_args.args[0]
        self.assertEqual("deliver", argv[0])
        self.assertIn("--producer", argv)
        self.assertIn("A,B", argv)
        bridge.ok.assert_not_called()

    def test_failed_delivery_never_publishes(self):
        code, bridge, _ = self.run_proof({"ok": False, "data": {"delivered": False, "error": "merge kept for review"}}, ["--publish"])
        self.assertNotEqual(0, code)
        bridge.ok.assert_not_called()

    def test_publish_is_a_proof_option_and_is_not_forwarded_to_deliver(self):
        code, bridge, run = self.run_proof({"ok": True, "data": {"delivered": True}}, ["--publish"])
        self.assertEqual(0, code)
        self.assertNotIn("--publish", run.call_args.args[0])
        self.assertEqual("publish", bridge.ok.call_args.args[0])

if __name__ == "__main__":
    unittest.main()
