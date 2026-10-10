"""Differential HTTP proof of the owned typed ordinal primitive in the personal lab.

Generates an independent UTF-16 code-unit oracle before requests. This proves the
primitive/transport boundary, not C# frontend lowering or a general runtime library.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / ".local/data-logic-translator/ordinal-primitive"
HOST = "personal-2qqw9srv.outsystemscloud.com"
URL = f"https://{HOST}/ZZHighCodeLab_CS/rest/CSharpLab/CompareOrdinal"


def code_units(text):
    raw = text.encode("utf-16-le", errors="surrogatepass")
    return [int.from_bytes(raw[i:i+2], "little") for i in range(0, len(raw), 2)]


def expected(left, right):
    a, b = code_units(left), code_units(right)
    return (a > b) - (a < b)


def run():
    publication = json.loads((WORK / "confirmed-publish.json").read_text())
    assert publication["Completed"] and not publication["HasErrors"]
    receipt = json.loads(Path((WORK / "delivery-path.txt").read_text()).read_text())
    assert receipt["environment"] == HOST and receipt["module"] == "ZZHighCodeLab_CS" and receipt["delivered"]
    alphabet = ["", "A", "a", "I", "i", "İ", "ı", "é", "e\u0301", "É", "E",
                "\x00", "a\x00", "a ", "aa", "😀", "\ue000", "\uffff", "𐀀", "😃"]
    cases = [{"left": a, "right": b, "expectedSign": expected(a,b), "kind": "unicode-text"}
             for a in alphabet for b in alphabet]
    cases += [{"left": a, "right": b, "expectedSign": expected(a,b), "kind": "unpaired-surrogate-wire"}
              for a,b in [("\ud800", "\ue000"), ("\ud800", "\ud801"), ("\udc00", "\ufffd"), ("a\ud800", "a\ud801")]]
    case_file = WORK / "primitive-cases.json"
    case_file.write_text(json.dumps(cases, ensure_ascii=True, indent=2))
    frozen = hashlib.sha256(case_file.read_bytes()).hexdigest()
    key = json.loads((ROOT / ".local/data-logic-translator/runtime-lab/secrets.json").read_text())["key"]

    def execute(item):
        index, case = item
        payload = json.dumps({"Left":case["left"], "Right":case["right"]}, ensure_ascii=True).encode()
        request = urllib.request.Request(URL, data=payload, headers={"Content-Type":"application/json", "LabKey":key}, method="POST")
        observed = {"index":index, **case}
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                raw = response.read().decode("utf-8")
            body = json.loads(raw)
            value = body.get("Result", 0) if isinstance(body, dict) else body
            assert isinstance(value, int) and not isinstance(value, bool), raw
            observed.update(actual=value, actualSign=(value > 0)-(value < 0), passed=((value > 0)-(value < 0))==case["expectedSign"])
        except urllib.error.HTTPError as error:
            observed.update(passed=False, httpStatus=error.code, body=error.read().decode("utf-8",errors="replace")[:1500])
        except Exception as error:
            observed.update(passed=False, error=str(error).replace(key,"[redacted]"))
        return observed

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(execute, enumerate(cases)))
    assert hashlib.sha256(case_file.read_bytes()).hexdigest() == frozen
    report = {"scope":"Owned ordinal primitive through authenticated native REST; C# translator not yet wired",
              "environment":HOST, "module":"ZZHighCodeLab_CS", "publishedVersion":publication["VersionId"],
              "caseSha256":frozen, "cases":len(results), "passed":sum(r["passed"] for r in results),
              "failed":sum(not r["passed"] for r in results), "results":results}
    (WORK / "primitive-execution.json").write_text(json.dumps(report, ensure_ascii=True, indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!="results"}))
    for row in results:
        if not row["passed"]: print(json.dumps(row,ensure_ascii=True))
    return int(report["failed"] > 0)


if __name__ == "__main__":
    raise SystemExit(run())
