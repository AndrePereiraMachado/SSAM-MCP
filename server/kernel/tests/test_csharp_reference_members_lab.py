"""Offline safety and semantic-boundary tests for immutable ColdReferenceJournal."""
import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/probes/highcode"))
import csharp_reference_members_lab as lab


def fixture():
    methods, cases, expected = lab.baseline()
    attrs = {
        "UnknownTextName": {"HasValue": "Boolean", "Value": "Text"},
        "Arena": {"Exceptions": "Failure List", "UnrelatedPool": "Cell List"},
        "Completion": {"Kind": "Integer", "ExceptionRef": "Integer"},
        "Failure": lab.EXCEPTION_FIELDS,
        "Cell": {"Value": "Integer"},
    }
    structures = [{"name": name, "attributes": [{"name": field, "type": kind} for field, kind in fields.items()]} for name, fields in attrs.items()]
    native = {"System.Int32": "Integer", "System.Boolean": "Boolean", "System.String": "UnknownTextName"}
    actions, mapping = [], []
    exceptions = ["ApplicationException", "ArgumentOutOfRangeException", "InvalidOperationException"]
    for number, method in enumerate(methods):
        wrapper, implementation = "CollisionResolved" + str(number), "PrivateOriginal" + str(number)
        inputs = [{"name": "Arg_" + p["name"], "type": native[p["clrType"]]} for p in method["inputs"]]
        output = [{"name": "AvResult", "type": "UnknownTextName"}]
        actions.append({"name": wrapper, "kind": "server", "public": True, "inputs": inputs, "outputs": output, "steps": [{"call": implementation}] + [{"raise": name} for name in exceptions]})
        actions.append({"name": implementation, "kind": "server", "public": False, "inputs": [{"name": "AvContextIn", "type": "Arena"}] + inputs, "outputs": [{"name": "AvContextOut", "type": "Arena"}, {"name": "AvCompletion", "type": "Completion"}] + output, "steps": []})
        mapping.append({"source": method["source"], "native": wrapper, "implementation": implementation, "kind": "server"})
    # Match the 23 original source methods without inventing callable public names.
    for number in range(12): mapping.append({"source": "ColdReferenceJournal.Private" + str(number) + "()", "native": "PrivateExtra" + str(number), "implementation": "PrivateExtra" + str(number), "kind": "server"})
    contract = {"data": {"structures": structures}, "logic": {"actions": actions}, "exceptions": [{"name": name} for name in exceptions]}
    return methods, cases, expected, contract, mapping


