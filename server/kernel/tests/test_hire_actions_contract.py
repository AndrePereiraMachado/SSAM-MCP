"""Security boundaries checked against the generated business specification."""
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import gen_hire_actions as hire


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


class HireActionContracts(unittest.TestCase):
    def setUp(self):
        self.actions = {a["name"]: a for a in hire.A}

    def test_public_operations_never_accept_an_actor_identity(self):
        for a in hire.A:
            if a["public"]:
                self.assertFalse({p["name"] for p in a["inputs"]} & {"ActorId", "ActorUserId", "CurrentUserId"}, a["name"])

    def test_provider_boundaries_do_not_write_or_fabricate_success(self):
        for name in ("Offer_Send", "Communication_RequestSend", "CandidateDocument_ConfirmUpload", "JobPublication_RequestPublish"):
            steps = list(walk(self.actions[name]["steps"]))
            self.assertTrue(any(s.get("raise") == "HireConfiguration" for s in steps), name)
            self.assertFalse(any(set(s) & {"save", "update", "create", "delete"} for s in steps), name)

    def test_job_creation_does_not_copy_client_status_or_audit(self):
        steps = list(walk(self.actions["Job_CreateDraft"]["steps"]))
        assignments = {k:v for s in steps for k,v in s.get("assign", {}).items()}
        self.assertEqual("Entities.JobStatus.Draft", assignments["R.StatusId"])
        self.assertNotEqual("Input.CreatedByUserId", assignments["R.CreatedByUserId"])
        self.assertNotEqual("Input.OrganizationId", assignments["R.OrganizationId"])

    def test_candidate_portal_has_no_internal_outcome_projection(self):
        fields = {a["name"] for a in hire.PORTAL["attributes"]}
        self.assertEqual({"ApplicationId", "JobTitle", "StatusId", "SubmittedAt"}, fields)

    def test_idempotent_request_rejects_different_payload(self):
        text = str(self.actions["Request_Begin"]["steps"])
        self.assertIn("HireRequest.ActorUserId = GetUserId()", text)
        self.assertIn("Payload <> Payload", text)
        self.assertIn("HireConflict", text)

    def test_completed_acceptance_is_replayed_before_workflow_checks(self):
        a = self.actions["Offer_Accept"]
        branch = next(s for s in a["steps"] if s.get("if") == "Request.Completed")
        before = a["steps"][:a["steps"].index(branch)]
        self.assertNotIn("StatusId <> Entities.OfferStatus.Sent", str(before))
        self.assertIn("StatusId <> Entities.OfferStatus.Sent", str(branch["else"]))

    def test_updates_reject_old_revisions(self):
        for name in ("Job_UpdateDraft", "Application_MoveStage", "Evaluation_SaveDraft", "Hire_RecordStart"):
            self.assertTrue(any(s.get("call") == "Concurrency_RequireRevision" for s in walk(self.actions[name]["steps"])), name)

    def test_no_duplicate_action_or_explicit_node_names(self):
        self.assertEqual(len(hire.A), len(self.actions))
        for a in hire.A:
            aliases = [s["as"] for s in walk(a["steps"]) if "as" in s]
            self.assertEqual(len(aliases), len(set(aliases)), a["name"])


if __name__ == "__main__":
    unittest.main()
