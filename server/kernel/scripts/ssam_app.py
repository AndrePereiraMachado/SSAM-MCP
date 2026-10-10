"""SSAM app boundary: trusted Codex hooks + a small MCP surface. No raw jobs or arbitrary commands are tools."""
from __future__ import annotations
import argparse
import importlib
import json
import os
import pathlib
import subprocess
import sys
import uuid
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOLS = {
    "context": "Read the host-captured request, accepted module contract and supported schema for this task.",
    "propose": "Record the complete initial module contract from the user request. Later requirement changes need user acceptance; this does not deliver or publish.",
    "continue": "Advance or resume the accepted task. Hybrid chooses snapshot, compilation, merge or reconciliation and preserves its original requirements.",
    "status": "Read the original task's delivery facts and content proof. This does not create or merge anything.",
}


def host(cli: pathlib.Path, action: str, payload: dict, workspace: pathlib.Path | None = None) -> dict:
    payload = dict(payload)
    payload.pop("trustedWorkspace", None)
    if workspace is not None:
        payload["trustedWorkspace"] = str(workspace)
    process = subprocess.run(["dotnet", str(cli), "app-session", "--action", action],
        input=json.dumps(payload, ensure_ascii=True), capture_output=True, text=True, encoding="utf-8", cwd=ROOT, timeout=30)
    try:
        envelope = json.loads(process.stdout)
    except ValueError as error:
        raise RuntimeError("Hybrid host did not return valid JSON; the controlled app session is unavailable") from error
    if not envelope.get("ok"):
        raise RuntimeError(envelope.get("error", "Hybrid host refused the request"))
    return envelope["data"]


def hook(cli: pathlib.Path, workspace: pathlib.Path | None = None) -> int:
    event: dict = {}
    outside = False
    try:
        event = json.load(sys.stdin)
        kind = event.get("hook_event_name")
        if workspace is not None:
            try:
                cwd = pathlib.Path(event.get("cwd", ""))
                outside = not cwd.is_absolute() or not cwd.resolve(strict=True).is_relative_to(workspace)
            except (OSError, ValueError):
                outside = True
            if outside:
                # Only scope metadata reaches the host when this hook survived a project change.
                event = {key: event[key] for key in ("hook_event_name", "session_id", "turn_id", "cwd", "tool_name") if key in event}
        if kind == "UserPromptSubmit":
            captured = host(cli, "capture", event) if workspace is None else host(cli, "capture", event, workspace)
            if outside or captured.get("captured") is False:
                return 0
            print(json.dumps({"hookSpecificOutput": {"hookEventName": kind,
                "additionalContext": "Controlled SSAM Hybrid app task: " + captured["taskId"] +
                ". Use only the ssam_hybrid tools with this task_id. The host retains the user request; unsupported scope is a blocker, not permission for maintenance."}}))
        elif kind == "PreToolUse":
            decision = host(cli, "guard", event) if workspace is None else host(cli, "guard", event, workspace)
            if workspace is not None and decision.get("inScope") is False and not event.get("tool_name", "").startswith("mcp__ssam_hybrid__"):
                return 0
            print(json.dumps({"hookSpecificOutput": {"hookEventName": kind,
                "permissionDecision": "allow" if decision["allowed"] and not outside else "deny",
                "permissionDecisionReason": decision.get("reason") or "Exact Hybrid task call authorized"}}))
        else:
            raise RuntimeError("Unsupported SSAM hook event")
        return 0
    except Exception as error:
        if outside and (event.get("hook_event_name") == "UserPromptSubmit"
                or not event.get("tool_name", "").startswith("mcp__ssam_hybrid__")):
            return 0
        if event.get("hook_event_name") == "PreToolUse":
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                "permissionDecisionReason": "Controlled app policy unavailable: " + str(error)}}))
            return 0
        print("SSAM could not capture the original user request: " + str(error), file=sys.stderr)
        return 2


