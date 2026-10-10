"""Differential read-only SQL fixtures for cold-authored C# queries.

The product compiler supplies every business expression and native action step.
This test adapter substitutes only relational table roots with typed fixture rows,
then calls the resulting native action through the authenticated personal lab.
No production entity data is inserted or rewritten.
"""
from __future__ import annotations
import argparse
import copy
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
import secrets
import shutil
import time
import urllib.error
import urllib.request

HOST = "personal-2qqw9srv.outsystemscloud.com"
MODULE = "ZZHighCodeLab_CS"
ROOT = Path(__file__).resolve().parents[3]
COLD = ROOT / ".local/data-logic-translator/cold-query-projection"
LAB = ROOT / ".local/data-logic-translator/runtime-lab"
TABLES = {"Account": "Accounts", "Invoice": "Invoices"}

def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"), parse_float=Decimal)

def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def native(value):
    if isinstance(value, str): return '"' + value.replace('"', '""') + '"'
    if isinstance(value, bool): return "True" if value else "False"
    if value is None: raise ValueError("This fixture has no null method arguments")
    text = format(value, "f") if isinstance(value, Decimal) else str(value)
    if "." not in text and (int(text) > 9223372036854775807 or int(text) < -9223372036854775807): text += ".0"
    return text

def sql_literal(value, kind, decimal_type="DECIMAL(37,8)"):
    if kind == "Text":
        # Exact UTF-16 fixture bytes avoid the Studio SQL lexer's Unicode literal rules.
        return "CAST(NULL AS NVARCHAR(MAX))" if value is None else "CONVERT(NVARCHAR(MAX), 0x" + str(value).encode("utf-16-le").hex().upper() + ")"
    if kind == "Boolean":
        return "CAST(" + ("NULL" if value is None else "1" if value else "0") + " AS BIT)"
    if kind == "Decimal" and decimal_type == "SQL_VARIANT":
        exact_type = fixture_decimal_type([value])
        if exact_type == "SQL_VARIANT": raise ValueError("Decimal fixture literal exceeds SQL representable precision")
        return "CAST(" + sql_literal(value,kind,exact_type) + " AS SQL_VARIANT)"
    sql_type = decimal_type if kind == "Decimal" else "INT" if kind == "Integer" else "BIGINT"
    if value is not None:
        number = Decimal(str(value))
        if not number.is_finite(): raise ValueError("Non-finite fixture number")
        text = format(number, "f")
    else: text = "NULL"
    return "CAST(" + text + " AS " + sql_type + ")"

def fixture_decimal_type(values):
    numbers = [Decimal(str(value)) for value in values if value is not None]
    scale = max((max(0,-value.as_tuple().exponent) for value in numbers),default=0)
    integer = max((max(0,value.adjusted()+1) for value in numbers),default=1)
    precision = max(1,integer+scale)
    if precision > 38: return "SQL_VARIANT"
    return "DECIMAL("+str(precision)+","+str(scale)+")"

def roots(dataset, contract, mapping, tables=TABLES):
    result = {}
    for entity in contract["data"]["entities"]:
        name = entity["name"]
        if name not in tables: raise ValueError("Unexpected fixture table " + name)
        columns = [("Id", "Long Integer", "Id", False)]
        by_native = {item["native"].split(".", 1)[1]: item for item in mapping if item.get("native", "").startswith(name + ".")}
        presence = {item["presence"]: item["source"].rsplit(".", 1)[1] for item in by_native.values() if item.get("presence")}
        for attribute in entity["attributes"]:
            column = attribute["name"]
            if column in presence: columns.append((column, "Boolean", presence[column], True))
            else:
                member = by_native[column]["source"].rsplit(".", 1)[1]
                columns.append((column, attribute["type"], member, False))
        rows = dataset[tables[name]]
        decimal_types = {column:fixture_decimal_type(row.get(member) for row in rows)
            for column,kind,member,_ in columns if kind=="Decimal"}
        selects = []
        for row in rows:
            values = []
            for column, kind, member, is_presence in columns:
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", column): raise ValueError("Non-identifier column")
                value = row.get(member)
                if is_presence: value = value is not None
                elif value is None: value = "" if kind == "Text" else False if kind == "Boolean" else 0
                values.append(sql_literal(value, kind,decimal_types.get(column,"DECIMAL(37,8)")) + " AS [" + column + "]")
            selects.append("SELECT " + ", ".join(values))
        if not selects:
            selects = ["SELECT " + ", ".join(sql_literal(None, kind) + " AS [" + column + "]" for column, kind, _, _ in columns) + " WHERE 1 = 0"]
        result[name] = "(" + " UNION ALL ".join(selects) + ")"
    return result

