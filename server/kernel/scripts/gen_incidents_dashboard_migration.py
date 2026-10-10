"""Build the reviewed Incidents navigation migration from fresh model dumps, without replacing business actions.

Inputs are the JSON results of the read-only dump jobs recorded in the dashboard review. Output jobs retain the
existing action/screen keys and guards. Run once before the regular HTML delivery; regenerate from fresh dumps
to resume against a changed module. No credentials, OML paths or publication are handled here.
"""
import argparse
import json
from pathlib import Path


def results(path):
    return [r["result"] for r in json.loads(Path(path).read_text(encoding="utf-8-sig"))["data"]["results"]]


def descendants(node):
    yield node
    for child in node.get("children", []):
        yield from descendants(child)


def set_value(ops, target, prop, value):
    ops.append(dict(op="set", target=target, prop=prop, value=value))


def ensure_parameter(ops, owner, model, name, kind="IInputParameter", data_type="Boolean"):
    if any(c.get("type") == kind and c.get("name") == name for c in model.get("children", [])):
        return
    alias = "$migration." + name + "." + str(len(ops))
    ops.append(dict(op="create", parent=owner, type=kind, name=name, **{"as": alias}))
    set_value(ops, alias, "DataType", data_type)
    if kind == "IInputParameter":
        set_value(ops, alias, "IsMandatory", False)
        set_value(ops, alias, "DefaultValue", "False")


def page_output(ops, owner, model):
    """A server aggregate's StartIndex does not slice a list returned by assignment in O11.
    Fetch the bounded prefix and append the requested range with a native ForEach.
    """
    assignments = [n for n in descendants(model) if n["type"] == "IAssignment"]
    candidates = []
    for item in assignments:
        expressions = {c["key"].rsplit(".#", 1)[-1]: c.get("text") for c in item.get("children", [])}
        if expressions.get("Variable") == "Incidents":
            candidates.append((item, expressions.get("Value")))
    if len(candidates) != 1 or candidates[0][1] not in ("GetIncidents.List", "GetNearDue.List"):
        raise ValueError(owner + ": unreviewed Incidents output; preserve it before migrating paging")
    item, source = candidates[0]
    aggregate_name = source.split(".")[0]
    aggregate = next(n for n in model["children"] if n.get("name") == aggregate_name)
    outputs = [n for n in model["children"] if n["type"] == "IAssignNode"]
    ends = [n for n in model["children"] if n["type"] == "IEndNode"]
    if len(outputs) != 1 or len(ends) != 1:
        raise ValueError(owner + ": unreviewed final flow for pagination")
    start = "If(StartIndex < 0, 0, StartIndex)"
    size = "If(MaxRecords < 1, 20, MaxRecords)"
    set_value(ops, owner + "/" + aggregate_name, "StartIndex", "0")
    set_value(ops, owner + "/" + aggregate_name, "MaxRecords", start + " + " + size)
    if not any(n.get("text") == "Incident.Id" for n in descendants(aggregate) if n.get("key", "").endswith(".#Attribute")):
        ops.append(dict(op="create", parent=owner + "/" + aggregate_name, type="ISort", **{"as": "$migration.sort"}))
        set_value(ops, "$migration.sort", "Attribute", "Incident.Id")
        set_value(ops, "$migration.sort", "SortDirection", "Ascending")
    assignment_index = next(i for i, n in enumerate(n for n in outputs[0]["children"] if n["type"] == "IAssignment") if n["key"] == item["key"])
    ops.append(dict(op="delete", target=owner + "/#IAssignNode/#IAssignment[" + str(assignment_index + 1) + "]"))
    loop, append = "$migration.page", "$migration.append"
    ops.append(dict(op="create", parent=owner, type="IForEachNode", **{"as": loop}))
    set_value(ops, loop, "RecordList", source)
    set_value(ops, loop, "StartIndex", start)
    set_value(ops, loop, "MaximumIterations", size)
    ops.append(dict(op="create", parent=owner, type="IExecuteServerActionNode", name="AppendPageRow", **{"as": append}))
    set_value(ops, append, "Action", "IActionSignature:ListAppend")
    set_value(ops, append + "/List", "Value", "Incidents")
    set_value(ops, append + "/Element", "Value", source + ".Current.Incident")
    ops.extend([dict(op="link", **{"from": "@" + outputs[0]["key"], "to": loop}),
                dict(op="link", **{"from": loop, "connector": "CycleTarget", "to": append}),
                dict(op="link", **{"from": append, "to": loop}),
                dict(op="link", **{"from": loop, "to": "@" + ends[0]["key"]}),
                dict(op="layout", target=owner)])