def schemas() -> list[dict]:
    result = []
    for name, description in TOOLS.items():
        properties: dict[str, Any] = {"task_id": {"type": "string", "description": "Task id supplied by the trusted UserPromptSubmit hook."}}
        required = ["task_id"]
        if name == "propose":
            properties["csharpSource"] = {"oneOf": [{"type": "string"}, {"type": "object", "properties": {"files": {"type": "object", "additionalProperties": {"type": "string"}}}, "required": ["files"], "additionalProperties": False}], "description": "Authored C# source text or files, compiled semantically into the same native module contract. Data declarations and typed static server/service methods use ordinary C# expressions, calls and structured control flow. Public methods require authentication; Authorize declares roles. Unsupported constructs report source diagnostics. IDataSession translates typed CRUD and basic LINQ queries. Paging, joins/projections, mutable reference effects, async and general .NET APIs remain incomplete. No jobs, graphs or native bindings are supplied by the author."}
            properties.update({"module": {"type": "string"}, "lane": {"type": "string", "enum": ["ss4", "ss5"]},
                "environment": {"type": "string"}, "uiSource": {"oneOf": [{"type": "string"}, {"type": "object", "properties": {"entry": {"type": "string"}, "files": {"type": "object", "additionalProperties": {"type": "string"}}}, "required": ["entry", "files"], "additionalProperties": False}], "description": "HTML/CSS/JS source, or a bundle of authored files with an entry path. Relative component imports are resolved and frozen by the Hybrid; no binding manifest."}, "data": {"type": "object"}, "logic": {"type": "object"}, "roles": {"type": "array", "items": {"type": "object"}}, "exceptions": {"type": "array", "items": {"type": "object"}}, "expectedMessages": {"type": "array", "items": {"type": "object"}}})
            required += ["module", "lane", "environment"]
        result.append({"name": name, "description": description, "inputSchema": {"type": "object", "properties": properties,
            "required": required, "additionalProperties": False}, "annotations": {"readOnlyHint": name in ("context", "status"),
            "destructiveHint": False, "openWorldHint": False}})
    return result


def contract_review(proposal: dict) -> str:
    # Full declaration, without truncating requirements to a count or a success label.
    return ("SSAM Hybrid — confira esta alteração do contrato do módulo já fixado. "
        "A aceitação fixa este conteúdo, módulo, ambiente e faixa; correções técnicas posteriores não mudam esses requisitos. "
        "Este contrato cobre dados e o fluxo declarado das actions; não comprova sozinho toda a intenção de negócio.\n\n" + json.dumps(proposal, ensure_ascii=False, indent=2))