def bind_roots(statement, sources):
    # One pass: inserted fixture text is never reparsed as a model identifier.
    pattern = re.compile(r"\bFROM\s+\{([A-Za-z_][A-Za-z0-9_]*)\}|\{([A-Za-z_][A-Za-z0-9_]*)\}", re.I)
    used = set()
    def replace(match):
        name = match.group(1) or match.group(2)
        if name not in sources: raise ValueError("Unbound table root " + name)
        alias = "AvFixture" + name
        if match.group(1):
            used.add(name)
            return "FROM " + sources[name] + " " + alias
        return alias
    translated = pattern.sub(replace, statement)
    if not used: raise ValueError("No fixture roots bound")
    return translated, sorted(used)

def runtime_call_steps(normalized):
    def walk(node):
        if isinstance(node,list):
            for item in node: yield from walk(item)
        elif isinstance(node,dict):
            target=node.get("call")
            if isinstance(target,str) and target.startswith("IFrameworkIntrinsic:"): yield node
            for key in ("then","else","do","next","steps","otherwise"): yield from walk(node.get(key))
            for arm in node.get("switch",[]): yield from walk(arm.get("steps"))
    for action in normalized["actions"]:
        yield from walk(action["steps"])
        for handler in action.get("handlers",[]): yield from walk(handler["steps"])


def bind_runtime_calls(normalized, receipt_path, fixture):
    """Bind only compiler call tokens to the already-proved delivery identities."""
    receipt=read(receipt_path)
    if receipt.get("delivered") is not True or receipt.get("environment") != HOST or receipt.get("module") != MODULE:
        raise ValueError("A successful personal-lab source delivery is required")
    for entry in receipt.get("sources",[])+receipt.get("artifacts",[]):
        if sha(Path(entry["path"])) != entry["sha256"].lower():
            raise ValueError("Source delivery evidence changed: "+entry["path"])
    source=receipt["specification"]["csharpSource"]["files"]
    original=(ROOT/"tests/csharp"/(fixture+".cs.txt")).read_text()
    if original not in source.values(): raise ValueError("Fixture source is absent from the delivered C# bundle")
    lock=read(Path(receipt["runtimeDependencies"]["path"]))
    producers={p["binding"]:p for p in lock["producers"]}
    targets={b["reference"]:"IServerActionSignature:@"+producers[b["producerBinding"]]["producerKey"]+"/"+b["originalElementKey"] for b in lock["bindings"]}
    calls=0
    for step in runtime_call_steps(normalized):
        target=step["call"]
        if target not in targets: raise ValueError("Unbound runtime requirement "+target)
        step["call"]=targets[target];calls+=1
    return {"delivery":str(receipt_path.resolve()),"taskId":receipt["taskId"],"callsBound":calls,
            "lockSha256":sha(Path(receipt["runtimeDependencies"]["path"])),"targets":targets}


