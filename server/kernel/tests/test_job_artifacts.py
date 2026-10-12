import sys
import tempfile
import unittest
import copy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import job_artifacts


class JobArtifactsTests(unittest.TestCase):
    def test_preexisting_warning_requires_exact_clean_inventory(self):
        warning = {"type": "Warning", "key": "w", "id": "Old", "detail": "existing", "path": "App"}
        data = {"accepted": True, "isValid": True, "messages": 1,
                "details": ["Warning Old: existing @ App"], "validation": {
                    "new": [], "unexpected": [], "missingExpected": [], "ambiguous": [],
                    "tolerated": [], "preexisting": [warning]}}
        self.assertTrue(job_artifacts.clean_validation(data))
        for category in ("new", "unexpected", "missingExpected", "ambiguous", "tolerated"):
            changed = copy.deepcopy(data)
            changed["validation"][category] = [warning]
            self.assertFalse(job_artifacts.clean_validation(changed))
        for field, value in (("details", ["mismatch"]), ("messages", True), ("accepted", False)):
            self.assertFalse(job_artifacts.clean_validation({**data, field: value}))
        changed = copy.deepcopy(data)
        changed["validation"]["preexisting"][0]["type"] = "Error"
        self.assertFalse(job_artifacts.clean_validation(changed))

    def test_valid_candidate_and_changed_input(self):
        with tempfile.TemporaryDirectory() as directory:
            base, job, out = [Path(directory) / n for n in ("base.oml", "job.json", "candidate.oml")]
            for file in (base, job, out):
                file.write_bytes(file.name.encode())
            before = job_artifacts.capture(base, job)
            result = {"ok": True, "data": {"accepted": True, "isValid": True, "messages": 0,
                      "outPath": str(out), "handles": {"@espace": "module-key"}}}
            proof = job_artifacts.bind(before, out, result)
            self.assertEqual(proof["candidate"], job_artifacts.artifact(out))
            self.assertEqual(proof["base"], before["base"])
            result["data"]["messages"] = 1
            self.assertIsNone(job_artifacts.bind(before, out, result))
            result["data"]["messages"] = 0
            job.write_bytes(b"changed")
            with self.assertRaises(ValueError):
                job_artifacts.bind(before, out, result)

    def test_output_path_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            a = Path(directory) / "a"
            a.write_bytes(b"base")
            result = {"ok": True, "data": {"accepted": True, "isValid": True, "messages": 0,
                      "outPath": str(a), "handles": {"@espace": "key"}}}
            with self.assertRaises(ValueError):
                job_artifacts.bind(job_artifacts.capture(a, a), a.with_name("other"), result)


if __name__ == "__main__":
    unittest.main()
