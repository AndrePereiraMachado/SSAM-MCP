"""Frozen .NET 8 journal oracle and additive authenticated reference laboratory.

oracle/build/check are local. run requires exact source/transport receipts and
confirmed publication. Public wrappers and internal context evidence are separate.
Business bodies are never copied, replaced, or reconstructed by this transport.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import time
import urllib.error
import urllib.request

import csharp_temporal_lab as common

ROOT = common.ROOT
WORK = ROOT / ".local/data-logic-translator/reference-lab"
SOURCE = ROOT / "tests/csharp/ReferenceJournal.cs.txt"
ORACLE = Path(__file__).with_name("ReferenceJournalOracle.cs.txt")
BUNDLE = common.LAB / "ReferenceSource.json"
DOTNET = Path("C:/Program Files/dotnet/dotnet.exe")
CSC = Path("C:/Program Files/dotnet/sdk/10.0.301/Roslyn/bincore/csc.dll")
RUNTIME = Path("C:/Program Files/dotnet/shared/Microsoft.NETCore.App/8.0.18")
read, write, sha, frozen_write = common.read, common.write, common.sha, common.frozen_write


def oracle(work):
    started = time.perf_counter()
    helper = work / "oracle"
    helper.mkdir(parents=True, exist_ok=True)
    frozen_write(helper / "ReferenceJournal.cs", SOURCE.read_bytes())
    frozen_write(helper / "Program.cs", ORACLE.read_bytes())
    frozen_write(helper / "Globals.cs", 'global using System;\nglobal using System.Collections.Generic;\nglobal using System.Linq;\n[assembly: System.Runtime.Versioning.TargetFramework(".NETCoreApp,Version=v8.0")]\n')
    # Managed PE metadata is inspected without loading business assemblies.
    ps = "$ErrorActionPreference='Stop'; Get-ChildItem -LiteralPath '" + str(RUNTIME) + "' -Filter '*.dll' -File | Sort-Object Name | ForEach-Object { try { [System.Reflection.AssemblyName]::GetAssemblyName($_.FullName) | Out-Null; $_.FullName } catch [System.BadImageFormatException] {} }"
    result = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, check=True)
    references = [Path(line) for line in result.stdout.splitlines() if line.strip()]
    if not references: raise ValueError("No .NET 8 managed reference assemblies")
    arguments = ['/nostdlib+', '/target:exe', '/langversion:12', '/nullable:enable', '/deterministic+', '/debug:portable', '/optimize-', '/warnaserror+', '/main:ReferenceJournalOracle', '/out:"' + str(helper / 'Oracle.dll') + '"']
    arguments += ['/reference:"' + str(path) + '"' for path in references]
    arguments += ['"' + str(helper / name) + '"' for name in ('ReferenceJournal.cs', 'Program.cs', 'Globals.cs')]
    frozen_write(helper / "compile.rsp", "\n".join(arguments) + "\n")
    frozen_write(helper / "Oracle.runtimeconfig.json", common.serialized({"runtimeOptions": {"tfm": "net8.0", "framework": {"name": "Microsoft.NETCore.App", "version": "8.0.18"}, "rollForward": "Disable"}}))
    timings = []
    commands = [[str(DOTNET), str(CSC), '/noconfig', '@' + str(helper / 'compile.rsp')], [str(DOTNET), str(helper / 'Oracle.dll')]]
    for index, command in enumerate(commands):
        before = time.perf_counter()
        result = subprocess.run(command, cwd=helper, capture_output=True, text=True, encoding="utf-8", check=False)
        timings.append({"stage": "compile" if index == 0 else "execute", "seconds": time.perf_counter() - before, "exitCode": result.returncode})
        (work / ("oracle-command-" + str(index) + ".log")).write_text(result.stdout + result.stderr, encoding="utf-8")
        if result.returncode: raise RuntimeError("Oracle command failed; inspect local oracle-command-" + str(index) + ".log")
    observed = json.loads(result.stdout)
    if observed["runtime"]["version"] != "8.0.18": raise ValueError("Oracle runtime drift")
    names = [key + ".json" for key in ("runtime", "methods", "cases", "expected", "observations", "exceptionDetails")]
    for name in names: frozen_write(work / name, common.serialized(observed[name[:-5]]))
    names += ["oracle/" + name for name in ("ReferenceJournal.cs", "Program.cs", "Globals.cs", "compile.rsp", "Oracle.runtimeconfig.json", "Oracle.dll", "Oracle.pdb")]
    manifest = {"sourcePath": str(SOURCE), "sourceSha256": sha(SOURCE), "oracleSourcePath": str(ORACLE), "oracleSourceSha256": sha(ORACLE), "compiler": {"path": str(CSC), "sha256": sha(CSC), "sdk": "10.0.301", "references": {str(path): sha(path) for path in references}}, "runtime": observed["runtime"], "coreLibrarySha256": sha(observed["runtime"]["coreLibrary"]), "files": {name: sha(work / name) for name in names}, "assumption": "SDK 10 Roslyn compiles against managed .NET 8.0.18 runtime assemblies because SDK/reference pack 8 is not installed; execution is pinned to real .NET 8.0.18."}
    frozen_write(work / "oracle.freeze.json", common.serialized(manifest))
    write(work / "oracle-timings.json", {"stages": timings, "totalSeconds": time.perf_counter() - started})
    verify_oracle(work)
    print(json.dumps({"oracle": observed["runtime"]["framework"], "publicMethods": 5, "publicCases": len(observed["cases"]), "publicThrows": sum(item["error"] is not None for item in observed["expected"]), "internalObservations": len(observed["observations"]), "businessBodyCopies": 0}))


def verify_oracle(work):
    freeze = read(work / "oracle.freeze.json")
    if sha(SOURCE) != freeze["sourceSha256"] or sha(ORACLE) != freeze["oracleSourceSha256"]: raise ValueError("Original reference source/oracle changed")
    for name, digest in freeze["files"].items():
        if sha(work / name) != digest: raise ValueError("Frozen oracle changed: " + name)
    methods, cases, expected, observations = [read(work / (name + ".json")) for name in ("methods", "cases", "expected", "observations")]
    if {m["source"] for m in methods} != {"JournalRules." + name for name in ("Run", "Same", "Fresh", "Rebind", "NullRequired")}: raise ValueError("Original public surface incomplete")
    if {m["method"] for m in methods} != {c["method"] for c in cases}: raise ValueError("Public method coverage incomplete")
    if [c["id"] for c in cases] != [e["id"] for e in expected] or len({c["id"] for c in cases}) != len(cases): raise ValueError("Oracle case identities mismatch")
    if len(cases) != 17 or len(observations) != 6: raise ValueError("Frozen journal case coverage changed")
    manual = {"fresh": 10, "rebind": 911, "same_shared": True, "same_independent": False, "run_success_3": 4303}
    for item in expected:
        if item["id"] in manual and (item["error"] is not None or item["result"] != manual[item["id"]]): raise ValueError("Manual CLR sanity check failed: " + item["id"])
    for item in observations:
        arguments, target = item["arguments"], item["expected"]
        amount, fail = arguments["amount"], arguments["fail"]
        if target["total"] != amount + (0 if fail else 1) or target["trace"] != ["before:" + str(amount), "shared"] + ([] if fail else ["after"]): raise ValueError("Manual state sanity check failed")
        if fail != (target["failure"] is not None) or not all(item["aliasChecks"].values()): raise ValueError("CLR shared observation failed")
    return methods, cases, expected, observations


def bind(methods, contract, source_map):
    # Generic ABI checks are reused; this corpus's source-map selection is explicit.
    actions = {a["name"]: a for a in contract["logic"]["actions"]}
    structures = {s["name"]: s for s in contract["data"]["structures"]}
    if len(actions) != len(contract["logic"]["actions"]): raise ValueError("Duplicate native action names")
    result = []
    for method in methods:
        matches = [entry for entry in source_map if entry.get("kind") == "server" and entry.get("source", "").startswith(method["source"] + "(")]
        if len(matches) != 1: raise ValueError("Require one exact source-map method binding: " + method["source"])
        entry = matches[0]
        action = actions.get(entry["native"])
        if action is None or action.get("public") is not True or action.get("kind") != "server": raise ValueError("Public method must bind to original public server boundary")
        if len(action["inputs"]) != len(method["inputs"]) or len(action["outputs"]) != 1: raise ValueError("Native method arity mismatch")
        inputs = []
        for declared, native in zip(method["inputs"], action["inputs"]):
            if native["name"] != "Arg_" + declared["name"]: raise ValueError("Require explicit parameter mapping")
            common.validate_schema(declared["schema"], native["type"], structures)
            inputs.append({"source": declared["name"], "native": native["name"], "type": native["type"], "schema": declared["schema"]})
        output = action["outputs"][0]
        common.validate_schema(method["output"], output["type"], structures)
        result.append({"method": method["method"], "source": entry["source"], "native": entry["native"], "implementation": entry.get("implementation"), "endpoint": "Reference" + method["method"], "inputs": inputs, "output": dict(output, schema=method["output"]), "evidenceScope": "original-public-wrapper"})
    if len({item["native"] for item in result}) != len(result): raise ValueError("Source-map native alias collision")
    return result, structures


def observation_shape(bindings, contract, source_map):
    run = next(item for item in bindings if item["method"] == "Run")
    actions = {a["name"]: a for a in contract["logic"]["actions"]}
    structures = {s["name"]: s for s in contract["data"]["structures"]}
    implementation = actions.get(run.get("implementation"))
    if implementation is None or implementation.get("public") is not False: raise ValueError("Internal Run implementation must come from SourceMap.implementation")
    ins = {p["name"]: p["type"] for p in implementation["inputs"]}
    outs = {p["name"]: p["type"] for p in implementation["outputs"]}
    if ins != {"AvContextIn": outs.get("AvContextOut"), "Arg_fail": "Boolean", "Arg_amount": "Integer"} or set(outs) != {"AvContextOut", "AvCompletion", "AvResult"} or outs["AvResult"] != "Integer": raise ValueError("Unsupported typed Run implementation ABI")
    context, completion = outs["AvContextOut"], outs["AvCompletion"]
    field_map = lambda kind: common.fields(kind, structures)
    if field_map(completion) != {"Kind": "Integer", "ExceptionRef": "Integer"}: raise ValueError("Completion shape drift")
    context_fields = field_map(context)
    if "Exceptions" not in context_fields or not context_fields["Exceptions"].endswith(" List"): raise ValueError("Exception pool missing")
    exception_type = context_fields["Exceptions"][:-5]
    if field_map(exception_type) != {"TypeName": "Text", "Message": "Text", "ParamName": "Text", "HasParamName": "Boolean", "InnerRef": "Integer"}: raise ValueError("Exception cell shape drift")
    mapped = {}
    for member in ("Entries", "Total"):
        matches = [entry for entry in source_map if entry.get("source") == "PostingJournal." + member]
        if len(matches) != 1: raise ValueError("Journal field mapping missing")
        mapped[member] = matches[0]["native"].split(".")[-1]
    pools = {name: kind[:-5] for name, kind in context_fields.items() if name != "Exceptions" and kind.endswith(" List")}
    candidates = [(name, kind) for name, kind in pools.items() if set(field_map(kind)) == set(mapped.values()) and field_map(kind).get(mapped["Total"]) == "Integer"]
    if len(candidates) != 1: raise ValueError("Require one typed PostingJournal cell pool")
    object_pool, object_cell = candidates[0]
    list_ref = field_map(object_cell)[mapped["Entries"]]
    if field_map(list_ref) != {"Index": "Integer"}: raise ValueError("List reference shape drift")
    lists = []
    for name, kind in pools.items():
        attrs = field_map(kind)
        if set(attrs) == {"Items"} and attrs["Items"].endswith(" List"):
            item_kind = attrs["Items"][:-5]
            if field_map(item_kind) == {"HasValue": "Boolean", "Value": "Text"}: lists.append((name, kind, item_kind))
    if len(lists) != 1 or len(pools) != 2: raise ValueError("Require unique typed text-list pool for this journal invocation")
    list_pool, list_cell, item_type = lists[0]
    return {"method": "RunState", "endpoint": "ReferenceRunState", "native": run["implementation"], "source": run["source"], "inputs": run["inputs"], "contextType": context, "completionType": completion, "objectPool": object_pool, "objectCell": object_cell, "listPool": list_pool, "listCell": list_cell, "itemType": item_type, "exceptionType": exception_type, "entriesField": mapped["Entries"], "totalField": mapped["Total"], "evidenceScope": "internal-same-invocation-state; does not certify public wrapper context exposure"}


def typed_default(kind, structures):
    if kind.endswith(" List"): return []
    if kind in structures: return {name: typed_default(child, structures) for name, child in common.fields(kind, structures).items()}
    return common.native_default(kind, structures)


def typed_value(value, kind, structures):
    if kind.endswith(" List"):
        if not isinstance(value, list): raise ValueError("Expected native list")
        return [typed_value(item, kind[:-5], structures) for item in value]
    if kind in structures:
        attrs = common.fields(kind, structures)
        if not isinstance(value, dict) or set(value) - set(attrs): raise ValueError("Unexpected native structure members")
        return {name: typed_value(value.get(name, typed_default(child, structures)), child, structures) for name, child in attrs.items()}
    schemas = {"Integer": "int", "Long Integer": "long", "Boolean": "bool", "Text": "string"}
    return common.encode(value, {"kind": schemas[kind]}, kind, structures)


def observe_response(body, shape, structures):
    if not isinstance(body, dict) or set(body) - {"Context", "Completion", "Result"}: raise ValueError("Unexpected internal observation envelope")
    context = typed_value(body.get("Context", {}), shape["contextType"], structures)
    completion = typed_value(body.get("Completion", {}), shape["completionType"], structures)
    if len(context[shape["objectPool"]]) != 1 or len(context[shape["listPool"]]) != 1: raise ValueError("Journal state must come from one fresh Run invocation")
    journal = context[shape["objectPool"]][0]
    reference = journal[shape["entriesField"]]["Index"]
    if reference != 1: raise ValueError("Journal list reference does not point to the invocation list")
    trace = [item["Value"] if item["HasValue"] else None for item in context[shape["listPool"]][reference - 1]["Items"]]
    error = None
    if completion["Kind"] == 2:
        index = completion["ExceptionRef"]
        if not 1 <= index <= len(context["Exceptions"]): raise ValueError("Completion exception does not belong to context")
        failure = context["Exceptions"][index - 1]
        if failure["InnerRef"] != 0: raise ValueError("Unexpected inner failure in this source vertical")
        error = {"type": failure["TypeName"], "message": failure["Message"], "paramName": failure["ParamName"] if failure["HasParamName"] else None}
    elif completion["Kind"] != 1 or completion["ExceptionRef"] != 0 or context["Exceptions"]:
        raise ValueError("Unexpected completion for journal Run")
    return {"total": journal[shape["totalField"]], "trace": trace, "failure": error}


def duplicate_bodies(actions):
    groups = defaultdict(list)
    for action in actions:
        body = json.dumps(action.get("steps", []), sort_keys=True, separators=(",", ":"))
        groups[body].append(action["name"])
    return sorted([sorted(names) for names in groups.values() if len(names) > 1])


def transport_ops(bindings, shape, contract):
    actions = {a["name"]: a for a in contract["logic"]["actions"]}
    types, ops = [], []
    all_bindings = bindings + [shape]
    for item in all_bindings:
        name = item["endpoint"]
        attrs = [{"name": "Context", "type": shape["contextType"]}, {"name": "Completion", "type": shape["completionType"]}, {"name": "Result", "type": "Integer"}] if item is shape else [{"name": "Result", "type": item["output"]["type"]}, {"name": "FailureType", "type": "Text"}, {"name": "FailureMessage", "type": "Text"}]
        types.append({"name": "AvLab" + name + "Response", "attributes": attrs})
        if item["inputs"]: types.append({"name": "AvLab" + name + "Request", "attributes": [{"name": p["native"], "type": p["type"]} for p in item["inputs"]]})
    if {t["name"] for t in types} & {s["name"] for s in contract["data"]["structures"]}: raise ValueError("Additive transport refuses existing envelope types")
    ops.append({"op": "spec", "data": {"structures": types}})
    def create(parent, kind, alias, name=None):
        op = {"op": "create", "parent": parent, "type": kind, "as": alias}
        if name is not None: op["name"] = name
        ops.append(op); return alias
    def setting(target, prop, value): ops.append({"op": "set", "target": target, "prop": prop, "value": value})
    def link(start, end): ops.append({"op": "link", "from": start, "to": end})
    exception_types = {name: "System." + name for name in ("ArgumentNullException", "InvalidOperationException", "NullReferenceException")}
    for item in all_bindings:
        name = item["endpoint"]
        method = create("IRestService:CSharpLab", "IRestServiceAction", "$" + name, name)
        setting(method, "HTTPMethod", "POST"); setting(method, "URLPath", "/" + name)
        key = create(method, "IRestServiceActionInput", method + "Key", "LabKey")
        setting(key, "DataType", "Text"); setting(key, "ReceiveIn", "Header"); setting(key, "IsMandatory", True)
        if item["inputs"]:
            payload = create(method, "IRestServiceActionInput", method + "Payload", "Payload")
            setting(payload, "DataType", "AvLab" + name + "Request"); setting(payload, "ReceiveIn", "Body"); setting(payload, "IsMandatory", True)
        response = create(method, "IRestServiceActionOutput", method + "Response", "Response")
        setting(response, "DataType", "AvLab" + name + "Response"); setting(response, "SendIn", "Body")
        auth = create(method, "IExecuteServerActionNode", method + "Auth", "AuthenticateLab")
        setting(auth, "Action", "IServerAction:LabAuthenticate"); setting(auth + "/LabKey", "Value", "LabKey")
        execute = create(method, "IExecuteServerActionNode", method + "Execute", "ExecuteReference")
        setting(execute, "Action", "IServerAction:" + item["native"])
        for parameter in item["inputs"]: setting(execute + "/" + parameter["native"], "Value", "Payload." + parameter["native"])
        values = [("Result", "ExecuteReference." + item["output"]["name"])] if item is not shape else [("Context", "ExecuteReference.AvContextOut"), ("Completion", "ExecuteReference.AvCompletion"), ("Result", "ExecuteReference.AvResult")]
        if item is shape:
            context = create(method, "ILocalVariable", method + "InitialContext", "InitialContext")
            setting(context, "DataType", shape["contextType"])
            setting(execute + "/AvContextIn", "Value", "InitialContext")
        assign = create(method, "IAssignNode", method + "Assign", "SetResponse")
        for field_name, value in values:
            field = create(assign, "IAssignment", method + field_name)
            setting(field, "Variable", "Response." + field_name); setting(field, "Value", value)
        link(method + "/#IStartNode", auth); link(auth, execute); link(execute, assign); link(assign, method + "/#IEndNode")
        if item is not shape:
            for number, exception in enumerate(common.declared_exceptions(actions[item["native"]], contract)):
                if exception not in exception_types: raise ValueError("Explicit exception mapping required: " + exception)
                prefix = method + "Error" + str(number)
                handler_name = "SourceException" + str(number)
                handler = create(method, "IExceptionHandlerNode", prefix, handler_name)
                setting(handler, "Exception", "IUserException:" + exception); setting(handler, "AbortTransaction", False); setting(handler, "LogError", False)
                failure = create(method, "IAssignNode", prefix + "Assign", "SetFailure" + str(number))
                for field_name, value in [("FailureType", '"' + exception_types[exception] + '"'), ("FailureMessage", handler_name + ".ExceptionMessage")]:
                    field = create(failure, "IAssignment", prefix + field_name)
                    setting(field, "Variable", "Response." + field_name); setting(field, "Value", value)
                end = create(method, "IEndNode", prefix + "End")
                link(handler, failure); link(failure, end)
        ops.append({"op": "layout", "target": method})
    return ops


def verify_source_delivery(path, bundle_path):
    receipt = common.verify_delivery(path)
    bundle = read(bundle_path)
    if receipt.get("specification", {}).get("csharpSource") != bundle.get("csharpSource"): raise ValueError("Receipt does not prove this exact combined source bundle")
    if SOURCE.read_text(encoding="utf-8") not in bundle["csharpSource"]["files"].values(): raise ValueError("Original ReferenceJournal source absent from delivered bundle")
    return receipt


def build(work, contract_path, map_path, source_delivery, bundle_path=BUNDLE):
    started = time.perf_counter()
    methods, cases, expected, observations = verify_oracle(work)
    receipt = verify_source_delivery(source_delivery, bundle_path)
    contract, source_map = read(contract_path), read(map_path)
    bindings, structures = bind(methods, contract, source_map)
    shape = observation_shape(bindings, contract, source_map)
    ops = transport_ops(bindings, shape, contract)
    by_method = {item["method"]: item for item in bindings + [shape]}
    requests = [{"id": case["id"], "method": case["method"], "endpoint": by_method[case["method"]]["endpoint"], "evidenceScope": by_method[case["method"]]["evidenceScope"], "payload": {p["native"]: common.encode(case["arguments"][p["source"]], p["schema"], p["type"], structures) for p in by_method[case["method"]]["inputs"]}} for case in cases + observations]
    job = {"description": "Additive authenticated journal transport: five original public wrappers and one separate same-invocation internal context observation; no business body copies", "expectValid": True, "expectedMessages": [], "ops": ops}
    contents = {"transport.json": job, "bindings.json": bindings, "observation-shape.json": shape, "requests.json": requests, "bound-contract.json": contract, "bound-source-map.json": source_map}
    for name, value in contents.items(): frozen_write(work / name, common.serialized(value))
    journal_names = {item[key] for item in source_map if item.get("source", "").startswith("JournalRules.") for key in ("native", "implementation") if item.get(key)}
    proof = {"sourceDelivery": str(source_delivery.resolve()), "sourceDeliverySha256": sha(source_delivery), "taskId": receipt["taskId"], "sourcePath": str(SOURCE), "sourceSha256": sha(SOURCE), "sourceBundlePath": str(bundle_path.resolve()), "sourceBundleSha256": sha(bundle_path), "contractPath": str(contract_path.resolve()), "contractSha256": sha(contract_path), "sourceMapPath": str(map_path.resolve()), "sourceMapSha256": sha(map_path), "oracleFreezeSha256": sha(work / "oracle.freeze.json"), "probeSha256": sha(__file__), "sharedHelperSha256": sha(common.__file__), "files": {name: sha(work / name) for name in contents}, "counts": {"sourceMethods": 11, "sourcePublicMethods": 5, "sourceNativeActions": len(journal_names), "publicEndpoints": len(bindings), "internalObservationEndpoints": 1, "publicCases": len(cases), "internalObservations": len(observations), "ops": len(ops), "businessBodyCopies": 0}, "identicalStepBodies": {"combinedContract": duplicate_bodies(contract["logic"]["actions"]), "journalOnly": duplicate_bodies([action for action in contract["logic"]["actions"] if action["name"] in journal_names])}, "evidenceScope": "Public endpoints call original wrappers. ReferenceRunState calls only SourceMap.implementation of Run and exposes its returned typed context/completion; its observations certify internal state, not context exposure by the public wrapper."}
    hash_path = contract_path.parent / "source-hash.txt"
    if hash_path.exists(): proof["compilerSourceHashFile"] = {"path": str(hash_path.resolve()), "sha256": sha(hash_path), "value": hash_path.read_text(encoding="utf-8-sig").strip()}
    frozen_write(work / "binding-proof.json", common.serialized(proof))
    write(work / "build-timings.json", {"totalSeconds": time.perf_counter() - started, "nativeExecutionSeconds": 0, "liveRequests": 0})
    check(work)
    print(json.dumps(proof["counts"]))


def check(work):
    methods, cases, expected, observations = verify_oracle(work)
    if (work / "binding-proof.json").exists():
        proof = read(work / "binding-proof.json")
        for name, digest in proof["files"].items():
            if sha(work / name) != digest: raise ValueError("Frozen transport changed: " + name)
        pairs = [(proof["sourceDelivery"], proof["sourceDeliverySha256"]), (proof["sourceBundlePath"], proof["sourceBundleSha256"]), (proof["contractPath"], proof["contractSha256"]), (proof["sourceMapPath"], proof["sourceMapSha256"]), (work / "oracle.freeze.json", proof["oracleFreezeSha256"])]
        pairs.extend([(Path(__file__), proof["probeSha256"]), (Path(common.__file__), proof["sharedHelperSha256"])])
        if "compilerSourceHashFile" in proof:
            item = proof["compilerSourceHashFile"]
            pairs.append((item["path"], item["sha256"]))
        for path, digest in pairs:
            if sha(path) != digest: raise ValueError("Bound evidence changed: " + str(path))
        verify_source_delivery(Path(proof["sourceDelivery"]), Path(proof["sourceBundlePath"]))
        contract, source_map = read(work / "bound-contract.json"), read(work / "bound-source-map.json")
        bindings, structures = bind(methods, contract, source_map)
        shape = observation_shape(bindings, contract, source_map)
        if bindings != read(work / "bindings.json") or shape != read(work / "observation-shape.json"): raise ValueError("Bindings differ from frozen compiler evidence")
        if transport_ops(bindings, shape, contract) != read(work / "transport.json")["ops"]: raise ValueError("Transport contains unrelated mutations or copied business bodies")
    print(json.dumps({"localChecksPassed": True, "publicMethods": len(methods), "publicCases": len(cases), "internalObservations": len(observations), "liveRequests": 0}))


def run(work, transport_delivery, publication_path, secret_path):
    check(work)
    proof = read(work / "binding-proof.json")
    receipt = common.verify_delivery(transport_delivery)
    hashes = {item["sha256"].lower() for item in receipt.get("artifacts", []) + receipt.get("sources", [])}
    if sha(work / "transport.json") not in hashes: raise ValueError("Transport receipt does not prove this exact job")
    publication = read(publication_path)
    if publication.get("Completed") is not True or publication.get("HasErrors") is not False or not publication.get("VersionId"): raise ValueError("Confirmed successful publication required")
    key = read(secret_path)["key"]
    bindings = {item["method"]: item for item in read(work / "bindings.json")}
    shape = read(work / "observation-shape.json")
    structures = {s["name"]: s for s in read(work / "bound-contract.json")["data"]["structures"]}
    targets = {item["id"]: {"result": item["result"], "error": item["error"]} for item in read(work / "expected.json")}
    targets.update({item["id"]: item["expected"] for item in read(work / "observations.json")})
    run_dir = work / "runs" / (time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(4)); run_dir.mkdir(parents=True)
    for path in work.iterdir():
        if path.is_file() and path.suffix == ".json": shutil.copyfile(path, run_dir / path.name)
    shutil.copyfile(publication_path, run_dir / "confirmed-publication.json")
    shutil.copyfile(transport_delivery, run_dir / "transport-delivery.json")
    shutil.copyfile(proof["sourceDelivery"], run_dir / "source-delivery.json")
    shutil.copyfile(__file__, run_dir / "probe.py")
    requests = read(work / "requests.json")
    probes = [(requests[0], "invalid-key")] + [(item, key) for item in requests]
    results = []
    for item, token in probes:
        before = time.perf_counter()
        request = urllib.request.Request("https://" + common.HOST + "/" + common.MODULE + "/rest/CSharpLab/" + item["endpoint"], data=json.dumps(item["payload"]).encode("utf-8") if item["payload"] else b"", headers={"LabKey": token, "Content-Type": "application/json"}, method="POST")
        status, wire, actual, failure = 0, None, None, None
        try:
            with urllib.request.urlopen(request, timeout=60) as response: status, wire = response.status, response.read().decode("utf-8")
            body = json.loads(wire)
            if isinstance(body, dict) and set(body) == {"Response"}: body = body["Response"]
            if item["method"] == "RunState": actual = observe_response(body, shape, structures)
            else:
                if not isinstance(body, dict) or set(body) - {"Result", "FailureType", "FailureMessage"}: raise ValueError("Unexpected public response envelope")
                error_type, message = body.get("FailureType", ""), body.get("FailureMessage", "")
                if not isinstance(error_type, str) or not isinstance(message, str): raise ValueError("Invalid exception envelope")
                if error_type: actual = {"result": None, "error": {"type": error_type, "message": message}}
                else:
                    if message: raise ValueError("Failure message without exception type")
                    output = bindings[item["method"]]["output"]
                    actual = {"result": common.decode(body.get("Result", common.native_default(output["type"], structures)), output["schema"], output["type"], structures), "error": None}
        except urllib.error.HTTPError as error: status, wire = error.code, error.read().decode("utf-8")
        except Exception as error: failure = str(error)
        anonymous = token != key
        denied = status in (400, 401, 403, 500) and wire is not None and ("LabAccessDenied" in wire or "Invalid laboratory key." in wire)
        target = None if anonymous else targets[item["id"]]
        passed = denied if anonymous else status == 200 and actual == target and failure is None
        results.append({"id": item["id"], "method": item["method"], "evidenceScope": item["evidenceScope"], "invalidKey": anonymous, "status": status, "passed": passed, "expected": target, "actual": actual, "wire": wire, "error": failure, "seconds": time.perf_counter() - before})
        write(run_dir / "execution.json", results); write(work / "execution.json", results)
        print(json.dumps({"id": item["id"], "invalidKey": anonymous, "passed": passed, "status": status, "evidenceScope": item["evidenceScope"]}), flush=True)
    write(run_dir / "hashes.json", {path.name: sha(path) for path in run_dir.iterdir() if path.is_file()})
    return 0 if all(item["passed"] for item in results) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("oracle", "build", "check", "run"))
    parser.add_argument("--work", type=Path, default=WORK)
    parser.add_argument("--contract", type=Path, default=WORK / "contract.json")
    parser.add_argument("--mapping", type=Path, default=WORK / "source-map.json")
    parser.add_argument("--source-bundle", type=Path, default=BUNDLE)
    parser.add_argument("--source-delivery", type=Path)
    parser.add_argument("--transport-delivery", type=Path)
    parser.add_argument("--publication", type=Path)
    parser.add_argument("--secrets", type=Path, default=common.LAB / "secrets.json")
    args = parser.parse_args()
    args.work = args.work.resolve()
    if args.mode == "oracle": oracle(args.work)
    elif args.mode == "check": check(args.work)
    elif args.mode == "build":
        if not args.source_delivery: parser.error("build requires --source-delivery for exact source receipt and hash evidence")
        build(args.work, args.contract.resolve(), args.mapping.resolve(), args.source_delivery.resolve(), args.source_bundle.resolve())
    else:
        if not args.transport_delivery or not args.publication: parser.error("run requires --transport-delivery and --publication")
        raise SystemExit(run(args.work, args.transport_delivery, args.publication, args.secrets))
