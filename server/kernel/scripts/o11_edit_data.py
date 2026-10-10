"""Edit Data nativo do Service Studio 11 pelo login do Studio aberto na faixa (SSO incluido); nenhuma credencial aqui.

A ponte executa, no proprio Studio, as chamadas do View/Edit Data (GetRecords, InsertRecords, UpdateRecords,
DeleteRecords do provider logado): operacoes `data-read` e `data-write` do `environment_session`
(DECISOES 2026-09-29 15:40, "Autorizo trocar a bridge (Recomendado)"). Este cliente fala com ela pelo `anvil_client`.
O schema (chaves de entidade e atributo) vem do OML publicado, lido pelo CLI existente (`inspect --kind`); o Smart App
Control recusou o CLI novo, entao nada aqui depende dele.

Regras:
- so entidades do proprio modulo com identificador (nunca (System)/Users nem estaticas);
- toda escrita leva as palavras de autorizacao do usuario e um operationId estavel; o recibo fica em
  <recibos>/<operationId>.json e uma escrita incerta (recibo pendente) nunca e repetida sozinha.

  python scripts/o11_edit_data.py schema --oml X.oml [--out schema.json]
  python scripts/o11_edit_data.py read --module Orders_CS --oml X.oml --entity WorkRequest [--all] [--out f.json]
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import uuid
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from anvil_client import AnvilBridge  # noqa: E402

# CLI ja aceito pelo Smart App Control, so para ler o modelo (inspect). ANVIL_READ_CLI troca.
READ_CLI = pathlib.Path(os.environ.get("ANVIL_READ_CLI", str(ROOT / ".local" / "cli-relayout-1851" / "anvil.dll")))
REFUSED_MODULES = {"(System)", "Users"}


def studio_to_db(key: str) -> str:
    """Chave do Studio (base64 dos bytes do Guid, '_' no lugar de '/', sem '=') -> GUID do banco e do REST."""
    raw = base64.b64decode(key.replace("_", "/") + "=" * (-len(key) % 4))
    if len(raw) != 16:
        raise ValueError(f"not a Studio object key: {key}")
    return str(uuid.UUID(bytes_le=raw))


def db_to_studio(key: str) -> str:
    return base64.b64encode(uuid.UUID(key).bytes_le).decode("ascii").rstrip("=").replace("/", "_")


def _inspect(oml: pathlib.Path, kind: str, properties: str) -> list[dict]:
    entries, offset = [], 0
    while True:
        cmd = ["dotnet", str(READ_CLI), "inspect", "--oml", str(oml), "--kind", kind, "--max", "500",
               "--offset", str(offset), "--depth", "0", "--properties", properties]
        out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        if out.returncode != 0:
            raise RuntimeError(f"inspect --kind {kind} failed: {out.stdout[-800:]} {out.stderr[-800:]}")
        data = json.loads(out.stdout)["data"]
        entries += data["entries"]
        if data.get("nextOffset") is None:  # a ultima pagina vem truncated=True (omitiu as anteriores) sem nextOffset
            return entries
        offset = data["nextOffset"]


def load_schema(oml: str | pathlib.Path, cache_dir: pathlib.Path | None = None) -> dict:
    """{module, moduleKey, moduleDbKey, entities: {Name: {key, dbKey, static, identifier, attributes: {Name: {...}}}}}."""
    oml = pathlib.Path(oml).resolve()
    digest = hashlib.sha256(oml.read_bytes()).hexdigest().upper()
    cache_dir = cache_dir or (ROOT / ".local" / "edit-data" / "schemas")
    cached = cache_dir / f"{digest}.json"
    if cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    module = _inspect_module(oml)
    entities: dict[str, dict] = {}
    for e in _inspect(oml, "Entity", "Name,IsStaticEntity,IdentifierAttribute"):
        kind = e["kind"]
        if kind not in ("ServerEntity", "StaticEntity") or "/" in e["path"]:
            continue
        entities[e["name"]] = {"key": e["key"], "dbKey": studio_to_db(e["key"]), "static": kind == "StaticEntity",
                               "identifier": (e["properties"].get("IdentifierAttribute") or "").split(":")[-1] or None,
                               "attributes": {}}
    for a in _inspect(oml, "EntityAttribute", "Name,IsAutoNumber,DataType"):
        owner = a["path"].split("/")[0]
        owner_kind, _, owner_name = owner.partition(":")
        if owner_kind not in ("ServerEntity", "StaticEntity") or owner_name not in entities or a["path"].count("/") != 1:
            continue
        entities[owner_name]["attributes"][a["name"]] = {
            "key": a["key"], "dbKey": studio_to_db(a["key"]),
            "autoNumber": a["properties"].get("IsAutoNumber") == "Yes",
            "type": (a["properties"].get("DataType") or "").split(":", 1)[-1]}
    schema = {"module": module["name"], "moduleKey": module["key"], "moduleDbKey": studio_to_db(module["key"]),
              "omlSha256": digest, "entities": entities}
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(schema, indent=1, ensure_ascii=False), encoding="utf-8")
    return schema


def _inspect_module(oml: pathlib.Path) -> dict:
    out = subprocess.run(["dotnet", str(READ_CLI), "inspect", "--oml", str(oml)], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        raise RuntimeError(f"inspect failed: {out.stdout[-800:]} {out.stderr[-800:]}")
    data = json.loads(out.stdout)["data"]
    return {"name": data["Name"], "key": data["Key"]}


def encode(value: Any) -> str | None:
    """Valor JSON -> texto do grid do Edit Data (formatos yyyy-MM-dd HH:mm:ss, yyyy-MM-dd, HH:mm:ss; booleano como o
    proprio GetRecords devolve, true/false)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dt.datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, str):
        return value
    raise TypeError(f"unsupported value {value!r}")


