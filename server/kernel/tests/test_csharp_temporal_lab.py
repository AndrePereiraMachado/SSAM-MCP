"""Boundary tests for exact CLR carrier and explicit source-map test transport."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("temporal_lab", ROOT / "scripts/probes/highcode/csharp_temporal_lab.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class TemporalTransportTests(unittest.TestCase):
    structures = {
        "Duration": {"attributes": [{"name": "Ticks", "type": "Long Integer"}]},
        "Offset": {"attributes": [{"name": "UtcTicks", "type": "Long Integer"}, {"name": "OffsetMinutes", "type": "Integer"}]},
        "OptionalOffset": {"attributes": [{"name": "HasValue", "type": "Boolean"}, {"name": "Value", "type": "Offset"}]},
        "OptionalBool": {"attributes": [{"name": "HasValue", "type": "Boolean"}, {"name": "Value", "type": "Boolean"}]},
    }

    def test_large_ticks_round_trip_without_double_conversion(self):
        for value in (-9223372036854775808, -9007199254740993, 9007199254740993, 9223372036854775807):
            normalized = {"Ticks": str(value)}
            wire = probe.encode(normalized, {"kind": "duration"}, "Duration", self.structures)
            self.assertEqual(wire, {"Ticks": value})
            self.assertEqual(probe.decode(json.loads(json.dumps(wire)), {"kind": "duration"}, "Duration", self.structures), normalized)
        for value in (float(9007199254740993), True, 9223372036854775808):
            with self.assertRaises(ValueError):
                probe.decode({"Ticks": value}, {"kind": "duration"}, "Duration", self.structures)

    def test_offset_preserves_utc_ticks_and_signed_offset_independently(self):
        for minutes in (-840, 0, 840):
            value = {"UtcTicks": "3155378975999999999", "OffsetMinutes": minutes}
            wire = probe.encode(value, {"kind": "offset"}, "Offset", self.structures)
            self.assertEqual(probe.decode(wire, {"kind": "offset"}, "Offset", self.structures), value)
        with self.assertRaises(ValueError):
            probe.validate_schema({"kind": "offset"}, "Duration", self.structures)

    def test_omitted_defaults_are_not_filled_from_expected_results(self):
        self.assertEqual(probe.decode({}, {"kind": "offset"}, "Offset", self.structures), {"UtcTicks": "0", "OffsetMinutes": 0})
        schema = {"kind": "nullable", "value": {"kind": "bool"}}
        self.assertIsNone(probe.decode({}, schema, "OptionalBool", self.structures))
        self.assertIs(probe.decode({"HasValue": True}, schema, "OptionalBool", self.structures), False)
        for body in ({"HasValue": "false"}, {"Unknown": 0}):
            with self.assertRaises(ValueError): probe.decode(body, schema, "OptionalBool", self.structures)

    def sample_binding(self):
        methods = [{"source": "Instants.Make", "method": "Make", "inputs": [{"name": "ticks", "schema": {"kind": "long"}}, {"name": "offsetTicks", "schema": {"kind": "long"}}], "output": {"kind": "offset"}}]
        action = {"name": "CompilerRenamedMake_123", "kind": "server", "inputs": [{"name": "Arg_ticks", "type": "Long Integer"}, {"name": "Arg_offsetTicks", "type": "Long Integer"}], "outputs": [{"name": "AvResult", "type": "Offset"}], "steps": [{"raise": "ArgumentException", "message": '"observed native message"'}]}
        contract = {"logic": {"actions": [action]}, "data": {"structures": [dict(v, name=k) for k, v in self.structures.items()]}, "exceptions": [{"name": "ArgumentException"}]}
        source_map = [{"kind": "server", "source": "Instants.Make(long, long)", "native": "CompilerRenamedMake_123"}]
        return methods, contract, source_map

    def test_binding_uses_qualified_source_map_and_refuses_guessed_names(self):
        methods, contract, mapping = self.sample_binding()
        bindings, _ = probe.binding(methods, contract, mapping, "instants")
        self.assertEqual(bindings[0]["native"], "CompilerRenamedMake_123")
        self.assertEqual(bindings[0]["endpoint"], "InstantMake")
        for bad_mapping in ([], mapping * 2, [dict(mapping[0], source="Calendar.Make(long, long)")], [dict(mapping[0], native="Make")]):
            with self.assertRaises(ValueError): probe.binding(methods, contract, bad_mapping, "instants")
        changed = copy.deepcopy(contract)
        changed["logic"]["actions"][0]["inputs"][0]["name"] = "ticks"
        with self.assertRaises(ValueError): probe.binding(methods, changed, mapping, "instants")

    def test_additive_transport_calls_auth_then_original_and_preserves_failure(self):
        methods, contract, mapping = self.sample_binding()
        cases = [{"id": "invalid_offset", "method": "Make", "arguments": {"ticks": "0", "offsetTicks": "1"}}]
        expected = [{"id": "invalid_offset", "result": None, "error": {"type": "System.ArgumentException", "message": "CLR observed"}}]
        original = copy.deepcopy(contract)
        receipt = {"taskId": "unit-test", "specification": {"csharpSource": {"files": {"Instants.cs": probe.INSTANT_SOURCE.read_text(encoding="utf-8")}}}}
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            for name, value in [("contract.json", contract), ("map.json", mapping), ("oracle.freeze.json", {})]: probe.write(work / name, value)
            with patch.object(probe, "verify_oracle", return_value=(methods, cases, expected)), patch.object(probe, "verify_delivery", return_value=receipt):
                probe.build(work, work / "contract.json", work / "map.json", work / "delivery.json", "instants")
            ops = probe.read(work / "transport.json")["ops"]
        self.assertEqual(contract, original)
        self.assertFalse(any(op["op"] in ("delete", "rename", "move", "logic") for op in ops))
        creates = [op for op in ops if op["op"] == "create"]
        self.assertEqual([op["name"] for op in creates if op["type"] == "IRestServiceAction"], ["InstantMake"])
        self.assertFalse(any(op["type"] in ("IRestService", "IServerAction") for op in creates))
        calls = [op["value"] for op in ops if op["op"] == "set" and op["prop"] == "Action"]
        self.assertEqual(calls, ["IServerAction:LabAuthenticate", "IServerAction:CompilerRenamedMake_123"])
        links = [op for op in ops if op["op"] == "link"]
        self.assertIn({"op": "link", "from": "$InstantMakeAuth", "to": "$InstantMakeExecute"}, links)
        values = [op["value"] for op in ops if op["op"] == "set" and op["prop"] == "Value"]
        self.assertIn('"System.ArgumentException"', values)
        self.assertIn("SourceException0.ExceptionMessage", values)
        self.assertNotIn('"CLR observed"', values)

    def test_replacement_reuses_abi_and_only_deletes_owned_endpoints(self):
        methods, contract, mapping = self.sample_binding()
        cases = [{"id": "invalid_offset", "method": "Make", "arguments": {"ticks": "0", "offsetTicks": "1"}}]
        expected = [{"id": "invalid_offset", "result": None, "error": {"type": "System.ArgumentException", "message": "CLR observed"}}]
        receipt = {"taskId": "unit-test", "specification": {"csharpSource": {"files": {"Instants.cs": probe.INSTANT_SOURCE.read_text(encoding="utf-8")}}}}
        with tempfile.TemporaryDirectory() as tmp:
            old, new = Path(tmp) / "old", Path(tmp) / "new"
            old.mkdir(); new.mkdir()
            for work in (old, new):
                for name, value in [("contract.json", contract), ("map.json", mapping), ("oracle.freeze.json", {})]: probe.write(work / name, value)
            with patch.object(probe, "verify_oracle", return_value=(methods, cases, expected)), patch.object(probe, "verify_delivery", return_value=receipt):
                probe.build(old, old / "contract.json", old / "map.json", old / "delivery.json", "instants")
                previous_hash = probe.sha(old / "transport.json")
                probe.build(new, new / "contract.json", new / "map.json", new / "delivery.json", "instants", replace=True, previous_transport=old / "transport.json")
                with self.assertRaisesRegex(ValueError, "already contains transport evidence"):
                    probe.build(new, new / "contract.json", new / "map.json", new / "delivery.json", "instants", replace=True, previous_transport=old / "transport.json")
            ops = probe.read(new / "transport.json")["ops"]
            self.assertEqual(probe.sha(old / "transport.json"), previous_hash)
            self.assertEqual(probe.sha(new / "previous-transport.json"), previous_hash)
            proof = probe.read(new / "binding-proof.json")
            self.assertEqual(proof["previousTransportSha256"], previous_hash)
        self.assertEqual([op for op in ops if op["op"] == "delete"], [{"op": "delete", "target": "IRestService:CSharpLab/InstantMake"}])
        self.assertFalse(any(op["op"] == "spec" for op in ops))
        self.assertFalse(any(op["op"] == "create" and op["type"] in ("IRestService", "IServerAction", "IStructure") for op in ops))
        self.assertEqual([op["value"] for op in ops if op["op"] == "set" and op["prop"] == "Action"], ["IServerAction:LabAuthenticate", "IServerAction:CompilerRenamedMake_123"])

    def test_replacement_refuses_envelope_endpoint_or_route_drift(self):
        bindings = [{"endpoint": "InstantMake"}]
        ops = [
            {"op": "spec", "data": {"structures": [{"name": "Response", "attributes": [{"name": "Result", "type": "Long Integer"}]}]}},
            {"op": "create", "parent": "IRestService:CSharpLab", "type": "IRestServiceAction", "name": "InstantMake", "as": "$InstantMake"},
            {"op": "set", "target": "$InstantMake", "prop": "URLPath", "value": "/InstantMake"},
            {"op": "create", "parent": "$InstantMake", "type": "IRestServiceActionOutput", "name": "Response", "as": "$Output"},
            {"op": "set", "target": "$Output", "prop": "DataType", "value": "Response"},
        ]
        probe.validate_replacement({"ops": ops}, ops, bindings)
        for mutation in ("envelope", "missing_endpoint", "extra_endpoint", "duplicate_endpoint", "other_service", "route", "response_type"):
            changed = copy.deepcopy(ops)
            if mutation == "envelope": changed[0]["data"]["structures"][0]["attributes"][0]["type"] = "Decimal"
            elif mutation == "missing_endpoint": changed.pop(1)
            elif mutation == "extra_endpoint": changed.append(dict(changed[1], name="UnownedEndpoint"))
            elif mutation == "duplicate_endpoint": changed.append(copy.deepcopy(changed[1]))
            elif mutation == "other_service": changed[1]["parent"] = "IRestService:OtherLab"
            elif mutation == "route": changed[2]["value"] = "/WrongRoute"
            elif mutation == "response_type": changed[4]["value"] = "DifferentResponse"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                probe.validate_replacement({"ops": changed}, ops, bindings)

    def test_replacement_requires_separate_work_and_original_transport(self):
        unused = Path("unused")
        for replace, previous in ((True, None), (False, unused)):
            with self.assertRaisesRegex(ValueError, "requires both"):
                probe.build(unused, unused, unused, unused, replace=replace, previous_transport=previous)
        with self.assertRaisesRegex(ValueError, "explicit new work directory"):
            probe.build(probe.INSTANT_WORK, unused, unused, unused, replace=True, previous_transport=unused)
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            with self.assertRaisesRegex(ValueError, "explicit new work directory"):
                probe.build(work, unused, unused, unused, replace=True, previous_transport=work / "previous.json")

    def test_calendar_defaults_still_select_original_source_and_endpoint(self):
        self.assertEqual(probe.corpus_settings("calendar"), (probe.SOURCE, "TemporalValues.cs", 21, "Calendar", "Temporal"))
        with self.assertRaises(ValueError): probe.corpus_settings("guessed")


if __name__ == "__main__": unittest.main()