def build(work, replace=False, corpus="queries", source_delivery=None):
    work.mkdir(parents=True, exist_ok=True)
    cold = COLD if corpus == "queries" else ROOT / ".local/data-logic-translator" / ("cold-group-authoring" if corpus=="groups" else "cold-average-pipeline")
    contract = read(cold / "translated-contract.json")
    mapping = read(cold / "translated-map.json")
    structures = {item["name"]:item for item in contract["data"]["structures"]}
    prefix = {"queries":"ColdQueryCase","groups":"ColdGroupCase","averages":"ColdAverageCase"}[corpus]
    if corpus == "queries":
        inputs = read(cold / "inputs.json")
        freeze = read(cold / "expectations.freeze.json")
        input_hash, expected_hash = freeze["InputsSha256"], freeze["ExpectationsSha256"]
        expected_file, fixture, tables = "expectations.json", "ColdQueryProjection", TABLES
    else:
        freeze = read(cold / "manifest.json")
        input_hash, expected_hash = freeze["inputSha256"], freeze["expectedSha256"]
        expected_file = "expected.json"
        fixture, tables = ("ColdGrouping", {"LedgerEntry":"Rows"}) if corpus=="groups" else ("ColdAveragePipeline", {"AverageLedgerEntry":"Rows"})
        original_inputs = read(cold / "inputs.json")
        errors = {item["name"]:item.get("error") for item in read(cold/expected_file)}
        inputs = {"Cases":[{"Id":item["name"],"Method":item["report"],"Dataset":item["name"],"Arguments":item["parameters"],"ExpectedError":errors[item["name"]]} for item in original_inputs],
            "Datasets":{item["name"]:{"Rows":[{key[0].upper()+key[1:]:value for key,value in row.items()} for row in item["rows"]]} for item in original_inputs}}
        if corpus=="averages":
            # The independent oracle calls both methods with its shared `Target` input.
            for case in inputs["Cases"]:
                case["Arguments"]["targetAmount" if case["Method"]=="ByAmountAverage" else "targetFee"]=case["Arguments"]["target"]
    if sha(cold / "inputs.json") != input_hash.lower() or sha(cold / expected_file) != expected_hash.lower():
        raise ValueError("Cold inputs/expectations changed")
    # Use the same policy lowering as delivery; authenticated guards stay in the cloned body.
    normalized = read(ROOT / ".local/data-logic-translator/native-data-effects" / fixture / "normalized-logic.json")
    runtime_proof=bind_runtime_calls(normalized,source_delivery,fixture) if source_delivery else None
    if any(runtime_call_steps(normalized)): raise ValueError("Runtime-dependent fixtures require --source-delivery")
    actions = {action["name"]: action for action in normalized["actions"]}
    ops, clones, cases, bindings = [], [], [], []
    if replace:
        for index in range(len(inputs["Cases"])):
            name = prefix + str(index).zfill(2)
            ops.extend([{"op":"delete","target":"IRestServiceAction:" + name},
                        {"op":"delete","target":"IServerAction:" + name}])
    for index, test in enumerate(inputs["Cases"]):
        name = prefix + str(index).zfill(2)
        original = actions[test["Method"]]
        clone = copy.deepcopy(original)
        clone["name"], clone["public"] = name, False
        queries = [step for step in clone["steps"] if step.get("sql")]
        if len(queries) != 1: raise ValueError("Expected one compiled relational query")
        query = queries[0]
        before = query["statement"]
        query["statement"], used = bind_roots(before, roots(inputs["Datasets"][test["Dataset"]], contract, mapping, tables))
        clones.append(clone)
        bindings.append({"case":test["Id"],"tables":used,"originalSqlSha256":hashlib.sha256(before.encode()).hexdigest(),
                         "fixtureSqlSha256":hashlib.sha256(query["statement"].encode()).hexdigest()})
        cases.append({"name":name,"id":test["Id"],"method":test["Method"],"dataset":test["Dataset"],
                      "arguments":test["Arguments"],"outputType":original["outputs"][0]["type"],"expectedError":test.get("ExpectedError"),"oracleNaming":"original" if corpus=="queries" else "camelCase"})
    ops.append({"op":"logic","data":{"actions":clones}})
    error_envelopes = {case["outputType"]: "AvLabError_" + hashlib.sha256(case["outputType"].encode()).hexdigest()[:12]
        for case in cases if case.get("expectedError")}
    # Replacement changes endpoint bodies, not their response ABI. Reuse the existing
    # deterministic envelope types, including Studio-owned derived record references.
    if error_envelopes and not replace:
        ops.append({"op":"spec","data":{"structures":[{"name":name,"attributes":[
            {"name":"Result","type":kind},{"name":"FailureType","type":"Text"},{"name":"FailureMessage","type":"Text"}]}
            for kind,name in error_envelopes.items()]}})
    def create(parent, kind, alias, name=None):
        op={"op":"create","parent":parent,"type":kind,"as":alias}
        if name is not None: op["name"]=name
        ops.append(op)
        return alias
    def setting(target, prop, value): ops.append({"op":"set","target":target,"prop":prop,"value":value})
    def link(start,end): ops.append({"op":"link","from":start,"to":end})
    for case in cases:
        name=case["name"]
        action=actions[case["method"]]
        method=create("IRestService:CSharpLab","IRestServiceAction","$" + name,name)
        setting(method,"HTTPMethod","POST")
        setting(method,"URLPath","/" + name)
        key=create(method,"IRestServiceActionInput",method+"Key","LabKey")
        setting(key,"DataType","Text")
        setting(key,"ReceiveIn","Header")
        setting(key,"IsMandatory",True)
        output=create(method,"IRestServiceActionOutput",method+"Output","Result")
        setting(output,"DataType",error_envelopes[case["outputType"]] if case.get("expectedError") else case["outputType"])
        setting(output,"SendIn","Body")
        auth=create(method,"IExecuteServerActionNode",method+"Auth","AuthenticateLab")
        setting(auth,"Action","IServerAction:LabAuthenticate")
        setting(auth+"/LabKey","Value","LabKey")
        execute=create(method,"IExecuteServerActionNode",method+"Execute","ExecuteQuery")
        setting(execute,"Action","IServerAction:"+name)
        literal_assign = None
        for parameter in action["inputs"]:
            source_name=parameter["name"].removeprefix("Arg_")
            if source_name not in case["arguments"]: raise ValueError("Unbound input " + source_name)
            value = case["arguments"][source_name]
            if parameter["type"].startswith("AvOptional_"):
                local_name = "Fixture_" + source_name
                local = create(method,"ILocalVariable",method+local_name,local_name)
                setting(local,"DataType",parameter["type"])
                if literal_assign is None: literal_assign=create(method,"IAssignNode",method+"Inputs","SetFixtureInputs")
                values = {"HasValue":value is not None}
                if value is not None: values["Value"]=value
                for field_name,field_value in values.items():
                    field=create(literal_assign,"IAssignment",method+local_name+field_name)
                    setting(field,"Variable",local_name+"."+field_name)
                    setting(field,"Value",native(field_value))
                setting(execute+"/"+parameter["name"],"Value",local_name)
            else: setting(execute+"/"+parameter["name"],"Value",native(value))
        assign=create(method,"IAssignNode",method+"Assign","SetResult")
        field=create(assign,"IAssignment",method+"Field")
        setting(field,"Variable","Result.Result" if case.get("expectedError") else "Result")
        setting(field,"Value","ExecuteQuery."+action["outputs"][0]["name"])
        link(method+"/#IStartNode",auth)
        if literal_assign is not None: link(auth,literal_assign);link(literal_assign,execute)
        else: link(auth,execute)
        link(execute,assign);link(assign,method+"/#IEndNode")
        if case.get("expectedError"):
            exception_type=case["expectedError"]["type"]
            native_exception=exception_type.rsplit(".",1)[-1]
            handler=create(method,"IExceptionHandlerNode",method+"ExpectedError","ExpectedSourceException")
            setting(handler,"Exception","IUserException:"+native_exception)
            setting(handler,"AbortTransaction",False);setting(handler,"LogError",False)
            failure=create(method,"IAssignNode",method+"Failure","SetFailure")
            for field_name,expression in [("FailureType",native(exception_type)),("FailureMessage","ExpectedSourceException.ExceptionMessage")]:
                assignment=create(failure,"IAssignment",method+field_name+"Assign")
                setting(assignment,"Variable","Result."+field_name);setting(assignment,"Value",expression)
            end=create(method,"IEndNode",method+"FailureEnd")
            link(handler,failure);link(failure,end)
        ops.append({"op":"layout","target":method})
    write(work/"transport.json",{"description":"Read-only relational fixtures for independently authored CSharp query tests","expectValid":True,"expectedMessages":[],"ops":ops})
    write(work/"cases.json",cases)
    write(work/"bindings.json",bindings)
    shutil.copyfile(cold/expected_file,work/"expectations.json")
    shutil.copyfile(cold/"translated-contract.json",work/"contract.json")
    shutil.copyfile(cold/"inputs.json",work/"inputs.json")
    write(work/"corpus.json",{"name":corpus,"inputsSha256":input_hash,"expectedSha256":expected_hash})
    if runtime_proof: write(work/"runtime-bindings.json",runtime_proof)
    print(json.dumps({"cases":len(cases),"nativeActions":len(clones),"ops":len(ops),"job":str(work/"transport.json")}))

