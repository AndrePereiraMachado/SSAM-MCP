"""Generate the isolated ZZHtmlDashboardReview_UI browser fixture (synthetic records, no Incidents_CS reference)."""
import argparse
import copy
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=".local/review/lab-job.json")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    source = root / "tests/html/incidents-dashboard.html"
    prelude = json.loads(source.with_suffix(".fixture.json").read_text(encoding="utf-8"))
    actions = prelude[1]["data"]["actions"]
    steps = []
    for i in range(30):
        closed = i >= 27
        values = {"Sample.Id": "NullIdentifier()", "Sample.Title": f'"AV Review {i + 1:02d} · Incidente de teste"',
                  "Sample.Description": '"Dado sintético do laboratório de telas."',
                  "Sample.PriorityId": "Entities.IncidentPriority." + ["Critical", "High", "Medium", "Low"][i % 4],
                  "Sample.StatusId": "Entities.IncidentStatus.Resolved" if closed else "Entities.IncidentStatus." + ["New", "InAnalysis", "InProgress"][i % 3],
                  "Sample.AssigneeId": "GetUserId()" if i % 2 == 0 else "NullIdentifier()",
                  "Sample.ReporterId": "GetUserId()" if i % 2 else "NullIdentifier()",
                  "Sample.CreatedAt": f"AddHours(AddDays(DateToDateTime(CurrDate()), -{i % 3}), 1)",
                  "Sample.ResolvedAt": "AddMinutes(CurrDateTime(), -5)" if i in (27, 28) else "AddDays(CurrDateTime(), -1)" if closed else "NullDate()",
                  "Sample.SlaDueAt": "AddMinutes(CurrDateTime(), 25)" if i < 15 else "AddMinutes(CurrDateTime(), -30)" if i < 20 else "AddHours(CurrDateTime(), 4)"}
        steps.extend([{"assign": values}, {"create": "Incident", "record": "Sample", "as": "CreateSample" + str(i + 1)}])
    seed = {"name": "SeedDashboardLab", "kind": "server", "public": False,
            "vars": [{"name": "Sample", "type": "Incident"}],
            "steps": [{"get": "Incident", "as": "ExistingSamples", "where": 'Incident.Title like "AV Review%"', "max": 1},
                      {"if": "ExistingSamples.List.Empty", "then": steps}]}
    for action in actions:
        if action["name"] not in ("GetDashboardMetricsForPeriod", "GetIncidentList", "GetIncidentsNearDue"):
            continue
        action["steps"].insert(0, {"if": "GetUserId() = NullIdentifier()", "then": [{"raise": "LabAuthenticationRequired", "message": '"É necessário entrar para ler os dados do laboratório."'}]})
        if action["name"] == "GetDashboardMetricsForPeriod":
            action["steps"].insert(1, {"call": "SeedDashboardLab", "as": "EnsureSampleData"})
            for step in action["steps"]:
                if step.get("as") == "GetResolvedToday":
                    step["where"] = "Incident.StatusId = Entities.IncidentStatus.Resolved and DateTimeToDate(Incident.ResolvedAt) = CurrDate()"
    actions.insert(0, seed)
    data = json.loads(source.with_suffix(".bindings.json").read_text(encoding="utf-8"))
    data["html"] = source.read_text(encoding="utf-8")
    job = {"description": "ZZHtmlDashboardReview_UI only: authenticated synthetic dataset (30 records), live browser states and pagination.",
           "base": "reactive-ui.oml", "expectValid": True, "expectedMessages": [],
           "ops": [{"op": "reference", "producer": "OutSystemsUI", "elements": ["IMobileBlock:DatePicker", "IMobileBlock:Pagination", "IMobileBlock:Search"]},
                   {"op": "create", "parent": "@espace", "type": "IUserException", "name": "LabAuthenticationRequired"},
                   *prelude, {"op": "html", "data": data},
                   {"op": "link", "from": "IMobileScreen:Dashboard", "connector": "Roles", "to": "@espace/AnonymousRole"}]}
    out = root / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(job, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
