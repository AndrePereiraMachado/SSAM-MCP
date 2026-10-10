#!/usr/bin/env python3
"""OutSystems padrões: checa as 35 regras de implementação OutSystems (RULES.md) e a regra P7. Python só stdlib.

Ferramenta opcional do SSAM Hybrid: roda só quando o usuário pede. Estágios: job, truechange (com o pré-requisito
interno K0 e a N4), oml (via `anvil inspect --oml`) e runtime. Os detectores de hoje leem jobs e OML do O11; no ODC
cada regra sai como "não checada no ODC ainda" (AR1: "não se aplica ao ODC"). Uso no README.md desta pasta.
Exit: 0 ok, 1 violação, 2 falha de ferramenta ou de entrada (fail-closed), 3 revisão, evidência de runtime ou
checagem pendente.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent


def find_kernel(start: pathlib.Path) -> pathlib.Path:
    """Raiz do kernel: a primeira pasta acima do script com MANIFESTO.md e scripts/. OUTSYSTEMS_PADROES_KERNEL manda."""
    env = os.environ.get("OUTSYSTEMS_PADROES_KERNEL")
    if env:
        return pathlib.Path(env).resolve()
    for at in (start, *start.parents):
        if (at / "MANIFESTO.md").exists() and (at / "scripts").is_dir():
            return at
    return start


KERNEL = find_kernel(HERE)
PADROES_DIR = KERNEL / ".local" / "padroes"          # trabalho e relatórios
DEFAULT_CLI = KERNEL / ".local" / "cli" / "anvil.dll"
EXAMPLE_CONFIG = HERE / "config.example.json"
SCHEMA = "outsystems-padroes/1"
EXC_SCHEMAS = ("outsystems-padroes-excecoes/1", "o11-padroes-excecoes/1")   # o segundo é o formato antigo, aceito
EXC_SCHEMA = EXC_SCHEMAS[0]
STAGES = ("job", "truechange", "oml", "runtime")
DETECTION_STAGES = ("job", "truechange", "oml")
PLATFORMS = ("o11", "odc")

SEV_ERR, SEV_WARN, SEV_INFO, SEV_CONTRACT = "erro", "aviso", "info", "pendente contrato"
NO_EXCEPTION_RULES = {"P7", "K0"}

# As 35 regras (RULES.md) e a P7, na ordem do documento. K0 é pré-requisito interno do estágio truechange, não regra.
RULE_ORDER = ("L1", "L2", "L3", "L4", "L5", "L6", "L7", "T1", "T2", "T3", "T4", "D1", "D2", "D3", "D4", "D5",
              "S1", "S2", "S3", "S4", "U1", "U2", "U3", "U4", "U5", "N1", "N2", "N3", "N4", "E1", "E2", "E3",
              "AR1", "AR2", "AR3", "P7")
# Onde a regra vale. Todas valem no O11 e no ODC, menos a AR1 (Architecture Canvas), que é só do O11.
RULE_PLATFORMS = {rule: ("O11", "ODC") for rule in RULE_ORDER}
RULE_PLATFORMS["AR1"] = ("O11",)
# Classificação da checagem (RULES.md).
RULE_CLASS = {
    "L1": "manual", "L2": "parcial", "L3": "automatica", "L4": "manual", "L5": "automatica", "L6": "parcial",
    "L7": "parcial", "T1": "parcial", "T2": "parcial", "T3": "automatica", "T4": "parcial", "D1": "parcial",
    "D2": "parcial", "D3": "parcial", "D4": "parcial", "D5": "automatica", "S1": "automatica", "S2": "automatica",
    "S3": "parcial", "S4": "parcial", "U1": "automatica", "U2": "parcial", "U3": "parcial", "U4": "parcial",
    "U5": "manual", "N1": "parcial", "N2": "parcial", "N3": "parcial", "N4": "automatica", "E1": "parcial",
    "E2": "parcial", "E3": "parcial", "AR1": "automatica", "AR2": "parcial", "AR3": "parcial", "P7": "automatica",
}
# O que cada estágio detecta hoje no O11 (jobs do O11 e OML lido por `anvil inspect`).
IMPLEMENTED = {
    "job": ["L2", "L3", "L5", "L6", "L7", "T1", "T2", "T3", "T4", "D2", "D3", "D4", "D5", "S1", "S2", "S3", "S4",
            "U1", "U3", "U4", "N1", "N2", "N3", "N4", "E1", "E2", "E3", "AR1", "AR2", "AR3", "P7"],
    "truechange": ["K0", "N4", "L5", "D3", "D5", "S1", "U4", "AR2"],
    "oml": ["L3", "L5", "L6", "T3", "T4", "D2", "D3", "D5", "S1", "S2", "S3", "U1", "U4", "N1", "N2", "N4", "E2", "E3", "AR1",
            "AR2", "AR3", "P7"],
    "runtime": ["T4"],
}
# Detectores por plataforma. No ODC ainda não há detector de job, truechange nem OML; o estágio runtime só cruza
# runtimeTests com runtimeEvidence e vale nas duas.
DETECTORS = {"o11": IMPLEMENTED, "odc": {"runtime": ["T4"]}}
REVIEW_QUESTIONS = {
    "L1": "Para cada action listada, existe built-in, list action, mapping ou filtro de aggregate que substitua algum trecho? (sim/não e qual)",
    "L2": "A local X é reutilizada ou deixa o fluxo mais legível?",
    "L4": "O Label descreve uma única intenção que cobre todas as atribuições?",
    "L6": "Algum Text carrega JSON entre actions ou módulos?",
    "L7": "Este literal é configuração (Site Property) ou domínio (Static Entity)?",
    "T1": "Cada item exige efeito ou decisão que list actions não expressam?",
    "T2": "Cada item exige efeito ou decisão que list actions não expressam?",
    "T4": "Qual E2E exercitou este filtro depois da publicação, e com que resultado?",
    "D1": "Os dados que a tela exibe vêm de Aggregate ou Data Action?",
    "D2": "Algum join ou filtro acontece fora do aggregate? Os DTOs e os outputs das Data Actions trazem só os campos exibidos? Algum aggregate tem a lista atribuída ou passada adiante?",
    "D3": "O que o aggregate não resolve aqui?",
    "D4": "A API que preenche a tela está numa Data Action?",
    "S3": "Algum log ou trace pode conter token ou dado pessoal?",
    "S4": "O timeout cobre o p95 medido nos runs reais?",
    "U2": "Há padrão equivalente no OutSystems UI?",
    "U3": "O cálculo pode ir para o fluxo, uma vez só?",
    "U5": "O bloco depende de algo além de parâmetros e eventos?",
    "N1": "Os nomes são curtos e significativos?",
    "N2": "A descrição explica o porquê? (por amostra)",
    "N3": "Cada bloco lógico está marcado?",
    "E1": "Cada local é necessária?",
    "AR2": "Algum input do cliente é usado sem revalidação no servidor?",
    "AR3": "Algum processo longo roda numa screen request?",
}
MANUAL_ALWAYS = ("L1", "L4", "U5", "D2", "S3", "S4", "U2", "AR2", "N2")

TRUECHANGE_RULES = {
    "ClientActionWithServerRequestsOnLifecycleEvent": "S1",
    "Block_ClientActionWithServerRequestsOnLifecycleEvent": "S1",
    "SelfRefreshingAggregate": "S1",
    "EntityActionInsideLoop": "D5",
    "SQLInjection": "D3",
    "SQL_ExpandInlineNotValidated": "D3",
    "ServerActionInAnonymousScreen": "AR2",
    "InvalidCSSStyle": "U4",
    "JavascriptInjection": "L5",
}

LIFECYCLE = ("OnInitialize", "OnReady", "OnRender", "OnParametersChanged", "OnAfterFetch", "OnDestroy")
LIST_ACTIONS = ("ListFilter", "ListSort", "ListAny", "ListAll", "ListIndexOf", "ListDistinct")
BASIC_TYPES = {"text", "integer", "long integer", "decimal", "boolean", "date", "time", "date time", "currency", "email",
               "phone number", "binary data", "object"}
ACTION_KIND = {"server": "ServerAction", "service": "ServiceAction", "client": "ClientAction", "screen": "ScreenAction",
               "data": "DataAction", "preparation": "Preparation"}
STEP_KINDS = ("get", "assign", "call", "save", "create", "update", "delete", "if", "foreach", "while", "break",
              "continue", "return", "raise", "switch", "node")
WRITE_STEPS = ("save", "create", "update", "delete")
STR_RE = re.compile(r'"(?:[^"]|"")*"')
IF_RE = re.compile(r"(?i)\bIf\s*\(")
GENERIC_LABEL = re.compile(r"^(If|Assign|ForEach|While|Switch|Return)\d*$")
URL_RE = re.compile(r"(?i)\b(?:https?|ftp)://|\bwww\.[a-z0-9-]+\.")
EMAIL_RE = re.compile(r"[\w.+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.]+")
HOST_RE = re.compile(r"(?i)^[a-z0-9-]+(\.[a-z0-9-]+)+\.(com|net|org|io|gov|edu|mil|us|br|ai|azure|cloud|local)(:\d+)?(/.*)?$")
MARKERS = ("anvil:html script", "anvil:ui", "STUB DE CONTRATO", "TODO")
STOPWORDS = {"the", "a", "an", "of", "to", "for", "and", "or", "in", "on", "by", "with", "o", "a", "os", "as", "de", "da",
             "do", "das", "dos", "e", "em", "para", "por", "com", "um", "uma", "no", "na"}

# Padrões da ferramenta. A config do projeto (config.example.json) sobrepõe chave a chave; as chaves de MERGE_KEYS
# são mescladas um nível (a config acrescenta ou troca itens). Nenhum nome de projeto ou cliente aqui.
DEFAULT_CONFIG = {
    "platform": "o11",
    "layerOrder": {"Foundation": 0, "Core": 1, "End-user": 2},
    "modules": {"OutSystemsUI": "Foundation", "OutSystemsCharts": "Foundation", "OutSystemsMaps": "Foundation",
                "Users": "Foundation", "(System)": "Foundation"},
    "modulePatterns": [["*_CW", "Core"], ["*_CS", "Core"], ["*_IS", "Foundation"], ["*_TH", "Foundation"], ["*_UI", "End-user"]],
    "forbiddenRefs": [],
    "integrationModules": [],
    "longRunning": [],
    "asyncStarters": [],
    "guardActions": ["Require*", "Guard_*", "Auth_Require*"],
    "patternLibrary": "",
    "libraries": ["OutSystemsUI", "OutSystemsCharts"],
    "anonymousScreens": ["Login"],
    "templatePaths": ["MobileFlow:Common/", "MobileFlow:Layouts/", "ServerAction:DoLogin", "ServerAction:DoLogout",
                      "ClientVariable:LastURL", "ClientVariable:Username"],
    "describedKinds": {
        "job": ["ServerAction", "ServiceAction", "ClientAction", "ScreenAction", "DataAction", "LocalVariable",
                "InputParameter", "OutputParameter", "Structure", "StructureAttribute", "ServerEntity", "EntityAttribute",
                "StaticEntity", "SiteProperty", "Timer", "Role", "ClientVariable", "MobileScreen", "MobileBlock",
                "JavaScriptNode", "JSONSerializeNode", "JSONDeserializeNode", "Script", "RestAPI", "RestAction",
                "Exception", "AggregateNode", "SQLNode", "ScreenAggregate", "ExcelToRecordListNode",
                "RecordListToExcelNode", "TriggerNode"],
        "oml": ["ServerAction", "ServiceAction", "ClientAction", "ScreenAction", "DataAction", "LocalVariable",
                "InputParameter", "OutputParameter", "ServerEntity", "StaticEntity", "EntityAttribute", "Structure",
                "StructureAttribute", "SiteProperty", "ClientVariable", "Timer", "Role", "AggregateNode", "SQLNode",
                "ScreenAggregate", "JSONSerializeNode", "JSONDeserializeNode", "JavaScriptNode",
                "ExcelToRecordListNode", "RecordListToExcelNode", "TriggerNode"],
    },
    "describedIgnoreNames": ["Id", "Label", "Order", "Is_Active"],
    "verbs": ["Get", "Set", "Create", "Update", "Delete", "Save", "Validate", "Check", "Compute", "Calculate", "Build",
              "Load", "Fetch", "Send", "Start", "Stop", "Cancel", "Approve", "Reject", "Submit", "Record", "Register",
              "Resolve", "Apply", "Clear", "Reset", "Add", "Remove", "Append", "Find", "Search", "List", "Count",
              "Compare", "Export", "Import", "Parse", "Serialize", "Format", "Invoke", "Dispatch", "Run", "Claim",
              "Release", "Drain", "Grant", "Revoke", "Open", "Close", "Answer", "Ask", "Publish", "Retire", "Verify",
              "Hash", "Redact", "Reveal", "Notify", "Log", "Audit", "Ensure", "Require", "Refresh", "Upload",
              "Download", "Prepare", "Propose", "Raise", "Handle", "Map", "Convert", "Merge", "Split", "Select",
              "Filter", "Sort", "Toggle", "Show", "Hide", "Navigate", "Initialize", "Accept", "Decline", "Assign",
              "Complete", "Finish", "Wake", "Schedule", "Clone", "Copy", "Read", "Write", "Mark", "Lock", "Unlock",
              "Enable", "Disable", "Test", "Probe", "Seed", "Generate", "Render", "Describe", "Summarize", "Evaluate",
              "Score", "Queue", "Enqueue", "Dequeue", "Retry", "Resume", "Pause", "Kill", "Deny", "Confirm", "Edit",
              "Change", "Move", "Rename", "Attach", "Detach", "Link", "Unlink", "Sync", "Process", "Execute", "Call",
              "Emit", "Trigger", "Track", "Store", "Restore", "Purge", "Archive", "Fill", "Go", "Do", "Is", "Has",
              "Can", "Try", "Collect", "Extract", "Snapshot", "Diff", "Replay", "Expire", "Escalate", "Reassign",
              "Request", "Return", "Receive", "Post", "Put", "Patch", "Sign", "Login", "Logout", "Classify",
              "Measure", "Decide", "Accumulate", "Encode", "Decode", "Route", "Drop", "Report", "Use", "Detect",
              "Match", "Translate", "Normalize", "Sanitize", "Truncate", "Increment", "Decrement", "Bump", "Tag",
              "Flag", "Stamp", "Pick", "Choose", "Advance", "Upsert", "Stage", "Acknowledge", "Reconfirm",
              "Reconcile"],
    "extraVerbs": [],
    "booleanPrefixes": ["Is", "Has", "Can"],
    "contractNames": [],
    "limits": {"commentAt": 12, "extractAt": 30, "maxLocals": 5},
    "numericAllowProps": ["max", "start", "MaxRecords", "StartIndex", "order", "length", "Length", "TimeoutinSeconds",
                          "TimeoutInMinutes", "ServerRequestTimeout", "Timeout", "MaximumIterations", "timeout"],
    "literalAllowProps": ["ISiteProperty.DefaultValue"],
    "timeoutPolicy": {"restTimeoutSeconds": None, "minSeconds": None, "maxSeconds": None},
    "expectedSiteProperties": {},
    "sensitivePattern": "(?i)token|password|secret|apikey|api_key|ssn",
    "subjectEntities": [],
    "p7": {"protectedEntities": [], "allowedEntities": [], "entryPatterns": [], "forbiddenCalls": [], "siteSwitches": []},
    "l6": {"integrationOnlyFields": [], "writeOnlyFields": []},
    "approvers": [],
    "exceptionsFile": "",
    "suggestions": {},
}
MERGE_KEYS = ("layerOrder", "modules", "describedKinds", "limits", "timeoutPolicy", "expectedSiteProperties", "p7", "l6",
              "suggestions")


# ------------------------------------------------------------------------------------------------ utilidades

def sha256_file(path) -> str | None:
    try:
        return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


def read_json(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8-sig"))


def strip_strings(expr: str) -> str:
    return STR_RE.sub('""', expr or "")


def string_literals(expr: str) -> list[str]:
    return [m.group(0)[1:-1].replace('""', '"') for m in STR_RE.finditer(expr or "")]


def count_ifs(expr: str) -> int:
    return len(IF_RE.findall(strip_strings(expr)))


def camel_tokens(name: str) -> list[str]:
    return re.findall(r"[A-Z]+(?=[A-Z][a-z]|\d|_|\b|$)|[A-Z]?[a-z]+|\d+", name or "")


def norm_kind(kind: str) -> str:
    kind = kind or ""
    return kind[1:] if len(kind) > 1 and kind[0] == "I" and kind[1].isupper() else kind


def parse_om_path(path: str) -> list[tuple[str, str]]:
    """'Kind:Nome/Kind:Nome' (leitor) -> pares. Nomes com '/' quebram o casamento por sufixo (usar ObjectKey)."""
    pairs = []
    for seg in (path or "").split("/"):
        if not seg:
            continue
        kind, _, name = seg.partition(":")
        pairs.append((kind, name))
    return pairs


def parse_verify_path(path: str) -> list[tuple[str, str]]:
    """'Nome (Kind) / Nome (Kind)' (Verify) -> pares, sem o nível ESpace."""
    pairs = []
    for seg in (path or "").split(" / "):
        seg = seg.strip()
        m = re.match(r"^(.*) \(([A-Za-z]+)\)$", seg)
        if m:
            pairs.append((m.group(2), m.group(1)))
            continue
        m = re.match(r'^([A-Za-z]+) "(.*)"$', seg)
        if m:
            pairs.append((m.group(1), m.group(2)))
            continue
        pairs.append((seg, ""))
    return [p for p in pairs if p[0] != "ESpace"]


def fmt_path(pairs) -> str:
    return "/".join(f"{k}:{n}" for k, n in pairs)


def is_signature_path(path: str) -> bool:
    if path.startswith("Reference:"):
        return True
    return any(seg.partition(":")[0].endswith("Signature") for seg in path.split("/") if seg)


def ts_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class NamePatterns:
    """Lista de expressões regulares (ou uma só string) comparadas com o nome INTEIRO (fullmatch). Vazia = desligada."""

    def __init__(self, patterns):
        if isinstance(patterns, str):
            patterns = [patterns]
        self.regs = [re.compile(p) for p in (patterns or []) if isinstance(p, str) and p.strip()]

    def __bool__(self):
        return bool(self.regs)

    def match(self, name) -> bool:
        return any(rg.fullmatch(str(name or "")) for rg in self.regs)


def load_config(path):
    """Padrões da ferramenta + config do projeto. Devolve (config efetiva, config lida)."""
    data = read_json(path) if path else {}
    if not isinstance(data, dict):
        raise ValueError("a config precisa ser um objeto JSON")
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    for k, v in data.items():
        if k in MERGE_KEYS and isinstance(v, dict) and isinstance(cfg.get(k), dict):
            cfg[k] = {**cfg[k], **v}
        else:
            cfg[k] = v
    cfg["verbs"] = list(dict.fromkeys(list(cfg.get("verbs") or []) + list(cfg.get("extraVerbs") or [])))
    lib = str(cfg.get("patternLibrary") or "").strip()
    if lib and lib not in (cfg.get("libraries") or []):
        cfg["libraries"] = list(cfg.get("libraries") or []) + [lib]
    for key in ("subjectEntities",):
        NamePatterns(cfg.get(key))                        # valida as expressões (re.error vira falha de entrada)
    p7 = cfg.get("p7") or {}
    for key in ("protectedEntities", "allowedEntities"):
        NamePatterns(p7.get(key))
    for key in ("entryPatterns", "forbiddenCalls"):
        for p in p7.get(key) or []:
            re.compile(p)
    re.compile(cfg.get("sensitivePattern") or r"(?!)")
    return cfg, data


def review_question(rule, cfg) -> str:
    if rule == "U2":
        lib = str(cfg.get("patternLibrary") or "").strip()
        if lib:
            return f"Há padrão equivalente na library de padrões do app ({lib}) ou no OutSystems UI?"
    return REVIEW_QUESTIONS[rule]


# ------------------------------------------------------------------------------------------------ relatório

class Report:
    def __init__(self, args, config, platform="o11"):
        self.args = args
        self.config = config
        self.mode = args.mode
        self.module = args.module
        self.platform = platform
        self.plan_stage = getattr(args, "plan_stage", None)
        self.scope_job_text = ""          # escopo lido por estágio (para staleExceptions)
        self.scope_msg_paths: list = []
        self.scope_msg_keys: set = set()
        self.findings: list[dict] = []
        self.tool_errors: list[dict] = []
        self.manual: dict[str, dict] = {}
        self.runtime_tests: dict[str, dict] = {}
        self.inputs: dict = {"jobs": [], "oml": None, "baseOml": None, "result": None, "deliverResult": None,
                             "config": None, "exceptions": None, "review": None}
        self.notes: list[str] = []
        self.k0 = None
        self.stages_run: list[str] = []
        self._seen = set()

    def add(self, rule, severity, message, *, stage, path=None, key=None, job=None, generated_by=None,
            suggestion=None, evidence=None, preexisting=False, scope=None, related=None):
        pairs = path if isinstance(path, list) else (parse_om_path(path) if isinstance(path, str) else [])
        pstr = fmt_path(pairs)
        fid = hashlib.sha1(f"{rule}|{self.module}|{pstr}|{key}|{message}|{evidence}".encode("utf-8")).hexdigest()[:12]
        if fid in self._seen:
            return None
        self._seen.add(fid)
        if severity == SEV_ERR and rule == "N1" and self._contract_name(pairs):
            severity = SEV_CONTRACT
        extra = str((self.config.get("suggestions") or {}).get(rule) or "").strip()
        if extra:                         # dica do projeto (config.suggestions) acrescentada à sugestão neutra
            suggestion = f"{suggestion} Projeto: {extra}" if suggestion else f"Projeto: {extra}"
        f = {"id": fid, "rule": rule, "severity": severity, "stage": stage, "source": stage, "module": self.module,
             "element": {"path": pstr, "pairs": [list(p) for p in pairs], "key": key, "job": job},
             "generatedBy": generated_by, "preexisting": bool(preexisting),
             "scope": scope or ("base" if preexisting else ("job" if stage == "job" else "new")),
             "message": message, "evidence": evidence, "suggestion": suggestion, "exception": None,
             "blocking": None, "relatedRule": related}
        self.findings.append(f)
        return f

    def _contract_name(self, pairs):
        names = set(self.config.get("contractNames") or [])
        return bool(names and pairs and pairs[-1][1] in names)

    def tool_error(self, what, detail):
        self.tool_errors.append({"what": what, "detail": detail})

    def ask(self, qid, rule, question, elements=None):
        entry = self.manual.setdefault(qid, {"questionId": qid, "rule": rule, "question": question, "elements": []})
        for e in elements or []:
            if e not in entry["elements"]:
                entry["elements"].append(e)

    def runtime_test(self, action, node, list_action, condition, *, stage, path):
        tid = hashlib.sha1(f"{self.module}|{action}|{node}|{list_action}".encode("utf-8")).hexdigest()[:12]
        t = self.runtime_tests.get(tid)
        if t is None:
            t = {"testId": tid, "rule": "T4", "module": self.module, "action": action, "node": node,
                 "listAction": list_action, "condition": condition, "path": path, "stages": []}
            self.runtime_tests[tid] = t
        if condition and not t.get("condition"):
            t["condition"] = condition
        if stage not in t["stages"]:
            t["stages"].append(stage)
        return t


# ------------------------------------------------------------------------------------------------ exceções

class Exceptions:
    def __init__(self, data, config, report: Report):
        self.report = report
        self.config = config
        self.items = []
        self.invalid = []
        self.pending = []
        self.out_of_stage = []
        approvers = set(config.get("approvers") or [])
        today = dt.date.today()
        plan = report.plan_stage
        if data.get("schema") not in EXC_SCHEMAS:
            report.tool_error("exceptions", f"esquema inesperado: {data.get('schema')!r} (esperado {EXC_SCHEMA})")
        frozen = data.get("planStage")
        if frozen and plan and stage_num(frozen) != stage_num(plan):
            report.tool_error("exceptions", f"cópia congelada do estágio {frozen} usada com --plan-stage {plan}")
        if frozen and data.get("module") and report.module and data["module"] != report.module:
            report.tool_error("exceptions", f"cópia congelada do módulo {data['module']} usada com --module {report.module}")
        if report.mode == "integrador" and not frozen and data.get("exceptions"):
            report.notes.append("Exceções: o arquivo não é uma cópia congelada do estágio (sem planStage). Congele com "
                                "--freeze-exceptions <saída> --plan-stage <estágio> --module <Módulo> e passe a cópia em --exceptions.")
        for ex in data.get("exceptions") or []:
            ex = dict(ex)
            if plan and ex.get("stages") and stage_num(plan) not in {stage_num(s) for s in ex["stages"]}:
                self.out_of_stage.append({"id": ex.get("id"), "stages": ex.get("stages")})
                continue
            ex["_uses"] = 0
            problems = []
            status = ex.get("status")
            if ex.get("rule") in NO_EXCEPTION_RULES:
                problems.append(f"a regra {ex.get('rule')} não aceita exceção")
            if status == "aprovada":
                ap = ex.get("approval") or {}
                if not (ap.get("message") or "").strip():
                    problems.append("aprovada sem approval.message (texto literal da mensagem de quem aprovou)")
                if ap.get("by") not in approvers:
                    problems.append(f"aprovador {ap.get('by')!r} fora de config.approvers")
                if not (ap.get("at") or "").strip():
                    problems.append("aprovada sem approval.at")
            exp = ex.get("expires")
            ex["_expired"] = False
            if exp:
                try:
                    ex["_expired"] = dt.date.fromisoformat(exp) < today
                except ValueError:
                    problems.append(f"expires inválido: {exp!r}")
            el = ex.get("element")
            concrete = isinstance(el, dict) and (el.get("objectKey") or el.get("path"))
            if ex.get("match") == "pattern" and not ex.get("maxMatches"):
                problems.append("match:pattern exige maxMatches")
            if problems:
                self.invalid.append({"id": ex.get("id"), "rule": ex.get("rule"), "module": ex.get("module"),
                                     "problems": problems})
                continue
            if not concrete:
                if status in ("proposta", "aprovada"):
                    self.pending.append({"id": ex.get("id"), "rule": ex.get("rule"), "module": ex.get("module"),
                                         "status": status, "note": "element a preencher pelo integrador; não se aplica"})
                continue
            self.items.append(ex)

    def applicable_status(self, ex) -> bool:
        if ex["_expired"]:
            return False
        if self.report.mode == "integrador":
            return ex.get("status") == "aprovada"
        return ex.get("status") in ("aprovada", "proposta")

    @staticmethod
    def _norm(pairs):
        return [(norm_kind(k).lower().removesuffix("signature"), (n or "").lower()) for k, n in pairs]

    def matches(self, ex, finding) -> bool:
        rules = set(ex.get("rules") or [ex.get("rule")])
        if finding["rule"] not in rules and finding.get("relatedRule") not in rules:
            return False
        if ex.get("module") and self.report.module and ex["module"] != self.report.module:
            return False
        el = ex["element"]
        key = finding["element"].get("key")
        if el.get("objectKey") and key:
            return el["objectKey"] == key
        want = self._norm([tuple(p) for p in el.get("path") or []])
        have = self._norm([tuple(p) for p in finding["element"].get("pairs") or []])
        if not want or not have:
            return False
        match = ex.get("match") or "suffix"
        if match == "exact":
            return want == have
        if match == "pattern":
            if len(want) > len(have):
                return False
            tail = have[-len(want):]
            return all(fnmatch.fnmatchcase(hk, wk) and fnmatch.fnmatchcase(hn, wn) for (hk, hn), (wk, wn) in zip(tail, want))
        if len(want) < 2 and len(have) >= 2:
            return False
        return len(want) <= len(have) and have[-len(want):] == want

    def apply(self, findings):
        per_ex = {}
        for f in findings:
            if f["rule"] in NO_EXCEPTION_RULES:
                continue
            for ex in self.items:
                if not self.matches(ex, f):
                    continue
                per_ex.setdefault(ex["id"], 0)
                if ex.get("match") == "pattern" and per_ex[ex["id"]] >= int(ex.get("maxMatches") or 0):
                    continue
                applies = self.applicable_status(ex)
                f["exception"] = {"id": ex["id"], "status": ex.get("status"), "applied": applies,
                                  "expired": ex["_expired"]}
                if applies:
                    per_ex[ex["id"]] += 1
                    ex["_uses"] += 1
                break

    def in_scope(self, ex, stage) -> bool:
        """O elemento da exceção estava no escopo que o estágio leu? O: o módulo inteiro; J: o texto do job;
        T: os caminhos e chaves das mensagens do Verify. Fora do escopo, a exceção nunca vira 'sem uso'."""
        el = ex.get("element") or {}
        r = self.report
        if stage == "oml":
            return True
        if stage == "job":
            path = el.get("path") or []
            leaf = (path[-1][1] if path else "") or ""
            return bool(leaf) and leaf.lower() in (r.scope_job_text or "")
        if stage == "truechange":
            if el.get("objectKey") and el["objectKey"] in r.scope_msg_keys:
                return True
            want = self._norm([tuple(p) for p in el.get("path") or []])
            for pairs in r.scope_msg_paths:
                have = self._norm(pairs)
                if want and len(want) <= len(have) and have[-len(want):] == want:
                    return True
            return False
        return False

    def stale(self, stages_run):
        out = []
        detectors = DETECTORS.get(self.report.platform, {})
        for ex in self.items:
            rules = set(ex.get("rules") or [ex.get("rule")])
            if ex["_uses"] or (ex.get("module") and ex["module"] != self.report.module):
                continue
            # só fica "sem uso" se a regra foi avaliada num estágio que leu o elemento (estágio parcial não conta)
            if any(rules & set(detectors.get(s, [])) and self.in_scope(ex, s) for s in stages_run):
                out.append({"id": ex["id"], "rule": ex.get("rule"), "module": ex.get("module"),
                            "status": ex.get("status"), "expired": ex["_expired"]})
        return out


# ------------------------------------------------------------------------------------------------ jobs

def repo_root(start: pathlib.Path):
    at = start
    while True:
        if (at / "MANIFESTO.md").exists():
            return at
        if at.parent == at:
            return None
        at = at.parent


def resolve_job_file(spec: str, job_dir: pathlib.Path) -> pathlib.Path:
    """Mesma ordem de JobRunner.ResolveJobFile (JobRunner.cs:185-205)."""
    cands = []
    root = repo_root(job_dir)
    if spec.startswith("job:"):
        name = spec[4:] + ".json"
        cands.append(job_dir / name)
        if job_dir.name.lower().endswith("-negative"):
            cands.append(job_dir.parent / job_dir.name[: -len("-negative")] / name)
        if root:
            cands.append(root / "tests" / "jobs" / name)
    else:
        p = pathlib.Path(spec)
        cands.append(p if p.is_absolute() else job_dir / p)
        if root and not p.is_absolute():
            cands.append(root / spec)
    for c in cands:
        if c.exists():
            return c.resolve()
    raise FileNotFoundError(f"jobs: parte não encontrada: {spec} (procurada em {', '.join(map(str, cands))})")


class JobOp:
    __slots__ = ("file", "index", "gidx", "op", "pointer")

    def __init__(self, file, index, gidx, op):
        self.file, self.index, self.gidx, self.op = file, index, gidx, op
        self.pointer = f"/ops/{index}"

    def ref(self, sub=""):
        return {"file": str(self.file), "op": self.index, "pointer": self.pointer + sub}


class JobSet:
    def __init__(self):
        self.files: list[dict] = []
        self.ops: list[JobOp] = []
        self.expected: list[tuple[pathlib.Path, dict]] = []
        self.meta: list[dict] = []

    def load(self, path: pathlib.Path, active=None):
        path = path.resolve()
        active = active or []
        if path in active:
            raise ValueError(f"ciclo de job composto: {' -> '.join(map(str, active + [path]))}")
        data = read_json(path)
        self.files.append({"path": str(path), "sha256": sha256_file(path), "mtime": path.stat().st_mtime})
        if isinstance(data, dict):
            for e in data.get("expectedMessages") or []:
                self.expected.append((path, e))
            self.meta.append({"path": str(path), "base": data.get("base"), "description": data.get("description")})
        if isinstance(data, list):
            ops = data
        elif isinstance(data, dict) and isinstance(data.get("jobs"), list):
            if data.get("ops"):
                raise ValueError("job composto: use 'jobs' ou 'ops', não os dois")
            for part in data["jobs"]:
                self.load(resolve_job_file(part, path.parent), active + [path])
            return
        elif isinstance(data, dict) and isinstance(data.get("ops"), list):
            ops = data["ops"]
        else:
            raise ValueError(f"{path}: job sem 'ops' nem 'jobs'")
        for i, op in enumerate(ops):
            if isinstance(op, dict):
                self.ops.append(JobOp(path, i, len(self.ops), op))


# ------------------------------------------------------------------------------------------------ estágio job (O11)

class LogicAction:
    def __init__(self, jop: JobOp, index: int, data: dict):
        self.jop, self.index, self.data = jop, index, data
        self.name = data.get("name") or ""
        self.kind = data.get("kind") or "server"
        self.owner = data.get("owner")
        self.pointer = f"/data/actions/{index}"

    def om_path(self, owner_name=None):
        pairs = []
        if self.kind in ("screen", "data", "preparation") and (owner_name or self.owner):
            o = owner_name or str(self.owner)
            okind = "MobileScreen"
            if ":" in o:
                okind, o = norm_kind(o.split(":", 1)[0]), o.split(":", 1)[1]
            elif o.startswith("$"):
                o = o[1:]
            pairs.append((okind, o))
        pairs.append((ACTION_KIND.get(self.kind, "ServerAction"), self.name))
        return pairs


def step_kind(step: dict) -> str | None:
    for k in STEP_KINDS:
        if k in step:
            return k
    return None


def iter_steps(steps, pointer, in_loop=False, loop_ptr=None, depth=0):
    """Percorre os passos da op logic: devolve (passo, ponteiro, dentro_de_laço, ponteiro_do_laço)."""
    for i, st in enumerate(steps or []):
        if not isinstance(st, dict):
            continue
        ptr = f"{pointer}/{i}"
        yield st, ptr, in_loop, loop_ptr
        k = step_kind(st)
        if k == "if":
            yield from iter_steps(st.get("then"), ptr + "/then", in_loop, loop_ptr, depth + 1)
            yield from iter_steps(st.get("else"), ptr + "/else", in_loop, loop_ptr, depth + 1)
        elif k in ("foreach", "while"):
            yield from iter_steps(st.get("do"), ptr + "/do", True, ptr, depth + 1)
            if k == "while":
                yield from iter_steps(st.get("next"), ptr + "/next", True, ptr, depth + 1)
        elif k == "switch":
            cases = st.get("switch") if isinstance(st.get("switch"), list) else []
            for j, c in enumerate(cases):
                if isinstance(c, dict):
                    yield from iter_steps(c.get("steps"), f"{ptr}/switch/{j}/steps", in_loop, loop_ptr, depth + 1)
            yield from iter_steps(st.get("otherwise"), ptr + "/otherwise", in_loop, loop_ptr, depth + 1)


def step_expressions(st: dict):
    """(propriedade, texto) das expressões de um passo."""
    k = step_kind(st)
    if k == "assign" and isinstance(st.get("assign"), dict):
        for var, val in st["assign"].items():
            yield f"assign:{var}", str(val)
    if k in ("if", "while"):
        yield k, str(st.get(k) or "")
    if k == "get":
        w = st.get("where")
        for x in (w if isinstance(w, list) else [w] if w else []):
            yield "where", str(x)
        if st.get("statement"):
            yield "statement", str(st["statement"])
        for pname, p in (st.get("params") or {}).items():
            if isinstance(p, dict) and p.get("value") is not None:
                yield f"param:{pname}", str(p["value"])
    if k in ("call", "node") and isinstance(st.get("args"), dict):
        for a, v in st["args"].items():
            yield f"arg:{a}", str(v)
    if k == "node" and isinstance(st.get("properties"), dict):
        for a, v in st["properties"].items():
            if isinstance(v, str):
                yield f"prop:{a}", v
    if k in WRITE_STEPS and st.get("record"):
        yield "record", str(st["record"])
    if k == "raise" and st.get("message"):
        yield "message", str(st["message"])
    if k == "foreach":
        yield "foreach", str(st.get("foreach") or "")


def step_node(st: dict, calls_client) -> tuple[str, str]:
    k = step_kind(st)
    name = st.get("as") or ""
    if k == "get":
        return ("SQLNode" if st.get("sql") else "AggregateNode"), name
    if k == "assign":
        return "AssignNode", name
    if k == "call":
        return ("ExecuteClientActionNode" if calls_client(st.get("call")) else "ExecuteServerActionNode"), name
    if k in WRITE_STEPS:
        return "ExecuteServerActionNode", name or f"{k}{st.get(k)}"
    if k == "if":
        return "IfNode", st.get("label") or name or str(st.get("if"))
    if k == "while":
        return "IfNode", st.get("label") or name or str(st.get("while"))
    if k == "foreach":
        return "ForEachNode", name
    if k == "switch":
        return "SwitchNode", name
    if k == "node":
        return norm_kind(str(st.get("node"))), name
    if k == "raise":
        return "RaiseExceptionNode", str(st.get("raise"))
    return (k or "?"), name


class JobStage:
    def __init__(self, report: Report, config: dict, jobs: JobSet):
        self.r, self.cfg, self.jobs = report, config, jobs
        self.aliases: dict[str, dict] = {}
        self.actions: dict[str, LogicAction] = {}
        self.sets: list[JobOp] = []
        self.links: list[JobOp] = []
        self.spec_statics: set = set()
        p7 = self.cfg.get("p7") or {}
        self.p7_protected = NamePatterns(p7.get("protectedEntities"))
        self.p7_allowed = NamePatterns(p7.get("allowedEntities"))
        self.subjects = NamePatterns(self.cfg.get("subjectEntities"))

    # ---- auxiliares
    def alias_type(self, target: str) -> str | None:
        if not isinstance(target, str):
            return None
        base = target.split("/")[0]
        a = self.aliases.get(base)
        if a and "/" not in target:
            return a["type"]
        if ":" in target and not target.startswith("$") and "/" not in target:
            return target.split(":", 1)[0]
        return None

    def alias_path(self, alias, depth=0) -> list:
        """Caminho no formato do leitor (pares Kind, Nome) pela cadeia de `parent` dos creates."""
        a = self.aliases.get(alias)
        if a is None or depth > 12:
            if isinstance(alias, str) and ":" in alias and not alias.startswith(("$", "@")):
                k, n = alias.split(":", 1)
                return [(norm_kind(k), n)]
            return []
        parent = a.get("parent")
        base = []
        if isinstance(parent, str) and parent not in ("@espace",):
            base = self.alias_path(parent.split("/")[0], depth + 1)
        return base + [(a["type"], a.get("name") or "")]

    def alias_name(self, target: str) -> str:
        a = self.aliases.get(target)
        if a:
            return a.get("name") or target
        if isinstance(target, str) and ":" in target:
            return target.split(":", 1)[1]
        return str(target)

    def module_layer(self, name):
        return layer_of(self.cfg, name)

    def is_client_action(self, name) -> bool:
        a = self.actions.get(str(name))
        return bool(a and a.kind in ("client", "screen"))

    def calls_client(self, name) -> bool:
        return self.is_client_action(name)

    def is_list_action(self, name) -> bool:
        return str(name).startswith("List") and str(name) in (LIST_ACTIONS + ("ListAppend", "ListAppendAll", "ListClear",
                                                                            "ListInsert", "ListRemove", "ListDuplicate"))

    # ---- entrada
    def run(self):
        for jop in self.jobs.ops:
            op = jop.op
            kind = op.get("op")
            if kind == "create" and op.get("as"):
                self.aliases[op["as"]] = {"type": norm_kind(str(op.get("type"))), "name": op.get("name"), "op": jop,
                                          "parent": op.get("parent")}
            elif kind == "logic":
                for i, a in enumerate(((op.get("data") or {}).get("actions")) or []):
                    if isinstance(a, dict):
                        la = LogicAction(jop, i, a)
                        self.actions[la.name] = la
            elif kind == "set":
                self.sets.append(jop)
            elif kind == "link":
                self.links.append(jop)
            elif kind == "spec":
                self.spec_statics.update(s.get("name") for s in ((op.get("data") or {}).get("static") or []) if isinstance(s, dict))
        self.check_expected_messages()
        self.check_logic()
        self.check_verbs()
        self.check_html()
        self.check_spec()
        self.check_screen_ops()
        self.check_references()
        self.check_verb_graphs()

    # ---- N4: warnings aceitos por expectedMessages
    def check_expected_messages(self):
        for path, e in self.jobs.expected:
            if not isinstance(e, dict):
                continue
            pairs = parse_verify_path(e.get("element", ""))
            self.r.add("N4", SEV_ERR,
                       f"N4: warning {e.get('id')} declarado em expectedMessages em {e.get('element')}. A N4 conta todo "
                       f"warning do módulo, declarado ou não; só uma exceção aprovada o cobre.",
                       stage="job", path=pairs, job={"file": str(path), "pointer": "/expectedMessages"},
                       evidence=e.get("why"), suggestion="Corrigir a causa (usar ou apagar o elemento) em vez de declarar o warning.")

    # ---- op logic
    def set_description(self, jop: JobOp, alias: str):
        """Description gravada por `set <alvo> Description` depois da op, na MESMA parte (arquivo) do job. O alvo pode ser o
        alias da logic (`$<Action>.<as>`), o filho por nome (`$<Action>/<as>`) ou por tipo (`IServerAction:<Action>/<as>`)."""
        m = re.match(r"^\$([^.]+)\.(.+)$", alias)
        targets = {alias}
        if m:
            action, node = m.group(1), m.group(2)
            targets.add(f"${action}/{node}")
            pat = re.compile(rf"^I\w+:{re.escape(action)}/{re.escape(node)}$")
        else:
            pat = None
        for j in self.sets:
            t = str(j.op.get("target"))
            if j.file == jop.file and j.gidx > jop.gidx and j.op.get("prop") == "Description" and (t in targets or (pat and pat.match(t))):
                return j.op.get("value")
        return None

    def check_logic(self):
        cfg = self.cfg
        described_job = set(cfg.get("describedKinds", {}).get("job") or [])
        integration = cfg.get("integrationModules") or []
        integration_fields = (cfg.get("l6") or {}).get("integrationOnlyFields") or []
        for la in self.actions.values():
            a, jop = la.data, la.jop
            base_ptr = la.pointer
            apath = la.om_path()
            jref = jop.ref(base_ptr)
            # N1/N2 da action
            self.check_name_and_description("action", la.name, a.get("description"), apath, jop.ref(base_ptr),
                                            action_kind=la.kind)
            params = []
            for grp in ("inputs", "outputs", "vars"):
                for j, p in enumerate(a.get(grp) or []):
                    if not isinstance(p, dict):
                        continue
                    pk = {"inputs": "InputParameter", "outputs": "OutputParameter", "vars": "LocalVariable"}[grp]
                    ppath = apath + [(pk, p.get("name", ""))]
                    params.append((grp, p, ppath, jop.ref(f"{base_ptr}/{grp}/{j}")))
                    self.check_name_and_description(pk, p.get("name", ""), p.get("description"), ppath,
                                                    jop.ref(f"{base_ptr}/{grp}/{j}"), data_type=p.get("type"))
                    self.check_json_text(p.get("name", ""), p.get("type"), ppath, jop.ref(f"{base_ptr}/{grp}/{j}"))
            steps = a.get("steps") or []
            all_steps = list(iter_steps(steps, base_ptr + "/steps"))
            for h, hd in enumerate(a.get("handlers") or []):
                if isinstance(hd, dict):
                    all_steps += list(iter_steps(hd.get("steps"), f"{base_ptr}/handlers/{h}/steps"))
            # N3
            n_nodes = len(all_steps)
            limits = cfg.get("limits", {})
            if n_nodes > int(limits.get("commentAt", 12)) and not a.get("comments"):
                self.r.add("N3", SEV_ERR, f"N3: {la.name} tem {n_nodes} passos e nenhum comentário (`comments`).",
                           stage="job", path=apath, job=jref,
                           suggestion="Marcar cada bloco lógico com `comments:[{text}]` ou extrair partes para actions.")
            if n_nodes > int(limits.get("extractAt", 30)):
                f = self.r.add("N3", SEV_WARN, f"N3: {la.name} tem {n_nodes} passos; o fluxo provavelmente não cabe numa tela.",
                               stage="job", path=apath, job=jref, suggestion="Extrair blocos para actions com nome Verbo+Objeto.")
                if f:
                    self.r.ask(f["id"], "N3", REVIEW_QUESTIONS["N3"], [fmt_path(apath)])
            # E1
            vars_ = [p for p in (a.get("vars") or []) if isinstance(p, dict)]
            if len(vars_) > int(limits.get("maxLocals", 5)):
                f = self.r.add("E1", SEV_WARN, f"E1: {la.name} declara {len(vars_)} locais (limite {limits.get('maxLocals', 5)}).",
                               stage="job", path=apath, job=jref, suggestion="Calcular no ponto de uso; manter só as locais reutilizadas.")
                if f:
                    self.r.ask(f["id"], "E1", REVIEW_QUESTIONS["E1"], [fmt_path(apath)])
            for grp, p, ppath, pref in params:
                if grp != "vars":
                    continue
                t = str(p.get("type") or "")
                if not is_basic_type(t):
                    f = self.r.add("E1", SEV_WARN, f"E1: a local {p.get('name')} é {'lista' if t.endswith(' List') else 'record'} ({t}).",
                                   stage="job", path=ppath, job=pref, suggestion="Preferir locais escalares.")
                    if f:
                        self.r.ask(f["id"], "E1", REVIEW_QUESTIONS["E1"], [fmt_path(ppath)])
            # L2 / E3: escritas e leituras das locais
            self.check_locals(la, vars_, all_steps, apath, jop)
            # passos
            has_all_exceptions = any(isinstance(h, dict) and str(h.get("exception", "")).replace(" ", "").lower().endswith("allexceptions")
                                     for h in a.get("handlers") or [])
            for st, ptr, in_loop, loop_ptr in all_steps:
                k = step_kind(st)
                nkind, nname = step_node(st, self.calls_client)
                spath = apath + [(nkind, nname)]
                sref = jop.ref(ptr)
                # N1 labels
                if k in ("assign", "foreach") and not st.get("as"):
                    self.r.add("N1", SEV_ERR, f"N1: passo {k} sem `as` em {la.name}: o Studio mostra um Label gerado ({'Assign' if k == 'assign' else 'ForEach'}<n>).",
                               stage="job", path=spath, job=sref, suggestion="Dar `as` com a intenção (ex.: \"Apply default values\").")
                if st.get("as") and GENERIC_LABEL.match(str(st.get("as"))):
                    self.r.add("N1", SEV_ERR, f"N1: Label genérico '{st.get('as')}' em {la.name}.", stage="job", path=spath, job=sref,
                               suggestion="Usar um Label que diga a intenção ou a pergunta.")
                if k in ("if", "while"):
                    label = st.get("label") or st.get("as") or str(st.get(k))
                    if not str(label).strip().endswith("?"):
                        self.r.add("N1", SEV_ERR, f"N1: o If '{label}' em {la.name} não é uma pergunta (Label sem '?').",
                                   stage="job", path=spath, job=sref,
                                   suggestion="Dar `label` em forma de pergunta (ex.: \"Order load succeeded?\").")
                # L3
                if k == "assign" and isinstance(st.get("assign"), dict):
                    for var, val in st["assign"].items():
                        n = count_ifs(str(val))
                        if n > 1:
                            self.r.add("L3", SEV_ERR, f"L3: o valor atribuído a {var} tem {n} If() (máximo 1).", stage="job",
                                       path=spath, job=sref, evidence=str(val)[:200],
                                       suggestion="Usar um passo `if`/`switch` no fluxo ou uma action com nome claro.")
                        # P7: assign de switch Site.*
                        self.check_site_switch(var, spath, sref)
                # L5 / L6: nós nativos
                if k == "node":
                    node_t = str(st.get("node"))
                    if node_t == "IJavaScriptNode":
                        self.r.add("L5", SEV_ERR, f"L5: nó JavaScript em {la.name}.", stage="job", path=spath, job=sref,
                                   suggestion="Usar a forma nativa (Refresh, chave natural, IUpload); JavaScript só com exceção aprovada, isolado e nomeado.")
                    if node_t in ("IJSONSerializeNode", "IJSONDeserializeNode"):
                        self.r.add("L6", SEV_ERR, f"L6: nó {norm_kind(node_t)} em {la.name}.", stage="job", path=spath, job=sref,
                                   suggestion="Passar dados por structures e parâmetros tipados; JSON só na fronteira, com exceção aprovada do próprio elemento.")
                        props = st.get("properties") or {}
                        text = " ".join(str(v) for v in props.values())
                        for fld in integration_fields:
                            if fld in text and self.r.module not in integration:
                                self.r.add("L6", SEV_ERR, f"L6: nó JSON fora dos módulos de integração lê {fld} (config.l6.integrationOnlyFields).",
                                           stage="job", path=spath, job=sref)
                    if node_t == "IRefreshDataNode" and in_loop:
                        self.loop_finding(la, spath, sref, "Refresh Data", loop_ptr)
                    # N1: nós nativos com Description (JSON, JS, Excel, Trigger) levam properties.Description
                    if norm_kind(node_t) in described_job:
                        d = (st.get("properties") or {}).get("Description") or self.set_description(jop, f"${la.name}.{st.get('as')}")
                        if not (d or "").strip():
                            self.r.add("N1", SEV_ERR, f"N1: nó {norm_kind(node_t)} {st.get('as')} em {la.name} sem Description.", stage="job",
                                       path=spath, job=sref, suggestion="`properties.Description` no passo `node` (ou `set <alias> Description` depois da op).")
                        else:
                            check_description_quality(self.r, "job", st.get("as") or "", d, spath, sref, None)
                # D2 / D3
                if k == "get":
                    # N1: aggregate/SQL gerado pela logic só recebe Description por `set $<Action>.<as> Description` na mesma parte
                    galias = f"${la.name}.{st.get('as')}"
                    gkind = "SQLNode" if st.get("sql") else "AggregateNode"
                    d = self.set_description(jop, galias)
                    if gkind in described_job and not (d or "").strip():
                        self.r.add("N1", SEV_ERR, f"N1: {gkind} {st.get('as')} em {la.name} sem Description.", stage="job", path=spath, job=sref,
                                   suggestion=f"Acrescentar, na mesma parte e depois da op logic, `{{\"op\":\"set\",\"target\":\"{galias}\",\"prop\":\"Description\",\"value\":\"...\"}}`.")
                    elif d:
                        check_description_quality(self.r, "job", st.get("as") or "", d, spath, sref, None)
                    if st.get("max") in (None, ""):
                        self.r.add("D2", SEV_ERR, f"D2: `get` {st.get('as')} sem `max` (Max Records) em {la.name}.",
                                   stage="job", path=spath, job=sref, suggestion="Definir `max` (e `start` para paginar) no próprio aggregate.")
                    if st.get("sql"):
                        stmt = str(st.get("statement") or "")
                        self.r.add("D3", SEV_ERR, f"D3: o nó SQL {st.get('as')} em {la.name} precisa de exceção aprovada que diga por que o aggregate não resolve.",
                                   stage="job", path=spath, job=sref, evidence=stmt[:160],
                                   suggestion="Usar aggregate; se o aggregate não resolver, registrar o nó numa exceção com o motivo.")
                        self.r.ask("D3-" + (st.get("as") or ptr), "D3", REVIEW_QUESTIONS["D3"], [fmt_path(spath)])
                        if re.search(r"(?i)\bsp_executesql\b|\bEXEC(UTE)?\s*\(", stmt):
                            self.r.add("D3", SEV_ERR, "D3: SQL dinâmico (sp_executesql/EXEC()) é proibido.", stage="job",
                                       path=spath, job=sref, evidence=stmt[:160])
                        self.check_p7_sql(la, stmt, spath, sref)
                # D5 / T3
                if in_loop and k in ("get", "call") + WRITE_STEPS:
                    local_call = k == "call" and (self.is_list_action(st.get("call")) or not self.reaches_server(st.get("call")))
                    if not local_call:
                        what = {"get": "aggregate/SQL", "call": f"chamada a {st.get('call')}"}.get(k, f"{k} de {st.get(k)}")
                        self.loop_finding(la, spath, sref, what, loop_ptr)
                # T1 / T2 / T4 / D2 list
                if k == "call":
                    callee = str(st.get("call"))
                    args = st.get("args") or {}
                    if callee in LIST_ACTIONS:
                        cond = args.get("Condition") or args.get("By") or args.get("Element") or ""
                        self.r.runtime_test(la.name, st.get("as"), callee, cond, stage="job", path=fmt_path(spath))
                        if callee in ("ListFilter", "ListSort") and la.kind in ("client", "screen"):
                            lst = str(args.get("List") or "")
                            if re.search(r"\.List\b", lst) or lst.split(".")[0] in self.data_sources():
                                self.r.add("D2", SEV_ERR, f"D2: {callee} no cliente sobre {lst}: filtrar e ordenar no aggregate ou na Data Action.",
                                           stage="job", path=spath, job=sref)
                    if callee == "ListAppend" and in_loop and ".Current." in str(args.get("Element", "")):
                        f = self.r.add("T2", SEV_WARN, f"T2: ListAppend de {args.get('Element')} dentro de ForEach em {la.name}.",
                                       stage="job", path=spath, job=sref, suggestion="Tipar na origem (output da Data Action ou do aggregate já no tipo de destino).")
                        if f:
                            self.r.ask(f["id"], "T2", REVIEW_QUESTIONS["T2"], [fmt_path(spath)])
                    # AR3
                    if la.kind in ("client", "screen", "data"):
                        target = self.reaches_long_running(callee)
                        if target and callee not in (cfg.get("asyncStarters") or []):
                            self.r.add("AR3", SEV_ERR, f"AR3: a {la.kind} action {la.name} chega a {target} (processo longo ou REST) numa screen request.",
                                       stage="job", path=spath, job=sref,
                                       suggestion="Iniciar por um starter assíncrono (config.asyncStarters) e deixar um Timer ou BPT executar.")
                    # AR2: GetUserId() vindo do cliente
                    if la.kind in ("client", "screen") and not self.is_client_action(callee):
                        for an, av in args.items():
                            if "GetUserId()" in strip_strings(str(av)):
                                self.r.add("AR2", SEV_ERR, f"AR2: {la.name} passa GetUserId() do cliente para {callee}.{an}.",
                                           stage="job", path=spath, job=sref,
                                           suggestion="Ler GetUserId() no servidor; nunca confiar no usuário enviado pelo cliente.")
                if k == "foreach":
                    self.classify_foreach(la, st, spath, sref)
                # L7
                for prop, expr in step_expressions(st):
                    self.check_literals(expr, prop, spath, sref)
                # P7
                self.check_p7_step(la, st, spath, sref)
            # AR2 por action. Fachada pública que só repassa ao próprio <Nome>_Impl herda a verificação do _Impl.
            exposed = la.kind in ("service", "data") or (la.kind == "server" and a.get("public"))
            impl_name = self.facade_impl(la) if exposed else None
            if impl_name:
                impl = self.actions.get(impl_name)
                if impl is None:
                    self.r.notes.append(f"AR2: a fachada {la.name} repassa a {impl_name}, que não está neste job; o estágio oml verifica o _Impl.")
                else:
                    self.check_guarded(impl, f"implementação da fachada {la.name}")
                if has_all_exceptions and (impl is None or any(self.is_guard(st) for st, *_ in iter_steps(impl.data.get("steps"), ""))):
                    self.r.add("AR2", SEV_ERR, f"AR2: a fachada {la.name} tem handler AllExceptions e engole a exceção da guarda de {impl_name}.",
                               stage="job", path=apath + [("ExceptionHandlerNode", "AllExceptions")], job=jref,
                               suggestion="A fachada só repassa; tratar só exceções específicas, fora do alcance da guarda.")
            elif exposed:
                self.check_guarded(la, None)
            elif la.name.endswith("_Impl") and la.name[: -len("_Impl")] not in self.actions:
                # parte que só implementa o _Impl (a fachada está em outro job): a guarda tem de estar aqui
                self.check_guarded(la, f"implementação da fachada {la.name[: -len('_Impl')]}")
            if has_all_exceptions and any(self.is_guard(st) for st, *_ in all_steps):
                self.r.add("AR2", SEV_ERR, f"AR2: {la.name} tem handler AllExceptions que captura a exceção da guarda de role.",
                           stage="job", path=apath + [("ExceptionHandlerNode", "AllExceptions")], job=jref,
                           suggestion="Tratar só exceções específicas, ou mover a guarda para uma action que não esteja sob AllExceptions.")
            # S2 em client/screen
            if la.kind in ("client", "screen"):
                n, unknown = self.max_server_calls(steps, set())
                if n > 1:
                    sev = SEV_ERR if not unknown else SEV_WARN
                    f = self.r.add("S2", sev, f"S2: {la.name} faz até {n} chamadas ao servidor no mesmo caminho"
                                   + (" (inclui chamadas a actions fora do job, contadas como servidor)" if unknown else "") + ".",
                                   stage="job", path=apath, job=jref,
                                   suggestion="Uma server action orquestradora, chamada uma vez (um round-trip, uma transação).")
                    if f and sev == SEV_WARN:
                        self.r.ask(f["id"], "S2", "As chamadas contadas vão mesmo ao servidor?", [fmt_path(apath)])

    def data_sources(self):
        out = set()
        for la in self.actions.values():
            if la.kind == "data":
                out.add(la.name)
        for a in self.aliases.values():
            if a["type"] in ("DataAction", "ScreenAggregate"):
                out.add(a.get("name"))
        return out

    def facade_impl(self, la) -> str | None:
        """Fachada = só UMA chamada ao próprio <Nome>_Impl, mais assigns que copiam as saídas dele; nada mais."""
        impl = f"{la.name}_Impl"
        steps = [st for st, *_ in iter_steps(la.data.get("steps"), "")]
        calls = [st for st in steps if step_kind(st) == "call"]
        if len(calls) != 1 or str(calls[0].get("call")) != impl:
            return None
        alias = str(calls[0].get("as") or "")
        for st in steps:
            k = step_kind(st)
            if k == "call":
                continue
            if k != "assign" or not isinstance(st.get("assign"), dict):
                return None
            for val in st["assign"].values():
                if not re.fullmatch(rf"\s*{re.escape(alias)}\.[\w.]+\s*", strip_strings(str(val))):
                    return None
        return impl

    def is_subject_read(self, st):
        k = step_kind(st)
        if k == "get":
            if st.get("sql"):
                return any(self.subjects.match(e) for e in re.findall(r"\{(\w+)\}", str(st.get("statement") or "")))
            ents = [str(st.get("get"))] + [str(s) for s in (st.get("sources") or []) if isinstance(s, str)]
            return any(self.subjects.match(e) for e in ents)
        if k == "call":
            m = re.match(r"^Get(?:ForUpdate)?(\w+)$", str(st.get("call")))
            return bool(m and self.subjects.match(m.group(1)))
        return False

    def check_guarded(self, la, context):
        """AR2: a guarda (role, lease, token, Require*) vem antes da primeira leitura de dado do sujeito ou escrita."""
        guard_seen = False
        for st, ptr, *_ in iter_steps(la.data.get("steps"), la.pointer + "/steps"):
            if not guard_seen and self.is_guard(st):
                guard_seen = True
            sensitive = self.is_write(st) or self.is_subject_read(st)
            if sensitive and not guard_seen:
                nkind, nname = step_node(st, self.calls_client)
                what = "grava" if self.is_write(st) else "lê dado do sujeito"
                ctx = f" ({context})" if context else f" ({la.kind}{', pública' if la.data.get('public') else ''})"
                self.r.add("AR2", SEV_ERR, f"AR2: {la.name}{ctx} {what} ({nname or nkind}) sem guarda dominante antes.",
                           stage="job", path=la.om_path() + [(nkind, nname)], job=la.jop.ref(ptr),
                           suggestion="No início: Require*, CheckRole, lease, token ou if GetUserId()=NullIdentifier() -> raise; e checar o acesso ao registro.")
                return False
        return True

    def is_write(self, st):
        k = step_kind(st)
        if k in WRITE_STEPS:
            return True
        if k == "call":
            c = str(st.get("call"))
            return bool(re.match(r"^(CreateOrUpdate|Create|Update|Delete)[A-Z]", c) or c.endswith("_Impl"))
        if k == "get" and st.get("sql"):
            return bool(re.search(r"(?i)\b(insert|update|delete|merge)\b", strip_strings(str(st.get("statement")))))
        return False

    def is_guard(self, st):
        k = step_kind(st)
        guards = self.cfg.get("guardActions") or []
        if k == "call" and any(fnmatch.fnmatchcase(str(st.get("call")), g) for g in guards):
            return True
        if k == "if":
            cond = strip_strings(str(st.get("if")))
            if re.search(r"Check\w*Role\s*\(|GetUserId\(\)\s*=\s*NullIdentifier\(\)", cond):
                branch = (st.get("then") or []) + (st.get("else") or [])
                return any(isinstance(b, dict) and step_kind(b) == "raise" for b in branch)
        return False

    def reaches_server(self, name, seen=None) -> bool:
        """True se a action chamada vai ao servidor (desconhecida conta como servidor)."""
        la = self.actions.get(str(name))
        if la is None:
            return not self.is_list_action(name)
        if la.kind not in ("client", "screen"):
            return True
        seen = seen or set()
        if la.name in seen:
            return False
        seen.add(la.name)
        for st, *_ in iter_steps(la.data.get("steps"), ""):
            k = step_kind(st)
            if k in WRITE_STEPS or k == "get":
                return True
            if k == "node" and st.get("node") == "IRefreshDataNode":
                return True
            if k == "call" and self.reaches_server(st.get("call"), seen):
                return True
        return False

    def reaches_long_running(self, name, seen=None):
        long_running = set(self.cfg.get("longRunning") or [])
        if str(name) in long_running:
            return str(name)
        la = self.actions.get(str(name))
        if la is None:
            return None
        seen = seen or set()
        if la.name in seen:
            return None
        seen.add(la.name)
        for st, *_ in iter_steps(la.data.get("steps"), ""):
            if step_kind(st) == "call":
                t = self.reaches_long_running(st.get("call"), seen)
                if t:
                    return t
        return None

    def max_server_calls(self, steps, seen) -> tuple[int, bool]:
        total, unknown = 0, False
        for st in steps or []:
            if not isinstance(st, dict):
                continue
            k = step_kind(st)
            if k in WRITE_STEPS:
                total += 1
            elif k == "node" and st.get("node") == "IRefreshDataNode":
                total += 1
            elif k == "call":
                c = str(st.get("call"))
                la = self.actions.get(c)
                if self.is_list_action(c):
                    pass
                elif la is None:
                    total += 1
                    unknown = True
                elif la.kind in ("client", "screen"):
                    if c not in seen:
                        n, u = self.max_server_calls(la.data.get("steps"), seen | {c})
                        total += n
                        unknown = unknown or u
                else:
                    total += 1
            elif k == "if":
                a, ua = self.max_server_calls(st.get("then"), seen)
                b, ub = self.max_server_calls(st.get("else"), seen)
                total += max(a, b)
                unknown = unknown or ua or ub
            elif k == "switch":
                best, u = 0, False
                for c in st.get("switch") if isinstance(st.get("switch"), list) else []:
                    if isinstance(c, dict):
                        n, uu = self.max_server_calls(c.get("steps"), seen)
                        best, u = max(best, n), u or uu
                n, uu = self.max_server_calls(st.get("otherwise"), seen)
                total += max(best, n)
                unknown = unknown or u or uu
            elif k in ("foreach", "while"):
                n, u = self.max_server_calls(st.get("do"), seen)
                total += n
                unknown = unknown or u
            elif k == "raise":
                break
        return total, unknown

    def loop_finding(self, la, spath, sref, what, loop_ptr):
        self.r.add("D5", SEV_ERR, f"D5/T3: {what} dentro de laço (foreach/while) em {la.name}: N+1 idas ao servidor ou ao banco.",
                   stage="job", path=spath, job=sref, related="T3", evidence=f"laço em {loop_ptr}",
                   suggestion="Agregar no próprio aggregate (columns Count/Sum), ler em lote antes do laço ou fazer uma única chamada orquestradora.")

    def classify_foreach(self, la, st, spath, sref):
        body = [b for b, *_ in iter_steps(st.get("do"), "")]
        kinds = [step_kind(b) for b in body]
        sugest = None
        has_if = "if" in kinds
        appends = [b for b in body if step_kind(b) == "call" and str(b.get("call")) == "ListAppend"]
        bool_assign = any(step_kind(b) == "assign" and any(str(v).strip() in ("True", "False") for v in (b.get("assign") or {}).values()) for b in body)
        if has_if and appends:
            sugest = "ListFilter"
        elif has_if and bool_assign:
            sugest = "ListAny/ListAll"
        elif has_if and any(step_kind(b) == "assign" and any("CurrentRowNumber" in str(v) for v in (b.get("assign") or {}).values()) for b in body):
            sugest = "ListIndexOf"
        elif appends and len(body) == len(appends):
            el = str(appends[0].get("args", {}).get("Element", ""))
            sugest = "ListAppendAll" if el.endswith(".Current") else "mapping/tipar na origem (T2)"
        if sugest:
            f = self.r.add("T1", SEV_WARN, f"T1: o ForEach {st.get('as') or ''} em {la.name} parece substituível por {sugest}.",
                           stage="job", path=spath, job=sref, suggestion=f"Usar {sugest}; ForEach só com efeito por item.")
            if f:
                self.r.ask(f["id"], "T1", REVIEW_QUESTIONS["T1"], [fmt_path(spath)])

    def check_locals(self, la, vars_, all_steps, apath, jop):
        texts = []
        writes: dict[str, int] = {}
        for st, *_ in all_steps:
            k = step_kind(st)
            if k == "assign" and isinstance(st.get("assign"), dict):
                for var in st["assign"]:
                    root = str(var).split(".")[0]
                    writes[root] = writes.get(root, 0) + 1
            if k == "call" and str(st.get("call")) == "ListAppend":
                root = str((st.get("args") or {}).get("List", "")).split(".")[0]
                if root:
                    writes[root] = writes.get(root, 0) + 1
            for prop, expr in step_expressions(st):
                texts.append(strip_strings(expr))
        blob = "\n".join(texts)
        for j, v in enumerate(vars_):
            name = v.get("name", "")
            if not name:
                continue
            reads = len(re.findall(rf"(?<![\w.]){re.escape(name)}\b", blob))
            w = writes.get(name, 0)
            vpath = apath + [("LocalVariable", name)]
            vref = jop.ref(f"{la.pointer}/vars/{j}")
            if w == 1 and reads <= 2:
                f = self.r.add("L2", SEV_WARN, f"L2: a local {name} em {la.name} é escrita uma vez e pouco lida; talvez a expressão possa ir direto ao ponto de uso.",
                               stage="job", path=vpath, job=vref, suggestion="Pôr a expressão no ponto de uso, salvo reutilização ou legibilidade.")
                if f:
                    self.r.ask(f["id"], "L2", REVIEW_QUESTIONS["L2"], [fmt_path(vpath)])
            default = v.get("default")
            if default not in (None, ""):
                trivial = str(default).strip() in TRIVIAL_DEFAULTS
                if not trivial and w == 0:
                    self.r.add("E3", SEV_ERR, f"E3: a local {name} tem default literal {default} e nunca é atribuída: funciona como constante.",
                               stage="job", path=vpath, job=vref, suggestion="Configuração vai em Site Property; domínio vai em Static Entity.")
                elif not trivial:
                    f = self.r.add("E3", SEV_WARN, f"E3: a local {name} tem default literal {default}.", stage="job", path=vpath, job=vref,
                                   suggestion="Confirmar que não é configuração.")
                    if f:
                        self.r.ask(f["id"], "E3", "Este default é configuração?", [fmt_path(vpath)])

    # ---- nomes e descrições
    def check_name_and_description(self, kind, name, description, path, jref, action_kind=None, data_type=None,
                                   generated_by=None, require_description=True):
        cfg = self.cfg
        if require_description and not (description or "").strip():
            self.r.add("N1", SEV_ERR, f"N1: {kind} {name} sem descrição.", stage="job", path=path, job=jref, generated_by=generated_by,
                       suggestion="Descrição curta que explique o porquê (N2).")
        elif description:
            check_description_quality(self.r, "job", name, description, path, jref, generated_by)
        if kind == "action":
            check_action_verb(self.r, cfg, "job", name, path, jref, action_kind)
        if data_type and str(data_type).strip().lower() == "boolean":
            check_boolean_prefix(self.r, cfg, "job", name, path, jref)

    def check_json_text(self, name, data_type, path, jref):
        if data_type and str(data_type).strip().lower() == "text" and re.search(r"(?i)json$", name or ""):
            self.r.add("L6", SEV_ERR, f"L6: {name} é Text com nome *Json: JSON dentro do app.", stage="job", path=path, job=jref,
                       suggestion="Usar structure ou lista tipada; JSON só com exceção aprovada do próprio elemento.")

    def check_site_switch(self, var, spath, sref):
        sw = (self.cfg.get("p7") or {}).get("siteSwitches") or []
        m = re.match(r"^\s*Site\.(\w+)\s*$", str(var))
        if m and m.group(1) in sw:
            self.r.add("P7", SEV_ERR, f"P7: assign da site property de switch Site.{m.group(1)} (config.p7.siteSwitches). É proibido e não aceita exceção.",
                       stage="job", path=spath, job=sref, suggestion="Switches só mudam pela mão de uma pessoa, no console da plataforma (Service Center no O11).")

    def p7_entry(self, name) -> bool:
        pats = (self.cfg.get("p7") or {}).get("entryPatterns") or []
        return any(re.search(p, name or "") for p in pats)

    def p7_scope(self):
        """Fecho transitivo, dentro do job, das actions alcançáveis a partir dos pontos de entrada (config.p7.entryPatterns)."""
        if hasattr(self, "_p7"):
            return self._p7
        scope = {}
        pending = [(n, n) for n in self.actions if self.p7_entry(n)]
        while pending:
            n, root = pending.pop()
            if n in scope:
                continue
            scope[n] = root
            la = self.actions.get(n)
            if not la:
                continue
            for st, *_ in iter_steps(la.data.get("steps"), ""):
                if step_kind(st) == "call" and str(st.get("call")) in self.actions:
                    pending.append((str(st.get("call")), root))
        self._p7 = scope
        return scope

    def p7_is_protected(self, entity) -> bool:
        return self.p7_protected.match(entity) and not self.p7_allowed.match(entity)

    def check_p7_step(self, la, st, spath, sref):
        if not self.p7_protected:
            return                              # P7 desligada: config.p7.protectedEntities vazia
        scope = self.p7_scope()
        if la.name not in scope:
            return
        cfg = self.cfg.get("p7") or {}
        k = step_kind(st)
        target = None
        if k in WRITE_STEPS:
            ent = str(st.get(k))
            if self.p7_is_protected(ent):
                target = f"{k} {ent}"
        elif k == "call":
            c = str(st.get("call"))
            m = re.match(r"^(CreateOrUpdate|Create|Update|Delete)(\w+)$", c)
            if m and self.p7_is_protected(m.group(2)):
                target = f"entity action {c}"
            if any(re.search(p, c) for p in cfg.get("forbiddenCalls") or []):
                target = f"chamada a {c} (action reservada a decisão humana)"
        if target:
            self.r.add("P7", SEV_ERR, f"P7: {target} a partir de {la.name} (alcançado por {scope[la.name]}). Pontos de entrada automáticos "
                       f"(config.p7.entryPatterns) não gravam entidades protegidas (config.p7.protectedEntities).",
                       stage="job", path=spath, job=sref,
                       suggestion="O ponto de entrada automático grava só em entidades de rascunho; a decisão e a gravação final ficam com uma pessoa.")

    def check_p7_sql(self, la, stmt, spath, sref):
        if not self.p7_protected:
            return
        scope = self.p7_scope()
        if la.name not in scope:
            return
        s = strip_strings(stmt)
        for m in re.finditer(r"(?i)\b(insert\s+into|update|delete\s+from|merge\s+into)\s+\{(\w+)\}", s):
            if self.p7_is_protected(m.group(2)):
                self.r.add("P7", SEV_ERR, f"P7: DML em {{{m.group(2)}}} a partir de {la.name} (ponto de entrada automático).", stage="job",
                           path=spath, job=sref)

    def check_literals(self, expr, prop, path, jref, owner_type=None, owner_alias=None):
        cfg = self.cfg
        if not expr:
            return
        allow_prop = owner_type and f"{owner_type}.{prop}" in (cfg.get("literalAllowProps") or [])
        if allow_prop:
            return                       # o lugar que a regra manda (ex.: ISiteProperty.DefaultValue)
        for lit in string_literals(expr):
            if URL_RE.search(lit) or EMAIL_RE.search(lit) or HOST_RE.match(lit.strip()):
                if not allow_prop:
                    self.r.add("L7", SEV_ERR, f"L7: literal de URL, host ou e-mail \"{lit[:80]}\" em {prop}.", stage="job",
                               path=path, job=jref, suggestion="Configuração vai em Site Property (DefaultValue) ou em dado.")
        bare = strip_strings(expr)
        if re.search(r'(=|<>)\s*"[^"]+"|"[^"]+"\s*(=|<>)', expr):
            f = self.r.add("L7", SEV_WARN, f"L7: literal de texto comparado com = ou <> em {prop}: {expr[:120]}", stage="job",
                           path=path, job=jref, suggestion="Usar Static Entity para domínios fixos.")
            if f:
                self.r.ask(f["id"], "L7", REVIEW_QUESTIONS["L7"], [fmt_path(path)])
        prop_base = prop.split(":")[-1]
        if prop_base in (cfg.get("numericAllowProps") or []) or prop.split(":")[0] in (cfg.get("numericAllowProps") or []) \
                or prop == "statement":         # SQL: tamanhos e estilos de CONVERT não são configuração
            return
        nums = [n for n in re.findall(r"(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])", bare) if n not in ("0", "1")]
        if nums:
            f = self.r.add("L7", SEV_WARN, f"L7: número literal {', '.join(sorted(set(nums))[:5])} em {prop}: {expr[:120]}",
                           stage="job", path=path, job=jref, suggestion="Mover para Site Property, Static Entity ou dado.")
            if f:
                self.r.ask(f["id"], "L7", REVIEW_QUESTIONS["L7"], [fmt_path(path)])

    # ---- verbos crus
    def check_verbs(self):
        cfg = self.cfg
        described = set(cfg.get("describedKinds", {}).get("job") or [])
        ignore = set(cfg.get("describedIgnoreNames") or [])
        integration = cfg.get("integrationModules") or []
        policy = cfg.get("timeoutPolicy") or {}
        desc_set, label_set, maxrec_set = {}, {}, set()
        roles_linked = set()
        is_secret, default_value = set(), {}
        expose_ro, public_true = set(), set()
        for jop in self.jobs.ops:
            op = jop.op
            if op.get("op") == "set":
                t, prop, val = op.get("target"), op.get("prop"), op.get("value")
                if prop == "Description":
                    desc_set[t] = val
                if prop == "Label":
                    label_set[t] = val
                if prop == "MaxRecords":
                    maxrec_set.add(t)
                if prop == "IsSecret" and val in (True, "True", "true"):
                    is_secret.add(t)
                if prop == "DefaultValue":
                    default_value[t] = val
                if prop == "ExposeReadOnly" and val in (True, "True", "true"):
                    expose_ro.add(t)
                if prop == "Public" and val in (True, "True", "true"):
                    public_true.add(t)
            if op.get("op") == "link" and op.get("connector") == "Roles":
                roles_linked.add(op.get("from"))
        for jop in self.jobs.ops:
            op = jop.op
            kind = op.get("op")
            if kind == "create":
                t = norm_kind(str(op.get("type")))
                alias = op.get("as")
                name = op.get("name") or alias or ""
                path = self.alias_path(alias) if alias in self.aliases else [(t, name)]
                ref = jop.ref()
                if t in described and name not in ignore:
                    d = desc_set.get(alias) if alias else None
                    if not (d or "").strip():
                        self.r.add("N1", SEV_ERR, f"N1: {t} {name} criado sem `set Description`.", stage="job", path=path, job=ref,
                                   suggestion="Acrescentar `set Description` com o porquê (N2).")
                    else:
                        check_description_quality(self.r, "job", name, d, path, ref, None)
                if t in ("ServerAction", "ClientAction", "ServiceAction", "ScreenAction", "DataAction"):
                    check_action_verb(self.r, cfg, "job", name, path, ref, t)
                if t in ("IfNode",):
                    lab = label_set.get(alias)
                    if not lab or not str(lab).strip().endswith("?"):
                        self.r.add("N1", SEV_ERR, f"N1: o If {lab or '(sem Label)'} não é uma pergunta.", stage="job", path=[(t, lab or name)], job=ref,
                                   suggestion="`set Label` em forma de pergunta.")
                if t in ("AssignNode", "ForEachNode"):
                    lab = label_set.get(alias)
                    if not lab or GENERIC_LABEL.match(str(lab)):
                        self.r.add("N1", SEV_ERR, f"N1: {t} sem Label significativo ({lab or 'vazio'}).", stage="job", path=[(t, lab or name)], job=ref,
                                   suggestion="`set Label` com a intenção.")
                if t in ("AggregateNode", "ScreenAggregate") and alias not in maxrec_set:
                    self.r.add("D2", SEV_ERR, f"D2: {t} {name} sem `set MaxRecords`.", stage="job", path=path, job=ref,
                               suggestion="Definir Max Records no aggregate.")
                if t == "JavaScriptNode" or t == "Script":
                    self.r.add("L5", SEV_ERR, f"L5: create {t} {name}.", stage="job", path=path, job=ref,
                               suggestion="Sem JavaScript: usar a forma nativa; JavaScript só com exceção aprovada, isolado e nomeado.")
                if t in ("JSONSerializeNode", "JSONDeserializeNode"):
                    self.r.add("L6", SEV_ERR, f"L6: create {t} {name}.", stage="job", path=path, job=ref,
                               suggestion="Structures e parâmetros tipados.")
                if t == "ClientVariable":
                    self.r.add("E2", SEV_ERR, f"E2: client variable {name}: toda client variable exige exceção aprovada.", stage="job",
                               path=path, job=ref, suggestion="Estado por input da tela ou dado no servidor.")
                    if re.search(cfg.get("sensitivePattern") or r"(?!)", name):
                        self.r.add("E2", SEV_ERR, f"E2: client variable {name} com nome sensível.", stage="job", path=path, job=ref)
                if t in ("RestAPI", "RestClient", "RestAction", "RestAPIMethod") and integration and self.r.module \
                        and self.r.module not in integration:
                    self.r.add("S3", SEV_ERR, f"S3/D4: REST ({t} {name}) fora dos módulos de integração (config.integrationModules).",
                               stage="job", path=path, job=ref, related="D4",
                               suggestion="REST só nos módulos de config.integrationModules, atrás de uma server action wrapper.")
                if t in ("RestAction", "RestAPIMethod"):
                    tv = [j.op.get("value") for j in self.sets if j.op.get("target") == alias and j.op.get("prop") == "TimeoutinSeconds"]
                    problem = timeout_problem(tv[-1] if tv else None, policy)
                    if problem:
                        self.r.add("S4", SEV_ERR, f"S4: {name} {problem}.", stage="job", path=path, job=ref,
                                   suggestion="`set TimeoutinSeconds <s>` pensado para a API real e abaixo do timeout de quem chama (config.timeoutPolicy).")
                if t in ("ServerEntity", "StaticEntity"):
                    layer = layer_of(cfg, self.r.module)
                    if self.r.module and layer and layer != "Core":
                        self.r.add("AR1", SEV_ERR, f"AR1: {t} {name} no módulo {self.r.module} ({layer}); entidades ficam no Core.",
                                   stage="job", path=path, job=ref)
                    if t == "ServerEntity" and alias in public_true and alias not in expose_ro:
                        self.r.add("AR1", SEV_ERR, f"AR1: entidade pública {name} sem ExposeReadOnly.", stage="job", path=path, job=ref,
                                   suggestion="`set ExposeReadOnly true`; a escrita passa só por actions.")
                if t == "SiteProperty" and alias not in is_secret and re.search(r"(?i)(api)?key$|secret|token|password", name):
                    self.r.add("S3", SEV_ERR, f"S3/E3: a site property {name} parece segredo e não recebe `set IsSecret true`.", stage="job",
                               path=path, job=ref, related="E3", suggestion="Marcar IsSecret, sem DefaultValue.")
                if t == "SiteProperty" and alias in is_secret and default_value.get(alias) not in (None, "", '""'):
                    self.r.add("L7", SEV_ERR, f"L7/S3: site property secreta {name} com DefaultValue.", stage="job", path=path, job=ref,
                               related="S3", suggestion="Segredo sem default; o valor fica só no console da plataforma.")
                if t in ("MobileScreen",) and alias not in roles_linked:
                    self.r.add("AR2", SEV_ERR, f"AR2: tela {name} sem Roles (`link ... connector Roles`).", stage="job", path=path, job=ref,
                               suggestion="Ligar as roles da tela; e revalidar no servidor.")
            elif kind == "set":
                t, prop, val = op.get("target"), op.get("prop"), op.get("value")
                ot = self.alias_type(t) or ""
                ref = jop.ref()
                if t in self.aliases:
                    path = self.alias_path(t)
                elif isinstance(t, str) and "/" in t and t.split("/")[0] in self.aliases:
                    path = self.alias_path(t.split("/")[0]) + [("Argument", t.split("/", 1)[1])]
                else:
                    path = [(ot or "?", self.alias_name(t))]
                if prop == "Visible":
                    self.r.add("U1", SEV_ERR, f"U1: `set {t} Visible` = {val}.", stage="job", path=path, job=ref,
                               suggestion="Usar IIfWidget (`<div if>` ou verbo) em vez da propriedade Visible.")
                if prop in ("JavaScript",):
                    self.r.add("L5", SEV_ERR, f"L5: `set {t} JavaScript`.", stage="job", path=path, job=ref)
                if prop == "StyleSheet" and ot in ("MobileScreen", "MobileBlock", "WebScreen", "WebBlock", "") and val:
                    self.r.add("U4", SEV_ERR, f"U4: `set {t} StyleSheet` em tela ou bloco.", stage="job", path=path, job=ref,
                               suggestion="CSS no tema ou na library; classes utilitárias do OutSystems UI.")
                if prop == "CustomStyle" and val:
                    f = self.r.add("U4", SEV_WARN, f"U4: CustomStyle em {t}.", stage="job", path=path, job=ref)
                    if f:
                        self.r.ask(f["id"], "U4", "O CustomStyle pode virar classe do tema?", [fmt_path(path)])
                if prop == "Property" and str(val).strip('"').lower() in ("style", "hidden"):
                    rule = "U4" if "style" in str(val).lower() else "U1"
                    self.r.add(rule, SEV_ERR, f"{rule}: ExtendedProperty '{val}' em {t}.", stage="job", path=path, job=ref)
                if prop == "Value" and ot == "Assignment":
                    n = count_ifs(str(val))
                    if n > 1:
                        self.r.add("L3", SEV_ERR, f"L3: `set {t} Value` com {n} If().", stage="job", path=path, job=ref, evidence=str(val)[:200])
                if prop == "Variable" and ot == "Assignment":
                    self.check_site_switch(val, path, ref)
                if prop == "Destination" and isinstance(t, str):
                    m = re.match(r"^(.*)/(" + "|".join(LIFECYCLE) + r")$", t)
                    if m:
                        self.check_lifecycle(m.group(1), m.group(2), val, jop)
                if prop == "ExpandInline" and val in (True, "True", "true"):
                    self.check_expand_inline(t, jop)
                base_alias = t.split("/")[0] if isinstance(t, str) else t
                in_static = (self.aliases.get(base_alias, {}).get("type") in ("Record", "StaticEntityRecord", "StaticEntity")
                             or self.aliases.get(str(self.aliases.get(base_alias, {}).get("parent")), {}).get("type") == "StaticEntity")
                in_static = in_static or any(str(base_alias).startswith(f"${s}.") for s in self.spec_statics)
                if in_static:
                    pass                        # L7: valores de record de Static Entity são domínio fixo, o lugar que a regra manda
                elif prop in ("Value", "Condition", "DefaultValue", "Source", "Filter") and isinstance(val, str):
                    otype = ot or ""
                    self.check_literals(val, prop, path, ref, owner_type=f"I{otype}" if otype else None)
                elif isinstance(val, str) and prop not in ("Description", "Label", "Name", "JavaScript", "Statement", "Text") \
                        and (URL_RE.search(val) or EMAIL_RE.search(val)) \
                        and f"I{ot}.{prop}" not in (self.cfg.get("literalAllowProps") or []):
                    self.r.add("L7", SEV_ERR, f"L7: valor fixo de URL ou e-mail em `set {t} {prop}` = {val[:80]}.", stage="job", path=path, job=ref,
                               suggestion="Configuração em Site Property ou dado; valor fixo de REST só com exceção aprovada.")

    def check_lifecycle(self, owner, event, dest, jop):
        ref = jop.ref()
        otype = self.alias_type(owner) or "MobileScreen"
        oname = self.alias_name(owner)
        path = [(otype, oname), ("UILifeCycleEvent", event)]
        if event == "OnDestroy":
            f = self.r.add("S1", SEV_WARN, f"S1: handler de OnDestroy ligado em {oname} ({dest}).", stage="job", path=path, job=ref,
                           suggestion="Evitar lógica no OnDestroy.")
            if f:
                self.r.ask(f["id"], "S1", "O OnDestroy chama o servidor ou JavaScript?", [fmt_path(path)])
            return
        dname = self.alias_name(dest) if isinstance(dest, str) else str(dest)
        if isinstance(dest, str) and dest.startswith("$") and "/" in dest:
            dname = dest.rsplit("/", 1)[1]
        reach = self.verb_action_reaches_server(dest)
        if reach is None and dname in self.actions:
            reach = self.reaches_server(dname)
        if reach:
            self.r.add("S1", SEV_ERR, f"S1: o {event} de {oname} chama {dname}, que chega ao servidor.", stage="job", path=path, job=ref,
                       suggestion="Dados por Aggregate ou Data Action com Fetch At Start; estado inicial por input da tela.")
        elif reach is None:
            f = self.r.add("S1", SEV_WARN, f"S1: o {event} de {oname} está ligado a {dname}; a action não está neste job, e o estágio oml decide se ela chega ao servidor.",
                           stage="job", path=path, job=ref, suggestion="Evitar handlers de ciclo de vida (eles também travam a reautoria pela op html).")
            if f:
                self.r.ask(f["id"], "S1", "A action do ciclo de vida chama o servidor?", [fmt_path(path)])

    def verb_action_reaches_server(self, dest):
        """Action criada por verbos: procura nos filhos criados com parent = alias."""
        if not isinstance(dest, str) or dest not in self.aliases:
            return None
        children = [a for a in self.aliases.values() if a.get("parent") == dest]
        if not children:
            return None
        for c in children:
            if c["type"] in ("ExecuteServerActionNode", "RefreshDataNode", "AggregateNode", "SQLNode"):
                return True
            if c["type"] == "ExecuteClientActionNode":
                alias = [k for k, v in self.aliases.items() if v is c]
                acts = [j.op.get("value") for j in self.sets if alias and j.op.get("target") == alias[0] and j.op.get("prop") == "Action"]
                for act in acts:
                    if isinstance(act, str) and act in self.aliases and self.verb_action_reaches_server(act):
                        return True
                    if isinstance(act, str) and act.split(":")[-1] in self.actions and self.reaches_server(act.split(":")[-1]):
                        return True
        return False

    def check_expand_inline(self, param_alias, jop):
        """D3: ExpandInline=True só com argumento literal de token T-SQL ("@@?\\w+")."""
        pname = self.alias_name(param_alias)
        parent = (self.aliases.get(param_alias) or {}).get("parent")
        vals = []
        for j in self.sets:
            t = str(j.op.get("target"))
            if parent and t in (f"{parent}/arg:{pname}", f"{parent}/{pname}") and j.op.get("prop") == "Value":
                vals.append(str(j.op.get("value")))
        ok = vals and all(re.fullmatch(r'"@@?\w+"', v.strip()) for v in vals)
        if not ok:
            self.r.add("D3", SEV_ERR, f"D3: ExpandInline=True em {pname} com argumento que não é token T-SQL literal ({', '.join(vals) or 'sem argumento'}).",
                       stage="job", path=[("SQLInputParameter", pname)], job=jop.ref(),
                       suggestion="Parâmetro normal; ExpandInline só para tokens T-SQL literais, com exceção aprovada.")

    # ---- op html
    def check_html(self):
        for jop in self.jobs.ops:
            op = jop.op
            if op.get("op") != "html":
                continue
            ref = jop.ref()
            data = op.get("data") if isinstance(op.get("data"), dict) else None
            html = ""
            if data is None:            # fragmento visual
                html = op.get("html") or ""
                if not html and op.get("file"):
                    p = resolve_repo_file(op["file"], jop.file)
                    html = p.read_text(encoding="utf-8-sig") if p else ""
                screen = str(op.get("parent"))
                spath = [("MobileWidget", self.alias_name(screen.split("/")[0]))]
                self.scan_html_attrs(html, spath, ref, "fragmento")
                continue
            screen = data.get("screen") or ""
            spath = [("MobileScreen", screen)]
            html = data.get("html") or ""
            self.scan_html_attrs(html, spath, ref, "página")
            bindings = data.get("bindings") or {}
            n_sources = len(data.get("sources") or []) + (1 if data.get("source") else 0)
            scripts = [s.get("name") for s in data.get("scripts") or [] if isinstance(s, dict)]
            for key, b in (bindings.items() if isinstance(bindings, dict) else []):
                if not isinstance(b, dict):
                    continue
                bref = jop.ref(f"/data/bindings/{key}")
                bk = b.get("kind")
                if bk == "visible":
                    self.r.add("U1", SEV_ERR, f"U1: o binding '{key}' kind visible na op html de página vira a propriedade Visible.",
                               stage="job", path=spath + [("Container", key)], job=bref, generated_by="html:visible",
                               suggestion="Fragmento visual `<div if>` / `<div else>` (IIfWidget).")
                if bk == "style":
                    self.r.add("U4", SEV_ERR, f"U4: o binding '{key}' kind style (estilo inline).", stage="job",
                               path=spath + [("Container", key)], job=bref, generated_by="html:style",
                               suggestion="Classe do tema via binding `class`, ou ProgressBar do OutSystems UI para percentuais.")
                if bk == "call":
                    act = b.get("action")
                    if n_sources > 1:
                        self.r.add("S2", SEV_ERR, f"S2: o binding call '{key}' ({act}) numa página com {n_sources} sources gera a call e um Refresh por fonte.",
                                   stage="job", path=spath + [("ScreenAction", f"{act}Handler")], job=bref, generated_by="html:call",
                                   suggestion="Uma Data Action de visão e o Refresh só dela; ou atualizar localmente o output.")
                    elif n_sources == 1:
                        sev = SEV_WARN if self.r.mode == "autor" else SEV_ERR
                        self.r.add("S2", sev,
                                   f"S2: o binding call '{key}' ({act}) com 1 source segue o padrão gravar e dar 1 Refresh; só vale com exceção aprovada para o handler.",
                                   stage="job", path=spath + [("ScreenAction", f"{act}Handler")], job=bref, generated_by="html:call",
                                   suggestion="Atualizar localmente o output da Data Action; senão, registrar o handler numa exceção.")
                for fld in ("value", "condition"):
                    expr = b.get(fld)
                    if isinstance(expr, str):
                        called = [s for s in scripts if re.search(rf"\b{re.escape(s)}\s*\(", strip_strings(expr))]
                        if called:
                            self.r.add("U3", SEV_ERR, f"U3: a expressão do binding '{key}' chama a função client {', '.join(called)}.",
                                       stage="job", path=spath + [("Expression", key)], job=bref, generated_by="html:scripts",
                                       suggestion="Calcular no fluxo (Data Action ou servidor), uma vez só.")
                        self.check_literals(expr, f"binding:{key}", spath + [("Expression", key)], bref)
            for i, s in enumerate(data.get("scripts") or []):
                if isinstance(s, dict):
                    sref = jop.ref(f"/data/scripts/{i}")
                    self.r.add("L5", SEV_ERR, f"L5: html.scripts[{s.get('name')}] vira client action com nó JavaScript.", stage="job",
                               path=spath + [("ClientAction", f"{screen}_{s.get('name')}")], job=sref, generated_by="html:scripts",
                               suggestion="Lógica nativa no fluxo, sem JavaScript.")
                    self.r.add("N2", SEV_ERR, f"N2: html.scripts[{s.get('name')}] gera a Description marcador 'anvil:html script'.", stage="job",
                               path=spath + [("ClientAction", f"{screen}_{s.get('name')}")], job=sref, generated_by="html:scripts")
            if data.get("components"):
                self.r.add("L5", SEV_ERR, "L5: html.components (legado) gera nós JavaScript, JSONDeserialize e ForEach.", stage="job", path=spath,
                           job=jop.ref("/data/components"), generated_by="html:components", related="L6")
            for i, d in enumerate(data.get("derived") or []):
                if isinstance(d, dict):
                    dref = jop.ref(f"/data/derived/{i}")
                    dpath = spath + [("ScreenAction", f"Derive{d.get('name')}")]
                    self.r.add("D2", SEV_ERR, f"D2: html.derived[{d.get('name')}] calcula máximo ou soma no cliente (ForEach, If e Assign no OnAfterFetch).",
                               stage="job", path=dpath, job=dref, generated_by="html:derived", related="T1",
                               suggestion="Coluna Max/Sum no aggregate ou valor calculado no servidor.")
                    self.r.add("T1", SEV_ERR, f"T1: html.derived[{d.get('name')}] gera ForEach no lugar de agregação.", stage="job",
                               path=dpath, job=dref, generated_by="html:derived")
            for i, s in enumerate(data.get("sources") or ([data["source"]] if data.get("source") else [])):
                if isinstance(s, dict) and s.get("as"):
                    skind = "ScreenAggregate" if s.get("entity") else "DataAction"
                    described = any(j.gidx > jop.gidx and j.op.get("prop") == "Description" and str(j.op.get("target", "")).endswith("/" + str(s["as"]))
                                    for j in self.sets)
                    if not described:
                        self.r.add("N1", SEV_ERR, f"N1: {skind} {s['as']} gerado por html.sources sem `set Description` depois da op.",
                                   stage="job", path=spath + [(skind, s["as"])], job=jop.ref(f"/data/sources/{i}"), generated_by="html:sources",
                                   suggestion="Acrescentar `set <tela>/<as> Description` depois da op html.")
                if isinstance(s, dict) and s.get("entity") and s.get("max") in (None, ""):
                    self.r.add("D2", SEV_ERR, f"D2: a source {s.get('as') or s.get('entity')} (entidade) está sem `max`.", stage="job",
                               path=spath + [("ScreenAggregate", s.get("as") or s.get("entity"))], job=jop.ref(f"/data/sources/{i}"),
                               generated_by="html:sources", suggestion="Definir `max` na source.")
            if data.get("stylesheet") == "none" and (data.get("css") or "<style" in html):
                self.r.add("U4", SEV_ERR, "U4: stylesheet:\"none\" com CSS: o CSS não vai para o tema.", stage="job", path=spath, job=ref)
            # N1: variáveis de tela declaradas pela página precisam de set Description depois
            for i, v in enumerate(data.get("vars") or []):
                if not isinstance(v, dict):
                    continue
                vname = v.get("name")
                described = any(j.gidx > jop.gidx and j.op.get("prop") == "Description" and str(j.op.get("target", "")).endswith("/" + str(vname))
                                for j in self.sets)
                if not described:
                    self.r.add("N1", SEV_ERR, f"N1: a variável de tela {vname} (html.vars) está sem `set Description` depois da op.",
                               stage="job", path=spath + [("LocalVariable", vname)], job=jop.ref(f"/data/vars/{i}"), generated_by="html:vars",
                               suggestion="Acrescentar `set <tela>/<var> Description` depois da op html.")
                if v.get("default") not in (None, "") and str(v.get("default")).strip() not in TRIVIAL_DEFAULTS:
                    f = self.r.add("E3", SEV_WARN, f"E3: a variável de tela {vname} tem default {v.get('default')}.", stage="job",
                                   path=spath + [("LocalVariable", vname)], job=jop.ref(f"/data/vars/{i}"))
                    if f:
                        self.r.ask(f["id"], "E3", "Este default é configuração?", [fmt_path(spath)])
            # AR2: tela criada pela página sem Roles
            if not any(j.op.get("op") == "link" and j.op.get("connector") == "Roles" and str(j.op.get("from", "")).endswith(screen)
                       for j in self.links):
                self.r.add("AR2", SEV_ERR, f"AR2: a tela {screen} (op html) não recebe Roles neste job.", stage="job", path=spath, job=ref,
                           suggestion="`link` da tela à role (connector Roles) depois da op html; e guarda no servidor.")

    def scan_html_attrs(self, html, spath, ref, where):
        for tag, attrs in parse_html_tags(html):
            for name, val in attrs:
                lname = name.lower()
                if lname == "hidden" or lname == "visible":
                    self.r.add("U1", SEV_ERR, f"U1: atributo `{name}` em <{tag}> no html ({where}).", stage="job",
                               path=spath + [(tag, name)], job=ref, generated_by=f"html:{lname}",
                               suggestion="Usar `<div if>`/`<div else>` (IIfWidget).")
                if lname == "style":
                    self.r.add("U4", SEV_ERR, f"U4: atributo style=\"{(val or '')[:60]}\" em <{tag}> ({where}).", stage="job",
                               path=spath + [(tag, "style")], job=ref, generated_by="html:style",
                               suggestion="Classe no tema ou classe utilitária do OutSystems UI.")
                if lname.startswith("on") and lname not in ("onclick",):
                    self.r.add("L5", SEV_ERR, f"L5: atributo {name} (handler JavaScript) em <{tag}>.", stage="job", path=spath + [(tag, name)], job=ref)
            if tag == "script":
                self.r.add("L5", SEV_ERR, "L5: <script> no html.", stage="job", path=spath, job=ref)

    # ---- op spec
    def check_spec(self):
        cfg = self.cfg
        layer = layer_of(cfg, self.r.module)
        ignore = set(cfg.get("describedIgnoreNames") or [])
        for jop in self.jobs.ops:
            op = jop.op
            if op.get("op") != "spec":
                continue
            data = op.get("data") or {}
            for grp, kind in (("entities", "ServerEntity"), ("static", "StaticEntity"), ("structures", "Structure"),
                              ("clientEntities", "ClientEntity")):
                for i, e in enumerate(data.get(grp) or []):
                    if not isinstance(e, dict):
                        continue
                    name = e.get("name", "")
                    path = [(kind, name)]
                    ref = jop.ref(f"/data/{grp}/{i}")
                    if not (e.get("description") or "").strip():
                        self.r.add("N1", SEV_ERR, f"N1: {kind} {name} sem descrição.", stage="job", path=path, job=ref,
                                   suggestion="`description` que explique o porquê.")
                    else:
                        check_description_quality(self.r, "job", name, e["description"], path, ref, None)
                    if kind in ("ServerEntity", "StaticEntity") and self.r.module and layer and layer != "Core":
                        self.r.add("AR1", SEV_ERR, f"AR1: {kind} {name} no módulo {self.r.module} ({layer}); entidades e statics ficam no Core.",
                                   stage="job", path=path, job=ref, suggestion="Mover para um módulo Core (_CS).")
                    if kind == "ServerEntity" and e.get("public") and e.get("readOnly") is False:
                        self.r.add("AR1", SEV_ERR, f"AR1: entidade pública {name} com readOnly:false (sem ExposeReadOnly).", stage="job",
                                   path=path, job=ref, suggestion="Expor como read-only; a escrita passa por actions.")
                    for j, at in enumerate(e.get("attributes") or []):
                        if not isinstance(at, dict):
                            continue
                        an = at.get("name", "")
                        akind = "StructureAttribute" if kind == "Structure" else "EntityAttribute"
                        apath = path + [(akind, an)]
                        aref = jop.ref(f"/data/{grp}/{i}/attributes/{j}")
                        if an not in ignore and not (at.get("description") or "").strip():
                            self.r.add("N1", SEV_ERR, f"N1: atributo {name}.{an} sem descrição.", stage="job", path=apath, job=aref,
                                       suggestion="`description` no atributo.")
                        elif at.get("description"):
                            check_description_quality(self.r, "job", an, at["description"], apath, aref, None)
                        if str(at.get("type", "")).strip().lower() == "boolean":
                            check_boolean_prefix(self.r, cfg, "job", an, apath, aref)
                        self.check_json_text(an, at.get("type"), apath, aref)
                        # L7: Static Entity É o lugar que a regra manda para domínios fixos; defaults e valores dos
                        # records (inclusive URL ou esquema de URL) não são acusados.
                        if kind != "StaticEntity" and at.get("default") not in (None, ""):
                            self.check_literals(str(at["default"]), "default", apath, aref)

    def check_screen_ops(self):
        for jop in self.jobs.ops:
            op = jop.op
            if op.get("op") != "screen":
                continue
            for i, s in enumerate((op.get("data") or {}).get("screens") or []):
                if not isinstance(s, dict):
                    continue
                name = s.get("name", "")
                path = [("MobileScreen", name)]
                ref = jop.ref(f"/data/screens/{i}")
                src = s.get("source") or {}
                if src.get("entity") and s.get("kind") in ("form", "dashboard"):
                    self.r.add("D2", SEV_ERR, f"D2: a op screen {name} ({s.get('kind')}) lê {src.get('entity')} sem Max Records (a op screen não tem `max` fora de paginação e detalhe).",
                               stage="job", path=path + [("ScreenAggregate", src.get("as") or src.get("entity"))], job=ref, generated_by="screen:source")
                if not any(j.op.get("op") == "link" and j.op.get("connector") == "Roles" and str(j.op.get("from", "")).endswith(name)
                           for j in self.links):
                    self.r.add("AR2", SEV_ERR, f"AR2: a tela {name} (op screen) não recebe Roles neste job.", stage="job", path=path, job=ref,
                               suggestion="`link` da tela à role (connector Roles).")

    # ---- AR1: op reference
    def check_references(self):
        cfg = self.cfg
        me = self.r.module
        for jop in self.jobs.ops:
            op = jop.op
            if op.get("op") != "reference":
                continue
            prod = str(op.get("producer", ""))
            name = prod[4:] if prod.startswith("job:") else pathlib.Path(prod).stem if prod.endswith((".oml", ".avsig")) else prod
            check_layer_edge(self.r, cfg, me, name, "job", jop.ref("/producer"))

    # ---- grafos de verbos crus (D5 por Tarjan)
    def check_verb_graphs(self):
        by_parent: dict[str, list[str]] = {}
        for alias, a in self.aliases.items():
            if a.get("parent"):
                by_parent.setdefault(a["parent"], []).append(alias)
        edges: dict[str, list[str]] = {}
        for j in self.links:
            f, t = j.op.get("from"), j.op.get("to")
            if isinstance(f, str) and isinstance(t, str):
                edges.setdefault(f, []).append(t)
        system_list = set()
        for j in self.sets:
            if j.op.get("prop") == "Action" and re.search(r"(?:^|:)List\w+$", str(j.op.get("value"))):
                system_list.add(j.op.get("target"))
        targets = {j.op.get("to") for j in self.links}
        flow_node_types = {"EndNode", "AssignNode", "IfNode", "ExecuteServerActionNode", "ExecuteClientActionNode", "AggregateNode",
                           "SQLNode", "ForEachNode", "RefreshDataNode", "JavaScriptNode", "JSONSerializeNode", "JSONDeserializeNode",
                           "RaiseExceptionNode", "SwitchNode", "DestinationNode", "MessageNode", "DownloadNode"}
        action_types = {"ServerAction", "ServiceAction", "ClientAction", "ScreenAction", "DataAction", "Preparation", "RestCallbackActionFlow"}
        for alias, a in self.aliases.items():
            parent = self.aliases.get(a.get("parent") or "")
            if a["type"] in flow_node_types and parent and parent["type"] in action_types and alias not in targets:
                what = "End órfão (sem conector de entrada)" if a["type"] == "EndNode" else f"{a['type']} sem conector de entrada (inalcançável)"
                self.r.add("N4", SEV_ERR, f"N4: {what} em {parent.get('name') or a.get('parent')}.", stage="job",
                           path=self.alias_path(alias), job=a["op"].ref(), suggestion="Apagar o nó ou ligar o fluxo.")
        for parent, nodes in by_parent.items():
            nodeset = set(nodes)
            sccs = tarjan(nodes, lambda n: [t for t in edges.get(n, []) if t in nodeset])
            for comp in sccs:
                if len(comp) < 2 and not any(t == comp[0] for t in edges.get(comp[0], [])):
                    continue
                for n in comp:
                    t = self.aliases[n]["type"]
                    if t in ("AggregateNode", "SQLNode", "RefreshDataNode") or (t == "ExecuteServerActionNode" and n not in system_list):
                        a = self.aliases[n]
                        self.r.add("D5", SEV_ERR, f"D5/T3: {t} {a.get('name') or n} dentro de um ciclo do fluxo de {self.alias_name(parent)}.",
                                   stage="job", path=[(self.aliases.get(parent, {}).get("type", "Action"), self.alias_name(parent)), (t, a.get("name") or n)],
                                   job=a["op"].ref(), related="T3",
                                   suggestion="Consulta em lote antes do laço ou agregação no aggregate.")


TRIVIAL_DEFAULTS = {"", '""', "0", "1", "-1", "True", "False", "NullDate()", "NullIdentifier()", "NullTextIdentifier()",
                    "NullBinary()", "NullObject()", "CurrDate()", "CurrDateTime()", "CurrTime()", "#1900-01-01#"}


def is_basic_type(t: str) -> bool:
    t = (t or "").strip()
    if not t:
        return True
    tl = t.lower()
    return tl in BASIC_TYPES or tl.endswith(" identifier")


def resolve_repo_file(spec, job_file: pathlib.Path):
    cands = [job_file.parent / spec]
    root = repo_root(job_file.parent)
    if root:
        cands.append(root / spec)
    cands.append(pathlib.Path(spec))
    for c in cands:
        if c.exists():
            return c
    return None


def parse_html_tags(html: str):
    from html.parser import HTMLParser

    out = []

    class P(HTMLParser):
        def handle_starttag(self, tag, attrs):
            out.append((tag, attrs))

        def handle_startendtag(self, tag, attrs):
            out.append((tag, attrs))

    try:
        P().feed(html or "")
    except Exception:
        pass
    return out


def check_description_quality(r: Report, stage, name, description, path, jref, generated_by, key=None):
    d = (description or "").strip()
    probs = []
    for m in MARKERS:
        if m.lower() in d.lower():
            probs.append(f"marcador '{m}'")
    if len(d) < 15:
        probs.append("menos de 15 caracteres")
    if d.lower().rstrip(".") == (name or "").lower():
        probs.append("igual ao nome")
    else:
        dt_ = {w.lower() for w in re.findall(r"[A-Za-z0-9]+", d)} - STOPWORDS
        nt = {w.lower() for w in camel_tokens(name or "")}
        if dt_ and nt and dt_ <= nt:
            probs.append("só repete as palavras do nome")
    if probs:
        r.add("N2", SEV_ERR, f"N2: a descrição de {name} é fraca ({'; '.join(probs)}): \"{d[:80]}\".", stage=stage, path=path, key=key,
              job=jref, generated_by=generated_by, suggestion="Explicar o porquê (motivo, contrato, efeito), sem repetir o nome.")


def check_action_verb(r: Report, cfg, stage, name, path, jref, action_kind=None, key=None):
    verbs = set(cfg.get("verbs") or [])
    toks = camel_tokens(name or "")
    if not toks:
        return
    if toks[0] not in verbs:
        r.add("N1", SEV_ERR, f"N1: a action {name} não começa por verbo (Verbo+Objeto).", stage=stage, path=path, key=key, job=jref,
              suggestion="Renomear para Verbo+Objeto (ex.: ValidateAddress, GetOrderOptions). Verbo do projeto que falte vai em config.extraVerbs; "
                         "falso positivo se resolve por resposta de revisão.")


def check_boolean_prefix(r: Report, cfg, stage, name, path, jref, key=None):
    prefixes = cfg.get("booleanPrefixes") or ["Is", "Has", "Can"]
    if not re.match(rf"^({'|'.join(prefixes)})[A-Z0-9]", name or ""):
        r.add("N1", SEV_ERR, f"N1: o booleano {name} não tem prefixo {'/'.join(prefixes)}.", stage=stage, path=path, key=key, job=jref,
              suggestion=f"Renomear (ex.: Is{name[:1].upper()}{name[1:]}).")


def timeout_problem(value, policy) -> str | None:
    """S4: TimeoutinSeconds de um método REST contra config.timeoutPolicy. None = conforme."""
    if value in (None, ""):
        return "sem TimeoutinSeconds explícito"
    try:
        secs = float(str(value).strip())
    except ValueError:
        return f"com TimeoutinSeconds não numérico ({value})"
    want = policy.get("restTimeoutSeconds")
    if want not in (None, "") and secs != float(want):
        return f"com TimeoutinSeconds={value}; a política do projeto pede {want}"
    lo, hi = policy.get("minSeconds"), policy.get("maxSeconds")
    if lo not in (None, "") and secs < float(lo):
        return f"com TimeoutinSeconds={value}, abaixo do mínimo {lo} da política"
    if hi not in (None, "") and secs > float(hi):
        return f"com TimeoutinSeconds={value}, acima do máximo {hi} da política"
    return None


def stage_num(stage) -> int:
    """Número do estágio do plano: o primeiro inteiro do texto ('I3' -> 3). Valor sem número conta como muito tarde."""
    m = re.search(r"(\d+)", str(stage or ""))
    return int(m.group(1)) if m else 99


def layer_of(cfg, module):
    if not module:
        return None
    mods = cfg.get("modules") or {}
    if module in mods:
        return mods[module]
    for pat, layer in cfg.get("modulePatterns") or []:
        if fnmatch.fnmatchcase(module, pat):
            return layer
    return None


def check_layer_edge(r: Report, cfg, src, dst, stage, jref=None):
    if not src or not dst or dst == src:
        return
    order = cfg.get("layerOrder") or {"Foundation": 0, "Core": 1, "End-user": 2}
    ls, ld = layer_of(cfg, src), layer_of(cfg, dst)
    path = [("ESpace", src), ("Reference", dst)]
    for fr in cfg.get("forbiddenRefs") or []:
        if fnmatch.fnmatchcase(src, fr.get("from", "")) and fnmatch.fnmatchcase(dst, fr.get("to", "")):
            r.add("AR1", SEV_ERR, f"AR1: referência proibida {src} -> {dst} ({fr.get('why', '')}).", stage=stage, path=path, job=jref)
            return
    if ls is None or ld is None:
        r.add("AR1", SEV_INFO, f"AR1: camada desconhecida em {src} -> {dst} (config.modules ou config.modulePatterns).", stage=stage, path=path, job=jref)
        return
    if ld == "End-user":
        r.add("AR1", SEV_ERR, f"AR1: {src} referencia o módulo End-user {dst}.", stage=stage, path=path, job=jref,
              suggestion="Nada referencia End-user; o que é compartilhado vai num módulo Core reutilizável (ex.: _CW), sem tipos de um app só.")
    elif order.get(ld, 0) > order.get(ls, 0):
        r.add("AR1", SEV_ERR, f"AR1: referência para cima {src} ({ls}) -> {dst} ({ld}).", stage=stage, path=path, job=jref,
              suggestion="Inverter a dependência ou mover o elemento para a camada certa.")


def tarjan(nodes, succ):
    index, low, stack, on, out = {}, {}, [], set(), []
    counter = [0]
    sys.setrecursionlimit(max(10000, sys.getrecursionlimit()))

    def strong(v):
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on.add(v)
        for w in succ(v):
            if w not in index:
                strong(w)
                low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop()
                on.discard(w)
                comp.append(w)
                if w == v:
                    break
            out.append(comp)

    for n in nodes:
        if n not in index:
            strong(n)
    return out



# ------------------------------------------------------------------------------------------------ estágio truechange (O11)

def load_envelope(path):
    d = read_json(path)
    if isinstance(d, dict) and "data" in d and isinstance(d["data"], dict):
        return d, d["data"]
    return d, d


def truechange_stage(r: Report, result_path, deliver_path, oml_path, job_files):
    if result_path:
        env, data = load_envelope(result_path)
        r.inputs["result"] = {"path": str(result_path), "sha256": sha256_file(result_path)}
        ok = bool(env.get("ok")) if isinstance(env, dict) and "ok" in env else True
        k0 = {"ok": ok, "accepted": data.get("accepted"), "isValid": data.get("isValid"),
              "policyMessages": data.get("policyMessages")}
        passed = ok and data.get("accepted") is True and data.get("isValid") is True and data.get("policyMessages") == []
        k0["passed"] = passed
        r.k0 = k0
        if not passed:
            r.add("K0", SEV_ERR, f"K0: o pré-requisito falhou (ok={ok}, accepted={data.get('accepted')}, isValid={data.get('isValid')}, "
                  f"policyMessages={len(data.get('policyMessages') or [])}).", stage="truechange", path=[("ESpace", r.module or "?")],
                  evidence="; ".join(map(str, (data.get("policyMessages") or [])[:3])),
                  suggestion="Corrigir o job até ter accepted e isValid verdadeiros e nenhuma policyMessage.")
        # consistência de entradas
        out_path = data.get("outPath")
        if oml_path:
            if not out_path or os.path.normcase(os.path.abspath(out_path)) != os.path.normcase(os.path.abspath(str(oml_path))):
                r.tool_error("inputs", f"data.outPath ({out_path}) diferente de --oml ({oml_path})")
            else:
                try:
                    if pathlib.Path(result_path).stat().st_mtime + 1e-3 < pathlib.Path(oml_path).stat().st_mtime:
                        r.tool_error("inputs", "o result.json é mais antigo que o OML")
                    for jf in job_files:
                        if pathlib.Path(oml_path).stat().st_mtime < jf["mtime"]:
                            r.tool_error("inputs", f"o OML é mais antigo que o job {jf['path']} (o job mudou depois de gerar o OML)")
                except OSError as e:
                    r.tool_error("inputs", str(e))
        val = data.get("validation") or {}
        messages(r, val.get("new") or [], False, "truechange", "run_job")
        messages(r, val.get("preexisting") or [], True, "truechange", "run_job")
        for m in val.get("tolerated") or []:
            r.add("AR2", SEV_ERR, f"AR2: warning tolerado pelo kernel ({m.get('id')}): Server Action exposta sem autenticação.",
                  stage="truechange", path=parse_verify_path(m.get("path", "")), key=message_object_key(m), evidence=m.get("detail"),
                  suggestion="Tirar Anonymous da tela ou exigir role; guarda no servidor.")
        cov = data.get("coverage") or {}
        r.coverage_ledger = cov.get("porTipo") or {}
        r.handles = data.get("handles") or {}
    if deliver_path:
        env, data = load_envelope(deliver_path)
        r.inputs["deliverResult"] = {"path": str(deliver_path), "sha256": sha256_file(deliver_path)}
        val = data.get("validation") or {}
        if data.get("delivered") is not True:
            r.add("K0", SEV_ERR, f"K0: a entrega não foi concluída (delivered={data.get('delivered')}, stage={data.get('stage')}).",
                  stage="truechange", path=[("ESpace", r.module or "?")], evidence=str(data.get("error"))[:200])
        if (data.get("newErrors") or val.get("newErrors") or 0) > 0:
            r.add("K0", SEV_ERR, f"K0: {data.get('newErrors') or val.get('newErrors')} erros novos do TrueChange depois do merge.",
                  stage="truechange", path=[("ESpace", r.module or "?")])
        messages(r, val.get("new") or [], False, "truechange", "deliver")
        messages(r, val.get("preexisting") or [], True, "truechange", "deliver")
        for m in (data.get("contract") or {}).get("tolerated") or []:
            r.add("AR2", SEV_ERR, f"AR2: warning tolerado pelo kernel ({m.get('id')}) no deliver.", stage="truechange",
                  path=parse_verify_path(m.get("path", "")), key=message_object_key(m), evidence=m.get("detail"))


def message_object_key(m):
    try:
        k = json.loads(m.get("key") or "[]")
        return k[1] if isinstance(k, list) and len(k) > 1 else None
    except (TypeError, ValueError):
        return None


def messages(r: Report, items, preexisting, stage, origin):
    for m in items:
        if not isinstance(m, dict):
            continue
        typ = m.get("type")
        mid = m.get("id")
        pairs = parse_verify_path(m.get("path", ""))
        key = message_object_key(m)
        r.scope_msg_paths.append(pairs)
        if key:
            r.scope_msg_keys.add(key)
        if typ == "Error":
            r.add("K0", SEV_ERR, f"K0: erro do Verify {mid} ({origin}) em {m.get('path')}.", stage=stage, path=pairs, key=key,
                  preexisting=preexisting, evidence=m.get("detail"))
            continue
        if typ != "Warning":
            continue
        rule = TRUECHANGE_RULES.get(mid, "N4")
        detail = m.get("detail") or ""
        if mid == "CustomObjectWarning":          # balde genérico do Service Studio: o texto diz o que é
            if "Anonymous" in detail:
                rule = "AR2"
            elif re.search(r"(?i)sql injection", detail):
                rule = "D3"
            elif re.search(r"(?i)javascript", detail):
                rule = "L5"
        msg = (f"N4: warning {mid} ({origin}{', preexistente' if preexisting else ''}) em {m.get('path')}: "
               f"todo warning do TrueChange conta, mesmo declarado em expectedMessages.")
        if rule != "N4":
            msg = f"{rule}: {mid} ({origin}{', preexistente' if preexisting else ''}) em {m.get('path')}; também conta na N4."
        r.add(rule, SEV_ERR, msg, stage=stage, path=pairs, key=key, preexisting=preexisting, evidence=m.get("detail"),
              related="N4" if rule != "N4" else None,
              suggestion="Corrigir a causa; o warning só passa com exceção aprovada do próprio elemento.")


# ------------------------------------------------------------------------------------------------ estágio oml (O11)

class OmlReader:
    def __init__(self, r: Report, cli, oml, work, timeout=600, parallel=4):
        self.r, self.cli, self.oml, self.work, self.timeout = r, str(cli), str(oml), str(work), timeout
        self.parallel = max(1, int(parallel))
        self.calls = []

    def query_many(self, specs):
        """Várias consultas em paralelo; cada processo com a sua pasta --work (a padrão é compartilhada)."""
        from concurrent.futures import ThreadPoolExecutor
        import threading
        local = threading.local()
        counter = iter(range(10 ** 6))
        lock = threading.Lock()

        def run(spec):
            if not hasattr(local, "work"):
                with lock:
                    local.work = str(pathlib.Path(self.work) / f"q{next(counter)}")
                pathlib.Path(local.work).mkdir(parents=True, exist_ok=True)
            return spec[0], self.query(spec[0], spec[1], spec[2] if len(spec) > 2 else None, work=local.work)

        with ThreadPoolExecutor(max_workers=self.parallel) as pool:
            return dict(pool.map(run, specs))

    def _run(self, argv, work=None):
        cmd = ["dotnet", self.cli, *argv, "--work", work or self.work]
        t0 = time.monotonic()
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=self.timeout,
                               cwd=str(KERNEL))
        except (OSError, subprocess.TimeoutExpired) as e:
            self.r.tool_error("inspect", f"{' '.join(argv[:6])}: {e}")
            return None
        ms = int((time.monotonic() - t0) * 1000)
        self.calls.append({"argv": argv, "ms": ms, "exit": p.returncode})
        out = p.stdout or ""
        i = out.find("\n{")
        i = 0 if out.startswith("{") else (i + 1 if i >= 0 else -1)
        if i < 0:
            self.r.tool_error("inspect", f"sem JSON: {' '.join(argv[:6])}: {(p.stderr or out)[:300]}")
            return None
        try:
            env = json.loads(out[i:])
        except json.JSONDecodeError as e:
            self.r.tool_error("inspect", f"JSON inválido ({e}): {' '.join(argv[:6])}")
            return None
        if not env.get("ok"):
            self.r.tool_error("inspect", f"ok=false: {' '.join(argv[:6])}: {json.dumps(env.get('error'))[:300]}")
            return None
        return env.get("data")

    def snapshot(self):
        return self._run(["inspect", "--oml", self.oml])

    def query(self, kind, props, required=None, work=None):
        """Leitura paginada com fail-closed: leitura incompleta ou propriedade cortada é falha de ferramenta."""
        entries, offset = [], 0
        required = required or {}
        while True:
            data = self._run(["inspect", "--oml", self.oml, "--kind", kind, "--properties", ",".join(props), "--full",
                              "--max", "500", "--offset", str(offset)], work)
            if data is None:
                return None
            if data.get("schema") != "ssam-reading/1":
                self.r.tool_error("inspect", f"{kind}: esquema {data.get('schema')}")
                return None
            if data.get("searchComplete") is False or (data.get("propertyReadErrors") or 0) > 0:
                self.r.tool_error("inspect", f"{kind}: searchComplete={data.get('searchComplete')} propertyReadErrors={data.get('propertyReadErrors')}")
                return None
            for e in data.get("entries") or []:
                path = e.get("path") or ""
                if is_signature_path(path):
                    continue
                if e.get("propertyErrors"):
                    self.r.tool_error("inspect", f"{kind}: propertyErrors em {path}: {json.dumps(e['propertyErrors'])[:200]}")
                    return None
                for pname, om in (e.get("propertiesOmitted") or {}).items():
                    if isinstance(om, dict) and om.get("reason") in ("characters", "items"):
                        self.r.tool_error("inspect", f"{kind}: {pname} cortado ({om.get('reason')}) em {path}")
                        return None
                req = required.get(e.get("kind"), set()) | required.get("*", set())
                miss = req & set(e.get("propertiesMissing") or [])
                if miss:
                    self.r.tool_error("inspect", f"{kind}: propriedades ausentes {sorted(miss)} em {e.get('kind')} {path}")
                    return None
                entries.append(e)
            nxt = data.get("nextOffset")
            if nxt is None:
                break
            offset = nxt
        return entries


def owner_of(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else ""


def ref_of(e, prop):
    return (e.get("propertyReferences") or {}).get(prop) or {}


class OmlStage:
    NODE_PROPS = ["Name", "Label", "Condition", "RecordList", "Action", "DataSource", "IsDisabled", "JavaScript", "MaxRecords",
                  "Exception", "Text", "Statement", "IncomingConnectors", "JSONString", "Data", "Destination", "Description", "Sources"]
    NODE_REQUIRED = {"IfNode": {"Condition", "Label", "IncomingConnectors"}, "AssignNode": {"Label"},
                     "ForEachNode": {"RecordList", "Label"}, "ExecuteServerActionNode": {"Action", "Name"},
                     "ExecuteClientActionNode": {"Action", "Name"}, "RefreshDataNode": {"DataSource"},
                     "AggregateNode": {"MaxRecords", "Name"}, "JavaScriptNode": {"JavaScript", "Name"},
                     "SQLNode": {"Statement", "Name"}, "EndNode": {"IncomingConnectors"},
                     "ExceptionHandlerNode": {"Exception"}, "CommentNode": {"Text"},
                     "JSONDeserializeNode": {"JSONString"}, "JSONSerializeNode": {"Data"},
                     "*": {"IsDisabled"}}

    def __init__(self, r: Report, cfg, reader: OmlReader, base_keys=None):
        self.r, self.cfg, self.rd = r, cfg, reader
        self.base_keys = base_keys
        self._impl_checked: set = set()
        p7 = self.cfg.get("p7") or {}
        self.p7_protected = NamePatterns(p7.get("protectedEntities"))
        self.p7_allowed = NamePatterns(p7.get("allowedEntities"))
        self.subjects = NamePatterns(self.cfg.get("subjectEntities"))

    def pre(self, key):
        return bool(self.base_keys is not None and key in self.base_keys)

    def add(self, rule, sev, msg, e=None, path=None, key=None, **kw):
        if e is not None:
            path = path or e.get("path")
            key = key or e.get("key")
        tpl = tuple(self.cfg.get("templatePaths") or [])
        pstr = path if isinstance(path, str) else fmt_path(path or [])
        if tpl and pstr.startswith(tpl) and sev in (SEV_ERR, SEV_WARN):
            self.r.add(rule, SEV_INFO, msg + " [template da plataforma; config.templatePaths]", stage="oml", path=path, key=key,
                       preexisting=self.pre(key), scope="template", **kw)
            return None
        return self.r.add(rule, sev, msg, stage="oml", path=path, key=key, preexisting=self.pre(key), **kw)

    def run(self):
        rd, cfg = self.rd, self.cfg
        snap = rd.snapshot()
        if snap is None:
            return
        module = snap.get("Name")
        if self.r.module and module and self.r.module != module:
            self.r.tool_error("inputs", f"--module {self.r.module} difere do módulo do OML ({module})")
        self.r.module = self.r.module or module
        self.r.inputs["omlModule"] = {"name": module, "kind": snap.get("Kind"), "key": snap.get("Key"), "objects": snap.get("Objects")}
        # AR1: References
        for ref in snap.get("References") or []:
            name = ref.get("Name")
            if name in ("(System)",):
                continue
            check_layer_edge(self.r, cfg, self.r.module, name, "oml")
        ui = (snap.get("Kind") or "") not in ("Service", "Extension")
        specs = [
            ("ActionNode", self.NODE_PROPS, self.NODE_REQUIRED),
            ("ActionConnector", ["Source", "Target"], {"ActionConnector": {"Source", "Target"}}),
            ("Assignment", ["Variable", "Value"], {"Assignment": {"Variable", "Value"}}),
            ("Argument", ["Value", "Parameter"], {"Argument": {"Value", "Parameter"}}),
            ("Action", ["Name", "Description", "Public", "Function"], {}),
            ("LocalVariable", ["Name", "DataType", "DefaultValue", "Description"], {"LocalVariable": {"DataType", "DefaultValue"}}),
            ("InputParameter", ["Name", "DataType", "Description"], {}),
            ("OutputParameter", ["Name", "DataType", "Description"], {}),
            ("ServerEntity", ["Name", "Public", "ExposeReadOnly", "Description"], {"ServerEntity": {"Public", "ExposeReadOnly"}}),
            ("EntityAttribute", ["Name", "DataType", "Description"], {}),
            ("Structure", ["Name", "Public", "Description"], {}),
            ("StructureAttribute", ["Name", "DataType", "Description"], {}),
            ("SiteProperty", ["Name", "DataType", "DefaultValue", "IsSecret", "Description"], {"SiteProperty": {"IsSecret", "DefaultValue"}}),
            ("Script", ["Name", "JavaScript"], {}),
            ("Aggregate", ["Name", "MaxRecords", "Description"], {"ScreenAggregate": {"MaxRecords"}, "AggregateNode": {"MaxRecords"}}),
            ("Timer", ["Name", "TimeoutInMinutes", "Action"], {}),
        ]
        if ui:
            specs += [
                ("MobileScreen", ["Name", "Roles", "StyleSheet", "Description"], {"MobileScreen": {"Roles", "StyleSheet"}}),
                ("MobileBlock", ["Name", "StyleSheet", "JavaScript", "Description"], {"MobileBlock": {"StyleSheet", "JavaScript"}}),
                ("UILifeCycleEvent", ["Destination"], {"UILifeCycleEvent": {"Destination"}}),
                ("MobileWidget", ["Name", "Visible", "CustomStyle"], {}),
                ("ExtendedProperty", ["Property", "Value"], {"ExtendedProperty": {"Property", "Value"}}),
                ("ClientVariable", ["Name", "DataType", "Description"], {}),
                ("ESpace", ["Name", "JavaScript"], {"ESpace": {"JavaScript"}}),
            ]
        else:
            self.r.notes.append("Módulo Service: IESpace.JavaScript, telas, blocos, widgets e client variables não se aplicam (não foram lidos).")
        got = rd.query_many(specs)
        if any(v is None for v in got.values()):
            return
        empty = []
        nodes, conns, assigns, args, actions = (got[k] for k in ("ActionNode", "ActionConnector", "Assignment", "Argument", "Action"))
        variables, params, outs = got["LocalVariable"], got["InputParameter"], got["OutputParameter"]
        entities, eattrs, structs, sattrs = got["ServerEntity"], got["EntityAttribute"], got["Structure"], got["StructureAttribute"]
        siteprops, scripts, aggs, timers = got["SiteProperty"], got["Script"], got["Aggregate"], got["Timer"]
        screens, blocks, events = got.get("MobileScreen", empty), got.get("MobileBlock", empty), got.get("UILifeCycleEvent", empty)
        widgets, extprops = got.get("MobileWidget", empty), got.get("ExtendedProperty", empty)
        clientvars, espace = got.get("ClientVariable", empty), got.get("ESpace", empty)
        self.cross_check_ledger(got)
        self.nodes, self.conns = nodes, conns
        self.by_key = {n["key"]: n for n in nodes}
        self.flows = {}
        for n in nodes:
            self.flows.setdefault(owner_of(n["path"]), []).append(n)
        self.succ = {}
        self.incoming = {}
        for c in conns:
            if c.get("kind") == "CommentConnector":
                continue
            s, t = ref_of(c, "Source").get("key"), ref_of(c, "Target").get("key")
            if s and t:
                self.succ.setdefault(s, []).append(t)
                self.incoming.setdefault(t, []).append(s)
        self.action_by_path = {a["path"]: a for a in actions}
        self.action_by_key = {a["key"]: a for a in actions}
        self.check_nodes()
        self.check_flows()
        self.check_guards()
        self.check_lifecycle(screens, blocks, events)
        self.check_assignments(assigns)
        self.check_arguments(args)
        self.check_widgets(widgets, extprops, screens, blocks)
        self.check_js(espace, scripts, blocks)
        self.check_names(actions, variables, params, outs, entities, eattrs, structs, sattrs, siteprops)
        self.check_data(entities, siteprops, clientvars, aggs, variables, assigns, timers)
        self.check_p7(assigns)

    def cross_check_ledger(self, read):
        ledger = getattr(self.r, "coverage_ledger", None) or {}
        observable = set(read) | set(self.NODE_REQUIRED) | {"ServerAction", "ServiceAction", "ClientAction", "ScreenAction",
                                                            "DataAction", "StaticEntity", "ScreenAggregate", "AggregateNode"}
        observable.discard("*")
        for t, info in ledger.items():
            if "create" not in (info.get("verbos") or []):
                continue
            k = norm_kind(t)
            if k not in observable:
                continue
            found = len(read[k]) if k in read and read[k] else sum(1 for lst in read.values() for e in lst or [] if e.get("kind") == k)
            if found == 0:
                self.r.tool_error("ledger", f"coverage.porTipo diz que {t} foi criado, mas a leitura do OML não achou nenhum {k}")

    # ---- nós
    def flow_kind(self, flow_path):
        a = self.action_by_path.get(flow_path)
        return a.get("kind") if a else (parse_om_path(flow_path)[-1][0] if flow_path else "")

    def call_target(self, n):
        ref = ref_of(n, "Action")
        return ref

    def is_system_list(self, ref):
        p = ref.get("path") or ""
        return p.startswith("Reference:(System)/") and re.match(r"^List\w+$", ref.get("name") or "")

    def is_server_node(self, n):
        k = n.get("kind")
        if k in ("AggregateNode", "SQLNode", "RefreshDataNode"):
            return True
        if k == "ExecuteServerActionNode":
            return not self.is_system_list(self.call_target(n))
        return False

    def check_nodes(self):
        cfg = self.cfg
        described = set(cfg.get("describedKinds", {}).get("oml") or [])
        integration = cfg.get("integrationModules") or []
        l6 = cfg.get("l6") or {}
        for n in self.nodes:
            k, props = n.get("kind"), n.get("properties") or {}
            flow = owner_of(n["path"])
            # N1: nós com Description (aggregate, SQL, JSON, JS...): o kind precisa ter a propriedade (propertiesMissing)
            if k in described and "Description" not in (n.get("propertiesMissing") or []):
                if not (props.get("Description") or "").strip():
                    self.add("N1", SEV_ERR, f"N1: {k} {n.get('name') or n.get('label') or ''} sem Description em {flow}.", n,
                             suggestion="Description que explique o porquê (na op logic: properties.Description do `node`, ou `set $<Action>.<as> Description`).")
                elif not (tuple(cfg.get("templatePaths") or []) and n["path"].startswith(tuple(cfg.get("templatePaths") or []))):
                    check_description_quality(self.r, "oml", n.get("name") or "", props["Description"], n["path"], None, None, key=n.get("key"))
            if props.get("IsDisabled") == "True":
                self.add("N4", SEV_ERR, f"N4: nó desativado (IsDisabled) em {flow}.", n, suggestion="Apagar o nó desativado.")
            if k == "EndNode" and props.get("IncomingConnectors", "[]") == "[]":
                self.add("N4", SEV_ERR, f"N4: End órfão (sem conector de entrada) em {flow}.", n, suggestion="Apagar o End órfão.")
            if k == "JavaScriptNode":
                self.add("L5", SEV_ERR, f"L5: nó JavaScript {n.get('name')} em {flow}.", n,
                         evidence=(props.get("JavaScript") or "")[:160],
                         suggestion="Forma nativa; JavaScript só com exceção aprovada, isolado, nomeado e descrito.")
                if "$actions." in (props.get("JavaScript") or ""):
                    self.r.ask("L5-actions-" + n["key"], "L5", "O JavaScript chama $actions.X (invisível ao grafo): o que ele chama?", [n["path"]])
            if k in ("JSONSerializeNode", "JSONDeserializeNode"):
                self.add("L6", SEV_ERR, f"L6: nó {k} em {flow}.", n, suggestion="Structures e parâmetros tipados; JSON só com exceção do próprio elemento.")
                text = (props.get("JSONString") or "") + (props.get("Data") or "")
                for fld in l6.get("integrationOnlyFields") or []:
                    if fld in text and self.r.module not in integration:
                        self.add("L6", SEV_ERR, f"L6: nó JSON fora dos módulos de integração lê {fld} (config.l6.integrationOnlyFields).", n)
                if k == "JSONDeserializeNode":
                    for fld in l6.get("writeOnlyFields") or []:
                        if fld in (props.get("JSONString") or ""):
                            self.add("L6", SEV_ERR, f"L6: JSONDeserialize lê {fld}; esse campo só pode ser gravado e exportado (config.l6.writeOnlyFields).", n)
            if k == "IfNode":
                label = n.get("label") or props.get("Label") or ""
                if not label.strip().endswith("?"):
                    self.add("N1", SEV_ERR, f"N1: o If '{label or props.get('Condition', '')[:40]}' em {flow} não é uma pergunta.", n,
                             suggestion="Label em forma de pergunta.")
                if label and GENERIC_LABEL.match(label):
                    self.add("N1", SEV_ERR, f"N1: Label genérico '{label}' em {flow}.", n)
            if k in ("AssignNode", "ForEachNode"):
                label = n.get("label") or props.get("Label") or ""
                if not label or GENERIC_LABEL.match(label):
                    self.add("N1", SEV_ERR, f"N1: {k} com Label genérico '{label}' em {flow}.", n, suggestion="Label com a intenção.")
                elif label in ("SetValues", "Larger"):
                    self.add("N1", SEV_WARN, f"N1: {k} com Label gerado pela op html '{label}' em {flow}.", n, generated_by="html")
            if k == "AggregateNode" and not (props.get("MaxRecords") or "").strip():
                self.add("D2", SEV_ERR, f"D2: aggregate {n.get('name')} sem Max Records em {flow}.", n, suggestion="Definir Max Records.")
            if k == "SQLNode":
                stmt = props.get("Statement") or ""
                self.add("D3", SEV_ERR, f"D3: o nó SQL {n.get('name')} em {flow} precisa de exceção aprovada que diga por que o aggregate não resolve.",
                         n, evidence=stmt[:160])
                if re.search(r"(?i)\bsp_executesql\b|\bEXEC(UTE)?\s*\(", stmt):
                    self.add("D3", SEV_ERR, "D3: SQL dinâmico (sp_executesql/EXEC()).", n, evidence=stmt[:160])

    # ---- fluxos: D5, N4, S2
    def check_flows(self):
        for flow, fnodes in self.flows.items():
            keys = [n["key"] for n in fnodes]
            kset = set(keys)
            sccs = tarjan(keys, lambda k: [t for t in self.succ.get(k, []) if t in kset])
            for comp in sccs:
                cyclic = len(comp) > 1 or comp[0] in self.succ.get(comp[0], [])
                if not cyclic:
                    continue
                for k in comp:
                    n = self.by_key[k]
                    hit = self.is_server_node(n)
                    if not hit and n.get("kind") == "ExecuteClientActionNode":
                        hit = self.client_reaches_server(self.call_target(n))
                    if hit:
                        self.add("D5", SEV_ERR, f"D5/T3: {n.get('kind')} {n.get('name') or ''} dentro de ciclo em {flow} (N+1 idas ao servidor ou ao banco).",
                                 n, related="T3", suggestion="Consulta em lote antes do laço, agregação no aggregate ou uma chamada orquestradora.")
            # N4: alcance a partir do Start e dos handlers
            starts = [n["key"] for n in fnodes if n.get("kind") in ("StartNode", "ExceptionHandlerNode")]
            seen, stack = set(), list(starts)
            while stack:
                k = stack.pop()
                if k in seen:
                    continue
                seen.add(k)
                stack.extend(t for t in self.succ.get(k, []) if t in kset)
            if starts:
                for n in fnodes:
                    if n["key"] not in seen and n.get("kind") not in ("CommentNode",):
                        self.add("N4", SEV_ERR, f"N4: nó inalcançável {n.get('kind')} {n.get('name') or n.get('label') or ''} em {flow}.", n,
                                 suggestion="Apagar o nó ou ligar o fluxo.")
            # S2: client/screen actions
            fk = self.flow_kind(flow)
            if fk in ("ScreenAction", "ClientAction") and not flow.startswith(tuple(self.cfg.get("templatePaths") or [])):
                start = [n["key"] for n in fnodes if n.get("kind") == "StartNode"]
                if start:
                    count = self.max_calls(start[0], kset, {}, set())
                    if count > 1:
                        self.add("S2", SEV_ERR, f"S2: {flow} faz até {count} chamadas ao servidor no mesmo caminho (inclui Refresh e client actions chamadas).",
                                 path=flow, key=(self.action_by_path.get(flow) or {}).get("key"),
                                 suggestion="Uma server action orquestradora; atualizar localmente o output da Data Action.")

    # ---- AR2: guarda dominante e AllExceptions
    GUARD_RE = re.compile(r"Check\w*Role\s*\(|GetUserId\(\)\s*=\s*NullIdentifier\(\)")

    def is_guard_node(self, n):
        k, props = n.get("kind"), n.get("properties") or {}
        if k == "IfNode" and self.GUARD_RE.search(strip_strings(props.get("Condition") or "")):
            return any((self.by_key.get(t) or {}).get("kind") == "RaiseExceptionNode" for t in self.succ.get(n["key"], []))
        if k == "ExecuteServerActionNode":
            name = self.call_target(n).get("name") or ""
            return any(fnmatch.fnmatchcase(name, g) for g in self.cfg.get("guardActions") or [])
        return False

    def is_write_node(self, n):
        k = n.get("kind")
        if k == "ExecuteServerActionNode":
            name = self.call_target(n).get("name") or ""
            return bool(re.match(r"^(CreateOrUpdate|Create|Update|Delete)[A-Z]", name) or name.endswith("_Impl"))
        if k == "SQLNode":
            return bool(re.search(r"(?i)\b(insert|update|delete|merge)\b", strip_strings((n.get("properties") or {}).get("Statement") or "")))
        return False

    def check_guards(self):
        for flow, fnodes in self.flows.items():
            a = self.action_by_path.get(flow) or {}
            kind = a.get("kind") or ""
            guards = [n for n in fnodes if self.is_guard_node(n)]
            handlers = [n for n in fnodes if n.get("kind") == "ExceptionHandlerNode"
                        and re.sub(r"\s", "", ref_of(n, "Exception").get("name") or "").lower() == "allexceptions"]
            if guards and handlers:
                self.add("AR2", SEV_ERR, f"AR2: {flow} tem guarda de acesso e handler AllExceptions no mesmo fluxo: a exceção da guarda é engolida.",
                         handlers[0], suggestion="Tratar só exceções específicas, ou tirar a guarda do alcance do AllExceptions.")
            public = (a.get("properties") or {}).get("Public") == "True" or kind in ("ServiceAction", "DataAction")
            if not public:
                continue
            impl = self.facade_impl(flow, fnodes)
            if impl:
                # fachada pública -> <Nome>_Impl privado: a guarda vive no _Impl; a fachada herda a verificação
                impl_nodes = self.flows.get(impl) or []
                if handlers and any(self.is_guard_node(n) for n in impl_nodes):
                    self.add("AR2", SEV_ERR, f"AR2: a fachada {flow} tem handler AllExceptions e engole a exceção da guarda de {impl}.",
                             handlers[0], suggestion="A fachada só repassa; tratar só exceções específicas, fora do alcance da guarda.")
                if impl not in self._impl_checked:
                    self._impl_checked.add(impl)
                    self.check_flow_guard(impl, f"implementação da fachada {parse_om_path(flow)[-1][1]}")
                continue
            self.check_flow_guard(flow, f"{kind}, pública")

    def facade_impl(self, flow, fnodes):
        """Fachada = uma única chamada ao próprio <Nome>_Impl do módulo, mais Assigns de cópia; nada mais."""
        name = parse_om_path(flow)[-1][1] if flow else ""
        core = [n for n in fnodes if n.get("kind") not in ("StartNode", "EndNode", "AssignNode", "CommentNode")]
        if len(core) != 1 or core[0].get("kind") != "ExecuteServerActionNode":
            return None
        tgt = self.call_target(core[0])
        path = tgt.get("path") or ""
        if tgt.get("name") != f"{name}_Impl" or path not in self.flows:
            return None
        return path

    def is_subject_read_node(self, n):
        k, props = n.get("kind"), n.get("properties") or {}
        if k == "AggregateNode":
            return any(self.subjects.match(s) for s in re.findall(r"AliasedSource:(\w+)", props.get("Sources") or ""))
        if k == "SQLNode":
            return any(self.subjects.match(e) for e in re.findall(r"\{(\w+)\}", props.get("Statement") or ""))
        if k == "ExecuteServerActionNode":
            m = re.match(r"^Get(?:ForUpdate)?(\w+)$", self.call_target(n).get("name") or "")
            return bool(m and self.subjects.match(m.group(1)))
        return False

    def check_flow_guard(self, flow, context):
        """AR2: nenhuma escrita nem leitura de dado do sujeito alcançável do Start sem passar por uma guarda."""
        fnodes = self.flows.get(flow) or []
        sensitive = [n for n in fnodes if self.is_write_node(n) or self.is_subject_read_node(n)]
        if not sensitive:
            return
        gkeys = {n["key"] for n in fnodes if self.is_guard_node(n)}
        start = [n["key"] for n in fnodes if n.get("kind") == "StartNode"]
        seen, stack = set(), list(start)
        while stack:
            k = stack.pop()
            if k in seen or k in gkeys:
                continue
            seen.add(k)
            stack.extend(self.succ.get(k, []))
        for w in sensitive:
            if w["key"] in seen:
                what = "grava" if self.is_write_node(w) else "lê dado do sujeito"
                self.add("AR2", SEV_ERR, f"AR2: {flow} ({context}) {what} ({w.get('name') or w.get('kind')}) sem guarda dominante de role ou acesso.",
                         w, suggestion="No início do fluxo: Require*, CheckRole, lease, token ou if GetUserId()=NullIdentifier() -> raise; e checar o acesso ao registro.")
                break

    def node_cost(self, n, stack):
        if self.is_server_node(n):
            return 1
        if n.get("kind") == "ExecuteClientActionNode":
            return self.client_action_cost(self.call_target(n), stack)
        return 0

    def client_action_cost(self, ref, stack):
        path = ref.get("path") or ""
        if not path or path in stack or is_signature_path(path):
            return 0
        fnodes = self.flows.get(path) or []
        start = [n["key"] for n in fnodes if n.get("kind") == "StartNode"]
        if not start:
            return 0
        return self.max_calls(start[0], {n["key"] for n in fnodes}, {}, stack | {path})

    def max_calls(self, k, kset, memo, stack, onpath=None):
        onpath = onpath or set()
        if k in memo:
            return memo[k]
        if k in onpath:
            return 0
        n = self.by_key.get(k)
        if n is None:
            return 0
        own = self.node_cost(n, stack)
        best = 0
        for t in self.succ.get(k, []):
            if t in kset:
                best = max(best, self.max_calls(t, kset, memo, stack, onpath | {k}))
        memo[k] = own + best
        return memo[k]

    def client_reaches_server(self, ref, stack=None):
        path = ref.get("path") or ""
        stack = stack or set()
        if not path or path in stack or is_signature_path(path):
            return False
        for n in self.flows.get(path) or []:
            if self.is_server_node(n):
                return True
            if n.get("kind") == "ExecuteClientActionNode" and self.client_reaches_server(self.call_target(n), stack | {path}):
                return True
        return False

    # ---- S1 / AR2 telas
    def check_lifecycle(self, screens, blocks, events):
        for e in events:
            key = e.get("key") or ""
            m = re.search(r"\.#(\w+)$", key)
            ev = m.group(1) if m else ""
            if ev not in LIFECYCLE:
                continue
            dest = ref_of(e, "Destination")
            if not dest:
                continue
            owner = owner_of(e["path"]) if e["path"].endswith("UILifeCycleEvent:") else e["path"]
            dpath = dest.get("path") or ""
            path = parse_om_path(owner) + [("UILifeCycleEvent", ev)]
            if ev == "OnDestroy":
                f = self.add("S1", SEV_WARN, f"S1: o OnDestroy de {owner} está ligado a {dest.get('name')}.", path=path, key=key)
                if f:
                    self.r.ask(f["id"], "S1", "O OnDestroy chama o servidor ou JavaScript?", [owner])
                continue
            hit = False
            for n in self.flows.get(dpath) or []:
                if self.is_server_node(n) or (n.get("kind") == "ExecuteClientActionNode" and self.client_reaches_server(self.call_target(n), {dpath})):
                    hit = True
                    break
            if hit:
                self.add("S1", SEV_ERR, f"S1: o {ev} de {owner} executa {dest.get('name')}, que chama o servidor (server action, aggregate ou Refresh).",
                         path=path, key=key, suggestion="Aggregate ou Data Action com Fetch At Start; estado inicial por input da tela.")
        for s in screens:
            props = s.get("properties") or {}
            roles = props.get("Roles", "[]")
            name = s.get("name")
            if roles in ("[]", ""):
                self.add("AR2", SEV_ERR, f"AR2: tela {name} sem Roles.", s, suggestion="Ligar roles à tela; guarda também no servidor.")
            elif "Anonymous" in roles and name not in (self.cfg.get("anonymousScreens") or ["Login"]):
                self.add("AR2", SEV_ERR, f"AR2: tela {name} com Anonymous.", s)
            if (props.get("StyleSheet") or "").strip():
                self.add("U4", SEV_ERR, f"U4: StyleSheet na tela {name}.", s, suggestion="CSS no tema ou na library.")
        for b in blocks:
            props = b.get("properties") or {}
            if (props.get("StyleSheet") or "").strip() and self.r.module not in (self.cfg.get("libraries") or []):
                self.add("U4", SEV_ERR, f"U4: StyleSheet no bloco {b.get('name')} fora de config.libraries.", b)

    # ---- L3 e T4 / AR2 / L7 simples
    def check_assignments(self, assigns):
        for a in assigns:
            props = a.get("properties") or {}
            val = props.get("Value") or ""
            n = count_ifs(val)
            if n > 1:
                self.add("L3", SEV_ERR, f"L3: Assignment {props.get('Variable')} com {n} If() em {owner_of(owner_of(a['path']))}.", a,
                         evidence=val[:200], suggestion="If node no fluxo ou action com nome claro.")

    def check_arguments(self, args):
        by_node = {}
        for a in args:
            by_node.setdefault(owner_of(a["path"]), []).append(a)
        for n in self.nodes:
            if n.get("kind") not in ("ExecuteServerActionNode", "ExecuteClientActionNode"):
                continue
            tgt = self.call_target(n)
            name = tgt.get("name")
            if self.is_system_list(tgt) and name in LIST_ACTIONS:
                cond = ""
                for a in by_node.get(n["path"], []):
                    pname = ref_of(a, "Parameter").get("name")
                    if pname in ("Condition", "By", "Element"):
                        cond = (a.get("properties") or {}).get("Value") or ""
                flow = owner_of(n["path"])
                self.r.runtime_test(parse_om_path(flow)[-1][1] if flow else "", n.get("name"), name, cond, stage="oml", path=n["path"])
                if name in ("ListFilter", "ListSort") and self.flow_kind(flow) in ("ScreenAction", "ClientAction"):
                    lst = [(a.get("properties") or {}).get("Value") for a in by_node.get(n["path"], []) if ref_of(a, "Parameter").get("name") == "List"]
                    if lst and re.search(r"\.List\b|\.\w+$", lst[0] or ""):
                        self.add("D2", SEV_ERR, f"D2: {name} no cliente sobre {lst[0]} em {flow}.", n,
                                 suggestion="Filtrar e ordenar no aggregate ou na Data Action.")
            flow = owner_of(n["path"])
            if self.flow_kind(flow) in ("ScreenAction", "ClientAction") and n.get("kind") == "ExecuteServerActionNode":
                for a in by_node.get(n["path"], []):
                    if "GetUserId()" in strip_strings((a.get("properties") or {}).get("Value") or ""):
                        self.add("AR2", SEV_ERR, f"AR2: {flow} passa GetUserId() do cliente para {name}.", a,
                                 suggestion="Ler GetUserId() no servidor.")
            # AR3
            if self.flow_kind(flow) in ("ScreenAction", "ClientAction", "DataAction") and n.get("kind") == "ExecuteServerActionNode":
                if name in (self.cfg.get("longRunning") or []) and name not in (self.cfg.get("asyncStarters") or []):
                    self.add("AR3", SEV_ERR, f"AR3: {flow} chama {name} (processo longo) numa screen request.", n,
                             suggestion="Iniciar por um starter assíncrono (config.asyncStarters) e deixar um Timer ou BPT executar.")
                if (tgt.get("kind") or "").startswith("RestMethod") or "RestAPI" in (tgt.get("path") or ""):
                    self.add("AR3", SEV_ERR, f"AR3/D4: {flow} chama o REST {name} diretamente.", n, related="D4")

    # ---- U1 / U4
    def check_widgets(self, widgets, extprops, screens, blocks):
        for w in widgets:
            props = w.get("properties") or {}
            vis = props.get("Visible")
            if vis not in (None, "", "True"):
                self.add("U1", SEV_ERR, f"U1: Visible = {vis[:80]} em {w.get('kind')} {w.get('name') or ''}.", w,
                         suggestion="IIfWidget (`<div if>` ou verbo) em vez de Visible.")
            if (props.get("CustomStyle") or "").strip():
                f = self.add("U4", SEV_WARN, f"U4: CustomStyle em {w.get('kind')} {w.get('name') or ''}: {props['CustomStyle'][:60]}.", w)
                if f:
                    self.r.ask(f["id"], "U4", "O CustomStyle pode virar classe do tema?", [w["path"]])
        for e in extprops:
            props = e.get("properties") or {}
            p = (props.get("Property") or "").strip('"').lower()
            if p == "hidden":
                self.add("U1", SEV_ERR, "U1: ExtendedProperty hidden.", e, suggestion="IIfWidget.")
            if p == "style":
                self.add("U4", SEV_ERR, f"U4: ExtendedProperty style = {(props.get('Value') or '')[:60]}.", e,
                         suggestion="Classe do tema ou classe utilitária do OutSystems UI.")
            if p.startswith("on") and p not in ("onclick",):
                self.add("L5", SEV_ERR, f"L5: ExtendedProperty {p} (handler JavaScript).", e)

    def check_js(self, espace, scripts, blocks):
        for e in espace:
            if ((e.get("properties") or {}).get("JavaScript") or "").strip():
                self.add("L5", SEV_ERR, "L5: JavaScript no módulo (IESpace.JavaScript).", e)
        for s in scripts:
            self.add("L5", SEV_ERR, f"L5: Script {s.get('name')}.", s)
        for b in blocks:
            if ((b.get("properties") or {}).get("JavaScript") or "").strip():
                self.add("L5", SEV_ERR, f"L5: JavaScript no bloco {b.get('name')}.", b)

    # ---- N1 / N2 / L6 de nomes
    def check_names(self, actions, variables, params, outs, entities, eattrs, structs, sattrs, siteprops):
        cfg = self.cfg
        described = set(cfg.get("describedKinds", {}).get("oml") or [])
        ignore = set(cfg.get("describedIgnoreNames") or [])
        tpl = tuple(cfg.get("templatePaths") or [])

        def own(e):
            return not (tpl and e["path"].startswith(tpl))

        for a in actions:
            if not own(a) or a.get("kind") in ("OnExceptionAction",):
                continue
            props = a.get("properties") or {}
            name = props.get("Name") or a.get("name") or ""
            if a.get("kind") in described and "Description" not in (a.get("propertiesMissing") or []):
                d = props.get("Description")
                if not (d or "").strip():
                    self.add("N1", SEV_ERR, f"N1: {a.get('kind')} {name} sem descrição.", a)
                else:
                    check_description_quality(self.r, "oml", name, d, a["path"], None, None, key=a.get("key"))
            if a.get("kind") in ("ServerAction", "ServiceAction", "ClientAction", "DataAction"):
                check_action_verb(self.r, cfg, "oml", name, a["path"], None, a.get("kind"), key=a.get("key"))
        for group, kind in ((variables, "LocalVariable"), (params, "InputParameter"), (outs, "OutputParameter"),
                            (eattrs, "EntityAttribute"), (sattrs, "StructureAttribute")):
            for v in group:
                if not own(v):
                    continue
                props = v.get("properties") or {}
                name = props.get("Name") or v.get("name") or ""
                owner_kind = parse_om_path(owner_of(v["path"]))[-1][0] if owner_of(v["path"]) else ""
                if owner_kind in ("JavaScriptNode", "SQLNode", "ScreenAction", "ExecuteServerActionNode") and kind != "LocalVariable":
                    continue
                dtype = props.get("DataType") or ""
                has_desc = "Description" not in (v.get("propertiesMissing") or [])
                if kind in described and has_desc and name not in ignore and not (props.get("Description") or "").strip():
                    self.add("N1", SEV_ERR, f"N1: {kind} {name} sem descrição ({owner_of(v['path'])}).", v)
                elif props.get("Description"):
                    check_description_quality(self.r, "oml", name, props["Description"], v["path"], None, None, key=v.get("key"))
                if dtype.endswith(":Boolean") and name not in ignore:
                    check_boolean_prefix(self.r, cfg, "oml", name, v["path"], None, key=v.get("key"))
                if dtype.endswith(":Text") and re.search(r"(?i)json$", name):
                    self.add("L6", SEV_ERR, f"L6: {kind} {name} é Text com nome *Json.", v, suggestion="Tipar (structure ou lista).")
        for group, kind in ((entities, None), (structs, "Structure")):
            for e in group:
                props = e.get("properties") or {}
                k = e.get("kind")
                if k in described and not (props.get("Description") or "").strip():
                    self.add("N1", SEV_ERR, f"N1: {k} {e.get('name')} sem descrição.", e)
        for s in siteprops:
            props = s.get("properties") or {}
            name = props.get("Name") or s.get("name")
            if name in ("TenantId", "TenantName"):
                continue
            if "SiteProperty" in described and not (props.get("Description") or "").strip():
                self.add("N1", SEV_ERR, f"N1: site property {name} sem descrição.", s)
            if (props.get("DataType") or "").endswith(":Boolean"):
                check_boolean_prefix(self.r, cfg, "oml", name, s["path"], None, key=s.get("key"))

    # ---- AR1 entidades, E2, E3, D2 aggregates, L7 IsSecret, AR3 timers
    def check_data(self, entities, siteprops, clientvars, aggs, variables, assigns, timers):
        cfg = self.cfg
        layer = layer_of(cfg, self.r.module)
        for e in entities:
            props = e.get("properties") or {}
            if layer and layer != "Core":
                self.add("AR1", SEV_ERR, f"AR1: {e.get('kind')} {e.get('name')} no módulo {self.r.module} ({layer}).", e,
                         suggestion="Entidades e statics ficam no Core.")
            if e.get("kind") == "ServerEntity" and props.get("Public") == "True" and props.get("ExposeReadOnly") != "True":
                self.add("AR1", SEV_ERR, f"AR1: entidade pública {e.get('name')} sem ExposeReadOnly.", e)
        by_name = {(s.get("properties") or {}).get("Name"): s for s in siteprops}
        plan = self.r.plan_stage
        for want in (cfg.get("expectedSiteProperties") or {}).get(self.r.module or "", []):
            wname = want.get("name") if isinstance(want, dict) else want
            from_ = want.get("fromStage") if isinstance(want, dict) else None
            if from_ and (plan is None or stage_num(plan) < stage_num(from_)):
                if plan is None:
                    self.r.notes.append(f"E3: {wname} é exigida a partir de {from_}; sem --plan-stage não foi cobrada.")
                continue
            if wname not in by_name:
                self.add("E3", SEV_ERR, f"E3: a site property esperada {wname} não existe em {self.r.module}.", path=[("SiteProperty", wname)],
                         suggestion="Criar a site property com Description (e IsSecret nas chaves).")
            elif isinstance(want, dict) and want.get("isSecret") and (by_name[wname].get("properties") or {}).get("IsSecret") != "True":
                self.add("S3", SEV_ERR, f"S3/E3: a site property {wname} deveria ser IsSecret (config.expectedSiteProperties).",
                         by_name[wname], related="E3")
        for s in siteprops:
            props = s.get("properties") or {}
            if props.get("IsSecret") == "True" and (props.get("DefaultValue") or "").strip() not in ("", '""'):
                self.add("L7", SEV_ERR, f"L7/S3: site property secreta {props.get('Name')} com DefaultValue.", s, related="S3")
            name = props.get("Name") or ""
            declared = any(isinstance(w, dict) and w.get("name") == name
                           for w in (cfg.get("expectedSiteProperties") or {}).get(self.r.module or "", []))
            if not declared and re.search(r"(?i)(api)?key|secret|token|password", name) and props.get("IsSecret") != "True" \
                    and name not in ("TenantId",):
                self.add("S3", SEV_ERR, f"S3/E3: a site property {name} parece segredo e não é IsSecret.", s,
                         suggestion="Marcar IsSecret.")
        for c in clientvars:
            props = c.get("properties") or {}
            self.add("E2", SEV_ERR, f"E2: client variable {c.get('name')} (toda client variable exige exceção aprovada).", c)
            dt_ = props.get("DataType") or ""
            if not dt_.startswith("BasicType:"):
                self.add("E2", SEV_ERR, f"E2: client variable {c.get('name')} com tipo não básico ({dt_}).", c)
        described = set(cfg.get("describedKinds", {}).get("oml") or [])
        for a in aggs:
            if a.get("kind") == "ScreenAggregate" and not ((a.get("properties") or {}).get("MaxRecords") or "").strip():
                self.add("D2", SEV_ERR, f"D2: screen aggregate {a.get('name')} sem Max Records.", a)
            if a.get("kind") == "ScreenAggregate" and "ScreenAggregate" in described \
                    and "Description" not in (a.get("propertiesMissing") or []) and not ((a.get("properties") or {}).get("Description") or "").strip():
                self.add("N1", SEV_ERR, f"N1: screen aggregate {a.get('name')} sem Description.", a,
                         suggestion="`set <tela>/<aggregate> Description` depois da op que o cria.")
        written = set()
        for a in assigns:
            v = ((a.get("properties") or {}).get("Variable") or "").split(".")[0]
            written.add((owner_of(owner_of(owner_of(a["path"]))), v))
        tpl = tuple(cfg.get("templatePaths") or [])
        for v in variables:
            props = v.get("properties") or {}
            d = (props.get("DefaultValue") or "").strip()
            if not d or d in TRIVIAL_DEFAULTS or (tpl and v["path"].startswith(tpl)):
                continue
            flow = owner_of(v["path"])
            if (flow, props.get("Name")) not in written:
                self.add("E3", SEV_ERR, f"E3: a local {props.get('Name')} tem default {d} e nunca é atribuída (constante) em {flow}.", v,
                         suggestion="Site Property ou Static Entity.")
        for t in timers:
            if not ((t.get("properties") or {}).get("TimeoutInMinutes") or "").strip():
                f = self.add("AR3", SEV_WARN, f"AR3: timer {t.get('name')} sem TimeoutInMinutes.", t)
                if f:
                    self.r.ask(f["id"], "AR3", "O timer tem timeout adequado?", [t["path"]])

    def check_p7(self, assigns):
        cfg = self.cfg.get("p7") or {}
        sw = set(cfg.get("siteSwitches") or [])
        for a in assigns:
            var = ((a.get("properties") or {}).get("Variable") or "").strip()
            m = re.match(r"^Site\.(\w+)$", var)
            if m and m.group(1) in sw:
                self.add("P7", SEV_ERR, f"P7: assign de Site.{m.group(1)} (switch de config.p7.siteSwitches; não aceita exceção).", a)
        if not self.p7_protected:
            return                              # P7 desligada: config.p7.protectedEntities vazia
        entry = [re.compile(p) for p in cfg.get("entryPatterns") or []]
        roots = [p for p in self.flows if parse_om_path(p) and any(r_.search(parse_om_path(p)[-1][1]) for r_ in entry)]
        seen = {}
        stack = [(p, p) for p in roots]
        while stack:
            p, root = stack.pop()
            if p in seen:
                continue
            seen[p] = root
            for n in self.flows.get(p) or []:
                if n.get("kind") not in ("ExecuteServerActionNode",):
                    continue
                tgt = self.call_target(n)
                nm = tgt.get("name") or ""
                mm = re.match(r"^(CreateOrUpdate|Create|Update|Delete)(\w+)$", nm)
                if mm and self.p7_protected.match(mm.group(2)) and not self.p7_allowed.match(mm.group(2)):
                    self.add("P7", SEV_ERR, f"P7: {nm} a partir de {p} (alcançado por {root}); entidade protegida (config.p7.protectedEntities).", n)
                if any(re.search(x, nm) for x in cfg.get("forbiddenCalls") or []):
                    self.add("P7", SEV_ERR, f"P7: chamada a {nm} (action reservada a decisão humana) a partir de {p}.", n)
                if tgt.get("path") in self.flows:
                    stack.append((tgt["path"], root))



# ------------------------------------------------------------------------------------------------ OML base (atribuição)

class BaseIndex:
    """Objetos da base (--base-oml), por ObjectKey e por caminho. Só atribuição: a severidade não muda (a N4 conta tudo).
    O caminho cobre o que foi recriado com chave nova (logic replace:true, delta) e os achados do estágio job, que não têm key."""

    def __init__(self, keys, paths):
        self.keys, self.paths = keys, paths

    @staticmethod
    def norm(pairs_or_path):
        pairs = parse_om_path(pairs_or_path) if isinstance(pairs_or_path, str) else pairs_or_path
        return "/".join(f"{norm_kind(k).lower().removesuffix('signature')}:{(n or '').lower()}" for k, n in pairs)

    def has(self, key=None, pairs=None):
        if key and key in self.keys:
            return True
        return bool(pairs) and self.norm(pairs) in self.paths

    def __contains__(self, key):               # compatibilidade: `key in base`
        return key in self.keys


def base_keys(reader_cls, r, cli, base, work, parallel=4):
    """Chaves e caminhos dos objetos da base, para marcar achados preexistentes."""
    rd = reader_cls(r, cli, base, pathlib.Path(work) / "base", parallel=parallel)
    keys, paths = set(), set()
    kinds = ("ActionNode", "MobileWidget", "ExtendedProperty", "Action", "LocalVariable", "SiteProperty", "ServerEntity",
             "Assignment", "UILifeCycleEvent", "InputParameter", "OutputParameter", "MobileScreen", "MobileBlock",
             "ClientVariable", "Structure", "EntityAttribute", "StructureAttribute", "Argument", "Timer", "Role", "Script")
    got = rd.query_many([(k, ["Name"], {}) for k in kinds])
    for es in got.values():
        if es is None:
            return None
        for e in es:
            keys.add(e.get("key"))
            paths.add(BaseIndex.norm(e.get("path") or ""))
    return BaseIndex(keys, paths)


def mark_preexisting(r: Report, base: "BaseIndex | None"):
    """Achados de job e oml cujo elemento já está na base (por key ou caminho) ficam preexisting=true, scope base."""
    if base is None:
        return
    for f in r.findings:
        if f["stage"] not in ("job", "oml") or f["preexisting"]:
            continue
        pairs = [tuple(p) for p in f["element"].get("pairs") or []]
        if base.has(f["element"].get("key"), pairs):
            f["preexisting"] = True
            if f.get("scope") != "template":
                f["scope"] = "base"


# ------------------------------------------------------------------------------------------------ revisão e runtime

def load_review(path):
    if not path:
        return {"answers": [], "runtimeEvidence": []}
    d = read_json(path)
    d.setdefault("answers", [])
    d.setdefault("runtimeEvidence", [])
    return d


def runtime_stage(r: Report, review):
    ev = {e.get("testId"): e for e in review.get("runtimeEvidence") or [] if isinstance(e, dict)}
    missing, failed = [], []
    for tid, t in r.runtime_tests.items():
        e = ev.get(tid)
        if not e:
            missing.append(tid)
            t["evidence"] = None
            continue
        t["evidence"] = e
        res = str(e.get("result", "")).lower()
        if res not in ("pass", "passou", "ok"):
            failed.append(tid)
            r.add("T4", SEV_ERR, f"T4: o E2E de {t['listAction']} em {t['action']}.{t['node']} falhou ({e.get('result')}); o job reabre.",
                  stage="runtime", path=t.get("path"), evidence=e.get("evidence") or e.get("test"))
    return missing, failed


# ------------------------------------------------------------------------------------------------ fechamento

STATUS_TEXT = {
    "checada": "checada",
    "revisao-manual": "sem detector; fica na revisão manual",
    "fora-dos-estagios": "não checada nos estágios pedidos",
    "nao-checada-odc": "não checada no ODC ainda",
    "nao-se-aplica": "não se aplica ao ODC",
}


def rule_status(platform, stages_run, stages_requested):
    """Situação de cada regra nesta execução. No ODC, regra sem detector ODC nunca passa calada."""
    detectors = DETECTORS.get(platform, {})
    detect_req = [s for s in stages_requested if s in DETECTION_STAGES]
    any_detector = set().union(*IMPLEMENTED.values())
    out = []
    for rule in RULE_ORDER:
        plats = RULE_PLATFORMS[rule]
        ran = [s for s in stages_run if rule in detectors.get(s, [])]
        if platform == "odc" and "ODC" not in plats:
            status = "nao-se-aplica"
        elif ran:
            status = "checada"
        elif platform == "odc" and detect_req:
            status = "nao-checada-odc"
        elif rule not in any_detector:
            status = "revisao-manual"
        else:
            status = "fora-dos-estagios"
        out.append({"rule": rule, "platforms": list(plats), "checagem": RULE_CLASS[rule], "status": status,
                    "texto": STATUS_TEXT[status], "stages": ran})
    return out


def finalize(r: Report, excs: Exceptions, review, stages_run):
    # O mesmo warning visto no job (expectedMessages) e no result: fica o do estágio truechange, que é a medida real.
    t_paths = {f["element"]["path"].lower() for f in r.findings if f["stage"] == "truechange"}
    r.findings = [f for f in r.findings if not (f["stage"] == "job" and f["rule"] == "N4" and f["element"]["path"].lower() in t_paths)]
    excs.apply(r.findings)
    answers = {a.get("questionId"): a for a in review.get("answers") or [] if isinstance(a, dict) and str(a.get("answer", "")).strip()}
    blocking_err = False
    for f in r.findings:
        ex = f.get("exception")
        covered = bool(ex and ex.get("applied"))
        f["blocking"] = False
        if f["severity"] == SEV_ERR and not covered:
            f["blocking"] = True
            blocking_err = True
        if f["severity"] == SEV_WARN:
            f["answered"] = f["id"] in answers
    # perguntas manuais (regras manuais e perguntas de revisão das parciais): só quando o estágio lê o código (job ou
    # oml); o truechange depois do deliver e o runtime não repetem a revisão feita antes do deliver
    if {"job", "oml"} & set(stages_run):
        for rule in MANUAL_ALWAYS:
            r.ask(f"{rule}-geral", rule, review_question(rule, r.config), [])
    manual = list(r.manual.values())
    for q in manual:
        q["answered"] = q["questionId"] in answers
        if q["answered"]:
            q["answer"] = answers[q["questionId"]]
    stale = excs.stale(stages_run)
    code = 0
    reasons = []
    if r.tool_errors:
        code = 2
        reasons.append("falha de ferramenta ou de entrada (fail-closed)")
    else:
        if blocking_err:
            code = 1
            reasons.append("erro sem exceção aplicável")
        if r.k0 and not r.k0.get("passed"):
            code = 1
            reasons.append("o pré-requisito K0 falhou")
        if r.mode == "integrador" and (excs.invalid or stale or any(e["_expired"] and e["_uses"] for e in excs.items)):
            code = 1
            reasons.append("exceção inválida, vencida ou sem uso")
        if "runtime" in stages_run:
            missing = [t for t in r.runtime_tests.values() if not t.get("evidence")]
            if code == 0 and missing:
                code = 3
                reasons.append(f"{len(missing)} runtimeTests sem runtimeEvidence")
        if code == 0 and r.mode == "integrador":
            unanswered_w = [f for f in r.findings if f["severity"] == SEV_WARN and not f.get("answered") and not (f.get("exception") or {}).get("applied")]
            unanswered_q = [q for q in manual if not q["answered"]]
            incomplete = [t for t in r.runtime_tests.values() if not t.get("condition")]
            if unanswered_w or unanswered_q or incomplete:
                code = 3
                reasons.append(f"revisão pendente: {len(unanswered_w)} avisos e {len(unanswered_q)} perguntas sem resposta; "
                               f"{len(incomplete)} runtimeTests incompletos")
    return code, reasons, manual, stale


def summarize(findings):
    s = {}
    for f in findings:
        e = s.setdefault(f["rule"], {SEV_ERR: 0, SEV_WARN: 0, SEV_INFO: 0, SEV_CONTRACT: 0, "excepted": 0, "blocking": 0})
        if (f.get("exception") or {}).get("applied"):
            e["excepted"] += 1
        else:
            e[f["severity"]] = e.get(f["severity"], 0) + 1
        if f.get("blocking"):
            e["blocking"] += 1
    return dict(sorted(s.items()))


def coverage():
    out = {"auto": [], "partial": [], "manual": [], "implementedByStage": IMPLEMENTED, "detectorsByPlatform": DETECTORS,
           "platforms": {rule: list(p) for rule, p in RULE_PLATFORMS.items()}, "notImplemented": []}
    for rule, cls in RULE_CLASS.items():
        out[{"automatica": "auto", "parcial": "partial", "manual": "manual"}[cls]].append(rule)
    done = set().union(*IMPLEMENTED.values())
    out["notImplemented"] = sorted(r for r in RULE_CLASS if r not in done and RULE_CLASS[r] != "manual")
    return out


# ------------------------------------------------------------------------------------------------ main

def build_parser():
    ap = argparse.ArgumentParser(description="OutSystems padrões (SSAM Hybrid): checa as regras de RULES.md. Ferramenta opcional; "
                                             "exit 0 ok, 1 violação, 2 falha de ferramenta ou entrada, 3 revisão ou checagem pendente.")
    ap.add_argument("--mode", choices=("autor", "integrador"), default="autor")
    ap.add_argument("--stage", default="all", help="job|oml|truechange|runtime|all (aceita vírgulas)")
    ap.add_argument("--platform", choices=PLATFORMS, help="o11 ou odc (padrão: config.platform, senão o11)")
    ap.add_argument("--job", action="append", default=[], help="job JSON do O11 (repetível; o composto é expandido)")
    ap.add_argument("--result", help="envelope do run_job (<out>.result.json)")
    ap.add_argument("--oml", help="OML candidato (deve ser igual a data.outPath)")
    ap.add_argument("--base-oml", help="OML base, só para atribuição (preexistente)")
    ap.add_argument("--deliver-result", help="<work>\\deliver\\<id>\\result.json (estágio truechange depois do merge)")
    ap.add_argument("--from-report", help="relatório .padroes.json anterior (fonte dos runtimeTests no estágio runtime)")
    ap.add_argument("--work", help="pasta de trabalho própria (padrão: <kernel>/.local/padroes/work)")
    ap.add_argument("--module")
    ap.add_argument("--config", help="config do projeto (padrão: OUTSYSTEMS_PADROES_CONFIG, <kernel>/.local/padroes/config.json "
                                     "ou config.example.json)")
    ap.add_argument("--exceptions", help="arquivo de exceções (padrão: config.exceptionsFile; sem ele, nenhuma exceção)")
    ap.add_argument("--review")
    ap.add_argument("--out", help="relatório (padrão: <kernel>/.local/padroes/<stem>.padroes.json)")
    ap.add_argument("--cli", help="anvil.dll (padrão: OUTSYSTEMS_PADROES_CLI ou <kernel>/.local/cli/anvil.dll)")
    ap.add_argument("--parallel", type=int, default=4, help="consultas inspect em paralelo (cada uma com --work próprio)")
    ap.add_argument("--plan-stage", help="estágio do plano do projeto (ex.: I1, I2): cobra só as site properties esperadas até ele "
                                         "e filtra exceções com 'stages'")
    ap.add_argument("--freeze-exceptions", metavar="SAIDA", help="grava a cópia congelada das exceções do estágio (--plan-stage, --module) e sai")
    ap.add_argument("--quiet", action="store_true")
    return ap


def resolve_config_path(args) -> pathlib.Path:
    if args.config:
        return pathlib.Path(args.config)
    env = os.environ.get("OUTSYSTEMS_PADROES_CONFIG")
    if env:
        return pathlib.Path(env)
    local = PADROES_DIR / "config.json"
    return local if local.exists() else EXAMPLE_CONFIG


def resolve_exceptions_path(args, config, config_path) -> pathlib.Path | None:
    if args.exceptions:
        return pathlib.Path(args.exceptions)
    rel = str(config.get("exceptionsFile") or "").strip()
    if not rel:
        return None
    p = pathlib.Path(rel)
    return p if p.is_absolute() else pathlib.Path(config_path).parent / p


def resolve_cli(args) -> pathlib.Path:
    return pathlib.Path(args.cli or os.environ.get("OUTSYSTEMS_PADROES_CLI") or DEFAULT_CLI)


def run_gate(args) -> tuple[int, dict]:
    config_path = resolve_config_path(args)
    config_error = None
    try:
        config, _ = load_config(config_path)
    except (OSError, ValueError, re.error) as e:
        config, _ = load_config(None)
        config_error = f"{config_path}: {e}"
    platform = str(args.platform or config.get("platform") or "o11").lower()
    r = Report(args, config, platform)
    if config_error:
        r.tool_error("config", config_error)
    if platform not in PLATFORMS:
        r.tool_error("args", f"plataforma desconhecida: {platform} (use o11 ou odc)")
    o11 = platform == "o11"
    r.inputs["config"] = {"path": str(config_path), "sha256": sha256_file(config_path)}
    exc_path = resolve_exceptions_path(args, config, config_path)
    r.inputs["exceptions"] = {"path": str(exc_path) if exc_path else None, "sha256": sha256_file(exc_path) if exc_path else None}
    stages = [s.strip() for s in args.stage.split(",")]
    if "all" in stages:
        stages = [s for s in STAGES if s != "runtime"]
        if args.from_report:
            stages.append("runtime")
    for s in stages:
        if s not in STAGES:
            r.tool_error("args", f"estágio desconhecido: {s}")
    excs_data = {"schema": EXC_SCHEMA, "exceptions": []}
    if exc_path:
        try:
            excs_data = read_json(exc_path)
        except (OSError, ValueError) as e:
            r.tool_error("exceptions", f"{exc_path}: {e}")
    review = {"answers": [], "runtimeEvidence": []}
    if args.review:
        try:
            review = load_review(args.review)
            r.inputs["review"] = {"path": args.review, "sha256": sha256_file(args.review)}
        except (OSError, ValueError) as e:
            r.tool_error("review", str(e))
    if args.mode == "integrador" and o11:
        if "truechange" in stages and not (args.result or args.deliver_result):
            r.tool_error("args", "o modo integrador exige --result (ou --deliver-result) no estágio truechange")
        if "oml" in stages and not args.base_oml:
            r.tool_error("args", "o modo integrador exige --base-oml no estágio oml (só atribuição)")
    jobs = JobSet()
    for j in args.job:
        try:
            jobs.load(pathlib.Path(j))
        except (OSError, ValueError) as e:
            r.tool_error("job", f"{j}: {e}")
    r.inputs["jobs"] = [{"path": f["path"], "sha256": f["sha256"]} for f in jobs.files]
    excs = Exceptions(excs_data, config, r)
    work = pathlib.Path(args.work) if args.work else PADROES_DIR / "work"
    work.mkdir(parents=True, exist_ok=True)
    cli = resolve_cli(args)
    p7 = config.get("p7") or {}
    if NamePatterns(p7.get("protectedEntities")) and not (p7.get("entryPatterns") or []):
        r.notes.append("P7: config.p7.protectedEntities está preenchida, mas config.p7.entryPatterns está vazia; sem ponto de "
                       "entrada, a checagem de escrita protegida não roda.")
    if not o11:
        skipped = [s for s in stages if s in DETECTION_STAGES]
        if skipped:
            r.notes.append(f"Plataforma {platform.upper()}: os detectores de hoje leem jobs e OML do O11 e não rodam aqui "
                           f"(estágios pedidos: {', '.join(skipped)}). Cada regra sai como 'não checada no ODC ainda' "
                           f"(AR1: 'não se aplica ao ODC').")
    if "job" in stages and o11:
        if not jobs.ops and not jobs.files:
            r.tool_error("args", "estágio job sem --job")
        else:
            JobStage(r, config, jobs).run()
            r.scope_job_text = "\n".join(pathlib.Path(f["path"]).read_text(encoding="utf-8-sig") for f in jobs.files).lower()
            r.stages_run.append("job")
    if "truechange" in stages and o11 and (args.result or args.deliver_result):
        try:
            truechange_stage(r, args.result, args.deliver_result, args.oml, jobs.files)
            r.stages_run.append("truechange")
        except (OSError, ValueError, KeyError) as e:
            r.tool_error("truechange", str(e))
    elif "truechange" in stages and o11 and args.stage != "all":
        r.tool_error("args", "estágio truechange sem --result ou --deliver-result")
    bkeys = None
    if o11 and args.base_oml and ({"job", "oml"} & set(stages)):
        if not pathlib.Path(args.base_oml).exists():
            r.tool_error("inputs", f"OML base não encontrado: {args.base_oml}")
        elif not cli.exists():
            r.tool_error("cli", f"CLI não encontrado: {cli} (necessário para ler o --base-oml)")
        else:
            r.inputs["baseOml"] = {"path": args.base_oml, "sha256": sha256_file(args.base_oml)}
            bkeys = base_keys(OmlReader, r, cli, args.base_oml, work, args.parallel)
    if "oml" in stages and o11 and args.oml:
        if not cli.exists():
            r.tool_error("cli", f"CLI não encontrado: {cli}")
        elif not pathlib.Path(args.oml).exists():
            r.tool_error("inputs", f"OML não encontrado: {args.oml}")
        else:
            r.inputs["oml"] = {"path": str(args.oml), "sha256": sha256_file(args.oml)}
            reader = OmlReader(r, cli, args.oml, work, parallel=args.parallel)
            OmlStage(r, config, reader, bkeys).run()
            r.inputs["inspectCalls"] = len(reader.calls)
            r.inputs["inspectMs"] = sum(c["ms"] for c in reader.calls)
            r.stages_run.append("oml")
    elif "oml" in stages and o11 and args.stage != "all":
        r.tool_error("args", "estágio oml sem --oml")
    if "runtime" in stages:
        if args.from_report:
            prev = read_json(args.from_report)
            for t in prev.get("runtimeTests") or []:
                r.runtime_tests.setdefault(t["testId"], dict(t))
            r.module = r.module or prev.get("module")
        runtime_stage(r, review)
        r.stages_run.append("runtime")
    attribute_by_handles(r, jobs)
    mark_preexisting(r, bkeys)
    code, reasons, manual, stale = finalize(r, excs, review, r.stages_run)
    statuses = rule_status(platform, r.stages_run, stages)
    unchecked = [s["rule"] for s in statuses if s["status"] == "nao-checada-odc"]
    if unchecked:
        reasons.append(f"{len(unchecked)} regras não checadas no ODC ainda (os detectores de hoje só leem O11)")
        if code == 0:
            code = 3
    r.inputs["exceptions"]["planStage"] = excs_data.get("planStage")
    r.inputs["exceptions"]["frozen"] = bool(excs_data.get("planStage"))
    report = {
        "schema": SCHEMA, "generatedAt": ts_utc(), "mode": r.mode, "platform": platform, "module": r.module,
        "stages": r.stages_run, "stagesRequested": stages, "planStage": r.plan_stage, "notes": r.notes,
        "outOfStageExceptions": excs.out_of_stage,
        "status": {0: "ok", 1: "falha", 2: "erro-de-ferramenta", 3: "revisao-pendente"}[code], "exitCode": code,
        "reasons": reasons, "k0": r.k0, "inputs": r.inputs, "summary": summarize(r.findings), "ruleStatus": statuses,
        "findings": r.findings, "manualReview": manual, "runtimeTests": list(r.runtime_tests.values()),
        "staleExceptions": stale, "invalidExceptions": excs.invalid, "pendingExceptions": excs.pending,
        "toolErrors": r.tool_errors, "coverage": coverage(),
    }
    return code, report


def attribute_by_handles(r: Report, jobs: JobSet):
    """Achado do OML -> ObjectKey -> alias do job (data.handles) -> op e ponteiro. Sem alias: fica só a key."""
    handles = getattr(r, "handles", None) or {}
    if not handles:
        return
    rev = {v: k for k, v in handles.items()}
    creates = {j.op.get("as"): j for j in jobs.ops if j.op.get("op") == "create" and j.op.get("as")}
    for f in r.findings:
        key = f["element"].get("key")
        if f["stage"] != "oml" or not key or key not in rev or f["element"].get("job"):
            continue
        alias = rev[key]
        jop = creates.get(alias)
        f["element"]["job"] = dict(jop.ref(), alias=alias) if jop else {"alias": alias}


def default_out(args):
    stem = args.module or (pathlib.Path(args.oml).stem if args.oml else pathlib.Path(args.job[0]).stem if args.job else "padroes")
    return PADROES_DIR / f"{stem}.padroes.json"


def print_summary(report, out):
    print(f"outsystems_padroes: {report['status']} (exit {report['exitCode']}) modo={report['mode']} plataforma={report['platform']} "
          f"modulo={report['module']} estagios={','.join(report['stages']) or '-'}")
    for reason in report["reasons"]:
        print("  motivo:", reason)
    for te in report["toolErrors"][:10]:
        print("  ferramenta:", te["what"], "-", te["detail"][:200])
    for note in (report.get("notes") or [])[:10]:
        print("  nota:", note[:240])
    for rule, s in report["summary"].items():
        print(f"  {rule:4} erro={s[SEV_ERR]} aviso={s[SEV_WARN]} info={s[SEV_INFO]} pendente={s[SEV_CONTRACT]} excecao={s['excepted']}")
    counts = {}
    for st in report.get("ruleStatus") or []:
        counts.setdefault(st["status"], []).append(st["rule"])
    if counts.get("nao-checada-odc"):
        print(f"  {len(counts['nao-checada-odc'])} regras: {STATUS_TEXT['nao-checada-odc']}")
    if counts.get("nao-se-aplica"):
        print(f"  {', '.join(counts['nao-se-aplica'])}: {STATUS_TEXT['nao-se-aplica']}")
    if report["runtimeTests"]:
        print(f"  runtimeTests: {len(report['runtimeTests'])}")
    print("  relatório:", out)


def freeze_exceptions(args) -> int:
    """Cópia congelada das exceções de UM estágio (e módulo): só os registros que valem ali, com o sha256 da fonte."""
    if not args.plan_stage:
        print("--freeze-exceptions exige --plan-stage", file=sys.stderr)
        return 2
    config_path = resolve_config_path(args)
    try:
        config, _ = load_config(config_path)
    except (OSError, ValueError, re.error) as e:
        print(f"config inválida: {config_path}: {e}", file=sys.stderr)
        return 2
    src = resolve_exceptions_path(args, config, config_path)
    if not src:
        print("--freeze-exceptions precisa de --exceptions ou de config.exceptionsFile", file=sys.stderr)
        return 2
    data = read_json(src)
    keep = []
    for ex in data.get("exceptions") or []:
        if args.module and ex.get("module") and ex["module"] != args.module:
            continue
        if ex.get("stages") and stage_num(args.plan_stage) not in {stage_num(s) for s in ex["stages"]}:
            continue
        keep.append(ex)
    out = {"schema": data.get("schema"), "planStage": args.plan_stage, "module": args.module, "frozenAt": ts_utc(),
           "frozenFrom": {"path": str(src), "sha256": sha256_file(src)},
           "_leia": "Cópia congelada para um estágio. Não editar: para mudar, edite a fonte e congele de novo.",
           "exceptions": keep}
    dst = pathlib.Path(args.freeze_exceptions)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"exceções congeladas: {len(keep)} registros, estágio {args.plan_stage}, módulo {args.module or '*'} -> {dst} (sha256 {sha256_file(dst)})")
    return 0


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args(argv)
    if args.freeze_exceptions:
        return freeze_exceptions(args)
    try:
        code, report = run_gate(args)
    except Exception as e:  # fail-closed: qualquer exceção inesperada é falha de ferramenta
        report = {"schema": SCHEMA, "generatedAt": ts_utc(), "status": "erro-de-ferramenta", "exitCode": 2,
                  "toolErrors": [{"what": "padroes", "detail": f"{type(e).__name__}: {e}"}], "findings": []}
        code = 2
        import traceback
        traceback.print_exc()
    out = pathlib.Path(args.out) if args.out else default_out(args)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    if not args.quiet:
        print_summary(report, out) if "summary" in report else print(json.dumps(report, ensure_ascii=False)[:2000])
    return code


if __name__ == "__main__":
    sys.exit(main())
