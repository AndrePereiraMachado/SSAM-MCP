"""Frozen CLR temporal oracle and authenticated personal-lab REST transport.

oracle/check are local. build only writes an additive native transport job; it
never copies/replaces business bodies or the existing CSharpLab/LabAuthenticate.
run requires separate successful source/transport delivery and publication proof.
"""
from __future__ import annotations
import argparse
from decimal import Decimal
import hashlib
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

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "tests/csharp/TemporalValues.cs.txt"
DEFAULT_WORK = ROOT / ".local/data-logic-translator/temporal-lab"
LAB = ROOT / ".local/data-logic-translator/runtime-lab"
HOST = "personal-2qqw9srv.outsystemscloud.com"
MODULE = "ZZHighCodeLab_CS"
INSTANT_SOURCE = ROOT / "tests/csharp/TemporalInstants.cs.txt"
INSTANT_WORK = ROOT / ".local/data-logic-translator/instant-lab"
INSTANT_ORACLE = Path(__file__).with_name("TemporalInstantsOracle.cs.txt")


def corpus_settings(corpus):
    if corpus == "calendar": return SOURCE, "TemporalValues.cs", 21, "Calendar", "Temporal"
    if corpus == "instants": return INSTANT_SOURCE, "TemporalInstants.cs", 45, "Instants", "Instant"
    raise ValueError("Unknown explicit corpus: " + corpus)