def server_job(models):
    ops = []
    for name in ("GetIncidentList", "GetIncidentListBySla", "GetIncidentsNearDue"):
        model = next(m for m in models if m.get("name") == name)
        owner = "IServerAction:" + name
        if name != "GetIncidentsNearDue":
            for parameter in ("OnlyOpen", "OnlyResolvedToday"):
                ensure_parameter(ops, owner, model, parameter)
        for aggregate in (n for n in model["children"] if n["type"] == "IAggregateNode"):
            for index, condition in enumerate(n for n in descendants(aggregate) if n["type"] == "IFilter"):
                text = next(n["text"] for n in condition["children"] if n.get("key", "").endswith(".#Condition"))
                if "Incident.CreatedAt" not in text:
                    continue
                changed = text.replace("Incident.CreatedAt <= EndDate", "Incident.CreatedAt < AddDays(DateToDateTime(DateTimeToDate(EndDate)), 1)")
                if name != "GetIncidentsNearDue":
                    if "OnlyOpen" not in changed:
                        changed += " and (not OnlyOpen or Incident.StatusId <> Entities.IncidentStatus.Resolved)"
                    if "OnlyResolvedToday" not in changed:
                        changed += " and (not OnlyResolvedToday or (Incident.StatusId = Entities.IncidentStatus.Resolved and Incident.ResolvedAt >= DateToDateTime(CurrDate()) and Incident.ResolvedAt < AddDays(DateToDateTime(CurrDate()), 1)))"
                if changed != text:
                    set_value(ops, owner + "/" + aggregate["name"] + "/**IFilter[" + str(index + 1) + "]", "Condition", changed)
        if name == "GetIncidentsNearDue" and not any(c.get("name") == "Total" and c["type"] == "IOutputParameter" for c in model["children"]):
            ensure_parameter(ops, owner, model, "Total", "IOutputParameter", "Long Integer")
            condition = next(n for n in descendants(model) if n["type"] == "IFilter")
            text = next(n["text"] for n in condition["children"] if n.get("key", "").endswith(".#Condition"))
            text = text.replace("Incident.CreatedAt <= EndDate", "Incident.CreatedAt < AddDays(DateToDateTime(DateTimeToDate(EndDate)), 1)")
            count = "$migration.countDue"
            ops.append(dict(op="create", parent=owner, type="IAggregateNode", name="CountNearDue", **{"as": count}))
            ops.append(dict(op="create", parent=count, type="IAliasedSource", args={"dataSource": "IServerEntity:Incident"}))
            ops.append(dict(op="create", parent=count, type="IFilter", args={"condition": text}))
            ops.append(dict(op="create", parent=count, type="IAggregateAttribute", name="MatchCount", **{"as": "$migration.matchCount"}))
            set_value(ops, "$migration.matchCount", "Attribute", "Incident.Id")
            set_value(ops, "$migration.matchCount", "AggregationType", "Count")
            set_value(ops, count, "MaxRecords", "1")
            ops.extend([{"op": "link", "from": owner + "/GetNearDue", "to": count},
                        {"op": "link", "from": count, "to": owner + "/#IAssignNode"}])
            ops.append(dict(op="create", parent=owner + "/#IAssignNode", type="IAssignment", **{"as": "$migration.dueTotal"}))
            set_value(ops, "$migration.dueTotal", "Variable", "Total")
            set_value(ops, "$migration.dueTotal", "Value", "CountNearDue.List.Current.MatchCount")
            ops.append({"op": "layout", "target": owner})
        page_output(ops, owner, model)
    return ops


