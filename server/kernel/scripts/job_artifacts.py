"""Bind an explicit ODC job's unchanged inputs to the native saved candidate."""
import hashlib
from pathlib import Path


def artifact(file):
    file = Path(file).resolve(strict=True)
    return {"file": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}


def capture(base, job):
    return {"base": artifact(base), "job": artifact(job)}


def clean_validation(data):
    count = data.get("messages")
    if data.get("accepted") is not True or data.get("isValid") is not True or type(count) is not int or count < 0:
        return False
    validation = data.get("validation")
    if count == 0 and not validation:
        return True
    if not isinstance(validation, dict) or any(validation.get(k) != [] for k in
            ("new", "unexpected", "missingExpected", "ambiguous", "tolerated")):
        return False
    warnings = validation.get("preexisting")
    if not isinstance(warnings, list) or len(warnings) != count:
        return False
    if count == 0:
        return True
    details = data.get("details")
    if not isinstance(details, list) or len(details) != count:
        return False
    keys = []
    for warning in warnings:
        if not isinstance(warning, dict) or warning.get("type") != "Warning" or not all(
                isinstance(warning.get(k), str) for k in ("key", "id", "detail", "path")) or not warning["key"]:
            return False
        if f"Warning {warning['id']}: {warning['detail']} @ {warning['path']}" not in details:
            return False
        keys.append(warning["key"])
    return len(set(keys)) == count


def bind(before, output, result):
    if any(artifact(value["file"]) != value for value in before.values()):
        raise ValueError("Job inputs changed during native validation")
    data = result.get("data") or {}
    if not (result.get("ok") is True and clean_validation(data)
            and data.get("handles", {}).get("@espace")):
        return None
    if Path(data["outPath"]).resolve() != Path(output).resolve():
        raise ValueError("Native output path differs from requested candidate")
    return {"schema": "ssam-job-artifacts/1", "lane": "odc", **before,
            "candidate": artifact(output), "moduleKey": data["handles"]["@espace"]}