ORACLE_CS = r'''using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
CultureInfo.CurrentUICulture = CultureInfo.InvariantCulture;
if (Environment.Version.Major != 8) throw new Exception("Oracle requires ordinary .NET 8 execution.");
var cases = new List<object>();
var expected = new List<object>();
var methods = typeof(Calendar).GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly);
object Schema(Type type) {
    var nullable = Nullable.GetUnderlyingType(type);
    if (nullable != null) return new { kind = "nullable", value = Schema(nullable) };
    var kind = type == typeof(DateOnly) ? "date" : type == typeof(TimeOnly) ? "time" : type == typeof(int) ? "int" : type == typeof(long) ? "long" : type == typeof(bool) ? "bool" : type == typeof(string) ? "string" : "record";
    return kind != "record" ? (object)new { kind } : new { kind, fields = type.GetProperties().ToDictionary(p => p.Name, p => Schema(p.PropertyType)) };
}
object? Normalize(object? value) => value switch {
    null => null,
    DateOnly date => new { DayNumber = date.DayNumber },
    TimeOnly clock => new { Ticks = clock.Ticks.ToString(CultureInfo.InvariantCulture) },
    long number => number.ToString(CultureInfo.InvariantCulture),
    int or bool or string => value,
    _ => value.GetType().GetProperties().ToDictionary(p => p.Name, p => Normalize(p.GetValue(value)))
};
void Case(string id, string methodName, params object?[] arguments) {
    var method = methods.Single(m => m.Name == methodName);
    var parameters = method.GetParameters();
    if (arguments.Length != parameters.Length) throw new Exception("Wrong case arity: " + id);
    cases.Add(new { id, method = methodName, arguments = parameters.Select((p, i) => (p.Name!, Value: Normalize(arguments[i]))).ToDictionary(p => p.Item1, p => p.Value) });
    try { expected.Add(new { id, result = Normalize(method.Invoke(null, arguments)), error = (object?)null }); }
    catch (TargetInvocationException exception) when (exception.InnerException != null) {
        var error = exception.InnerException;
        expected.Add(new { id, result = (object?)null, error = new { type = error.GetType().FullName, message = error.Message } });
    }
}
var first = DateOnly.MinValue; var last = DateOnly.MaxValue; var leap = new DateOnly(2000, 2, 29);
var zero = TimeOnly.MinValue; var tick = new TimeOnly(1); var end = TimeOnly.MaxValue;
Case("make_min", "Make", 1, 1, 1);
Case("make_max", "Make", 9999, 12, 31);
Case("make_leap_century", "Make", 2000, 2, 29);
Case("make_nonleap_century", "Make", 1900, 2, 29);
Case("make_bad_month", "Make", 2024, 13, 1);
Case("number_constructor_min", "FromNumber", 0);
Case("number_constructor_max", "FromNumber", last.DayNumber);
Case("number_constructor_negative", "FromNumber", -1);
Case("number_constructor_overflow", "FromNumber", last.DayNumber + 1);
Case("add_leap", "Add", leap, 1);
Case("add_backwards", "Add", new DateOnly(2024, 1, 1), -1);
Case("add_underflow", "Add", first, -1);
Case("add_overflow", "Add", last, 1);
Case("add_int_max", "Add", leap, int.MaxValue);
Case("first", "First"); Case("last", "Last"); Case("default_date", "Zero");
Case("number_min", "Number", first); Case("number_max", "Number", last);
Case("parts_min", "Parts", first); Case("parts_max", "Parts", last); Case("parts_leap", "Parts", leap);
Case("label_min", "Label", first); Case("label_max", "Label", last);
Case("custom_label_min", "CustomLabel", first); Case("custom_label_leap", "CustomLabel", leap);
Case("before_nulls", "Before", null, null); Case("before_null_left", "Before", null, first);
Case("before_null_right", "Before", first, null); Case("before_true", "Before", first, last);
Case("equal_nulls", "Equal", null, null); Case("equal_null_value", "Equal", null, first);
Case("equal_values", "Equal", leap, leap); Case("equal_different", "Equal", first, last);
Case("compare_before", "Compare", first, last); Case("compare_same", "Compare", leap, leap); Case("compare_after", "Compare", last, first);
Case("clock_zero", "Clock", 0L); Case("clock_one_tick", "Clock", 1L); Case("clock_max", "Clock", end.Ticks);
Case("clock_negative", "Clock", -1L); Case("clock_overflow", "Clock", end.Ticks + 1);
Case("at_microseconds", "At", 23, 59, 59, 999, 999);
Case("at_bad_hour", "At", 24, 0, 0, 0, 0);
Case("at_bad_millisecond", "At", 1, 2, 3, 1000, 0);
Case("at_bad_microsecond", "At", 1, 2, 3, 0, -1);
Case("shift_forward_wrap", "Shift", new TimeOnly(23, 59), 2);
Case("shift_backward_wrap", "Shift", tick, -1);
Case("shift_int_max", "Shift", tick, int.MaxValue);
Case("shift_int_min", "Shift", end, int.MinValue);
Case("fraction_zero", "Fraction", zero); Case("fraction_one_tick", "Fraction", tick); Case("fraction_wrap", "Fraction", end);
Case("last_tick", "LastTick");
Case("between_start_inclusive", "Between", new TimeOnly(8, 0), new TimeOnly(8, 0), new TimeOnly(9, 0));
Case("between_end_exclusive", "Between", new TimeOnly(9, 0), new TimeOnly(8, 0), new TimeOnly(9, 0));
Case("between_wrap_late", "Between", end, new TimeOnly(23, 0), new TimeOnly(1, 0));
Case("between_wrap_early", "Between", zero, new TimeOnly(23, 0), new TimeOnly(1, 0));
Case("between_wrap_gap", "Between", new TimeOnly(12, 0), new TimeOnly(23, 0), new TimeOnly(1, 0));
Case("between_equal_bounds", "Between", tick, tick, tick);
Case("same_clock_nulls", "SameClock", null, null); Case("same_clock_null_value", "SameClock", null, zero);
Case("same_clock_equal", "SameClock", tick, tick); Case("same_clock_tick_difference", "SameClock", zero, tick);
Case("nanosecond_zero", "Nanosecond", zero); Case("nanosecond_100", "Nanosecond", tick); Case("nanosecond_900", "Nanosecond", end);
var descriptors = methods.OrderBy(m => m.Name).Select(m => new {
    source = "Calendar." + m.Name, method = m.Name,
    inputs = m.GetParameters().Select(p => new { name = p.Name, schema = Schema(p.ParameterType) }), output = Schema(m.ReturnType)
});
Console.Write(JsonSerializer.Serialize(new { runtime = new { framework = RuntimeInformation.FrameworkDescription, version = Environment.Version.ToString(), culture = CultureInfo.CurrentCulture.Name, newline = Environment.NewLine }, methods = descriptors, cases, expected }, new JsonSerializerOptions { WriteIndented = true }));
'''


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"), parse_float=Decimal)


def serialized(value):
    return json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n"


def write(path, value):
    Path(path).write_text(serialized(value), encoding="utf-8")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def frozen_write(path, content):
    data = content.encode("utf-8") if isinstance(content, str) else content
    if path.exists() and path.read_bytes() != data:
        raise ValueError("Frozen artifact differs; use a new explicit work directory: " + str(path))
    if not path.exists(): path.write_bytes(data)


