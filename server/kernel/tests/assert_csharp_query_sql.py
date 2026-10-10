"""Execute generated relational SQL with fixed parameters; this does not replace the OutSystems runtime proof."""
import json
import re
import sqlite3
import sys
from pathlib import Path

contract = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
entity = next(e for e in contract["data"]["entities"] if e["name"] == "Reading")
presence = next(a["name"] for a in entity["attributes"] if a["name"].startswith("AvHas_"))
db = sqlite3.connect(":memory:")
db.execute(f'CREATE TABLE Reading (Id INTEGER, Rank INTEGER, "Group" INTEGER, Optional INTEGER, "{presence}" INTEGER)')
db.executemany("INSERT INTO Reading VALUES (?,?,?,?,?)", [(1,30,1,0,0),(2,10,1,0,1),(3,20,2,9,1),(4,20,1,5,1),(5,50,1,0,0)])
expected = {
    "Page": [3,4], "TakeThenWhere": [], "WhereThenTake": [3], "SkipAfterTake": [3,4], "TakeAfterSkip": [3,4,5],
    "EmptyTake": [], "NegativeTake": [], "NegativeSkip": [1], "NullableAscending": [1,5,2], "NullableDescending": [3,4,2],
    "CountPage": 2, "PredicateAfterTake": False, "FirstEmpty": [], "StableOrderBy": [5,1,4,2,3], "TwoTakes": [1], "TwoSkips": [4,5],
    "AbsentValues": [1,5], "ZeroValues": [2],
}
for action in contract["logic"]["actions"]:
    query = next(s for s in action["steps"] if s.get("sql"))
    statement = re.sub(r"\{([A-Za-z_][A-Za-z0-9_]*)\}\.\[([A-Za-z_][A-Za-z0-9_]*)\]", r'"\1"."\2"', query["statement"])
    statement = re.sub(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", r'"\1"', statement)
    parameters = {}
    for name, parameter in query["params"].items():
        value = parameter["value"]
        assert re.fullmatch(r"-?\d+", value), f"Fixture must bind a constant, not simulate a native expression: {value}"
        parameters[name] = int(value)
    rows = db.execute(statement, parameters).fetchall()
    actual = rows[0][0] if action["name"] == "CountPage" else bool(rows) if action["name"] == "PredicateAfterTake" else [row[0] for row in rows]
    assert actual == expected[action["name"]], (action["name"], actual, expected[action["name"]])
print(json.dumps({"passed": len(expected), "scope": "Generated relational SQL execution in SQLite; server integration remains separate"}))