def native_default(kind, structures):
    # REST omits native default-valued attributes; this rule is independent of the oracle.
    if kind.endswith(" List"): return []
    if kind in structures: return {}
    if kind == "Text": return ""
    if kind == "Boolean": return False
    if kind in ("Integer", "Long Integer", "Decimal") or kind.endswith(" Identifier"): return 0
    raise ValueError("No REST default mapping for " + kind)

def decode(value, kind, structures):
    if kind.endswith(" List"):
        if not isinstance(value,list): raise ValueError("Expected list: "+repr(value)[:200])
        return [decode(item,kind[:-5],structures) for item in value]
    if kind in structures:
        if not isinstance(value,dict): raise ValueError("Expected record: "+repr(value)[:200])
        fields = {field["name"]:field["type"] for field in structures[kind]["attributes"]}
        if set(value) - set(fields): raise ValueError("Unexpected REST attributes")
        if kind.startswith("AvOptional_"):
            present = value.get("HasValue",False)
            if type(present) is not bool: raise ValueError("Invalid optional presence flag")
            return decode(value.get("Value",native_default(fields["Value"],structures)),fields["Value"],structures) if present else None
        return {name:decode(value.get(name,native_default(field_type,structures)),field_type,structures) for name,field_type in fields.items()}
    if kind=="Long Integer" or kind.endswith(" Identifier"):
        if type(value) not in (int,str): raise ValueError("Large integer crossed floating point")
        return str(value)
    if kind=="Decimal": return Decimal(str(value))
    return value