class EditData:
    """Uma lease do Studio logado para um modulo publicado. Use como context manager."""

    def __init__(self, module: str, oml: str | pathlib.Path, host: str | None = None, read_only: bool = True,
                 receipts: str | pathlib.Path | None = None, port: int | None = None) -> None:
        if module in REFUSED_MODULES:
            raise ValueError("Users and roles are out of reach of Edit Data here")
        self.schema = load_schema(oml)
        if self.schema["module"] != module:
            raise ValueError(f"snapshot is {self.schema['module']}, not {module}")
        self.oml_sha = self.schema["omlSha256"]
        self.read_only = read_only
        self.receipts = pathlib.Path(receipts or (ROOT / ".local" / "edit-data" / "receipts"))
        self.bridge = AnvilBridge(port, timeout=180.0)
        connected = self.bridge.ok("environment_session", operation="connect", host=host, module=None, readOnly=read_only)
        self.lease, self.host, self.user = connected["lease"], connected["host"], connected["username"]
        if "data-read" not in connected.get("operations", []):
            self.close()
            raise RuntimeError("the Studio bridge has no Edit Data operation; open the Studio from the 'Service Studio (SSAM)' shortcut")
        live = [m for m in self._call("modules") if m.get("Key") in (self.schema["moduleKey"], self.schema["moduleDbKey"])]
        if not live or live[0].get("Name") != module:
            self.close()
            raise RuntimeError(f"module identity {module} not found in {self.host}")
        self.module_version = live[0].get("VersionId")

    def __enter__(self) -> "EditData":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        try:
            self.bridge.call("environment_session", operation="close", lease=self.lease)
        except Exception:
            pass
        self.bridge.close()

    def _call(self, environment_operation: str, **arguments: Any) -> Any:
        return self.bridge.ok("environment_session", operation=environment_operation, lease=self.lease, arguments=arguments)["value"]

    def entity(self, name: str) -> dict:
        e = self.schema["entities"].get(name)
        if e is None:
            raise KeyError(f"entity {name} is not in {self.schema['module']}")
        return e

    def _names(self, entity: dict) -> dict[str, str]:
        names = {}
        for name, a in entity["attributes"].items():
            names[a["dbKey"].lower()] = name
            names[a["key"]] = name
        return names

    def read(self, entity_name: str, ids: list[str] | None = None, offset: int = 0) -> list[dict]:
        e = self.entity(entity_name)
        rows = self._call("data-read", moduleKey=self.schema["moduleDbKey"], entityKey=e["dbKey"], tenantId=None,
                          ids=ids, offset=offset, includeBinary=False)
        names = self._names(e)
        out = []
        for r in rows:
            named = {"Id": r["Id"]}
            for cell in r["Attributes"]:
                named[names.get(cell["Key"].lower(), names.get(cell["Key"], cell["Key"]))] = cell["Value"]
            out.append(named)
        return out

    def read_all(self, entity_name: str) -> list[dict]:
        rows, seen, offset = [], set(), 0
        for _ in range(1000):
            page = self.read(entity_name, offset=offset)
            fresh = [r for r in page if r["Id"] not in seen]
            seen.update(r["Id"] for r in fresh)
            rows += fresh
            offset += len(page)
            if not page or not fresh:
                break
        return rows

    def write(self, operation: str, entity_name: str, *, authorization: str, operation_id: str,
              records: list[dict] | None = None, ids: list[str] | None = None) -> dict:
        """insert | update | delete com recibo exclusivo. records: [{Atributo: valor}] (update leva o identificador)."""
        if self.read_only:
            raise PermissionError("read-only lease: writes are refused before reaching the Studio")
        if not authorization.strip():
            raise ValueError("writing data requires the user's own authorization words")
        uuid.UUID(operation_id)
        e = self.entity(entity_name)
        if e["static"]:
            raise ValueError("static entity records change in the model and are published, not through Edit Data")
        identifier = e["identifier"] or next((n for n, a in e["attributes"].items() if a["autoNumber"]), "Id")
        wire = None
        if operation in ("insert", "update"):
            wire = []
            for i, record in enumerate(records or []):
                rid = f"new-{i}" if operation == "insert" else str(record.get(identifier) or "")
                if not rid:
                    raise ValueError(f"update needs {identifier} on every record")
                cells = []
                for name, value in record.items():
                    a = e["attributes"].get(name)
                    if a is None:
                        raise KeyError(f"unknown attribute {entity_name}.{name}")
                    if name == identifier:
                        if operation == "insert" and a["autoNumber"]:
                            raise ValueError(f"AutoNumber {name} is assigned by the server")
                        if operation == "update":
                            continue
                    if a["type"] == "Binary Data":
                        raise ValueError(f"Binary Data is not written here: {name}")
                    cells.append({"key": a["dbKey"], "value": encode(value)})
                wire.append({"id": rid, "attributes": cells})
            if not wire:
                raise ValueError("records must be nonempty")
        elif operation == "delete":
            if not ids or len(set(ids)) != len(ids):
                raise ValueError("ids must be nonempty and unique")
        else:
            raise ValueError("operation must be insert, update or delete")
        # O recibo guarda os valores como texto do Edit Data (o mesmo que vai na chamada).
        request = {"operation": operation, "entity": entity_name,
                   "records": [{k: encode(v) for k, v in r.items()} for r in records] if records else None, "ids": ids}
        return self._receipt(operation_id, authorization, e, request, lambda: self._send(operation, e, wire, ids))

    def _send(self, operation: str, e: dict, wire: list | None, ids: list[str] | None) -> dict:
        reports = self._call("data-write", moduleKey=self.schema["moduleDbKey"], entityKey=e["dbKey"], tenantId=None,
                             operation=operation, records=wire, ids=ids)
        expected = len(ids) if operation == "delete" else len(wire or [])
        ok = len(reports) == expected and all(r["Status"] == "Success" and not r.get("Error") for r in reports)
        return {"ok": ok, "reports": [{"recordId": r.get("RecordId"), "clientRecordId": r.get("ClientRecordId"),
                                       "status": r.get("Status"), "error": r.get("Error")} for r in reports]}

    def _receipt(self, operation_id: str, authorization: str, e: dict, request: dict, send) -> dict:
        self.receipts.mkdir(parents=True, exist_ok=True)
        path = self.receipts / f"{uuid.UUID(operation_id).hex}.json"
        digest = hashlib.sha256("\n".join([self.host, self.schema["moduleDbKey"], e["dbKey"], self.oml_sha,
                                           json.dumps(request, sort_keys=True, ensure_ascii=False)]).encode("utf-8")).hexdigest()
        attempts: list = []
        if path.exists():
            previous = json.loads(path.read_text(encoding="utf-8"))
            if previous["digest"] != digest and previous["state"] != "reconciled-not-sent":
                raise RuntimeError(f"operationId {operation_id} already belongs to a different request")
            if previous["state"] == "completed":
                return {**previous["result"], "replayed": True, "receipt": str(path)}
            if previous["state"] != "reconciled-not-sent":
                raise RuntimeError(f"uncertain write: reconcile the live records and the receipt before any new request: {path}")
            # reconciliado a mao (a linha nao existe ao vivo e o pedido nao saiu): nova tentativa, historico preservado
            attempts = previous.get("previousAttempts", []) + [{k: v for k, v in previous.items() if k != "previousAttempts"}]
        receipt = {"operationId": operation_id, "digest": digest, "host": self.host, "user": self.user, "previousAttempts": attempts,
                   "module": self.schema["module"], "moduleVersion": self.module_version, "entity": request["entity"],
                   "omlSha256": self.oml_sha, "authorization": authorization, "operation": request["operation"],
                   "request": request, "state": "pending", "startedUtc": dt.datetime.now(dt.timezone.utc).isoformat()}
        _save(path, receipt)
        result = send()  # sem retry: um erro aqui deixa o recibo pendente como evidencia
        receipt.update(result=result, state="completed", finishedUtc=dt.datetime.now(dt.timezone.utc).isoformat())
        _save(path, receipt)
        return {**result, "receipt": str(path)}


def _save(path: pathlib.Path, value: dict) -> None:
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=1, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("schema"); s.add_argument("--oml", required=True); s.add_argument("--out")
    r = sub.add_parser("read"); r.add_argument("--module", required=True); r.add_argument("--oml", required=True)
    r.add_argument("--entity", required=True); r.add_argument("--all", action="store_true"); r.add_argument("--host")
    r.add_argument("--out")
    a = p.parse_args()
    if a.cmd == "schema":
        result: Any = load_schema(a.oml)
    else:
        with EditData(a.module, a.oml, host=a.host, read_only=True) as data:
            rows = data.read_all(a.entity) if a.all else data.read(a.entity)
            result = {"host": data.host, "module": a.module, "moduleVersion": data.module_version, "entity": a.entity,
                      "count": len(rows), "records": rows}
    text = json.dumps(result, indent=1, ensure_ascii=False)
    if getattr(a, "out", None):
        pathlib.Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(a.out).write_text(text, encoding="utf-8")
        print(json.dumps({"ok": True, "out": a.out}))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
