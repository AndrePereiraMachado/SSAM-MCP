"""Offline contract tests for the journal lab transport, with synthetic names."""
import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/probes/highcode"))
import csharp_reference_lab as lab


def fixture():
    specs = [("Run", [("fail", "bool"), ("amount", "int")], "int"), ("Same", [("shared", "bool")], "bool"), ("Fresh", [], "int"), ("Rebind", [], "int"), ("NullRequired", [], "int")]
    types = {"bool": "Boolean", "int": "Integer"}
    methods, actions, mapping = [], [], []
    for name, inputs, output in specs:
        native = "CollisionResolved_" + name
        methods.append({"source": "JournalRules." + name, "method": name, "inputs": [{"name": n, "schema": {"kind": t}} for n, t in inputs], "output": {"kind": output}})
        actions.append({"name": native, "kind": "server", "public": True, "inputs": [{"name": "Arg_" + n, "type": types[t]} for n, t in inputs], "outputs": [{"name": "AvResult", "type": types[output]}], "steps": []})
        mapping.append({"source": "JournalRules." + name + "(synthetic-signature)", "kind": "server", "native": native, "implementation": "Hidden_" + name})
    actions.append({"name": "Hidden_Run", "kind": "server", "public": False, "inputs": [{"name": "AvContextIn", "type": "Arena"}, {"name": "Arg_fail", "type": "Boolean"}, {"name": "Arg_amount", "type": "Integer"}], "outputs": [{"name": "AvContextOut", "type": "Arena"}, {"name": "AvCompletion", "type": "Completion"}, {"name": "AvResult", "type": "Integer"}], "steps": []})
    mapping += [{"source": "PostingJournal.Entries", "native": "PostingJournal.Events"}, {"source": "PostingJournal.Total", "native": "PostingJournal.Balance"}]
    fields = {
        "Arena": {"Exceptions": "Failure List", "Journals": "JournalCell List", "Texts": "TextListCell List"},
        "Completion": {"Kind": "Integer", "ExceptionRef": "Integer"},
        "Failure": {"TypeName": "Text", "Message": "Text", "ParamName": "Text", "HasParamName": "Boolean", "InnerRef": "Integer"},
        "JournalCell": {"Events": "ListHandle", "Balance": "Integer"},
        "ListHandle": {"Index": "Integer"},
        "TextListCell": {"Items": "OptionalText List"},
        "OptionalText": {"HasValue": "Boolean", "Value": "Text"},
    }
    structures = [{"name": name, "attributes": [{"name": field, "type": kind} for field, kind in attrs.items()]} for name, attrs in fields.items()]
    return methods, {"logic": {"actions": actions}, "data": {"structures": structures}, "exceptions": []}, mapping


