"""Offline contracts for the immutable Unicode public-action HTTP harness."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/probes/highcode"))
import csharp_unicode_text_lab as lab


def fixture(optional_output=False):
    carrier = {"name": "CompilerChosenTextPresence", "attributes": [{"name": "HasValue", "type": "Boolean"}, {"name": "Value", "type": "Text"}]}
    actions, mapping = [], []
    for number, method in enumerate(lab.METHODS):
        name = "CollisionResolvedPublic" + str(number)
        kind = carrier["name"] if optional_output and method["result"] == "Text" else method["result"]
        actions.append({"name": name, "kind": "server", "public": True,
                        "inputs": [{"name": "Arg_value", "type": carrier["name"]}],
                        "outputs": [{"name": "AvResult", "type": kind}],
                        "steps": [{"assign": {"DoNotCopyThisBusinessBody": "123"}}]})
        mapping.append({"source": method["source"], "native": name, "implementation": "NeverCallPrivate" + str(number), "kind": "server"})
    return {"data": {"structures": [carrier]}, "logic": {"actions": actions}}, mapping


def build_fixture(root, optional_output=False):
    work = root / "work"
    lab.prepare(work)
    contract, mapping = fixture(optional_output)
    bundle = {"csharpSource": {"files": {"Utf16TextRules.cs": lab.SOURCE.read_bytes().decode("utf-8")}}}
    paths = {name: root / name for name in ("contract.json", "mapping.json", "source.json", "source-delivery.json", "source-hash.txt")}
    for name, value in [("contract.json", contract), ("mapping.json", mapping), ("source.json", bundle)]: lab.write(paths[name], value)
    paths["source-hash.txt"].write_text(lab.compiler_source_hash(bundle), encoding="utf-8")
    receipt = {"taskId": "offline-source", "delivered": True, "environment": lab.HOST, "module": lab.MODULE,
               "moduleKey": "offline-module-key", "updatedAt": "2020-01-01T00:00:00+00:00",
               "specification": bundle, "sources": [lab.evidence(paths["source.json"])]}
    lab.write(paths["source-delivery.json"], receipt)
    lab.build(work, paths["contract.json"], paths["mapping.json"], paths["source-delivery.json"], paths["source.json"])
    return work, paths


def publication_fixture(root, work):
    transport = root / "transport-delivery.json"
    lab.write(transport, {"taskId": "offline-transport", "delivered": True, "environment": lab.HOST, "module": lab.MODULE,
                          "moduleKey": "offline-module-key", "updatedAt": "2020-01-02T00:00:00Z", "sources": [lab.evidence(work / "transport.json")]})
    snapshot = root / "snapshot.json"
    oml = root / "snapshot.oml"
    oml.write_bytes(b"synthetic offline gate fixture; not an O11 model")
    lab.write(snapshot, {"success": True, "error": None, "data": {"environment": lab.HOST, "name": lab.MODULE,
        "key": "offline-module-key", "snapshot_id": "offline-snapshot", "path": str(oml), "sha256": lab.sha(oml).upper()}})
    raw = root / "confirmation.json"
    lab.write(raw, {"Completed": True, "HasErrors": False, "VersionId": 5001})
    publication = root / "publication-bound.json"
    envelope = lab.read(work / "publication-template.json")
    envelope.update(transportDelivery=lab.evidence(transport), transportTaskId="offline-transport",
                    snapshotReceipt=lab.evidence(snapshot), snapshotSha256=lab.sha(oml), confirmation=lab.evidence(raw), VersionId=5001)
    lab.write(publication, envelope)
    return transport, publication, snapshot, oml, raw


def response_fixture(work):
    targets = lab.read(work / "targets.json")
    bindings = {item["method"]: item for item in lab.read(work / "bindings.json")}
    structures = {item["name"]: item for item in lab.read(work / "bound-contract.json")["data"]["structures"]}
    return {item["id"]: {"Response": {"Completed": True, "Result": lab.common.encode(targets[item["id"]]["result"],
        bindings[item["method"]]["output"]["schema"], bindings[item["method"]]["output"]["type"], structures)}}
        for item in lab.read(work / "requests.json")}


class Reply:
    def __init__(self, status, body): self.status, self.body = status, json.dumps(body).encode("utf-8")
    def read(self): return self.body
    def __enter__(self): return self
    def __exit__(self, *unused): return None


class FakeOpener:
    def __init__(self, work, secret, guard=True, reflect=False):
        self.requests = []
        self.plan = lab.read(work / "requests.json")
        self.responses = response_fixture(work)
        self.secret, self.guard, self.reflect = secret, guard, reflect
    def open(self, request, timeout):
        self.requests.append(request)
        if len(self.requests) == 1:
            return Reply(403, {"error": "LabAccessDenied" + (self.secret if self.reflect else "")}) if self.guard else Reply(200, {"Completed": True, "Result": 0})
        item = self.plan[len(self.requests) - 2]
        if request.full_url != "https://" + lab.HOST + "/" + lab.MODULE + "/rest/CSharpLab/" + item["endpoint"]: raise AssertionError("Unexpected host or route")
        if json.loads(request.data) != item["payload"]: raise AssertionError("Payload changed")
        if request.get_header("Labkey") != self.secret: raise AssertionError("Missing private header")
        return Reply(200, self.responses[item["id"]])


class UnicodeTextLabTests(unittest.TestCase):
    def test_baseline_has_54_http_cases_and_8_separate_surrogate_cases(self):
        methods, cases, expected = lab.baseline()
        self.assertEqual((2, 54, 54), (len(methods), len(cases), len(expected)))
        self.assertEqual(46, sum(case["group"] == "public" for case in cases))
        self.assertEqual(8, sum(case["group"] == "discriminator" for case in cases))
        self.assertFalse(any("isolated-" in case["id"] or "reversed-surrogates" in case["id"] for case in cases))
        for case in cases:
            if case["arguments"][0] is not None: case["arguments"][0].encode("utf-8", errors="strict")
        with patch.dict(lab.FROZEN_HASHES, {"expected.json": "0" * 64}):
            with self.assertRaisesRegex(ValueError, "artifact changed"): lab.baseline()

    def test_prepare_is_idempotent_and_never_reexecutes_the_oracle(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            lab.prepare(work); lab.prepare(work)
            self.assertFalse(lab.read(work / "oracle.freeze.json")["oracleReexecuted"])
            for name in lab.FROZEN_HASHES: self.assertEqual(lab.original_path(name).read_bytes(), (work / name).read_bytes())
            (work / "discriminator-expected.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "baseline changed"): lab.check(work)

    def test_exact_source_symbol_and_public_alias_are_required(self):
        contract, mapping = fixture()
        bindings, _ = lab.bind(contract, mapping)
        self.assertEqual("CollisionResolvedPublic0", bindings[0]["native"])
        for change in ("signature", "private", "duplicate", "parameter", "return"):
            with self.subTest(change=change):
                current, names = copy.deepcopy(contract), copy.deepcopy(mapping)
                if change == "signature": names[0]["source"] = "Utf16TextRules.Measure(string)"
                elif change == "private": current["logic"]["actions"][0]["public"] = False
                elif change == "duplicate": names.append(names[0])
                elif change == "parameter": current["logic"]["actions"][0]["inputs"][0]["name"] = "GuessedValue"
                else: current["logic"]["actions"][0]["outputs"][0]["name"] = "GuessedResult"
                with self.assertRaises(ValueError): lab.bind(current, names)

    def test_null_and_empty_always_have_distinct_input_carriers(self):
        contract, mapping = fixture()
        bindings, structures = lab.bind(contract, mapping)
        _, cases, expected = lab.baseline()
        requests, _ = lab.requests_and_targets(cases, expected, bindings, structures)
        by_id = {item["id"]: item for item in requests}
        self.assertEqual({"HasValue": False, "Value": ""}, by_id["null/Measure"]["payload"]["Arg_value"])
        self.assertEqual({"HasValue": True, "Value": ""}, by_id["empty/Measure"]["payload"]["Arg_value"])
        contract["logic"]["actions"][0]["inputs"][0]["type"] = "Text"
        with self.assertRaises(ValueError): lab.bind(contract, mapping)

    def test_transport_authenticates_then_calls_only_original_public_actions(self):
        contract, mapping = fixture()
        bindings, structures = lab.bind(contract, mapping)
        ops = lab.transport_ops(bindings, structures)
        self.assertEqual({"IServerAction:LabAuthenticate", "IServerAction:CollisionResolvedPublic0", "IServerAction:CollisionResolvedPublic1"},
                         {op["value"] for op in ops if op.get("prop") == "Action"})
        self.assertNotIn("DoNotCopyThisBusinessBody", json.dumps(ops))
        self.assertFalse(any(op.get("op") in ("logic", "delete", "duplicate") or op.get("type") in ("IServerAction", "IServiceAction") for op in ops))
        endpoints = [op for op in ops if op.get("type") == "IRestServiceAction"]
        self.assertEqual(2, len(endpoints))
        for endpoint in endpoints:
            alias = endpoint["as"]
            self.assertEqual("IRestService:CSharpLab", endpoint["parent"])
            self.assertIn({"op": "link", "from": alias + "/#IStartNode", "to": alias + "Auth"}, ops)
            self.assertIn({"op": "link", "from": alias + "Auth", "to": alias + "Execute"}, ops)
            self.assertIn({"op": "set", "target": alias + "Completed", "prop": "Value", "value": "True"}, ops)

    def test_completed_marker_prevents_missing_result_from_becoming_false_success(self):
        contract, mapping = fixture()
        bindings, structures = lab.bind(contract, mapping)
        self.assertEqual({"result": 0, "error": None}, lab.compare_response({"Completed": True}, bindings[0], structures))
        for body in ({}, {"Result": 0}, {"Completed": False, "Result": 0}, {"Completed": "true", "Result": 0}):
            with self.assertRaises(ValueError): lab.compare_response(body, bindings[0], structures)

    def test_optional_text_output_is_decoded_without_assuming_a_native_type_name(self):
        contract, mapping = fixture(optional_output=True)
        bindings, structures = lab.bind(contract, mapping)
        self.assertEqual({"result": "é😀", "error": None}, lab.compare_response({"Response": {"Completed": True, "Result": {"HasValue": True, "Value": "é😀"}}}, bindings[1], structures))
        with self.assertRaises(ValueError): lab.compare_response({"Completed": True, "Result": True}, bindings[0], structures)

    def test_source_bundle_compiler_hash_and_receipt_are_all_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work, paths = build_fixture(root)
            self.assertTrue(lab.check(work)["transportBuilt"])
            paths["source-hash.txt"].write_text("0" * 64)
            with self.assertRaisesRegex(ValueError, "evidence changed"): lab.check(work)

    def test_successful_delivery_on_a_different_target_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, paths = build_fixture(root)
            receipt = lab.read(paths["source-delivery.json"])
            for change, value in (("environment", "other.example"), ("module", "CustomerModule"), ("delivered", False), ("sources", [])):
                lab.write(paths["source-delivery.json"], dict(receipt, **{change: value}))
                with self.assertRaises(ValueError): lab.verify_source_delivery(paths["source-delivery.json"], paths["source.json"])

    def test_compare_requires_all_cases_and_does_not_normalize_unicode(self):
        with tempfile.TemporaryDirectory() as directory:
            work, _ = build_fixture(Path(directory), optional_output=True)
            responses = response_fixture(work)
            self.assertTrue(all(item["passed"] for item in lab.compare(work, responses)))
            responses["combining/Describe"]["Response"]["Result"]["Value"] = "changed"
            results = lab.compare(work, responses)
            self.assertEqual(["combining/Describe"], [item["id"] for item in results if not item["passed"]])
            responses.pop("null/Measure")
            with self.assertRaisesRegex(ValueError, "54"): lab.compare(work, responses)

    def test_template_is_blocked_and_cannot_substitute_for_raw_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); work, _ = build_fixture(root)
            transport, publication, _, _, raw = publication_fixture(root, work)
            with self.assertRaises(ValueError): lab.execution_gate(work, transport, work / "publication-template.json")
            self.assertEqual(5001, lab.execution_gate(work, transport, publication)["version"])
            confirmation = {"Completed": False, "HasErrors": False, "VersionId": 5001}
            lab.write(raw, confirmation)
            envelope = lab.read(publication); envelope["confirmation"] = lab.evidence(raw); envelope["Completed"] = True
            lab.write(publication, envelope)
            with self.assertRaisesRegex(ValueError, "Raw successful"): lab.execution_gate(work, transport, publication)

    def test_gate_uses_registered_snapshot_identity_instead_of_declared_template_strings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); work, _ = build_fixture(root)
            transport, publication, snapshot, _, _ = publication_fixture(root, work)
            for field, value in (("environment", "other.example"), ("name", "CustomerModule"), ("key", "another-key")):
                original = lab.read(snapshot)
                broken = copy.deepcopy(original); broken["data"][field] = value; lab.write(snapshot, broken)
                envelope = lab.read(publication); envelope["environment"] = lab.HOST; envelope["module"] = lab.MODULE; envelope["snapshotReceipt"] = lab.evidence(snapshot); lab.write(publication, envelope)
                with self.assertRaisesRegex(ValueError, "Snapshot does not identify"): lab.execution_gate(work, transport, publication)
                lab.write(snapshot, original)

    def test_snapshot_must_be_later_than_both_deliveries_and_confirmation_later_than_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); work, _ = build_fixture(root)
            transport, publication, _, oml, raw = publication_fixture(root, work)
            before = oml.stat().st_mtime
            os.utime(oml, (1, 1))
            with self.assertRaisesRegex(ValueError, "after both deliveries"): lab.execution_gate(work, transport, publication)
            os.utime(oml, (before, before)); os.utime(raw, (1, 1))
            with self.assertRaisesRegex(ValueError, "version/order"): lab.execution_gate(work, transport, publication)

    def test_receipt_ids_and_published_snapshot_hash_cannot_be_swapped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); work, _ = build_fixture(root)
            transport, publication, _, _, _ = publication_fixture(root, work)
            original = lab.read(publication)
            for field, value in (("sourceTaskId", "wrong"), ("transportTaskId", "wrong"), ("snapshotSha256", "0" * 64), ("VersionId", 999)):
                lab.write(publication, dict(original, **{field: value}))
                with self.assertRaises(ValueError): lab.execution_gate(work, transport, publication)

    def test_invalid_gate_performs_no_http_or_secret_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); work, _ = build_fixture(root)
            transport, _, _, _, _ = publication_fixture(root, work)
            with patch.object(lab.urllib.request, "build_opener") as opened:
                with self.assertRaises(ValueError): lab.run(work, transport, work / "publication-template.json", root / "missing-secrets.json")
                opened.assert_not_called()

    def test_run_is_55_gated_requests_and_archives_no_secret_file_or_reflected_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); work, _ = build_fixture(root)
            transport, publication, _, _, _ = publication_fixture(root, work)
            key, password = "synthetic-private-key-123456", "synthetic-password-never-used"
            secret_path = work / "secrets.json"  # Explicit allowlist must still omit this file.
            lab.write(secret_path, {"key": key, "password": password})
            fake = FakeOpener(work, key, reflect=True)
            with patch.object(lab.urllib.request, "build_opener", return_value=fake), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(0, lab.run(work, transport, publication, secret_path))
            self.assertEqual(55, len(fake.requests))
            self.assertNotEqual(key, fake.requests[0].get_header("Labkey"))
            self.assertNotIn(key, output.getvalue())
            run = next((work / "runs").iterdir())
            self.assertFalse((run / "secrets.json").exists())
            for path in run.iterdir():
                self.assertNotIn(key.encode(), path.read_bytes())
                self.assertNotIn(password.encode(), path.read_bytes())
            self.assertTrue(lab.read(run / "summary.json")["passed"])
            self.assertEqual(0, lab.read(run / "summary.json")["httpSurrogateCases"])

    def test_invalid_key_guard_failure_stops_before_any_public_case(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); work, _ = build_fixture(root)
            transport, publication, _, _, _ = publication_fixture(root, work)
            secret_path = root / "secrets.json"; lab.write(secret_path, {"key": "synthetic-private-key"})
            fake = FakeOpener(work, "synthetic-private-key", guard=False)
            with patch.object(lab.urllib.request, "build_opener", return_value=fake), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, "no public cases"): lab.run(work, transport, publication, secret_path)
            self.assertEqual(1, len(fake.requests))

    def test_binding_manifest_cannot_drop_the_harness_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            work, _ = build_fixture(Path(directory))
            proof = lab.read(work / "binding-proof.json")
            proof["evidence"].pop("probe")
            lab.write(work / "binding-proof.json", proof)
            with self.assertRaisesRegex(ValueError, "Incomplete binding proof"): lab.check(work)

    def test_duplicate_native_carrier_fields_are_rejected(self):
        contract, mapping = fixture()
        contract["data"]["structures"][0]["attributes"].append({"name": "HasValue", "type": "Boolean"})
        with self.assertRaisesRegex(ValueError, "Duplicate native carrier"): lab.bind(contract, mapping)

    def test_http_boundary_rejects_duplicate_json_fields(self):
        with self.assertRaisesRegex(ValueError, "Duplicate response field"):
            lab.parse_response('{"Completed": false, "Completed": true, "Result": 0}')

    def test_redirects_cannot_forward_the_private_header(self):
        self.assertIsNone(lab.NoRedirect().redirect_request(None, None, 302, "Moved", {}, "https://other.example/"))


if __name__ == "__main__": unittest.main()