class ColdReferenceMembersLabTests(unittest.TestCase):
    def setUp(self):
        self.methods, self.cases, self.expected, self.contract, self.mapping = fixture()
        self.bindings, self.structures = lab.bind(self.methods, self.contract, self.mapping)
        self.shapes = lab.observation_shapes(self.bindings, self.contract, self.expected)

    def exception_body(self, actual=-3):
        return {"Context": {"Exceptions": [{"TypeName": "System.ArgumentOutOfRangeException", "Message": "Original message", "HasHResult": True, "HResult": -2146233086, "HasParamName": True, "ParamName": "adjustment", "HasActualValue": True, "ActualValueType": "System.Int32", "ActualValueInteger": actual}]}, "Completion": {"Kind": 2, "ExceptionRef": 1}}

    def test_generated_envelopes_have_bounded_distinct_names_and_all_type_uses_bind(self):
        ops = lab.transport_ops(self.bindings, self.shapes, self.contract)
        names = [item["name"] for item in ops[0]["data"]["structures"]]
        self.assertEqual(28, len(names))
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(all(len(name) <= 48 for name in names))
        uses = {op["value"] for op in ops if op.get("prop") == "DataType" and op.get("value", "").startswith("AvLab")}
        self.assertEqual(set(names), uses)
        left = lab.envelope_name("X" * 100 + "A", "Response")
        right = lab.envelope_name("X" * 100 + "B", "Response")
        self.assertNotEqual(left, right)
        self.assertEqual(48, len(left))

    def test_independent_clr_baseline_counts_and_hashes_are_pinned(self):
        self.assertEqual((11, 38, 5), (len(self.methods), len(self.cases), sum(x["expected"]["kind"] == "throw" for x in self.expected)))
        with patch.dict(lab.FROZEN_HASHES, {"expected": "0" * 64}):
            with self.assertRaisesRegex(ValueError, "Frozen CLR artifact changed"): lab.baseline()

    def test_prepare_copies_independent_bytes_without_reexecuting_oracle(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            lab.prepare(work)
            self.assertEqual(lab.SOURCE.read_bytes(), (work / "ColdReferenceJournal.cs.txt").read_bytes())
            self.assertFalse(lab.read(work / "oracle.freeze.json")["oracleReexecuted"])
            self.assertFalse(lab.check(work)["transportBuilt"])
            lab.prepare(work)
            (work / "expected.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "Frozen laboratory baseline changed"): lab.check(work)

    def test_bind_uses_exact_source_symbol_and_mapping_native_name(self):
        self.assertEqual("CollisionResolved0", self.bindings[0]["native"])
        wrong = copy.deepcopy(self.mapping)
        wrong[0]["source"] = wrong[0]["source"].replace("int, int", "int, string")
        with self.assertRaisesRegex(ValueError, "exact source symbol"): lab.bind(self.methods, self.contract, wrong)
        with self.assertRaisesRegex(ValueError, "exact source symbol"): lab.bind(self.methods, self.contract, self.mapping + [self.mapping[0]])

    def test_public_evidence_cannot_call_private_implementation(self):
        mapping = copy.deepcopy(self.mapping)
        mapping[0]["native"] = mapping[0]["implementation"]
        with self.assertRaisesRegex(ValueError, "public wrapper"): lab.bind(self.methods, self.contract, mapping)

    def test_native_parameter_arity_type_and_name_are_verified(self):
        for mutation in ("arity", "type", "name"):
            with self.subTest(mutation=mutation):
                contract = copy.deepcopy(self.contract)
                parameter = contract["logic"]["actions"][0]["inputs"]
                if mutation == "arity": parameter.pop()
                elif mutation == "type": parameter[0]["type"] = "Text"
                else: parameter[0]["name"] = "GuessedSeed"
                with self.assertRaises(ValueError): lab.bind(self.methods, contract, self.mapping)

    def test_text_presence_is_derived_from_native_structure(self):
        binding = next(b for b in self.bindings if b["method"] == "TextSlots")
        parameter = binding["inputs"][0]
        self.assertEqual({"kind": "nullable", "value": {"kind": "string"}}, parameter["schema"])
        for value, expected in [(None, {"HasValue": False, "Value": ""}), ("", {"HasValue": True, "Value": ""}), ("é😀", {"HasValue": True, "Value": "é😀"})]:
            self.assertEqual(expected, lab.common.encode(value, parameter["schema"], parameter["type"], self.structures))
        self.assertEqual({"kind": "string"}, lab.native_schema("System.String", "Text", self.structures))
        with self.assertRaisesRegex(ValueError, "presence carrier"): lab.native_schema("System.String", "Cell", self.structures)

    def test_output_presence_distinguishes_absent_empty_and_unicode(self):
        binding = self.bindings[0]
        self.assertEqual({"result": None, "error": None}, lab.public_response({}, binding, self.structures))
        self.assertEqual({"result": "", "error": None}, lab.public_response({"Result": {"HasValue": True}}, binding, self.structures))
        self.assertEqual({"result": "é😀", "error": None}, lab.public_response({"Result": {"HasValue": True, "Value": "é😀"}}, binding, self.structures))
        with self.assertRaises(ValueError): lab.public_response({"Result": {"HasValue": "true"}}, binding, self.structures)

    def test_internal_endpoints_cover_three_original_methods_and_five_throws(self):
        self.assertEqual({"CaptureListReceiver", "CaptureCompoundReceiver", "RejectSharedEdit"}, {s["method"] for s in self.shapes})
        requests, targets = lab.requests_and_targets(self.cases, self.expected, self.bindings, self.shapes, self.structures)
        self.assertEqual(43, len(requests))
        self.assertEqual(5, sum(r["evidenceScope"] == lab.INTERNAL_SCOPE for r in requests))
        self.assertEqual(38, sum(r["evidenceScope"] == lab.PUBLIC_SCOPE for r in requests))
        self.assertEqual(0, targets["internal:edit-shared-reject-zero"]["actualValue"])
        self.assertEqual(-3, targets["internal:edit-shared-reject-negative"]["actualValue"])
        self.assertEqual({"type", "message"}, set(targets["edit-shared-reject-negative"]["error"]))
        self.assertNotIn("stackTrace", targets["internal:edit-shared-reject-negative"])

    def test_internal_mapping_requires_original_implementation_and_full_abi(self):
        bindings = copy.deepcopy(self.bindings)
        next(b for b in bindings if b["method"] == "CaptureListReceiver")["implementation"] = "NotInSourceMap"
        with self.assertRaisesRegex(ValueError, "SourceMap.implementation"): lab.observation_shapes(bindings, self.contract, self.expected)
        contract = copy.deepcopy(self.contract)
        failure = next(s for s in contract["data"]["structures"] if s["name"] == "Failure")
        failure["attributes"] = [a for a in failure["attributes"] if a["name"] != "HasHResult"]
        with self.assertRaisesRegex(ValueError, "Complete typed exception ABI"): lab.observation_shapes(self.bindings, contract, self.expected)

    def test_observer_decodes_full_completion_exception_including_zero_actual_value(self):
        for actual in (-3, 0):
            observed = lab.observe_response(self.exception_body(actual), self.shapes[0], self.structures)
            self.assertEqual({"type": "System.ArgumentOutOfRangeException", "message": "Original message", "hResult": -2146233086, "paramName": "adjustment", "actualValue": actual, "innerRef": 0}, observed)

    def test_missing_optional_exception_fields_decode_as_null(self):
        body = self.exception_body()
        body["Context"]["Exceptions"] = [{"TypeName": "System.ApplicationException", "Message": "Thrown", "HasHResult": True, "HResult": -2146232832}]
        actual = lab.observe_response(body, self.shapes[0], self.structures)
        self.assertIsNone(actual["actualValue"])
        self.assertIsNone(actual["paramName"])

    def test_exception_requires_own_completion_and_hresult_presence(self):
        for mutation in ("index", "completion", "hresult", "inner", "actual", "type"):
            with self.subTest(mutation=mutation):
                body = self.exception_body()
                error = body["Context"]["Exceptions"][0]
                if mutation == "index": body["Completion"]["ExceptionRef"] = 2
                elif mutation == "completion": body["Completion"]["Kind"] = 1
                elif mutation == "hresult": error["HasHResult"] = False
                elif mutation == "inner": error["InnerRef"] = 2
                elif mutation == "actual": error["ActualValueType"] = "System.Object"
                else: error["ActualValueInteger"] = True
                with self.assertRaises(ValueError): lab.observe_response(body, self.shapes[0], self.structures)

    def test_authentication_precedes_every_original_call_and_no_business_copies(self):
        ops = lab.transport_ops(self.bindings, self.shapes, self.contract)
        endpoints = [op for op in ops if op.get("type") == "IRestServiceAction"]
        self.assertEqual(14, len(endpoints))
        self.assertFalse(any(op.get("op") in ("logic", "delete", "duplicate") or op.get("type") in ("IServerAction", "IServiceAction") for op in ops))
        expected_calls = {"IServerAction:" + b["native"] for b in self.bindings + self.shapes} | {"IServerAction:LabAuthenticate"}
        self.assertEqual(expected_calls, {op["value"] for op in ops if op.get("prop") == "Action"})
        for endpoint in endpoints:
            alias = endpoint["as"]
            self.assertEqual("IRestService:CSharpLab", endpoint["parent"])
            self.assertIn({"op": "link", "from": alias + "/#IStartNode", "to": alias + "Auth"}, ops)
            self.assertIn({"op": "link", "from": alias + "Auth", "to": alias + "Execute"}, ops)
            self.assertIn({"op": "set", "target": alias + "Auth", "prop": "Action", "value": "IServerAction:LabAuthenticate"}, ops)
        self.assertTrue(any(op.get("value") == '"System.ArgumentOutOfRangeException"' for op in ops))

    def test_additive_transport_refuses_envelope_name_collision(self):
        contract = copy.deepcopy(self.contract)
        contract["data"]["structures"].append({"name": "AvLab" + self.bindings[0]["endpoint"] + "Response", "attributes": []})
        with self.assertRaisesRegex(ValueError, "existing envelopes"): lab.transport_ops(self.bindings, self.shapes, contract)

    def test_exact_delivery_gate_rejects_wrong_host_failed_receipt_or_source_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            bundle = folder / "source.json"
            specification = {"csharpSource": {"files": {"ColdReferenceJournal.cs": lab.SOURCE.read_text(encoding="utf-8")}}}
            lab.write(bundle, specification)
            receipt = {"delivered": True, "environment": lab.common.HOST, "module": lab.common.MODULE, "specification": specification, "sources": [{"path": str(bundle), "sha256": lab.sha(bundle)}]}
            path = folder / "result.json"
            lab.write(path, receipt)
            lab.verify_source_delivery(path, bundle)
            for field, value in [("environment", "other.example"), ("delivered", False), ("module", "OtherModule"), ("sources", [])]:
                broken = dict(receipt, **{field: value})
                lab.write(path, broken)
                with self.assertRaises(ValueError): lab.verify_source_delivery(path, bundle)
            lab.write(path, receipt)
            (folder / "source.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "artifact changed"): lab.verify_source_delivery(path, bundle)

    def test_build_freezes_all_evidence_and_check_rejects_map_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            lab.prepare(work)
            contract_path, map_path = work / "input-contract.json", work / "input-map.json"
            bundle_path, receipt_path = work / "source.json", work / "source-delivery.json"
            specification = {"csharpSource": {"files": {"ColdReferenceJournal.cs": lab.SOURCE.read_text(encoding="utf-8")}}}
            for path, value in [(contract_path, self.contract), (map_path, self.mapping), (bundle_path, specification)]: lab.write(path, value)
            lab.write(receipt_path, {"taskId": "offline-fixture", "delivered": True, "environment": lab.common.HOST, "module": lab.common.MODULE, "specification": specification, "sources": [{"path": str(bundle_path), "sha256": lab.sha(bundle_path)}]})
            counts = lab.build(work, contract_path, map_path, receipt_path, bundle_path)
            self.assertEqual((11, 3, 43, 0), tuple(counts[key] for key in ("publicEndpoints", "internalObservationEndpoints", "requests", "businessBodyCopies")))
            self.assertTrue(lab.check(work)["transportBuilt"])
            proof = lab.read(work / "binding-proof.json")
            self.assertEqual(lab.sha(lab.reference.__file__), proof["evidence"]["referenceHelper"]["sha256"])
            self.assertEqual(lab.sha(lab.common.__file__), proof["evidence"]["temporalHelper"]["sha256"])
            with self.assertRaisesRegex(ValueError, "43"): lab.compare(work, {})
            map_path.write_text("[]")
            with self.assertRaisesRegex(ValueError, "Bound evidence changed"): lab.check(work)


if __name__ == "__main__": unittest.main()
