"""Additive transport for the immutable ColdReferenceJournal CLR oracle.

prepare/build/check/compare are offline. run is an explicit, separately gated
laboratory action. No CLR oracle is compiled or rerun by this program. Public
wrappers and internal exception completion observations are separate evidence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import secrets
import shutil
import time
import urllib.error
import urllib.request

import csharp_reference_lab as reference
import csharp_temporal_lab as common

ROOT = common.ROOT
WORK = ROOT / ".local/data-logic-translator/cold-reference-lab"
SOURCE = ROOT / "tests/csharp/ColdReferenceJournal.cs.txt"
ORACLE_DIR = ROOT / "tests/csharp/oracles/ColdReferenceJournal"
OWNER = "ColdReferenceJournal"
read, write, sha, frozen_write = common.read, common.write, common.sha, common.frozen_write
PUBLIC_SCOPE = "original-public-wrapper: return or exception type/message"
INTERNAL_SCOPE = "internal-original-implementation: completion exception type/message/HResult/ParamName/ActualValue/InnerRef"
EXCLUDED = ["CLR stackTrace", "Source", "TargetSite", "fullText", "public wrapper context exposure"]
# These are the independently frozen inputs, not regenerated expectations.
FROZEN_HASHES = {
    "source": "80292620b436d7cbc08257ae468a9faef7c27dc4960b5d5456854314d2590b11",
    "inputs": "763317e36be6aa443155d7197faa46ff7d397ea3c0fb5105ada45593ffd72e3f",
    "expected": "a0ffc6a828cf54ddbe41806cc9942ab2dd2b8484c31090964c22d73cca39536f",
}
EXCEPTION_FIELDS = {
    "TypeName": "Text", "Message": "Text", "ParamName": "Text",
    "HasParamName": "Boolean", "InnerRef": "Integer", "HasHResult": "Boolean",
    "HResult": "Integer", "HasActualValue": "Boolean", "ActualValueType": "Text",
    "ActualValueInteger": "Integer", "ActualValueLong": "Long Integer",
    "ActualValueText": "Text", "ActualValueBoolean": "Boolean",
}
EXCEPTION_TYPES = {name: "System." + name for name in (
    "ApplicationException", "ArgumentException", "ArgumentNullException",
    "ArgumentOutOfRangeException", "InvalidOperationException", "NullReferenceException",
)}


def source_methods():
    """Read only signatures from this hash-pinned corpus, never business bodies."""
    source = SOURCE.read_text(encoding="utf-8")
    declarations = re.findall(r"\b(public|private) static (string|void|int) (\w+)\(([^)]*)\)", source)
    if len(declarations) != 23: raise ValueError("Frozen source method count changed")
    methods = []
    clr = {"int": "System.Int32", "bool": "System.Boolean", "string": "System.String", "string?": "System.String"}
    for access, result, name, parameters in declarations:
        if access != "public": continue
        inputs = []
        for parameter in parameters.split(",") if parameters else []:
            kind, label = parameter.strip().split()
            if kind not in clr: raise ValueError("Unrecognized frozen source parameter")
            inputs.append({"name": label, "sourceType": kind, "clrType": clr[kind]})
        if result != "string": raise ValueError("Frozen public result must be string")
        methods.append({"method": name, "source": OWNER + "." + name + "(" + ", ".join(p["sourceType"] for p in inputs) + ")", "inputs": inputs, "returnType": "System.String"})
    if len(methods) != 11: raise ValueError("Frozen public surface changed")
    return methods


def baseline():
    paths = {"source": SOURCE, "inputs": ORACLE_DIR / "inputs.json", "expected": ORACLE_DIR / "expected.json"}
    for name, path in paths.items():
        if sha(path) != FROZEN_HASHES[name]: raise ValueError("Frozen CLR artifact changed: " + name)
    inputs, report = read(paths["inputs"]), read(paths["expected"])
    if report["runtime"]["environmentVersion"] != "8.0.18": raise ValueError("Frozen CLR runtime drift")
    if report["sources"]["corpus"]["sha256"] != FROZEN_HASHES["source"] or report["sources"]["inputs"]["sha256"] != FROZEN_HASHES["inputs"]:
        raise ValueError("Oracle does not attest these frozen source/inputs")
    cases, expected, methods = inputs["cases"], report["cases"], source_methods()
    if report["counts"] != {"methods": 11, "cases": 38, "successful": 33, "thrown": 5}: raise ValueError("Frozen case count changed")
    if len(cases) != 38 or len(expected) != 38 or len({c["id"] for c in cases}) != 38: raise ValueError("Invalid frozen case identities")
    by_method = {m["method"]: m for m in methods}
    if set(by_method) != {c["method"] for c in cases}: raise ValueError("Every original public method requires coverage")
    for case, observed in zip(cases, expected):
        if any(case[key] != observed[key] for key in ("id", "method", "arguments")): raise ValueError("Oracle input case mismatch")
        method = by_method[case["method"]]
        if observed["returnType"] != method["returnType"] or observed["parameterTypes"] != [p["clrType"] for p in method["inputs"]]: raise ValueError("CLR signature mismatch")
        outcome = observed["expected"]
        if outcome["kind"] == "return":
            if not isinstance(outcome["value"], str) or outcome["exception"] is not None: raise ValueError("Invalid CLR return")
        elif outcome["kind"] == "throw":
            if outcome["value"] is not None or not isinstance(outcome["exception"], dict): raise ValueError("Invalid CLR throw")
        else: raise ValueError("Unknown CLR completion")
    if sum(e["expected"]["kind"] == "throw" for e in expected) != 5: raise ValueError("Frozen exception coverage changed")
    return methods, cases, expected


def prepare(work):
    methods, cases, expected = baseline()
    work.mkdir(parents=True, exist_ok=True)
    files = {"ColdReferenceJournal.cs.txt": SOURCE, "inputs.json": ORACLE_DIR / "inputs.json", "expected.json": ORACLE_DIR / "expected.json"}
    for name, source in files.items(): frozen_write(work / name, source.read_bytes())
    frozen_write(work / "methods.json", common.serialized(methods))
    manifest = {"schema": "cold-reference-lab-baseline-v1", "originals": {name: {"path": str(path.resolve()), "sha256": sha(path)} for name, path in files.items()}, "files": {name: sha(work / name) for name in [*files, "methods.json"]}, "counts": {"sourceMethods": 23, "publicMethods": len(methods), "publicCases": len(cases), "publicReturns": 33, "publicThrows": 5, "internalExceptionObservations": 5}, "runtime": read(ORACLE_DIR / "expected.json")["runtime"], "oracleReexecuted": False, "excludedEvidence": EXCLUDED}
    frozen_write(work / "oracle.freeze.json", common.serialized(manifest))
    return verify_oracle(work)


def verify_oracle(work):
    result = baseline()
    freeze = read(work / "oracle.freeze.json")
    for name, digest in freeze["files"].items():
        if sha(work / name) != digest: raise ValueError("Frozen laboratory baseline changed: " + name)
    if read(work / "methods.json") != result[0]: raise ValueError("Frozen source signatures changed")
    for name, path in {"source": work / "ColdReferenceJournal.cs.txt", "inputs": work / "inputs.json", "expected": work / "expected.json"}.items():
        if sha(path) != FROZEN_HASHES[name]: raise ValueError("Laboratory baseline differs from independent oracle")
    return result


def native_schema(clr_type, kind, structures):
    """Native types decide whether Text requires an explicit presence carrier."""
    if clr_type == "System.String" and kind in structures:
        if common.fields(kind, structures) != {"HasValue": "Boolean", "Value": "Text"}: raise ValueError("String presence carrier shape drift")
        schema = {"kind": "nullable", "value": {"kind": "string"}}
    else:
        tags = {"System.String": "string", "System.Int32": "int", "System.Boolean": "bool"}
        if clr_type not in tags: raise ValueError("Unsupported laboratory CLR scalar")
        schema = {"kind": tags[clr_type]}
    common.validate_schema(schema, kind, structures)
    return schema


def bind(methods, contract, source_map):
    actions = {a["name"]: a for a in contract["logic"]["actions"]}
    structures = {s["name"]: s for s in contract["data"]["structures"]}
    if len(actions) != len(contract["logic"]["actions"]) or len(structures) != len(contract["data"]["structures"]): raise ValueError("Duplicate native action or structure names")
    bindings = []
    for method in methods:
        matches = [entry for entry in source_map if entry.get("kind") == "server" and entry.get("source") == method["source"]]
        if len(matches) != 1: raise ValueError("Require exact source symbol in SourceMap: " + method["source"])
        entry = matches[0]
        action = actions.get(entry.get("native"))
        if action is None or action.get("public") is not True or action.get("kind") != "server": raise ValueError("Original public wrapper required")
        if len(action["inputs"]) != len(method["inputs"]) or len(action["outputs"]) != 1: raise ValueError("Native public arity mismatch")
        parameters = []
        for declared, native in zip(method["inputs"], action["inputs"]):
            if native["name"] != "Arg_" + declared["name"]: raise ValueError("Explicit source parameter mapping required")
            parameters.append({"source": declared["name"], "native": native["name"], "type": native["type"], "schema": native_schema(declared["clrType"], native["type"], structures)})
        output = action["outputs"][0]
        bindings.append({"method": method["method"], "source": entry["source"], "native": entry["native"], "implementation": entry.get("implementation"), "endpoint": "ColdReference" + method["method"], "inputs": parameters, "output": dict(output, schema=native_schema(method["returnType"], output["type"], structures)), "evidenceScope": PUBLIC_SCOPE})
    if len({b["native"] for b in bindings}) != len(bindings): raise ValueError("SourceMap native alias collision")
    return bindings, structures


def observation_shapes(bindings, contract, expected):
    actions = {a["name"]: a for a in contract["logic"]["actions"]}
    structures = {s["name"]: s for s in contract["data"]["structures"]}
    throwing = {e["method"] for e in expected if e["expected"]["kind"] == "throw"}
    shapes = []
    for binding in bindings:
        if binding["method"] not in throwing: continue
        action = actions.get(binding.get("implementation"))
        if action is None or action.get("public") is not False or action.get("kind") != "server": raise ValueError("Internal original action must come from SourceMap.implementation")
        inputs = {p["name"]: p["type"] for p in action["inputs"]}
        outputs = {p["name"]: p["type"] for p in action["outputs"]}
        if set(outputs) != {"AvContextOut", "AvCompletion", "AvResult"} or outputs["AvResult"] != binding["output"]["type"]: raise ValueError("Internal result/completion ABI drift")
        context, completion = outputs["AvContextOut"], outputs["AvCompletion"]
        if inputs != {"AvContextIn": context, **{p["native"]: p["type"] for p in binding["inputs"]}}: raise ValueError("Internal invocation input ABI drift")
        if common.fields(completion, structures) != {"Kind": "Integer", "ExceptionRef": "Integer"}: raise ValueError("Completion ABI drift")
        context_fields = common.fields(context, structures)
        exception_list = context_fields.get("Exceptions", "")
        if not exception_list.endswith(" List") or common.fields(exception_list[:-5], structures) != EXCEPTION_FIELDS: raise ValueError("Complete typed exception ABI required")
        shapes.append(dict(binding, native=binding["implementation"], endpoint="ColdReferenceInternal" + binding["method"], contextType=context, completionType=completion, exceptionType=exception_list[:-5], evidenceScope=INTERNAL_SCOPE))
    if len(shapes) != len(throwing): raise ValueError("Missing original throwing method observation")
    return shapes


def public_expected(item):
    outcome = item["expected"]
    if outcome["kind"] == "return": return {"result": outcome["value"], "error": None}
    error = outcome["exception"]
    return {"result": None, "error": {"type": error["type"], "message": error["message"]}}


def internal_expected(item):
    error = item["expected"]["exception"]
    if item["expected"]["kind"] != "throw" or error is None: raise ValueError("Internal observer requires an original throw case")
    if error["innerException"] is not None: raise ValueError("This frozen corpus requires no inner exception")
    return {"type": error["type"], "message": error["message"], "hResult": error["hResult"], "paramName": error["paramName"], "actualValue": error["actualValue"], "innerRef": 0}


def public_response(body, binding, structures):
    if not isinstance(body, dict) or set(body) - {"Result", "FailureType", "FailureMessage"}: raise ValueError("Unexpected public response envelope")
    error_type, message = body.get("FailureType", ""), body.get("FailureMessage", "")
    if not isinstance(error_type, str) or not isinstance(message, str): raise ValueError("Exception envelope types")
    if error_type: return {"result": None, "error": {"type": error_type, "message": message}}
    if message: raise ValueError("Failure message without exception type")
    output = binding["output"]
    result = common.decode(body.get("Result", common.native_default(output["type"], structures)), output["schema"], output["type"], structures)
    return {"result": result, "error": None}


def observe_response(body, shape, structures):
    if not isinstance(body, dict) or set(body) - {"Context", "Completion", "Result"}: raise ValueError("Unexpected internal response envelope")
    context = reference.typed_value(body.get("Context", {}), shape["contextType"], structures)
    completion = reference.typed_value(body.get("Completion", {}), shape["completionType"], structures)
    if completion["Kind"] != 2: raise ValueError("Throw completion required for this observer")
    index = completion["ExceptionRef"]
    if not 1 <= index <= len(context["Exceptions"]): raise ValueError("Completion exception does not belong to this invocation")
    error = context["Exceptions"][index - 1]
    if not error["HasHResult"]: raise ValueError("Completion lacks HResult presence")
    inner = error["InnerRef"]
    if inner != 0 and not 1 <= inner <= len(context["Exceptions"]): raise ValueError("Inner exception reference outside invocation")
    actual = None
    if error["HasActualValue"]:
        field = {"System.Int32": "ActualValueInteger", "System.Int64": "ActualValueLong", "System.String": "ActualValueText", "System.Boolean": "ActualValueBoolean"}.get(error["ActualValueType"])
        if field is None: raise ValueError("Unknown ActualValue typed discriminator")
        actual = error[field]
    elif error["ActualValueType"]:
        raise ValueError("ActualValue type without presence")
    return {"type": error["TypeName"], "message": error["Message"], "hResult": error["HResult"], "paramName": error["ParamName"] if error["HasParamName"] else None, "actualValue": actual, "innerRef": inner}


def envelope_name(endpoint, suffix):
    name = "AvLab" + endpoint + suffix
    return name if len(name) <= 48 else name[:37] + "_" + hashlib.sha256(name.encode("utf-8")).hexdigest()[:10]


def transport_ops(bindings, shapes, contract):
    """Only REST envelopes, authentication, original calls and response assignments."""
    actions = {a["name"]: a for a in contract["logic"]["actions"]}
    ops, types = [], []
    for binding in [*bindings, *shapes]:
        internal = binding["evidenceScope"] == INTERNAL_SCOPE
        attributes = [{"name": "Result", "type": binding["output"]["type"]}]
        attributes += ([{"name": "Context", "type": binding["contextType"]}, {"name": "Completion", "type": binding["completionType"]}] if internal else [{"name": "FailureType", "type": "Text"}, {"name": "FailureMessage", "type": "Text"}])
        types.append({"name": envelope_name(binding["endpoint"], "Response"), "attributes": attributes})
        if binding["inputs"]: types.append({"name": envelope_name(binding["endpoint"], "Request"), "attributes": [{"name": p["native"], "type": p["type"]} for p in binding["inputs"]]})
    if len({t["name"] for t in types}) != len(types): raise ValueError("Envelope names collide after native normalization")
    if {t["name"] for t in types} & {s["name"] for s in contract["data"]["structures"]}: raise ValueError("Additive transport refuses existing envelopes")
    ops.append({"op": "spec", "data": {"structures": types}})
    def create(parent, kind, alias, name=None):
        op = {"op": "create", "parent": parent, "type": kind, "as": alias}
        if name is not None: op["name"] = name
        ops.append(op)
        return alias
    def setting(target, prop, value): ops.append({"op": "set", "target": target, "prop": prop, "value": value})
    def link(start, end): ops.append({"op": "link", "from": start, "to": end})
    for binding in [*bindings, *shapes]:
        internal, name = binding["evidenceScope"] == INTERNAL_SCOPE, binding["endpoint"]
        method = create("IRestService:CSharpLab", "IRestServiceAction", "$" + name, name)
        setting(method, "HTTPMethod", "POST"); setting(method, "URLPath", "/" + name)
        key = create(method, "IRestServiceActionInput", method + "Key", "LabKey")
        setting(key, "DataType", "Text"); setting(key, "ReceiveIn", "Header"); setting(key, "IsMandatory", True)
        if binding["inputs"]:
            payload = create(method, "IRestServiceActionInput", method + "Payload", "Payload")
            setting(payload, "DataType", envelope_name(name, "Request")); setting(payload, "ReceiveIn", "Body"); setting(payload, "IsMandatory", True)
        response = create(method, "IRestServiceActionOutput", method + "Response", "Response")
        setting(response, "DataType", envelope_name(name, "Response")); setting(response, "SendIn", "Body")
        auth = create(method, "IExecuteServerActionNode", method + "Auth", "AuthenticateLab")
        setting(auth, "Action", "IServerAction:LabAuthenticate"); setting(auth + "/LabKey", "Value", "LabKey")
        execute = create(method, "IExecuteServerActionNode", method + "Execute", "ExecuteReference")
        setting(execute, "Action", "IServerAction:" + binding["native"])
        for parameter in binding["inputs"]: setting(execute + "/" + parameter["native"], "Value", "Payload." + parameter["native"])
        values = [("Result", "ExecuteReference." + binding["output"]["name"])]
        if internal:
            context = create(method, "ILocalVariable", method + "InitialContext", "InitialContext")
            setting(context, "DataType", binding["contextType"])
            setting(execute + "/AvContextIn", "Value", "InitialContext")
            values += [("Context", "ExecuteReference.AvContextOut"), ("Completion", "ExecuteReference.AvCompletion")]
        assign = create(method, "IAssignNode", method + "Assign", "SetResponse")
        for field_name, value in values:
            field = create(assign, "IAssignment", method + field_name)
            setting(field, "Variable", "Response." + field_name); setting(field, "Value", value)
        link(method + "/#IStartNode", auth); link(auth, execute); link(execute, assign); link(assign, method + "/#IEndNode")
        if not internal:
            for number, exception in enumerate(common.declared_exceptions(actions[binding["native"]], contract)):
                if exception not in EXCEPTION_TYPES: raise ValueError("Explicit CLR exception mapping required: " + exception)
                prefix, handler_name = method + "Error" + str(number), "SourceException" + str(number)
                handler = create(method, "IExceptionHandlerNode", prefix, handler_name)
                setting(handler, "Exception", "IUserException:" + exception); setting(handler, "AbortTransaction", False); setting(handler, "LogError", False)
                failure = create(method, "IAssignNode", prefix + "Assign", "SetFailure" + str(number))
                for field_name, value in [("FailureType", '"' + EXCEPTION_TYPES[exception] + '"'), ("FailureMessage", handler_name + ".ExceptionMessage")]:
                    field = create(failure, "IAssignment", prefix + field_name)
                    setting(field, "Variable", "Response." + field_name); setting(field, "Value", value)
                end = create(method, "IEndNode", prefix + "End")
                link(handler, failure); link(failure, end)
        ops.append({"op": "layout", "target": method})
    return ops


def requests_and_targets(cases, expected, bindings, shapes, structures):
    requests, targets = [], {}
    expectations = {item["id"]: item for item in expected}
    for group, internal in [(bindings, False), (shapes, True)]:
        by_method = {item["method"]: item for item in group}
        for case in cases:
            observed = expectations[case["id"]]
            if internal and observed["expected"]["kind"] != "throw": continue
            binding = by_method[case["method"]]
            identity = ("internal:" if internal else "") + case["id"]
            payload = {p["native"]: common.encode(value, p["schema"], p["type"], structures) for p, value in zip(binding["inputs"], case["arguments"])}
            if len(binding["inputs"]) != len(case["arguments"]): raise ValueError("Original arguments must all be transported")
            requests.append({"id": identity, "oracleCaseId": case["id"], "method": case["method"], "endpoint": binding["endpoint"], "evidenceScope": binding["evidenceScope"], "payload": payload})
            targets[identity] = internal_expected(observed) if internal else public_expected(observed)
    return requests, targets


def verify_source_delivery(path, bundle_path):
    receipt = common.verify_delivery(path)
    bundle = read(bundle_path)
    if receipt.get("specification", {}).get("csharpSource") != bundle.get("csharpSource"): raise ValueError("Receipt does not prove exact source bundle")
    source_files = bundle.get("csharpSource", {}).get("files", {})
    original = SOURCE.read_text(encoding="utf-8")
    if list(source_files.values()).count(original) != 1: raise ValueError("Exact original cold source must occur once in delivered bundle")
    if sha(bundle_path) not in {item["sha256"].lower() for item in receipt.get("sources", [])}: raise ValueError("Source bundle hash absent from successful receipt")
    return receipt


def build(work, contract_path, map_path, source_delivery, bundle_path):
    started = time.perf_counter()
    methods, cases, expected = verify_oracle(work)
    receipt = verify_source_delivery(source_delivery, bundle_path)
    contract, source_map = read(contract_path), read(map_path)
    bindings, structures = bind(methods, contract, source_map)
    shapes = observation_shapes(bindings, contract, expected)
    ops = transport_ops(bindings, shapes, contract)
    requests, targets = requests_and_targets(cases, expected, bindings, shapes, structures)
    contents = {"transport.json": {"description": "Additive authenticated ColdReferenceJournal transport: 11 original public wrappers plus 3 separate internal exception observers; zero business body copies", "expectValid": True, "expectedMessages": [], "ops": ops}, "bindings.json": bindings, "observation-shapes.json": shapes, "requests.json": requests, "targets.json": targets, "bound-contract.json": contract, "bound-source-map.json": source_map}
    for name, value in contents.items(): frozen_write(work / name, common.serialized(value))
    evidence_paths = {"sourceDelivery": source_delivery, "sourceBundle": bundle_path, "contract": contract_path, "sourceMap": map_path, "oracleFreeze": work / "oracle.freeze.json", "probe": Path(__file__), "referenceHelper": Path(reference.__file__), "temporalHelper": Path(common.__file__)}
    hash_path = contract_path.parent / "source-hash.txt"
    if hash_path.exists(): evidence_paths["compilerSourceHash"] = hash_path
    source_entries = [m for m in source_map if m.get("kind") == "server" and m.get("source", "").startswith(OWNER + ".")]
    if len(source_entries) != 23: raise ValueError("All 23 original source methods must be mapped")
    native_names = {entry[key] for entry in source_entries for key in ("native", "implementation") if entry.get(key)}
    proof = {"schema": "cold-reference-lab-binding-v1", "environment": common.HOST, "module": common.MODULE, "taskId": receipt["taskId"], "evidence": {name: {"path": str(Path(path).resolve()), "sha256": sha(path)} for name, path in evidence_paths.items()}, "files": {name: sha(work / name) for name in contents}, "counts": {"sourceMethods": 23, "sourcePublicMethods": len(bindings), "sourceNativeActions": len(native_names), "publicEndpoints": len(bindings), "internalObservationEndpoints": len(shapes), "publicCases": len(cases), "publicReturns": 33, "publicThrows": 5, "internalExceptionObservations": len(requests) - len(cases), "requests": len(requests), "ops": len(ops), "businessBodyCopies": 0}, "identicalStepBodies": reference.duplicate_bodies([a for a in contract["logic"]["actions"] if a["name"] in native_names]), "excludedEvidence": EXCLUDED}
    frozen_write(work / "binding-proof.json", common.serialized(proof))
    write(work / "build-timings.json", {"totalSeconds": time.perf_counter() - started, "liveRequests": 0, "oracleReexecuted": False})
    check(work)
    return proof["counts"]


def check(work):
    methods, cases, expected = verify_oracle(work)
    if (work / "binding-proof.json").exists():
        proof = read(work / "binding-proof.json")
        if proof["environment"] != common.HOST or proof["module"] != common.MODULE: raise ValueError("Personal laboratory target drift")
        for name, digest in proof["files"].items():
            if sha(work / name) != digest: raise ValueError("Frozen transport changed: " + name)
        for item in proof["evidence"].values():
            if sha(item["path"]) != item["sha256"]: raise ValueError("Bound evidence changed: " + item["path"])
        evidence = proof["evidence"]
        verify_source_delivery(Path(evidence["sourceDelivery"]["path"]), Path(evidence["sourceBundle"]["path"]))
        contract, source_map = read(work / "bound-contract.json"), read(work / "bound-source-map.json")
        if contract != read(evidence["contract"]["path"]) or source_map != read(evidence["sourceMap"]["path"]): raise ValueError("Exact compiler contract/map differs")
        bindings, structures = bind(methods, contract, source_map)
        shapes = observation_shapes(bindings, contract, expected)
        requests, targets = requests_and_targets(cases, expected, bindings, shapes, structures)
        if bindings != read(work / "bindings.json") or shapes != read(work / "observation-shapes.json"): raise ValueError("Source bindings changed")
        if requests != read(work / "requests.json") or targets != read(work / "targets.json"): raise ValueError("Requests/targets differ from frozen oracle")
        if transport_ops(bindings, shapes, contract) != read(work / "transport.json")["ops"]: raise ValueError("Transport contains unrelated mutations or business copies")
    return {"localChecksPassed": True, "publicMethods": len(methods), "publicCases": len(cases), "publicReturns": 33, "publicThrows": 5, "internalExceptionObservations": 5, "transportBuilt": (work / "binding-proof.json").exists(), "liveRequests": 0}


def compare_response(item, body, bindings, shapes, structures):
    if isinstance(body, dict) and set(body) == {"Response"}: body = body["Response"]
    if item["evidenceScope"] == INTERNAL_SCOPE: return observe_response(body, shapes[item["method"]], structures)
    return public_response(body, bindings[item["method"]], structures)


def compare(work, responses):
    check(work)
    bindings = {b["method"]: b for b in read(work / "bindings.json")}
    shapes = {s["method"]: s for s in read(work / "observation-shapes.json")}
    structures = {s["name"]: s for s in read(work / "bound-contract.json")["data"]["structures"]}
    requests, targets = read(work / "requests.json"), read(work / "targets.json")
    if not isinstance(responses, dict) or set(responses) != {r["id"] for r in requests}: raise ValueError("Exactly all 43 public/internal responses required")
    results = []
    for item in requests:
        actual = compare_response(item, responses[item["id"]], bindings, shapes, structures)
        results.append({"id": item["id"], "evidenceScope": item["evidenceScope"], "expected": targets[item["id"]], "actual": actual, "passed": actual == targets[item["id"]]})
    return results


def run(work, transport_delivery, publication_path, secret_path):
    """Only invoked explicitly after source/transport delivery and publication gates."""
    check(work)
    receipt = common.verify_delivery(transport_delivery)
    if sha(work / "transport.json") not in {i["sha256"].lower() for i in receipt.get("sources", []) + receipt.get("artifacts", [])}: raise ValueError("Receipt does not prove this exact transport")
    publication = read(publication_path)
    if publication.get("Completed") is not True or publication.get("HasErrors") is not False or not publication.get("VersionId"): raise ValueError("Confirmed successful publication required")
    key = read(secret_path)["key"]
    if not isinstance(key, str) or not key: raise ValueError("Laboratory key missing")
    run_dir = work / "runs" / (time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(4))
    run_dir.mkdir(parents=True)
    for path in work.iterdir():
        if path.is_file() and path.suffix in (".json", ".txt"): shutil.copyfile(path, run_dir / path.name)
    for source, name in [(publication_path, "confirmed-publication.json"), (transport_delivery, "transport-delivery.json"), (Path(__file__), "probe.py")]: shutil.copyfile(source, run_dir / name)
    requests = read(work / "requests.json")
    responses, execution = {}, []
    # No redirects can send the header to another host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl): return None
    opener = urllib.request.build_opener(NoRedirect)
    for item, invalid in [(requests[0], True)] + [(r, False) for r in requests]:
        before = time.perf_counter()
        request = urllib.request.Request("https://" + common.HOST + "/" + common.MODULE + "/rest/CSharpLab/" + item["endpoint"], data=json.dumps(item["payload"]).encode("utf-8"), headers={"LabKey": "invalid-key" if invalid else key, "Content-Type": "application/json"}, method="POST")
        status, wire, failure = 0, "", None
        try:
            with opener.open(request, timeout=60) as response: status, wire = response.status, response.read().decode("utf-8")
        except urllib.error.HTTPError as error: status, wire = error.code, error.read().decode("utf-8")
        except Exception as error: failure = type(error).__name__
        # Avoid persisting any server reflection of the key.
        wire = wire.replace(key, "[redacted]")
        if not invalid and status == 200:
            try: responses[item["id"]] = json.loads(wire)
            except ValueError: failure = "Invalid JSON response"
        denied = invalid and status in (400, 401, 403, 500) and ("LabAccessDenied" in wire or "Invalid laboratory key." in wire)
        execution.append({"id": item["id"], "invalidKey": invalid, "status": status, "denied": denied, "evidenceScope": item["evidenceScope"], "wire": wire, "failure": failure, "seconds": time.perf_counter() - before})
        write(run_dir / "execution.json", execution)
        print(json.dumps({"id": item["id"], "invalidKey": invalid, "status": status}), flush=True)
        if invalid and not denied: raise ValueError("Existing laboratory guard did not reject invalid key")
    write(run_dir / "responses.json", responses)
    results = compare(work, responses)
    write(run_dir / "comparison.json", results)
    write(run_dir / "hashes.json", {p.name: sha(p) for p in run_dir.iterdir() if p.is_file()})
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "build", "check", "compare", "run"))
    parser.add_argument("--work", type=Path, default=WORK)
    parser.add_argument("--contract", type=Path)
    parser.add_argument("--mapping", type=Path)
    parser.add_argument("--source-bundle", type=Path)
    parser.add_argument("--source-delivery", type=Path)
    parser.add_argument("--transport-delivery", type=Path)
    parser.add_argument("--publication", type=Path)
    parser.add_argument("--secrets", type=Path)
    parser.add_argument("--responses", type=Path)
    args = parser.parse_args()
    if args.mode == "prepare": prepare(args.work); print(json.dumps(check(args.work)))
    elif args.mode == "check": print(json.dumps(check(args.work)))
    elif args.mode == "build":
        if any(getattr(args, name) is None for name in ("contract", "mapping", "source_delivery", "source_bundle")): parser.error("build requires exact --contract, --mapping, --source-delivery, --source-bundle")
        print(json.dumps(build(args.work, args.contract, args.mapping, args.source_delivery, args.source_bundle)))
    elif args.mode == "compare":
        if args.responses is None: parser.error("compare requires --responses")
        results = compare(args.work, read(args.responses)); write(args.work / "comparison.json", results)
        print(json.dumps({"cases": len(results), "passed": sum(r["passed"] for r in results)}))
        raise SystemExit(0 if all(r["passed"] for r in results) else 1)
    else:
        if any(getattr(args, name) is None for name in ("transport_delivery", "publication", "secrets")): parser.error("run requires --transport-delivery, --publication and --secrets")
        raise SystemExit(run(args.work, args.transport_delivery, args.publication, args.secrets))