def oracle(work, corpus="calendar"):
    source, source_name, _, _, _ = corpus_settings(corpus)
    work.mkdir(parents=True, exist_ok=True)
    helper = work / "oracle"
    helper.mkdir(exist_ok=True)
    frozen_write(helper / source_name, source.read_bytes())
    frozen_write(helper / "Program.cs", ORACLE_CS if corpus == "calendar" else INSTANT_ORACLE.read_text(encoding="utf-8"))
    frozen_write(helper / "Oracle.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseAppHost>false</UseAppHost><EnableNETAnalyzers>false</EnableNETAnalyzers><TreatWarningsAsErrors>true</TreatWarningsAsErrors></PropertyGroup></Project>\n')
    frozen_write(helper / "NuGet.Config", '<?xml version="1.0"?><configuration><packageSources><clear /></packageSources></configuration>\n')
    appdata = work / ".appdata"
    (appdata / "NuGet").mkdir(parents=True, exist_ok=True)
    frozen_write(appdata / "NuGet/NuGet.Config", (helper / "NuGet.Config").read_bytes())
    env = dict(os.environ, DOTNET_CLI_TELEMETRY_OPTOUT="1", DOTNET_NOLOGO="1", DOTNET_CLI_HOME=str(work / ".dotnet"),
               APPDATA=str(appdata), DOTNET_ADD_GLOBAL_TOOLS_TO_PATH="false", NUGET_PACKAGES=str(Path(os.environ["USERPROFILE"]) / ".nuget/packages"))
    commands = [["dotnet", "restore", "Oracle.csproj", "--configfile", "NuGet.Config", "--verbosity", "quiet"],
                ["dotnet", "build", "Oracle.csproj", "--no-restore", "--verbosity", "quiet"],
                ["dotnet", "bin/Debug/net8.0/Oracle.dll"]]
    for index, command in enumerate(commands):
        result = subprocess.run(command, cwd=helper, env=env, capture_output=True, text=True, encoding="utf-8", check=False)
        (work / ("oracle-command-" + str(index) + ".log")).write_text(result.stdout + result.stderr, encoding="utf-8")
        if result.returncode: raise RuntimeError("Oracle command failed: " + " ".join(command) + "\n" + result.stdout + result.stderr)
    observed = json.loads(result.stdout)
    for key in ["runtime", "methods", "cases", "expected"]:
        frozen_write(work / (key + ".json"), serialized(observed[key]))
    names = ["runtime.json", "methods.json", "cases.json", "expected.json", "oracle/" + source_name, "oracle/Program.cs", "oracle/Oracle.csproj", "oracle/NuGet.Config"]
    manifest = {"sourcePath": str(source), "sourceSha256": sha(source), "files": {name: sha(work / name) for name in names}}
    frozen_write(work / "oracle.freeze.json", serialized(manifest))
    print(json.dumps({"oracle": "ordinary .NET 8", "methods": len(observed["methods"]), "cases": len(observed["cases"]), "errors": sum(x["error"] is not None for x in observed["expected"]), "work": str(work)}))


def verify_oracle(work, corpus="calendar"):
    source, _, method_count, owner, _ = corpus_settings(corpus)
    freeze = read(work / "oracle.freeze.json")
    if sha(source) != freeze["sourceSha256"]: raise ValueError("Original temporal source changed")
    for name, digest in freeze["files"].items():
        if sha(work / name) != digest: raise ValueError("Frozen oracle changed: " + name)
    methods = read(work / "methods.json")
    cases = read(work / "cases.json")
    expected = read(work / "expected.json")
    if len(methods) != method_count or any(m["source"] != owner + "." + m["method"] for m in methods) or {m["method"] for m in methods} != {c["method"] for c in cases}:
        raise ValueError("All " + str(method_count) + " " + owner + " methods must have oracle cases")
    if len({c["id"] for c in cases}) != len(cases) or [c["id"] for c in cases] != [e["id"] for e in expected]:
        raise ValueError("Invalid oracle case identities")
    return methods, cases, expected


def fields(kind, structures):
    return {f["name"]: f["type"] for f in structures[kind]["attributes"]}


def native_default(kind, structures):
    if kind in structures: return {name: native_default(t, structures) for name, t in fields(kind, structures).items()}
    if kind == "Text": return ""
    if kind == "Boolean": return False
    if kind in ("Integer", "Long Integer", "Decimal"): return 0
    raise ValueError("Unknown transport type: " + kind)


def validate_schema(schema, kind, structures):
    tag = schema["kind"]
    primitives = {"int": "Integer", "long": "Long Integer", "bool": "Boolean", "string": "Text"}
    if tag in primitives:
        if kind != primitives[tag]: raise ValueError("CLR/native scalar mismatch: " + repr((tag, kind)))
        return
    if kind not in structures: raise ValueError("Missing native carrier: " + kind)
    attrs = fields(kind, structures)
    if tag == "nullable":
        if set(attrs) != {"HasValue", "Value"} or attrs["HasValue"] != "Boolean": raise ValueError("Invalid nullable carrier")
        validate_schema(schema["value"], attrs["Value"], structures)
    elif tag in ("date", "time", "duration", "offset"):
        carriers = {"date": {"DayNumber": "Integer"}, "time": {"Ticks": "Long Integer"}, "duration": {"Ticks": "Long Integer"}, "offset": {"UtcTicks": "Long Integer", "OffsetMinutes": "Integer"}}
        if attrs != carriers[tag]: raise ValueError("Invalid temporal carrier")
    elif tag == "record":
        if set(attrs) != set(schema["fields"]): raise ValueError("Record fields require a verified member mapping")
        for name, nested in schema["fields"].items(): validate_schema(nested, attrs[name], structures)
    else: raise ValueError("Unsupported CLR schema: " + tag)


def encode(value, schema, kind, structures):
    validate_schema(schema, kind, structures)
    if schema["kind"] == "nullable":
        inner = fields(kind, structures)["Value"]
        return {"HasValue": value is not None, "Value": native_default(inner, structures) if value is None else encode(value, schema["value"], inner, structures)}
    if kind in structures:
        attrs = fields(kind, structures)
        if not isinstance(value, dict) or set(value) != set(attrs): raise ValueError("Input record shape mismatch")
        return {name: encode(value[name], schema.get("fields", {}).get(name, {"kind": "long" if t == "Long Integer" else "int"}), t, structures) for name, t in attrs.items()}
    if kind == "Long Integer":
        if type(value) not in (int, str) or not re.fullmatch(r"-?\d+", str(value)): raise ValueError("Long integer must remain exact")
        result = int(value)
        if not -9223372036854775808 <= result <= 9223372036854775807: raise ValueError("Long integer range")
        return result
    if kind == "Integer" and (type(value) is not int or not -2147483648 <= value <= 2147483647): raise ValueError("Integer range/type")
    if kind == "Boolean" and type(value) is not bool: raise ValueError("Boolean type")
    if kind == "Text" and not isinstance(value, str): raise ValueError("Text type")
    return value


def decode(value, schema, kind, structures):
    validate_schema(schema, kind, structures)
    if kind in structures:
        attrs = fields(kind, structures)
        if not isinstance(value, dict) or set(value) - set(attrs): raise ValueError("Unexpected REST record")
        present = {name: value.get(name, native_default(t, structures)) for name, t in attrs.items()}
        if schema["kind"] == "nullable":
            if type(present["HasValue"]) is not bool: raise ValueError("Nullable presence type")
            return decode(present["Value"], schema["value"], attrs["Value"], structures) if present["HasValue"] else None
        return {name: decode(present[name], schema.get("fields", {}).get(name, {"kind": "long" if t == "Long Integer" else "int"}), t, structures) for name, t in attrs.items()}
    exact = encode(value, schema, kind, structures)
    return str(exact) if kind == "Long Integer" else exact


def binding(methods, contract, source_map, corpus="calendar"):
    """Only the compiler SourceMap chooses action names; no simple-name fallback."""
    _, _, _, _, endpoint_prefix = corpus_settings(corpus)
    actions = {a["name"]: a for a in contract["logic"]["actions"]}
    if len(actions) != len(contract["logic"]["actions"]): raise ValueError("Duplicate native action names")
    structures = {s["name"]: s for s in contract["data"]["structures"]}
    result = []
    for method in methods:
        matches = [m for m in source_map if m.get("kind") == "server" and m.get("source", "").startswith(method["source"] + "(")]
        if len(matches) != 1: raise ValueError("Require one verified source-map binding: " + method["source"])
        entry = matches[0]
        if entry["native"] not in actions: raise ValueError("Mapped action is absent: " + entry["native"])
        action = actions[entry["native"]]
        if action.get("kind") != "server" or len(action["inputs"]) != len(method["inputs"]) or len(action["outputs"]) != 1: raise ValueError("Native method signature mismatch")
        inputs = []
        for declared, native in zip(method["inputs"], action["inputs"]):
            if native["name"] != "Arg_" + declared["name"]: raise ValueError("Input naming requires explicit reviewed parameter mapping")
            validate_schema(declared["schema"], native["type"], structures)
            inputs.append({"source": declared["name"], "native": native["name"], "type": native["type"], "schema": declared["schema"]})
        output = action["outputs"][0]
        validate_schema(method["output"], output["type"], structures)
        result.append({"method": method["method"], "source": entry["source"], "native": entry["native"], "endpoint": endpoint_prefix + method["method"], "inputs": inputs, "output": dict(output, schema=method["output"])})
    if len({m["native"] for m in result}) != len(result): raise ValueError("Source-map alias collision")
    return result, structures


def declared_exceptions(action, contract):
    actions = {a["name"]: a for a in contract["logic"]["actions"]}
    declared = {e["name"] for e in contract.get("exceptions", [])}
    found, visited = set(), set()
    def walk(node):
        if isinstance(node, list):
            for item in node: walk(item)
        elif isinstance(node, dict):
            if "raise" in node:
                name = node["raise"].removeprefix("IUserException:")
                if name not in declared: raise ValueError("Undeclared source exception: " + name)
                found.add(name)
            if isinstance(node.get("call"), str):
                target = node["call"].removeprefix("IServerAction:")
                if target in actions and target not in visited:
                    visited.add(target); walk(actions[target])
            for key, value in node.items():
                if key != "call": walk(value)
    walk(action)
    return sorted(found)


def verify_delivery(path):
    receipt = read(path)
    if receipt.get("delivered") is not True or receipt.get("environment") != HOST or receipt.get("module") != MODULE: raise ValueError("Successful personal-lab delivery required")
    for item in receipt.get("sources", []) + receipt.get("artifacts", []):
        if sha(item["path"]) != item["sha256"].lower(): raise ValueError("Delivery artifact changed: " + item["path"])
    return receipt


def validate_replacement(previous, generated_ops, bindings):
    """Accept only the same envelope structures and REST boundary in the same service."""
    previous_ops = previous.get("ops", [])
    specs = [op for op in previous_ops if op.get("op") == "spec"]
    expected_specs = [op for op in generated_ops if op.get("op") == "spec"]
    if len(specs) != 1 or specs != expected_specs:
        raise ValueError("Replacement requires the exact unchanged previous envelope spec")
    endpoints = [op for op in previous_ops if op.get("op") == "create" and op.get("type") == "IRestServiceAction"]
    names = [op.get("name") for op in endpoints]
    expected_names = {item["endpoint"] for item in bindings}
    if len(names) != len(expected_names) or set(names) != expected_names or any(op.get("parent") != "IRestService:CSharpLab" for op in endpoints):
        raise ValueError("Replacement requires the exact previous CSharpLab endpoint set")
    def boundary(ops):
        creates = [op for op in ops if op.get("op") == "create" and op.get("type") in ("IRestServiceAction", "IRestServiceActionInput", "IRestServiceActionOutput")]
        aliases = {op.get("as") for op in creates}
        settings = [op for op in ops if op.get("op") == "set" and op.get("target") in aliases]
        return creates, settings
    if boundary(previous_ops) != boundary(generated_ops):
        raise ValueError("Replacement refuses request/response ABI or endpoint route drift")


def build(work, contract_path, map_path, source_delivery, corpus="calendar", replace=False, previous_transport=None):
    if replace != (previous_transport is not None):
        raise ValueError("Replacement requires both --replace and --previous-transport")
    if replace:
        work, previous_transport = work.resolve(), previous_transport.resolve()
        if work in (DEFAULT_WORK.resolve(), INSTANT_WORK.resolve()) or previous_transport.is_relative_to(work):
            raise ValueError("Replacement requires an explicit new work directory separate from the previous transport")
        if any((work / name).exists() for name in ("transport.json", "binding-proof.json", "previous-transport.json")):
            raise ValueError("Replacement work already contains transport evidence; use a new explicit work directory")
    source, _, _, owner, _ = corpus_settings(corpus)
    methods, cases, expected = verify_oracle(work, corpus)
    contract, source_map = read(contract_path), read(map_path)
    receipt = verify_delivery(source_delivery)
    bundle = receipt["specification"]["csharpSource"]["files"]
    if source.read_text(encoding="utf-8") not in bundle.values(): raise ValueError("Original " + owner + " source absent from delivered bundle")
    bindings, structures = binding(methods, contract, source_map, corpus)
    # Persist the precise caller-supplied compiler evidence; no source-body edits.
    by_method = {m["method"]: m for m in bindings}
    actions = {a["name"]: a for a in contract["logic"]["actions"]}
    exception_types = {name: "System." + name for name in ["ArgumentOutOfRangeException", "ArgumentException", "OverflowException"]}
    ops, envelope_types = [], []
    for item in bindings:
        envelope_types.append({"name": "AvLab" + item["endpoint"] + "Response", "attributes": [{"name": "Result", "type": item["output"]["type"]}, {"name": "FailureType", "type": "Text"}, {"name": "FailureMessage", "type": "Text"}]})
        if item["inputs"]: envelope_types.append({"name": "AvLab" + item["endpoint"] + "Request", "attributes": [{"name": p["native"], "type": p["type"]} for p in item["inputs"]]})
    if not replace and any(t["name"] in structures for t in envelope_types): raise ValueError("Transport type already exists; additive build refuses replacement")
    ops.append({"op": "spec", "data": {"structures": envelope_types}})
    def create(parent, kind, alias, name=None):
        op = {"op": "create", "parent": parent, "type": kind, "as": alias}
        if name is not None: op["name"] = name
        ops.append(op); return alias
    def setting(target, prop, value): ops.append({"op": "set", "target": target, "prop": prop, "value": value})
    def link(start, end): ops.append({"op": "link", "from": start, "to": end})
    for item in bindings:
        name = item["endpoint"]
        method = create("IRestService:CSharpLab", "IRestServiceAction", "$" + name, name)
        setting(method, "HTTPMethod", "POST"); setting(method, "URLPath", "/" + name)
        key = create(method, "IRestServiceActionInput", method + "Key", "LabKey")
        setting(key, "DataType", "Text"); setting(key, "ReceiveIn", "Header"); setting(key, "IsMandatory", True)
        if item["inputs"]:
            body = create(method, "IRestServiceActionInput", method + "Body", "Payload")
            setting(body, "DataType", "AvLab" + name + "Request"); setting(body, "ReceiveIn", "Body"); setting(body, "IsMandatory", True)
        output = create(method, "IRestServiceActionOutput", method + "Output", "Response")
        setting(output, "DataType", "AvLab" + name + "Response"); setting(output, "SendIn", "Body")
        auth = create(method, "IExecuteServerActionNode", method + "Auth", "AuthenticateLab")
        setting(auth, "Action", "IServerAction:LabAuthenticate"); setting(auth + "/LabKey", "Value", "LabKey")
        execute = create(method, "IExecuteServerActionNode", method + "Execute", "ExecuteTemporal")
        setting(execute, "Action", "IServerAction:" + item["native"])
        for parameter in item["inputs"]: setting(execute + "/" + parameter["native"], "Value", "Payload." + parameter["native"])
        assign = create(method, "IAssignNode", method + "Assign", "SetResult")
        field = create(assign, "IAssignment", method + "Result")
        setting(field, "Variable", "Response.Result"); setting(field, "Value", "ExecuteTemporal." + item["output"]["name"])
        link(method + "/#IStartNode", auth); link(auth, execute); link(execute, assign); link(assign, method + "/#IEndNode")
        item["exceptions"] = declared_exceptions(actions[item["native"]], contract)
        for number, exception in enumerate(item["exceptions"]):
            if exception not in exception_types: raise ValueError("Explicit CLR type mapping required for source exception: " + exception)
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
    previous_evidence = {}
    if replace:
        validate_replacement(read(previous_transport), ops, bindings)
        # Parent-qualified targets exclude identically named methods in other services.
        deletions = [{"op": "delete", "target": "IRestService:CSharpLab/" + item["endpoint"]} for item in bindings]
        ops = deletions + [op for op in ops if op["op"] != "spec"]
        shutil.copyfile(previous_transport, work / "previous-transport.json")
        previous_evidence = {"previousTransportPath": str(previous_transport), "previousTransportSha256": sha(previous_transport)}
    requests = [{"id": c["id"], "endpoint": by_method[c["method"]]["endpoint"], "payload": {p["native"]: encode(c["arguments"][p["source"]], p["schema"], p["type"], structures) for p in by_method[c["method"]]["inputs"]}} for c in cases]
    for path, value in [("transport.json", {"description": ("Replace only verified temporal REST endpoints with unchanged request/response ABI" if replace else "Additive authenticated temporal CLR differential transport; original business actions are unchanged"), "expectValid": True, "expectedMessages": [], "ops": ops}), ("bindings.json", bindings), ("requests.json", requests), ("bound-contract.json", contract), ("bound-source-map.json", source_map)]: write(work / path, value)
    write(work / "binding-proof.json", {**previous_evidence, "sourceDelivery": str(source_delivery.resolve()), "taskId": receipt["taskId"], "contractPath": str(contract_path.resolve()), "contractSha256": sha(contract_path), "sourceMapPath": str(map_path.resolve()), "sourceMapSha256": sha(map_path), "oracleFreezeSha256": sha(work / "oracle.freeze.json"), "files": {n: sha(work / n) for n in ["transport.json", "bindings.json", "requests.json", "bound-contract.json", "bound-source-map.json"] + (["previous-transport.json"] if replace else [])}})
    check(work, corpus)
    print(json.dumps({"methods": len(bindings), "cases": len(cases), "ops": len(ops), "transport": str(work / "transport.json")}))


def check(work, corpus="calendar"):
    methods, cases, expected = verify_oracle(work, corpus)
    checks = 0
    if (work / "binding-proof.json").exists():
        proof = read(work / "binding-proof.json")
        if "previousTransportPath" in proof and sha(proof["previousTransportPath"]) != proof["previousTransportSha256"]:
            raise ValueError("Previous immutable transport evidence changed")
        for name, digest in proof["files"].items():
            if sha(work / name) != digest: raise ValueError("Transport evidence changed: " + name)
        if sha(work / "oracle.freeze.json") != proof["oracleFreezeSha256"]: raise ValueError("Oracle freeze changed")
        contract = read(work / "bound-contract.json")
        bindings, structures = binding(methods, contract, read(work / "bound-source-map.json"), corpus)
        by_method = {b["method"]: b for b in bindings}
        for case, expectation in zip(cases, expected):
            item = by_method[case["method"]]
            for parameter in item["inputs"]:
                value = case["arguments"][parameter["source"]]
                wire = encode(value, parameter["schema"], parameter["type"], structures)
                if decode(wire, parameter["schema"], parameter["type"], structures) != value: raise ValueError("Input carrier round trip failed")
                checks += 1
            if expectation["error"] is None:
                output = item["output"]
                wire = encode(expectation["result"], output["schema"], output["type"], structures)
                if decode(wire, output["schema"], output["type"], structures) != expectation["result"]: raise ValueError("Output carrier round trip failed")
                checks += 1
    print(json.dumps({"localChecksPassed": True, "oracleCases": len(cases), "methods": len(methods), "carrierRoundTrips": checks}))


def run(work, transport_delivery, publication_path, secret_path, corpus="calendar"):
    check(work, corpus)
    proof = read(work / "binding-proof.json")
    verify_delivery(Path(proof["sourceDelivery"]))
    receipt = verify_delivery(transport_delivery)
    artifact_hashes = {x["sha256"].lower() for x in receipt.get("artifacts", []) + receipt.get("sources", [])}
    if sha(work / "transport.json") not in artifact_hashes: raise ValueError("Transport receipt does not prove this exact job")
    publication = read(publication_path)
    if publication.get("Completed") is not True or publication.get("HasErrors") is not False or not publication.get("VersionId"): raise ValueError("Confirmed successful server publication required")
    key = read(secret_path)["key"]
    cases, expected = read(work / "cases.json"), read(work / "expected.json")
    requests = {r["id"]: r for r in read(work / "requests.json")}
    bindings = {b["method"]: b for b in read(work / "bindings.json")}
    structures = {s["name"]: s for s in read(work / "bound-contract.json")["data"]["structures"]}
    run_dir = work / "runs" / (time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(4)); run_dir.mkdir(parents=True)
    for path in work.iterdir():
        if path.is_file() and path.suffix == ".json": shutil.copyfile(path, run_dir / path.name)
    shutil.copyfile(publication_path, run_dir / "confirmed-publication.json")
    shutil.copyfile(transport_delivery, run_dir / "transport-delivery.json")
    shutil.copyfile(__file__, run_dir / "probe.py")
    if corpus == "instants": shutil.copyfile(INSTANT_ORACLE, run_dir / INSTANT_ORACLE.name)
    results = []
    probes = [(cases[0], expected[0], "invalid-key")] + [(case, expectation, key) for case, expectation in zip(cases, expected)]
    for case, expectation, token in probes:
        wire_input = requests[case["id"]]
        request = urllib.request.Request("https://" + HOST + "/" + MODULE + "/rest/CSharpLab/" + wire_input["endpoint"], data=json.dumps(wire_input["payload"]).encode("utf-8") if bindings[case["method"]]["inputs"] else b"", headers={"LabKey": token, "Content-Type": "application/json"}, method="POST")
        status, wire, actual, failure = 0, None, None, None
        try:
            with urllib.request.urlopen(request, timeout=60) as response: status, wire = response.status, response.read().decode("utf-8")
            body = json.loads(wire, parse_float=Decimal)
            if isinstance(body, dict) and set(body) == {"Response"}: body = body["Response"]
            if not isinstance(body, dict) or set(body) - {"Result", "FailureType", "FailureMessage"}: raise ValueError("Unexpected response envelope")
            error_type, message = body.get("FailureType", ""), body.get("FailureMessage", "")
            if not isinstance(error_type, str) or not isinstance(message, str): raise ValueError("Exception envelope requires text")
            if error_type: actual = {"result": None, "error": {"type": error_type, "message": message}}
            else:
                output = bindings[case["method"]]["output"]
                if message: raise ValueError("Failure message without exception type")
                actual = {"result": decode(body.get("Result", native_default(output["type"], structures)), output["schema"], output["type"], structures), "error": None}
        except urllib.error.HTTPError as error: status, wire = error.code, error.read().decode("utf-8")
        except Exception as error: failure = str(error)
        anonymous = token != key
        target = {k: expectation[k] for k in ("result", "error")}
        denied = status in (400, 401, 403, 500) and wire is not None and ("LabAccessDenied" in wire or "Invalid laboratory key." in wire)
        passed = denied if anonymous else status == 200 and actual == target and failure is None
        results.append({"id": case["id"], "method": case["method"], "invalidKey": anonymous, "status": status, "passed": passed, "expected": None if anonymous else target, "actual": actual, "wire": wire, "error": failure})
        write(run_dir / "execution.json", results); write(work / "execution.json", results)
        print(json.dumps({"id": case["id"], "invalidKey": anonymous, "passed": passed, "status": status}), flush=True)
    write(run_dir / "hashes.json", {p.name: sha(p) for p in run_dir.iterdir() if p.is_file()})
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["oracle", "check", "build", "run"])
    parser.add_argument("--corpus", choices=["calendar", "instants"], default="calendar", help="Explicit unchanged C# corpus; default preserves Calendar frozen67cases")
    parser.add_argument("--work", type=Path)
    parser.add_argument("--contract", type=Path)
    parser.add_argument("--mapping", type=Path, help="Exact compiler SourceMap; no guessed method-name binding")
    parser.add_argument("--source-delivery", type=Path)
    parser.add_argument("--replace", action="store_true", help="Replace only existing verified REST endpoints, reusing their unchanged ABI")
    parser.add_argument("--previous-transport", type=Path, help="Original additive transport job; required with --replace and a new explicit --work")
    parser.add_argument("--transport-delivery", type=Path)
    parser.add_argument("--publication", type=Path)
    parser.add_argument("--secrets", type=Path, default=LAB / "secrets.json")
    args = parser.parse_args()
    if args.replace or args.previous_transport:
        if args.mode != "build" or not args.replace or not args.previous_transport or not args.work:
            parser.error("replacement requires build --replace --previous-transport and an explicit new --work")
    args.work = (args.work or (INSTANT_WORK if args.corpus == "instants" else DEFAULT_WORK)).resolve()
    if args.mode == "oracle": oracle(args.work, args.corpus)
    elif args.mode == "check": check(args.work, args.corpus)
    elif args.mode == "build":
        if not all([args.contract, args.mapping, args.source_delivery]): parser.error("build requires --contract, --mapping and --source-delivery")
        build(args.work, args.contract, args.mapping, args.source_delivery, args.corpus, args.replace, args.previous_transport)
    else:
        if not all([args.transport_delivery, args.publication]): parser.error("run requires --transport-delivery and --publication")
        raise SystemExit(run(args.work, args.transport_delivery, args.publication, args.secrets, args.corpus))
