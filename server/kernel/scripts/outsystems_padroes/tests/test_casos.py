"""Testes da ferramenta OutSystems padrões (unittest, Python só stdlib).

Rodar da raiz do repositório:
    python -m unittest discover -s kernel/scripts/outsystems_padroes/tests -v

Cada casos/<nome>.expect.json vira um teste. Os casos dos estágios job, truechange e runtime rodam offline. Os casos
do estágio oml (e os que usam baseOml) precisam do CLI anvil e do OML gerado a partir do job composto; sem eles, o caso
sai como pulado, com o motivo. Variáveis:
    OUTSYSTEMS_PADROES_CLI      anvil.dll de origem (padrão: <kernel>/.local/cli/anvil.dll). O teste COPIA a pasta
                                do CLI para uma pasta temporária e roda a cópia, nunca o original.
    OUTSYSTEMS_PADROES_NEG_OML  pasta com os OMLs dos casos (padrão: <kernel>/.local/padroes/neg-oml).
    ANVIL_STUDIO_DIR            DLLs do Service Studio 11, só leitura (padrão: a instalação padrão, se existir).
O teste fixa ANVIL_WORKER=0 e ANVIL_ODC_NO_WORKER=1: nenhum worker é iniciado.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import os
import pathlib
import re
import shutil
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
TOOL_DIR = HERE.parent
CASES = HERE / "casos"
TEST_CONFIG = HERE / "config.test.json"
STUDIO_DEFAULT = pathlib.Path(r"C:\Program Files\OutSystems\Service Studio 11\Service Studio")

os.environ["ANVIL_WORKER"] = "0"
os.environ["ANVIL_ODC_NO_WORKER"] = "1"
if not os.environ.get("ANVIL_STUDIO_DIR") and STUDIO_DEFAULT.is_dir():
    os.environ["ANVIL_STUDIO_DIR"] = str(STUDIO_DEFAULT)


def load_tool():
    spec = importlib.util.spec_from_file_location("outsystems_padroes", TOOL_DIR / "outsystems_padroes.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["outsystems_padroes"] = mod
    spec.loader.exec_module(mod)
    return mod


P = load_tool()


def read_json(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8-sig"))


class OmlEnv:
    """CLI copiado para uma pasta temporária e pasta dos OMLs. Preparado uma vez, só se algum caso precisar."""
    _ready = False
    cli = None
    reason = None
    tmp = None

    @classmethod
    def prepare(cls):
        if cls._ready:
            return
        cls._ready = True
        if not shutil.which("dotnet"):
            cls.reason = "dotnet não está no PATH"
            return
        src = pathlib.Path(os.environ.get("OUTSYSTEMS_PADROES_CLI") or P.DEFAULT_CLI)
        if not src.exists():
            cls.reason = f"CLI anvil ausente: {src} (defina OUTSYSTEMS_PADROES_CLI)"
            return
        if not os.environ.get("ANVIL_STUDIO_DIR"):
            cls.reason = "ANVIL_STUDIO_DIR não definido e o Service Studio 11 não está na pasta padrão"
            return
        cls.tmp = pathlib.Path(tempfile.mkdtemp(prefix="padroes-cli-"))
        shutil.copytree(src.parent, cls.tmp / "cli")
        cls.cli = cls.tmp / "cli" / src.name

    @classmethod
    def cleanup(cls):
        if cls.tmp:
            shutil.rmtree(cls.tmp, ignore_errors=True)

    @staticmethod
    def oml_dir() -> pathlib.Path:
        return pathlib.Path(os.environ.get("OUTSYSTEMS_PADROES_NEG_OML") or (P.PADROES_DIR / "neg-oml"))


def tearDownModule():
    OmlEnv.cleanup()


def composite_for(oml_name: str) -> str:
    stem = oml_name[: -len(".oml")] if oml_name.endswith(".oml") else oml_name
    return f"tests/casos/{stem}.json"


class CasosTest(unittest.TestCase):
    maxDiff = None

    def need_oml(self, name):
        OmlEnv.prepare()
        if OmlEnv.reason:
            self.skipTest(OmlEnv.reason)
        path = OmlEnv.oml_dir() / name
        if not path.exists():
            self.skipTest(f"OML ausente: {path}. Gerar com: ssam job --lane o11 {composite_for(name)} --out {path}")
        return path

    def run_case(self, name, exp):
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="padroes-caso-"))
        try:
            self._run_case(name, exp, tmp)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def _run_case(self, name, exp, tmp):
        cfg = read_json(TEST_CONFIG)
        cfg.update(copy.deepcopy(exp.get("configOverride") or {}))
        cfg_path = tmp / "config.json"
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
        stage = exp.get("stage", "job")
        argv = ["--mode", exp.get("mode", "autor"), "--stage", stage, "--config", str(cfg_path),
                "--out", str(tmp / f"{name}.padroes.json"), "--work", str(tmp / "work"), "--quiet"]
        if exp.get("platform"):
            argv += ["--platform", exp["platform"]]
        if exp.get("exceptions"):
            argv += ["--exceptions", str(CASES / exp["exceptions"])]
        if exp.get("module"):
            argv += ["--module", exp["module"]]
        if exp.get("planStage"):
            argv += ["--plan-stage", exp["planStage"]]
        if exp.get("baseOml"):
            argv += ["--base-oml", str(self.need_oml(exp["baseOml"])), "--cli", str(OmlEnv.cli)]
        default_job = [f"{name}.json"] if (CASES / f"{name}.json").exists() and stage == "job" else []
        for j in exp.get("jobs") or default_job:
            argv += ["--job", str(CASES / j)]
        if exp.get("result"):
            argv += ["--result", str(CASES / exp["result"])]
        if exp.get("deliverResult"):
            argv += ["--deliver-result", str(CASES / exp["deliverResult"])]
        if exp.get("review"):
            argv += ["--review", str(CASES / exp["review"])]
        if exp.get("fromReport"):
            argv += ["--from-report", str(CASES / exp["fromReport"])]
        if exp.get("oml"):
            oml = self.need_oml(exp["oml"])
            argv += ["--oml", str(oml), "--cli", str(OmlEnv.cli)]
            if exp.get("resultForOml"):
                src = OmlEnv.oml_dir() / exp["resultForOml"]
                if not src.exists():
                    self.skipTest(f"result do OML ausente: {src}")
                # cópia com data.outPath apontando para o OML usado aqui (o truechange exige outPath igual a --oml)
                env = read_json(src)
                (env.get("data") if isinstance(env.get("data"), dict) else env)["outPath"] = str(oml)
                dst = tmp / exp["resultForOml"]
                dst.write_text(json.dumps(env, ensure_ascii=False), encoding="utf-8")
                argv += ["--result", str(dst)]
        code, report = P.run_gate(P.build_parser().parse_args(argv))
        self.check(exp, code, report)

    def check(self, exp, code, report):
        problems = []
        findings = report["findings"]

        def text(f):
            return (f["message"] + " " + f["element"]["path"]).lower()

        if "exitCode" in exp and code != exp["exitCode"]:
            problems.append(f"exit {code} != esperado {exp['exitCode']} (motivos: {report.get('reasons')}; "
                            f"ferramenta: {report.get('toolErrors')})")
        for want in exp.get("mustFind") or []:
            hits = [f for f in findings if f["rule"] == want["rule"]
                    and (not want.get("severity") or f["severity"] == want["severity"])
                    and (not want.get("stage") or f["stage"] == want["stage"])
                    and (want.get("excepted") is None or bool((f.get("exception") or {}).get("applied")) == want["excepted"])
                    and (want.get("preexisting") is None or bool(f.get("preexisting")) == want["preexisting"])
                    and (not want.get("contains") or want["contains"].lower() in text(f))]
            if not hits:
                problems.append(f"não achou {want}")
        for bad in exp.get("mustNotFind") or []:
            hits = [f for f in findings if f["rule"] == bad["rule"]
                    and (not bad.get("severity") or f["severity"] == bad["severity"])
                    and (bad.get("preexisting") is None or bool(f.get("preexisting")) == bad["preexisting"])
                    and (not bad.get("contains") or bad["contains"].lower() in text(f))]
            if hits:
                problems.append(f"achou o proibido {bad}: {hits[0]['message'][:160]}")
        if exp.get("runtimeTests") is not None and len(report["runtimeTests"]) < exp["runtimeTests"]:
            problems.append(f"runtimeTests {len(report['runtimeTests'])} < {exp['runtimeTests']}")
        if exp.get("invalidExceptions") is not None and len(report.get("invalidExceptions") or []) < exp["invalidExceptions"]:
            problems.append(f"invalidExceptions {len(report.get('invalidExceptions') or [])} < {exp['invalidExceptions']}")
        if exp.get("toolErrors") is not None and len(report.get("toolErrors") or []) < exp["toolErrors"]:
            problems.append(f"toolErrors {len(report.get('toolErrors') or [])} < {exp['toolErrors']}")
        if exp.get("maxBlockingErrors") is not None:
            blocking = [f for f in findings if f.get("blocking")]
            if len(blocking) > exp["maxBlockingErrors"]:
                problems.append(f"{len(blocking)} erros bloqueantes > {exp['maxBlockingErrors']}: "
                                + "; ".join(f["message"][:100] for f in blocking)[:600])
        if exp.get("maxFindings") is not None and len(findings) > exp["maxFindings"]:
            problems.append(f"{len(findings)} achados > {exp['maxFindings']}: " + "; ".join(f["message"][:80] for f in findings)[:400])
        if exp.get("ruleStatus"):
            got = {s["rule"]: s["status"] for s in report.get("ruleStatus") or []}
            for rule, status in exp["ruleStatus"].items():
                if got.get(rule) != status:
                    problems.append(f"ruleStatus {rule} = {got.get(rule)!r}, esperado {status!r}")
        self.assertFalse(problems, "\n".join(problems))


def _make_case(name, exp_path):
    def test(self):
        self.run_case(name, read_json(exp_path))
    test.__doc__ = f"caso {name}"
    return test


for _exp in sorted(CASES.glob("*.expect.json")):
    _name = _exp.name[: -len(".expect.json")]
    setattr(CasosTest, "test_" + re.sub(r"\W", "_", _name), _make_case(_name, _exp))


class UnidadesTest(unittest.TestCase):
    def test_timeout_policy(self):
        self.assertEqual(P.timeout_problem(None, {}), "sem TimeoutinSeconds explícito")
        self.assertIsNone(P.timeout_problem(60, {"restTimeoutSeconds": 60}))
        self.assertIn("pede 60", P.timeout_problem(30, {"restTimeoutSeconds": 60}))
        self.assertIn("abaixo do mínimo", P.timeout_problem(10, {"minSeconds": 20}))
        self.assertIn("acima do máximo", P.timeout_problem(120, {"maxSeconds": 90}))
        self.assertIsNone(P.timeout_problem(45, {"minSeconds": 20, "maxSeconds": 90}))

    def test_stage_num(self):
        self.assertEqual(P.stage_num("I3"), 3)
        self.assertEqual(P.stage_num("estagio 12"), 12)
        self.assertEqual(P.stage_num(None), 99)

    def test_name_patterns(self):
        pats = P.NamePatterns(["Protected\\w*"])
        self.assertTrue(pats.match("ProtectedOrder"))
        self.assertFalse(pats.match("MyProtectedOrder"))
        self.assertFalse(P.NamePatterns([]))
        self.assertFalse(P.NamePatterns(""))

    def test_config_example(self):
        cfg, raw = P.load_config(TOOL_DIR / "config.example.json")
        self.assertEqual(raw.get("schema"), "outsystems-padroes-config/1")
        self.assertEqual(cfg["p7"]["protectedEntities"], [])           # P7 desligada no exemplo
        self.assertEqual(cfg["patternLibrary"], "")                    # sem library de cliente por padrão
        self.assertIn("Get", cfg["verbs"])                             # padrões da ferramenta continuam valendo
        self.assertIn("OutSystemsUI", cfg["modules"])                  # modules é mesclado

    def test_pattern_library_and_extra_verbs(self):
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="padroes-cfg-"))
        try:
            path = tmp / "c.json"
            path.write_text(json.dumps({"patternLibrary": "Lib_Patterns", "extraVerbs": ["Frobnicate"]}), encoding="utf-8")
            cfg, _ = P.load_config(path)
            self.assertIn("Lib_Patterns", cfg["libraries"])
            self.assertIn("Frobnicate", cfg["verbs"])
            self.assertIn("Lib_Patterns", P.review_question("U2", cfg))
            self.assertNotIn("library de padrões", P.review_question("U2", P.load_config(None)[0]))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class RegrasDocTest(unittest.TestCase):
    """RULES.md tem as 35 regras e a P7, com checagem, estágios e plataformas iguais aos do script."""
    STAGE_NAMES = {"job": "job", "truechange": "truechange", "oml": "oml", "runtime": "runtime"}

    def rows(self):
        out = {}
        for line in (TOOL_DIR / "RULES.md").read_text(encoding="utf-8").splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) >= 5 and cells[0].strip("*") in P.RULE_ORDER:
                out[cells[0].strip("*")] = cells
        return out

    def test_rules_table(self):
        rows = self.rows()
        self.assertEqual(sorted(rows), sorted(P.RULE_ORDER))
        cls_text = {"automatica": "automática", "parcial": "parcial", "manual": "manual"}
        for rule, cells in rows.items():
            _, statement, checking, stages, platforms = cells[:5]
            self.assertTrue(statement, rule)
            self.assertEqual(checking.split()[0].lower(), cls_text[P.RULE_CLASS[rule]], rule)
            want_stages = [s for s in ("job", "truechange", "oml", "runtime") if rule in P.IMPLEMENTED[s]]
            got_stages = [s.strip() for s in stages.split(",") if s.strip() and s.strip() != "—"]
            self.assertEqual(got_stages, want_stages, rule)
            want_plat = "O11 e ODC" if P.RULE_PLATFORMS[rule] == ("O11", "ODC") else "só O11"
            self.assertEqual(platforms, want_plat, rule)


class NeutroTest(unittest.TestCase):
    """Nenhum nome de cliente ou de PoC nos arquivos da ferramenta."""
    NAMES = ["HM" + "IS", "J" + "HA", "Agent" + "Ops", "Han" + "ford", "Wright" + "Flood", "Flood" + "Quotes", "DC" + "IPS"]

    def test_no_client_names(self):
        rx = re.compile("|".join(self.NAMES), re.I)
        hits = []
        for path in sorted(TOOL_DIR.rglob("*")):
            if path.is_file() and path.suffix in (".py", ".json", ".md") and "__pycache__" not in path.parts:
                for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                    if rx.search(line):
                        hits.append(f"{path.relative_to(TOOL_DIR)}:{i}: {line.strip()[:120]}")
        self.assertFalse(hits, "\n".join(hits))


if __name__ == "__main__":
    unittest.main(verbosity=2)