class ReferenceLabTests(unittest.TestCase):
    def setUp(self):
        self.methods, self.contract, self.mapping = fixture()
        self.bindings, self.structures = lab.bind(self.methods, self.contract, self.mapping)
        self.shape = lab.observation_shape(self.bindings, self.contract, self.mapping)

    def state(self, fail=False):
        context = {"Journals": [{"Events": {"Index": 1}, "Balance": 42 if fail else 43}], "Texts": [{"Items": [{"HasValue": True, "Value": "before:42"}, {"HasValue": True, "Value": "shared"}] + ([] if fail else [{"HasValue": True, "Value": "after"}])}]}
        if fail: context["Exceptions"] = [{"TypeName": "System.InvalidOperationException", "Message": "leaf failed"}]
        return {"Context": context, "Completion": {"Kind": 2 if fail else 1, "ExceptionRef": 1 if fail else 0}}

    def test_public_binding_uses_mapping_even_when_name_is_mangled(self):
        self.assertEqual("CollisionResolved_Same", next(item for item in self.bindings if item["method"] == "Same")["native"])
        changed = [entry for entry in self.mapping if not entry["source"].startswith("JournalRules.Same(")]
        with self.assertRaisesRegex(ValueError, "source-map"): lab.bind(self.methods, self.contract, changed)

    def test_public_method_cannot_be_certified_through_private_implementation(self):
        bad = copy.deepcopy(self.mapping)
        bad[0]["native"] = "Hidden_Run"
        with self.assertRaisesRegex(ValueError, "public server boundary"): lab.bind(self.methods, self.contract, bad)

    def test_observation_uses_implementation_and_typed_member_mapping(self):
        self.assertEqual("Hidden_Run", self.shape["native"])
        self.assertEqual(("Journals", "Texts", "Events", "Balance"), tuple(self.shape[key] for key in ("objectPool", "listPool", "entriesField", "totalField")))
        bad = copy.deepcopy(self.bindings)
        bad[0]["implementation"] = None
        with self.assertRaisesRegex(ValueError, "SourceMap.implementation"): lab.observation_shape(bad, self.contract, self.mapping)

    def test_same_invocation_success_and_throw_keep_trace_and_total(self):
        self.assertEqual({"total": 43, "trace": ["before:42", "shared", "after"], "failure": None}, lab.observe_response(self.state(), self.shape, self.structures))
        self.assertEqual({"total": 42, "trace": ["before:42", "shared"], "failure": {"type": "System.InvalidOperationException", "message": "leaf failed", "paramName": None}}, lab.observe_response(self.state(True), self.shape, self.structures))

    def test_null_and_empty_list_items_are_distinct(self):
        body = self.state()
        body["Context"]["Texts"][0]["Items"] = [{}, {"HasValue": True}]
        self.assertEqual([None, ""], lab.observe_response(body, self.shape, self.structures)["trace"])

    def test_unowned_reference_and_incorrect_exception_index_rejected(self):
        body = self.state()
        body["Context"]["Journals"][0]["Events"]["Index"] = 0
        with self.assertRaisesRegex(ValueError, "invocation list"): lab.observe_response(body, self.shape, self.structures)
        body = self.state(True)
        body["Completion"]["ExceptionRef"] = 2
        with self.assertRaisesRegex(ValueError, "does not belong"): lab.observe_response(body, self.shape, self.structures)

    def test_separate_invocation_pool_and_wrong_scalar_types_rejected(self):
        body = self.state()
        body["Context"]["Journals"].append(copy.deepcopy(body["Context"]["Journals"][0]))
        with self.assertRaisesRegex(ValueError, "one fresh Run invocation"): lab.observe_response(body, self.shape, self.structures)
        body = self.state()
        body["Context"]["Texts"][0]["Items"][0]["HasValue"] = "false"
        with self.assertRaisesRegex(ValueError, "Boolean type"): lab.observe_response(body, self.shape, self.structures)

    def test_endpoints_authenticate_before_original_calls_without_business_copies(self):
        ops = lab.transport_ops(self.bindings, self.shape, self.contract)
        endpoints = [op for op in ops if op.get("type") == "IRestServiceAction"]
        self.assertEqual(6, len(endpoints))
        self.assertFalse(any(op.get("op") in {"logic", "delete", "duplicate"} or op.get("type") in {"IServerAction", "IServiceAction"} for op in ops))
        for endpoint in endpoints:
            name = endpoint["as"]
            self.assertIn({"op": "link", "from": name + "/#IStartNode", "to": name + "Auth"}, ops)
            self.assertIn({"op": "link", "from": name + "Auth", "to": name + "Execute"}, ops)
            self.assertIn({"op": "set", "target": name + "Auth", "prop": "Action", "value": "IServerAction:LabAuthenticate"}, ops)
        implementation_calls = [op for op in ops if op.get("prop") == "Action" and op.get("value") == "IServerAction:Hidden_Run"]
        self.assertEqual(1, len(implementation_calls))

    def test_receipt_must_contain_exact_combined_source(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bundle.json"
            bundle = {"csharpSource": {"files": {"ReferenceJournal.cs": lab.SOURCE.read_text(encoding="utf-8")}}}
            lab.write(path, bundle)
            with patch.object(lab.common, "verify_delivery", return_value={"specification": bundle}):
                lab.verify_source_delivery(Path("unused-receipt"), path)
            with patch.object(lab.common, "verify_delivery", return_value={"specification": {"csharpSource": {"files": {}}}}):
                with self.assertRaisesRegex(ValueError, "exact combined source bundle"): lab.verify_source_delivery(Path("unused-receipt"), path)

    def test_frozen_manifest_inputs_cannot_silently_change(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "frozen.json"
            lab.frozen_write(path, "original")
            with self.assertRaisesRegex(ValueError, "Frozen artifact differs"): lab.frozen_write(path, "replacement")


    def test_check_rejects_changed_probe_helper_and_compiler_hash_file(self):
        for changed in ("probe", "helper", "compiler-source"):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                evidence = work / "evidence.json"
                evidence.write_text("{}", encoding="utf-8")
                freeze = work / "oracle.freeze.json"
                freeze.write_text("{}", encoding="utf-8")
                proof = {
                    "files": {}, "sourceDelivery": str(evidence), "sourceDeliverySha256": lab.sha(evidence),
                    "sourceBundlePath": str(evidence), "sourceBundleSha256": lab.sha(evidence),
                    "contractPath": str(evidence), "contractSha256": lab.sha(evidence),
                    "sourceMapPath": str(evidence), "sourceMapSha256": lab.sha(evidence),
                    "oracleFreezeSha256": lab.sha(freeze),
                    "probeSha256": "changed" if changed == "probe" else lab.sha(lab.__file__),
                    "sharedHelperSha256": "changed" if changed == "helper" else lab.sha(lab.common.__file__),
                    "compilerSourceHashFile": {"path": str(evidence), "sha256": "changed" if changed == "compiler-source" else lab.sha(evidence)},
                }
                lab.write(work / "binding-proof.json", proof)
                with patch.object(lab, "verify_oracle", return_value=([], [], [], [])):
                    with self.assertRaisesRegex(ValueError, "Bound evidence changed"): lab.check(work)


if __name__ == "__main__": unittest.main()
