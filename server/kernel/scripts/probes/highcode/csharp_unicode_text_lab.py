"""Frozen Unicode source/oracle and additive authenticated public-action transport.

prepare/build/check/compare are offline. run requires exact delivery receipts,
a later registered snapshot and its bound, successful publication confirmation.
Business bodies and isolated-surrogate HTTP expectations are never generated here.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import secrets
import time
import urllib.error
import urllib.request

import csharp_temporal_lab as common

ROOT = common.ROOT
CORPUS = ROOT / "tests/csharp/oracles/Utf16TextRules"
SOURCE = ROOT / "tests/csharp/Utf16TextRules.cs.txt"
WORK = ROOT / ".local/data-logic-translator/unicode-text-lab"
HOST, MODULE = common.HOST, common.MODULE
SOURCE_NAME = "Utf16TextRules.cs.txt"
SCOPE = "original-public-actions: exact Measure/Describe results"
FROZEN_HASHES = {
    SOURCE_NAME: "933d61367b61eec0ad77321eb7c433af26c743c6d8d7e30df5e80f5c8d9c369f",
    "inputs.json": "42acabc501b4706187ef8f89f4673c5e67ad9c3b9a68f4c29419bcaf7cce361b",
    "expected.json": "003e653aae858ca5a10dbcaf9609eedab41519485d80fc669b21a0e1c6a8ecd9",
    "discriminator-inputs.json": "63f49d96d42d11e0fbef1f1efe2899deb7bb7a29617440fd6f1d086f29c16369",
    "discriminator-expected.json": "022276765fcc0e4e04cc14d8e908aca3024bbd693d2fa6bed921896fd158a465",
    "inprocess-surrogates.json": "feff358737c6948cc1083ba38310cc9fbdd842c26ecea8e87dcde40f357088d0",
}
METHODS = [
    {"method": "Measure", "source": "Utf16TextRules.Measure(string?)", "result": "Integer"},
    {"method": "Describe", "source": "Utf16TextRules.Describe(string?)", "result": "Text"},
]
COUNTS = {"publicMethods": 2, "publicCases": 46, "discriminatorCases": 8, "httpCases": 54,
          "inProcessOnlySurrogateCases": 8, "httpSurrogateCases": 0, "businessBodyCopies": 0}
read, write, sha, frozen_write = common.read, common.write, common.sha, common.frozen_write


def original_path(name):
    return SOURCE if name == SOURCE_NAME else CORPUS / name


def baseline():
    for name, digest in FROZEN_HASHES.items():
        if sha(original_path(name)) != digest: raise ValueError("Independent Unicode artifact changed: " + name)
    cases, expected = [], []
    for inputs_name, expected_name, count, group in (
        ("inputs.json", "expected.json", 46, "public"),
        ("discriminator-inputs.json", "discriminator-expected.json", 8, "discriminator"),
    ):
        inputs, outputs = read(CORPUS / inputs_name), read(CORPUS / expected_name)
        if any(value["sourceSha256"] != FROZEN_HASHES[SOURCE_NAME] for value in (inputs, outputs)):
            raise ValueError("Oracle source identity differs")
        if outputs["oracleRuntime"] != ".NET 8.0.18" or len(inputs["cases"]) != count or len(outputs["cases"]) != count:
            raise ValueError("Frozen Unicode coverage changed")
        for case, target in zip(inputs["cases"], outputs["cases"]):
            if case["id"] != target["id"] or case["method"] != target["method"] or case["method"] not in {"Measure", "Describe"}:
                raise ValueError("Oracle case identities differ")
            if len(case["arguments"]) != 1 or target["error"] is not None: raise ValueError("Unexpected frozen case shape")
            value = case["arguments"][0]
            if value is not None:
                if not isinstance(value, str): raise ValueError("Unicode input must be text or null")
                value.encode("utf-8", errors="strict")  # No isolated surrogate may enter the HTTP corpus.
            if type(target["result"]) is not (int if case["method"] == "Measure" else str): raise ValueError("Oracle return type drift")
            cases.append(dict(case, group=group))
            expected.append(target)
    if len({case["id"] for case in cases}) != 54: raise ValueError("Exactly 54 distinct public cases required")
    separate = read(CORPUS / "inprocess-surrogates.json")
    if len(separate["cases"]) != 8 or {case["id"] for case in separate["cases"]} & {case["id"] for case in cases}:
        raise ValueError("Surrogate evidence must remain separate")
    return METHODS, cases, expected


def prepare(work):
    baseline()
    work.mkdir(parents=True, exist_ok=True)
    for name in FROZEN_HASHES: frozen_write(work / name, original_path(name).read_bytes())
    frozen_write(work / "methods.json", common.serialized(METHODS))
    freeze = {"schema": "unicode-text-oracle-v1", "originals": {name: evidence(original_path(name)) for name in FROZEN_HASHES},
              "files": {name: sha(work / name) for name in [*FROZEN_HASHES, "methods.json"]},
              "counts": COUNTS, "oracleRuntime": ".NET 8.0.18", "oracleReexecuted": False,
              "excludedEvidence": "8 isolated-surrogate cases remain in-process only; no HTTP success is claimed for them."}
    frozen_write(work / "oracle.freeze.json", common.serialized(freeze))
    return check(work)


def verify_oracle(work):
    result = baseline()
    freeze = read(work / "oracle.freeze.json")
    names = {*FROZEN_HASHES, "methods.json"}
    if set(freeze["files"]) != names or freeze["counts"] != COUNTS or freeze.get("oracleReexecuted") is not False:
        raise ValueError("Invalid frozen Unicode manifest")
    for name in names:
        if sha(work / name) != freeze["files"][name]: raise ValueError("Frozen Unicode baseline changed: " + name)
    for name, digest in FROZEN_HASHES.items():
        if sha(work / name) != digest or freeze["originals"][name] != evidence(original_path(name)):
            raise ValueError("Laboratory baseline differs from independent oracle")
    if read(work / "methods.json") != METHODS: raise ValueError("Original public signatures changed")
    return result


def evidence(path):
    return {"path": str(Path(path).resolve()), "sha256": sha(path)}


def verify_evidence(item):
    if not isinstance(item, dict) or set(item) != {"path", "sha256"} or sha(item["path"]) != item["sha256"]:
        raise ValueError("Bound evidence changed")
    return Path(item["path"])


def source_files(specification):
    source = specification.get("csharpSource")
    if isinstance(source, str): source = {"files": {"source.cs": source}}
    if not isinstance(source, dict) or set(source) != {"files"} or not isinstance(source["files"], dict) or not source["files"]:
        raise ValueError("Explicit authored source bundle required")
    result = {}
    for name, text in source["files"].items():
        name = name.replace("\\", "/")
        if not name.endswith(".cs") or name.startswith("/") or re.match(r"^[A-Za-z]:", name) or any(part in ("", ".", "..") for part in name.split("/")):
            raise ValueError("Relative C# source paths required")
        if name in result or not isinstance(text, str): raise ValueError("Duplicate or invalid source file")
        result[name] = text
    return result


def compiler_source_hash(specification):
    files = source_files(specification)
    # SourceProgram normalizes slashes and orders filenames using .NET ordinal (UTF-16) order.
    joined = "\n".join(name + "\0" + files[name] for name in sorted(files, key=lambda name: name.encode("utf-16-be")))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def verify_source_delivery(path, bundle_path):
    receipt = common.verify_delivery(path)
    bundle = read(bundle_path)
    files = source_files(bundle)
    if source_files(receipt.get("specification", {})) != files: raise ValueError("Receipt does not prove the exact source bundle")
    original = SOURCE.read_bytes().decode("utf-8")
    if list(files.values()).count(original) != 1: raise ValueError("Exact original Unicode source must occur once")
    if sha(bundle_path) not in {item["sha256"].lower() for item in receipt.get("sources", [])}:
        raise ValueError("Source bundle hash absent from delivery receipt")
    if not receipt.get("taskId") or not receipt.get("moduleKey"): raise ValueError("Delivery task and module identity required")
    return receipt


def bind(contract, mapping):
    actions = {action["name"]: action for action in contract["logic"]["actions"]}
    raw_structures = contract.get("data", {}).get("structures", [])
    structures = {value["name"]: value for value in raw_structures}
    if len(actions) != len(contract["logic"]["actions"]) or len(structures) != len(raw_structures): raise ValueError("Duplicate native declaration")
    if any(len({field["name"] for field in value["attributes"]}) != len(value["attributes"]) for value in raw_structures): raise ValueError("Duplicate native carrier field")
    bindings = []
    for method in METHODS:
        candidates = [entry for entry in mapping if entry.get("kind") == "server" and entry.get("source") == method["source"]]
        if len(candidates) != 1: raise ValueError("Exact original public SourceMap symbol required: " + method["source"])
        entry = candidates[0]
        action = actions.get(entry.get("native"))
        if action is None or action.get("public") is not True or action.get("kind") != "server" or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", action["name"]):
            raise ValueError("Original public server action required; private implementations cannot substitute")
        if len(action["inputs"]) != 1 or len(action["outputs"]) != 1 or action["inputs"][0]["name"] != "Arg_value":
            raise ValueError("Original public parameter mapping required")
        parameter, output = action["inputs"][0], action["outputs"][0]
        if output["name"] != "AvResult": raise ValueError("Original return parameter mapping required")
        input_schema = {"kind": "nullable", "value": {"kind": "string"}}
        common.validate_schema(input_schema, parameter["type"], structures)
        output_schema = {"kind": "int" if method["result"] == "Integer" else "string"}
        if method["result"] == "Text" and output["type"] in structures:
            output_schema = {"kind": "nullable", "value": {"kind": "string"}}
        common.validate_schema(output_schema, output["type"], structures)
        bindings.append({"method": method["method"], "source": entry["source"], "native": entry["native"],
                         "endpoint": "UnicodeText" + method["method"], "input": dict(parameter, schema=input_schema),
                         "output": dict(output, schema=output_schema), "evidenceScope": SCOPE})
    if len({item["native"] for item in bindings}) != 2: raise ValueError("SourceMap native alias collision")
    return bindings, structures


def transport_ops(bindings, structures):
    """Add REST envelopes/authentication/original public calls only; no copied business graphs."""
    types, ops = [], []
    for item in bindings:
        prefix = "AvLab" + item["endpoint"]
        types.extend([
            {"name": prefix + "Request", "attributes": [{"name": "Arg_value", "type": item["input"]["type"]}]},
            {"name": prefix + "Response", "attributes": [{"name": "Completed", "type": "Boolean"}, {"name": "Result", "type": item["output"]["type"]}]},
        ])
    if {value["name"] for value in types} & set(structures): raise ValueError("Additive transport refuses existing envelope names")
    ops.append({"op": "spec", "data": {"structures": types}})
    def create(parent, kind, alias, name=None):
        op = {"op": "create", "parent": parent, "type": kind, "as": alias}
        if name is not None: op["name"] = name
        ops.append(op)
        return alias
    def setting(target, prop, value): ops.append({"op": "set", "target": target, "prop": prop, "value": value})
    def link(start, end): ops.append({"op": "link", "from": start, "to": end})
    for item in bindings:
        endpoint, prefix = item["endpoint"], "AvLab" + item["endpoint"]
        method = create("IRestService:CSharpLab", "IRestServiceAction", "$" + endpoint, endpoint)
        setting(method, "HTTPMethod", "POST"); setting(method, "URLPath", "/" + endpoint)
        key = create(method, "IRestServiceActionInput", method + "Key", "LabKey")
        setting(key, "DataType", "Text"); setting(key, "ReceiveIn", "Header"); setting(key, "IsMandatory", True)
        payload = create(method, "IRestServiceActionInput", method + "Payload", "Payload")
        setting(payload, "DataType", prefix + "Request"); setting(payload, "ReceiveIn", "Body"); setting(payload, "IsMandatory", True)
        response = create(method, "IRestServiceActionOutput", method + "Response", "Response")
        setting(response, "DataType", prefix + "Response"); setting(response, "SendIn", "Body")
        auth = create(method, "IExecuteServerActionNode", method + "Auth", "AuthenticateLab")
        setting(auth, "Action", "IServerAction:LabAuthenticate"); setting(auth + "/LabKey", "Value", "LabKey")
        call = create(method, "IExecuteServerActionNode", method + "Execute", "ExecuteOriginal")
        setting(call, "Action", "IServerAction:" + item["native"]); setting(call + "/Arg_value", "Value", "Payload.Arg_value")
        assign = create(method, "IAssignNode", method + "Assign", "SetResponse")
        for name, value in [("Completed", "True"), ("Result", "ExecuteOriginal." + item["output"]["name"])]:
            field = create(assign, "IAssignment", method + name)
            setting(field, "Variable", "Response." + name); setting(field, "Value", value)
        link(method + "/#IStartNode", auth); link(auth, call); link(call, assign); link(assign, method + "/#IEndNode")
        ops.append({"op": "layout", "target": method})
    return ops


def requests_and_targets(cases, expected, bindings, structures):
    by_method = {item["method"]: item for item in bindings}
    requests = []
    for case in cases:
        item = by_method[case["method"]]
        value = common.encode(case["arguments"][0], item["input"]["schema"], item["input"]["type"], structures)
        requests.append({"id": case["id"], "method": case["method"], "group": case["group"], "endpoint": item["endpoint"], "payload": {"Arg_value": value}})
    return requests, {item["id"]: {"result": item["result"], "error": item["error"]} for item in expected}


def build(work, contract_path, map_path, source_delivery, bundle_path, source_hash_path=None):
    _, cases, expected = verify_oracle(work)
    receipt = verify_source_delivery(source_delivery, bundle_path)
    source_hash_path = source_hash_path or contract_path.parent / "source-hash.txt"
    if source_hash_path.read_text(encoding="utf-8-sig").strip().lower() != compiler_source_hash(read(bundle_path)):
        raise ValueError("Compiler source hash does not match the delivered source bundle")
    contract, mapping = read(contract_path), read(map_path)
    bindings, structures = bind(contract, mapping)
    requests, targets = requests_and_targets(cases, expected, bindings, structures)
    contents = {"transport.json": {"description": "Additive authenticated Unicode transport calling original public Measure/Describe; no business copies", "expectValid": True, "expectedMessages": [], "ops": transport_ops(bindings, structures)},
                "bindings.json": bindings, "requests.json": requests, "targets.json": targets, "bound-contract.json": contract, "bound-source-map.json": mapping}
    for name, value in contents.items(): frozen_write(work / name, common.serialized(value))
    paths = {"sourceDelivery": source_delivery, "sourceBundle": bundle_path, "contract": contract_path, "sourceMap": map_path,
             "compilerSourceHash": source_hash_path, "oracleFreeze": work / "oracle.freeze.json", "probe": Path(__file__), "commonHelper": Path(common.__file__)}
    proof = {"schema": "unicode-text-binding-v1", "environment": HOST, "module": MODULE, "moduleKey": receipt["moduleKey"], "sourceTaskId": receipt["taskId"],
             "evidence": {name: evidence(path) for name, path in paths.items()}, "files": {name: sha(work / name) for name in contents}, "counts": dict(COUNTS, endpoints=2, guardRequests=1, totalRunRequests=55, ops=len(contents["transport.json"]["ops"]))}
    frozen_write(work / "binding-proof.json", common.serialized(proof))
    template = {"schema": "unicode-text-publication-v1", "bindingProof": evidence(work / "binding-proof.json"),
                "sourceDelivery": evidence(source_delivery), "sourceTaskId": receipt["taskId"],
                "transportDelivery": None, "transportTaskId": None, "snapshotReceipt": None, "snapshotSha256": None,
                "confirmation": None, "VersionId": None,
                "instructions": "Copy this template to a new file. Fill only after both deliveries, a fresh registered snapshot, and confirmed publication of that snapshot. Raw confirmation remains authoritative; this template grants no approval."}
    frozen_write(work / "publication-template.json", common.serialized(template))
    check(work)
    return proof["counts"]


def check(work):
    _, cases, expected = verify_oracle(work)
    built = (work / "binding-proof.json").exists()
    if built:
        proof = read(work / "binding-proof.json")
        if proof.get("schema") != "unicode-text-binding-v1" or set(proof["files"]) != {"transport.json", "bindings.json", "requests.json", "targets.json", "bound-contract.json", "bound-source-map.json"} or set(proof["evidence"]) != {"sourceDelivery", "sourceBundle", "contract", "sourceMap", "compilerSourceHash", "oracleFreeze", "probe", "commonHelper"}:
            raise ValueError("Incomplete binding proof")
        if proof["environment"] != HOST or proof["module"] != MODULE: raise ValueError("Personal target drift")
        for name, digest in proof["files"].items():
            if sha(work / name) != digest: raise ValueError("Frozen transport changed: " + name)
        for item in proof["evidence"].values(): verify_evidence(item)
        paths = proof["evidence"]
        receipt = verify_source_delivery(Path(paths["sourceDelivery"]["path"]), Path(paths["sourceBundle"]["path"]))
        if receipt["moduleKey"] != proof["moduleKey"] or receipt["taskId"] != proof["sourceTaskId"]: raise ValueError("Source delivery identity drift")
        if Path(paths["compilerSourceHash"]["path"]).read_text(encoding="utf-8-sig").strip().lower() != compiler_source_hash(read(paths["sourceBundle"]["path"])):
            raise ValueError("Compiler source identity drift")
        contract, mapping = read(work / "bound-contract.json"), read(work / "bound-source-map.json")
        if contract != read(paths["contract"]["path"]) or mapping != read(paths["sourceMap"]["path"]): raise ValueError("Compiler artifacts differ")
        bindings, structures = bind(contract, mapping)
        requests, targets = requests_and_targets(cases, expected, bindings, structures)
        if bindings != read(work / "bindings.json") or requests != read(work / "requests.json") or targets != read(work / "targets.json"):
            raise ValueError("Bindings/requests/targets differ from the independent corpus")
        if transport_ops(bindings, structures) != read(work / "transport.json")["ops"]:
            raise ValueError("Transport contains unrelated mutations or copied business bodies")
    return dict(COUNTS, localChecksPassed=True, transportBuilt=built, liveRequests=0)


def compare_response(body, binding, structures):
    if isinstance(body, dict) and set(body) == {"Response"}: body = body["Response"]
    if not isinstance(body, dict) or set(body) - {"Completed", "Result"} or body.get("Completed") is not True:
        raise ValueError("Original action must complete before any default result can be decoded")
    output = binding["output"]
    # O11 can omit default-valued JSON fields. Completed=True independently proves the call returned.
    value = common.decode(body.get("Result", common.native_default(output["type"], structures)), output["schema"], output["type"], structures)
    return {"result": value, "error": None}


def compare(work, responses):
    check(work)
    requests, targets = read(work / "requests.json"), read(work / "targets.json")
    if not isinstance(responses, dict) or set(responses) != {item["id"] for item in requests}: raise ValueError("Exactly all 54 HTTP responses are required")
    bindings = {item["method"]: item for item in read(work / "bindings.json")}
    structures = {item["name"]: item for item in read(work / "bound-contract.json").get("data", {}).get("structures", [])}
    results = []
    for item in requests:
        try: actual = compare_response(responses[item["id"]], bindings[item["method"]], structures)
        except (ValueError, TypeError, KeyError): actual = {"protocolError": "Invalid or unsuccessful original-action response"}
        results.append({"id": item["id"], "group": item["group"], "expected": targets[item["id"]], "actual": actual, "passed": actual == targets[item["id"]]})
    return results


def updated_at(receipt):
    value = datetime.fromisoformat(receipt["updatedAt"].replace("Z", "+00:00"))
    if value.tzinfo is None: raise ValueError("Delivery timestamp must include its timezone")
    return value.astimezone(timezone.utc).timestamp()


def execution_gate(work, transport_delivery, publication_path):
    check(work)
    proof, publication = read(work / "binding-proof.json"), read(publication_path)
    if publication.get("schema") != "unicode-text-publication-v1": raise ValueError("Bound publication envelope required")
    source_path = Path(proof["evidence"]["sourceDelivery"]["path"])
    for key, path in [("bindingProof", work / "binding-proof.json"), ("sourceDelivery", source_path), ("transportDelivery", transport_delivery)]:
        if publication.get(key) != evidence(path): raise ValueError("Publication is not bound to these exact receipts and transport")
    source, transport = common.verify_delivery(source_path), common.verify_delivery(transport_delivery)
    if source["taskId"] != publication.get("sourceTaskId") or transport.get("taskId") != publication.get("transportTaskId"):
        raise ValueError("Publication delivery IDs differ")
    if any(receipt.get("moduleKey") != proof["moduleKey"] for receipt in (source, transport)): raise ValueError("Delivered module identity differs")
    if sha(work / "transport.json") not in {item["sha256"].lower() for item in transport.get("sources", []) + transport.get("artifacts", [])}:
        raise ValueError("Transport receipt does not prove this transport job")
    snapshot_path = verify_evidence(publication.get("snapshotReceipt"))
    snapshot = read(snapshot_path)
    if snapshot.get("success") is not True or snapshot.get("error") is not None: raise ValueError("Successful registered snapshot required")
    state = snapshot["data"]
    if state.get("environment") != HOST or state.get("name") != MODULE or state.get("key") != proof["moduleKey"] or not state.get("snapshot_id"):
        raise ValueError("Snapshot does not identify the delivered personal module")
    snapshot_oml = Path(state["path"])
    if sha(snapshot_oml) != state["sha256"].lower() or publication.get("snapshotSha256") != state["sha256"].lower(): raise ValueError("Published snapshot bytes differ")
    after = max(updated_at(source), updated_at(transport))
    if min(snapshot_path.stat().st_mtime, snapshot_oml.stat().st_mtime) < after:
        raise ValueError("Registered snapshot must be captured after both deliveries")
    confirmation_path = verify_evidence(publication.get("confirmation"))
    confirmation = read(confirmation_path)
    if confirmation.get("Completed") is not True or confirmation.get("HasErrors") is not False or type(confirmation.get("VersionId")) is not int or confirmation["VersionId"] <= 0:
        raise ValueError("Raw successful terminal publication confirmation required")
    if publication.get("VersionId") != confirmation["VersionId"] or confirmation_path.stat().st_mtime < max(snapshot_path.stat().st_mtime, snapshot_oml.stat().st_mtime):
        raise ValueError("Publication version/order is not bound to the fresh snapshot")
    return {"source": source_path, "transport": transport_delivery, "snapshotReceipt": snapshot_path,
            "snapshotOml": snapshot_oml, "confirmation": confirmation_path, "version": confirmation["VersionId"],
            "moduleKey": state["key"], "snapshotId": state["snapshot_id"], "snapshotSha256": sha(snapshot_oml)}


def parse_response(wire):
    def unique_fields(pairs):
        result = {}
        for name, value in pairs:
            if name in result: raise ValueError("Duplicate response field")
            result[name] = value
        return result
    return json.loads(wire, object_pairs_hook=unique_fields)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None


def redact(wire, key):
    for value in sorted({key, json.dumps(key, ensure_ascii=False)[1:-1], json.dumps(key, ensure_ascii=True)[1:-1]}, key=len, reverse=True):
        wire = wire.replace(value, "[redacted]")
    return wire


def run(work, transport_delivery, publication_path, secret_path):
    gate = execution_gate(work, transport_delivery, publication_path)
    key = read(secret_path).get("key")
    if not isinstance(key, str) or not key or any(ord(character) < 32 or ord(character) > 126 for character in key): raise ValueError("Printable laboratory key required in secrets file")
    # Copy an explicit allowlist, never every JSON file in work or the secrets file.
    proof = read(work / "binding-proof.json")
    archive = {name: work / name for name in [*FROZEN_HASHES, "methods.json", "oracle.freeze.json", "binding-proof.json", *proof["files"]]}
    archive.update({"publication-bound.json": publication_path, "source-delivery.json": gate["source"], "transport-delivery.json": gate["transport"],
                    "snapshot-receipt.json": gate["snapshotReceipt"], "confirmed-publication.json": gate["confirmation"], "probe.py": Path(__file__), "common-helper.py": Path(common.__file__),
                    "source-bundle.json": Path(proof["evidence"]["sourceBundle"]["path"]), "compiler-source-hash.txt": Path(proof["evidence"]["compilerSourceHash"]["path"])})
    for path in archive.values():
        if Path(path).resolve() == secret_path.resolve() or redact(path.read_text(encoding="utf-8-sig"), key) != path.read_text(encoding="utf-8-sig"):
            raise ValueError("Evidence archive would expose laboratory secrets")
    run_dir = work / "runs" / (time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(4))
    run_dir.mkdir(parents=True)
    for name, path in archive.items(): frozen_write(run_dir / name, path.read_bytes())
    requests = read(work / "requests.json")
    responses, execution = {}, []
    opener = urllib.request.build_opener(NoRedirect)
    invalid_key = "invalid-" + secrets.token_hex(24)
    for item, invalid in [(requests[0], True)] + [(item, False) for item in requests]:
        request = urllib.request.Request("https://" + HOST + "/" + MODULE + "/rest/CSharpLab/" + item["endpoint"],
            data=json.dumps(item["payload"], ensure_ascii=True).encode("utf-8"),
            headers={"LabKey": invalid_key if invalid else key, "Content-Type": "application/json"}, method="POST")
        before = time.perf_counter()
        status, wire, failure = 0, "", None
        try:
            with opener.open(request, timeout=60) as response: status, wire = response.status, response.read().decode("utf-8")
        except urllib.error.HTTPError as error: status, wire = error.code, error.read().decode("utf-8")
        except Exception as error: failure = type(error).__name__
        wire = redact(wire, key)
        denied = invalid and status in (400, 401, 403, 500) and ("LabAccessDenied" in wire or "Invalid laboratory key." in wire)
        execution.append({"id": item["id"], "invalidKey": invalid, "status": status, "denied": denied,
                          "wire": wire, "failure": failure, "seconds": time.perf_counter() - before})
        write(run_dir / "execution.json", execution)
        if invalid and not denied:
            write(run_dir / "summary.json", {"guardPassed": False, "publicRequests": 0, "publishedVersion": gate["version"], "passed": False})
            raise ValueError("Laboratory guard did not reject invalid key; no public cases sent")
        if not invalid:
            try: responses[item["id"]] = parse_response(wire) if status == 200 and failure is None else {"transportFailure": status}
            except ValueError: responses[item["id"]] = {"transportFailure": "InvalidJson"}
        print(json.dumps({"id": item["id"], "invalidKey": invalid, "status": status}), flush=True)
    # Recheck frozen evidence after execution before attributing results to it.
    execution_gate(work, transport_delivery, publication_path)
    write(run_dir / "responses.json", responses)
    results = compare(work, responses)
    write(run_dir / "comparison.json", results)
    passed = sum(item["passed"] for item in results)
    write(run_dir / "summary.json", dict(COUNTS, guardPassed=True, compared=54, matched=passed, passed=passed == 54,
        publishedVersion=gate["version"], moduleKey=gate["moduleKey"], snapshotId=gate["snapshotId"], snapshotSha256=gate["snapshotSha256"], evidenceScope=SCOPE))
    write(run_dir / "hashes.json", {path.name: sha(path) for path in run_dir.iterdir() if path.is_file()})
    return 0 if passed == 54 else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "build", "check", "compare", "run"))
    parser.add_argument("--work", type=Path, default=WORK)
    for flag in ("contract", "mapping", "source-bundle", "source-delivery", "source-hash", "transport-delivery", "publication", "secrets", "responses"):
        parser.add_argument("--" + flag, type=Path)
    args = parser.parse_args()
    if args.mode in ("prepare", "check"):
        print(json.dumps(prepare(args.work) if args.mode == "prepare" else check(args.work))); return 0
    required = {"build": ("contract", "mapping", "source_bundle", "source_delivery"), "compare": ("responses",), "run": ("transport_delivery", "publication", "secrets")}[args.mode]
    if any(getattr(args, name) is None for name in required): parser.error(args.mode + " requires " + ", ".join("--" + name.replace("_", "-") for name in required))
    if args.mode == "build":
        print(json.dumps(build(args.work, args.contract, args.mapping, args.source_delivery, args.source_bundle, args.source_hash))); return 0
    if args.mode == "compare":
        results = compare(args.work, read(args.responses)); write(args.work / "comparison.json", results)
        print(json.dumps({"cases": len(results), "passed": sum(item["passed"] for item in results), "httpSurrogateCases": 0}))
        return 0 if all(item["passed"] for item in results) else 1
    return run(args.work, args.transport_delivery, args.publication, args.secrets)


if __name__ == "__main__":
    raise SystemExit(main())