class Server:
    def __init__(self, cli: pathlib.Path, read=sys.stdin, write=sys.stdout, workspace: pathlib.Path | None = None):
        self.cli, self.read, self.write = cli, read, write
        self.workspace = workspace
        self.elicitation = False

    def host(self, action: str, payload: dict) -> dict:
        return host(self.cli, action, payload) if self.workspace is None else host(self.cli, action, payload, self.workspace)

    def send(self, value: dict) -> None:
        self.write.write(json.dumps(value, ensure_ascii=False) + "\n")
        self.write.flush()

    def accept_contract(self, proposal: dict, parent_id: Any) -> bool:
        if not self.elicitation:
            raise RuntimeError("Client does not support user contract acceptance; controlled delivery remains blocked")
        request_id = "ssam-review-" + uuid.uuid4().hex
        self.send({"jsonrpc": "2.0", "id": request_id, "method": "elicitation/create", "params": {
            "message": contract_review(proposal), "requestedSchema": {"type": "object", "properties": {
                "accepted": {"type": "boolean", "title": "O contrato corresponde ao meu pedido", "default": False}}, "required": ["accepted"]}}})
        for line in self.read:
            reply = json.loads(line)
            if reply.get("id") == request_id and "method" not in reply:
                answer = reply.get("result", {})
                return answer.get("action") == "accept" and answer.get("content", {}).get("accepted") is True
            if reply.get("method") == "notifications/cancelled" and reply.get("params", {}).get("requestId") == parent_id:
                return False
            if "id" in reply:
                self.send({"jsonrpc": "2.0", "id": reply["id"], "error": {"code": -32000, "message": "A contract review is pending; no other operation was executed"}})
        return False

    def call(self, name: str, arguments: dict, request_id: Any) -> dict:
        schema = next((s["inputSchema"] for s in schemas() if s["name"] == name), None)
        if schema is None:
            raise ValueError("Unknown app tool")
        if set(arguments) - set(schema["properties"]) or set(schema["required"]) - set(arguments):
            raise ValueError("Only the declared app tool arguments are accepted")
        self.host("authorize", {"tool": name, "arguments": arguments})
        task_id = arguments["task_id"]
        if name in ("context", "status"):
            result = self.host(name, {"task_id": task_id})
            if name == "context":
                result["lanes"] = self.lanes()
            return result
        if name == "propose":
            proposal = {key: value for key, value in arguments.items() if key != "task_id"}
            result = self.host("propose", {"task_id": task_id, "proposal": proposal})
            if result.get("accepted"):
                return result
            if not self.accept_contract(result["proposal"], request_id):
                return {"accepted": False, "state": "awaiting-user-acceptance", "taskId": task_id}
            return self.host("accept", {"task_id": task_id, "contract_hash": result["contractHash"]})
        prepared = self.host("prepare", {"task_id": task_id})
        os.environ["ANVIL_LANE"] = prepared["lane"]
        import lanes
        os.environ["ANVIL_STUDIO_DIR"] = str(lanes.lane(prepared["lane"]).studio_dir)
        import anvil_cli
        importlib.reload(anvil_cli)
        envelope = anvil_cli.run(["deliver", "--resume", prepared["deliveryTaskId"], "--work", prepared["work"]])
        result = self.host("status", {"task_id": task_id})
        if not envelope.get("ok") and not result.get("result", {}).get("error"):
            result["transportError"] = envelope.get("error") or envelope.get("data", {}).get("error")
        return result

    @staticmethod
    def lanes() -> list[dict]:
        from anvil_client import AnvilBridge
        result = []
        for name, port in [("ss4", 4516), ("ss5", 4536)]:
            bridge = AnvilBridge(port=port, timeout=3)
            try:
                manifest = bridge.ok("bridge_manifest")
                entry = {"lane": name, "ready": manifest.get("protocolVersion", 0) >= 2}
                if entry["ready"]:
                    inventory = bridge.ok("list_open_modules")
                    environments = inventory.get("environments", [])
                    entry.update({"environments": environments, "activeModule": None})
                    if any(module.get("hasESpace") for module in inventory.get("modules", [])):
                        active = bridge.ok("get_active_module")
                        entry.update({"environment": active.get("environment"), "activeModule": active.get("name")})
                    elif len(environments) == 1:
                        entry["environment"] = environments[0]
                    if not environments:
                        entry.update({"ready": False, "reason": "Connect the Studio to the requested environment first"})
                else:
                    entry["reason"] = "Bridge update required before controlled app delivery"
                result.append(entry)
            except Exception as error:
                result.append({"lane": name, "ready": False, "reason": str(error)})
            finally:
                bridge.close()
        return result

    def serve(self) -> int:
        for line in self.read:
            request: dict = {}
            try:
                request = json.loads(line)
                if "id" not in request:
                    continue
                method, params = request.get("method"), request.get("params", {})
                if method == "initialize":
                    self.elicitation = "elicitation" in params.get("capabilities", {})
                    result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "ssam_hybrid", "version": "1.0.0"}}
                elif method == "ping":
                    result = {}
                elif method == "tools/list":
                    result = {"tools": schemas()}
                elif method == "tools/call":
                    try:
                        value = self.call(params["name"], params.get("arguments", {}), request["id"])
                        result = {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "structuredContent": value}
                    except Exception as error:
                        result = {"isError": True, "content": [{"type": "text", "text": str(error)}]}
                else:
                    self.send({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Unsupported MCP method"}})
                    continue
                self.send({"jsonrpc": "2.0", "id": request["id"], "result": result})
            except Exception as error:
                self.send({"jsonrpc": "2.0", "id": request.get("id"), "error": {"code": -32600, "message": str(error)}})
        return 0


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=pathlib.Path, required=True)
    parser.add_argument("--hook", action="store_true")
    parser.add_argument("--workspace", type=pathlib.Path)
    args = parser.parse_args()
    workspace = args.workspace
    if workspace is not None:
        if not workspace.is_absolute():
            parser.error("--workspace must be an absolute existing directory")
        workspace = workspace.resolve(strict=True)
        if not workspace.is_dir():
            parser.error("--workspace must be an existing directory")
    return hook(args.cli, workspace) if args.hook else Server(args.cli, workspace=workspace).serve()


if __name__ == "__main__":
    raise SystemExit(main())