def run(work):
    publication=read(LAB/"confirmed-publish.json")
    if not publication["Completed"] or publication["HasErrors"]: raise ValueError("Publication not confirmed")
    key=read(LAB/"secrets.json")["key"]
    cases=read(work/"cases.json")
    expected=read(work/"expectations.json")
    if isinstance(expected,list): expected={item["name"]:item["output"] for item in expected}
    structures={s["name"]:s for s in read(work/"contract.json")["data"]["structures"]}
    run_dir=work/"runs"/(time.strftime("%Y%m%d-%H%M%S")+"-"+secrets.token_hex(4))
    run_dir.mkdir(parents=True)
    for name in ["transport.json","cases.json","bindings.json","expectations.json","contract.json","inputs.json","corpus.json"]:
        shutil.copyfile(work/name,run_dir/name)
    for name in ["source-check.json","delivery-check.json","runtime-bindings.json"]:
        if (work/name).exists(): shutil.copyfile(work/name,run_dir/name)
    shutil.copyfile(LAB/"confirmed-publish.json",run_dir/"confirmed-publish.json")
    shutil.copyfile(LAB/"current-for-publish.oml",run_dir/"published.oml")
    shutil.copyfile(work/"source.json" if (work/"source.json").exists() else LAB/"RelationalSource.json",run_dir/"source.json")
    shutil.copyfile(__file__,run_dir/"probe.py")
    results=[]
    for case in cases:
        request=urllib.request.Request("https://"+HOST+"/"+MODULE+"/rest/CSharpLab/"+case["name"],data=b"",
            headers={"LabKey":key},method="POST")
        error=None;actual=None;status=0;wire=None
        try:
            with urllib.request.urlopen(request,timeout=60) as response:
                status=response.status
                wire=response.read().decode()
                body=json.loads(wire,parse_float=Decimal)
            if isinstance(body,dict) and body.get("FailureType"):
                actual={"error":{"type":body["FailureType"],"message":body.get("FailureMessage","")}}
            else:
                if isinstance(body,dict) and set(body)=={"Result"}: body=body["Result"]
                actual=decode(body,case["outputType"],structures)
            if case.get("oracleNaming")=="camelCase":
                def camel(value):
                    if isinstance(value,list): return [camel(item) for item in value]
                    if isinstance(value,dict): return {name[0].lower()+name[1:]:camel(item) for name,item in value.items()}
                    return value
                actual=camel(actual)
        except urllib.error.HTTPError as ex:
            status=ex.code;wire=ex.read().decode();error=wire
        except Exception as ex:
            error=str(ex)
        expectation={"error":case["expectedError"]} if case.get("expectedError") else expected[case["id"]]
        passed=status==200 and actual==expectation
        results.append({"case":case["id"],"method":case["method"],"dataset":case["dataset"],"status":status,
                        "passed":passed,"expected":expectation,"actual":actual,"error":error,"wire":wire})
        write(run_dir/"execution.json",results);write(work/"execution.json",results)
        print(json.dumps({"case":case["id"],"passed":passed,"status":status}),flush=True)
    write(run_dir/"hashes.json",{path.name:sha(path) for path in run_dir.iterdir() if path.is_file()})
    return 0 if all(r["passed"] for r in results) else 1

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode",choices=["build","run"])
    parser.add_argument("--work",type=Path,required=True)
    parser.add_argument("--replace",action="store_true")
    parser.add_argument("--corpus",choices=["queries","groups","averages"],default="queries")
    parser.add_argument("--source-delivery",type=Path)
    args=parser.parse_args()
    if args.mode=="build": build(args.work,args.replace,args.corpus,args.source_delivery)
    else: raise SystemExit(run(args.work))