def ui_job(model):
    ops = []
    owner = "IMobileScreen:IncidentList"
    for parameter in ("OnlyOpen", "OnlyResolvedToday"):
        ensure_parameter(ops, owner, model, parameter)
        ensure_parameter(ops, owner, model, parameter + "FilterValue", "ILocalVariable")
    mapping = {name: (name[:-2] if name.endswith("Id") else name) + "FilterValue" for name in ("Search", "StatusId", "PriorityId", "CategoryId", "AssigneeId", "OnlyMine", "OnlyOverdue", "OnlyOpen", "OnlyResolvedToday", "StartDate", "EndDate")}
    known_locals = {c.get("name") for c in model["children"] if c["type"] == "ILocalVariable"} | {"OnlyOpenFilterValue", "OnlyResolvedTodayFilterValue"}
    missing = set(mapping.values()) - known_locals
    if missing:
        raise ValueError("Unreviewed filter variable names: " + ", ".join(sorted(missing)))
    # Copy URL inputs once. Subsequent edits/clear use local filter state, so URL parameters cannot override user edits.
    action = {"name": "InitializeDashboardListFilters", "owner": owner, "kind": "screen", "replace": any(c.get("name") == "InitializeDashboardListFilters" for c in model["children"]),
              "steps": [{"assign": {**{local: name for name, local in mapping.items()}, "StartIndex": "0"}}]}
    apply_filters = {"name": "ApplyIncidentFilters", "owner": owner, "kind": "screen", "replace": True,
                     "steps": [{"assign": {"StartIndex": "0"}},
                               {"node": "IRefreshDataNode", "as": "RefreshIncidents", "properties": {"DataSource": owner + "/LoadIncidents", "MaxRecords": "MaxRecords"}},
                               {"node": "IRefreshDataNode", "as": "RefreshIncidentsBySla", "properties": {"DataSource": owner + "/LoadIncidentsBySla", "MaxRecords": "MaxRecords"}}]}
    ops.append({"op": "logic", "data": {"actions": [action, apply_filters]}})
    set_value(ops, owner + "/OnInitialize", "Destination", owner + "/InitializeDashboardListFilters")
    for call in ("LoadIncidents/ReadSource", "LoadIncidentsBySla/ReadIncidentsBySla"):
        for parameter, local in mapping.items():
            set_value(ops, owner + "/" + call + "/" + parameter, "Value", local)
        set_value(ops, owner + "/" + call + "/StartIndex", "Value", "StartIndex")
        set_value(ops, owner + "/" + call + "/MaxRecords", "Value", "MaxRecords")
    clear = next(c for c in model["children"] if c.get("name") == "ClearIncidentFilters")
    assign = next(c for c in clear["children"] if c["type"] == "IAssignNode")
    existing = {n.get("text") for n in descendants(assign) if n.get("key", "").endswith(".#Variable")}
    for name, value in [("OnlyOpenFilterValue", "False"), ("OnlyResolvedTodayFilterValue", "False"), ("StartIndex", "0")]:
        if name in existing:
            continue
        alias = "$migration.clear." + name
        ops.append(dict(op="create", parent=owner + "/ClearIncidentFilters/#IAssignNode", type="IAssignment", **{"as": alias}))
        set_value(ops, alias, "Variable", name)
        set_value(ops, alias, "Value", value)
    return ops


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contracts", required=True)
    parser.add_argument("--sla-contracts", required=True)
    parser.add_argument("--ui-contract", required=True)
    parser.add_argument("--ui-events", required=True, help="get results including IncidentList/OnInitialize")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    models = results(args.contracts) + results(args.sla_contracts)
    ui = results(args.ui_contract)[0]
    initializer = next((c for c in ui["children"] if c.get("name") == "InitializeDashboardListFilters"), None)
    event = next(r for r in results(args.ui_events) if r.get("key", "").endswith(".#OnInitialize"))
    destination = event["properties"]["Destination"]
    if destination is not None and (initializer is None or destination != "@" + initializer["key"]):
        raise ValueError("IncidentList has an unreviewed OnInitialize handler; preserve its logic before migrating")
    for name, ops in [("cs", server_job(models)), ("ui", ui_job(ui))]:
        job = {"description": "Reviewed Incidents Dashboard navigation migration (" + name + "); preserve existing bodies, authorization and keys.", "base": "reactive-ui.oml", "expectValid": True, "expectedMessages": [], "ops": ops}
        (out / ("incidents-dashboard-" + name + ".json")).write_text(json.dumps(job, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(name, len(ops), "ops")


if __name__ == "__main__":
    main()
