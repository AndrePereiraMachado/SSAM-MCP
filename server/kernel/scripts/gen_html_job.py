"""Gera jobs de prova a partir de uma pagina HTML/CSS autorada e do seu manifesto de bindings.

    python scripts/gen_html_job.py tests/html/incidents-dashboard.html tests/jobs/html-dashboard-reactive.json --target fixture
    python scripts/gen_html_job.py tests/html/incidents-dashboard.html tests/jobs/html-dashboard-update.json --target update
    python scripts/gen_html_job.py tests/html/incidents-dashboard.html tests/jobs-live/html-dashboard-incidents.json --target product

A fonte canonica e o par <pagina>.html + <pagina>.bindings.json; os jobs sao derivados (HTML embutido, sha256 da pagina
na descricao) e regenerados por inteiro, sempre iguais para a mesma fonte.

- fixture: prelude <pagina>.fixture.json (spec/logic/screen stand-ins) + op html, sobre reactive-ui.oml.
- update: so o op html, sobre job:<job da fixture> (a tela ja existe: prova o delta com identidade preservada).
- product: prelude <pagina>.product.json (reference ao modulo produtor) + op html; base e o snapshot que o deliver tira;
  <pagina>.product.expected.json (opcional) declara os avisos que o modulo real ja carrega, com elemento e motivo.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("page"); ap.add_argument("out")
    ap.add_argument("--target", choices=["fixture", "update", "product"], default="fixture")
    ap.add_argument("--fixture-job", default="html-dashboard-reactive", help="nome do job da fixture que o alvo update usa como base")
    a = ap.parse_args()
    page = pathlib.Path(a.page); out = pathlib.Path(a.out)
    html = page.read_text(encoding="utf-8")
    bindings = json.loads(page.with_suffix(".bindings.json").read_text(encoding="utf-8"))
    digest = hashlib.sha256(html.encode("utf-8")).hexdigest()
    html_op = {"op": "html", "data": {**bindings, "html": html}}
    expected: list = []
    if a.target == "fixture":
        prelude = json.loads(page.with_suffix(".fixture.json").read_text(encoding="utf-8"))
        base, what = "reactive-ui.oml", "em tela nativa Reactive sobre fixture, com stand-ins das actions do produtor"
    elif a.target == "update":
        prelude, base, what = [], f"job:{a.fixture_job}", "outra vez sobre a tela ja criada (delta: identidade da tela e variaveis preservadas, sem duplicar)"
    else:
        prelude = json.loads(page.with_suffix(".product.json").read_text(encoding="utf-8"))
        base, what = "reactive-ui.oml", "no modulo de produto (base = snapshot tirado pelo deliver; referencia ao Incidents_CS)"
        # Avisos que o modulo real ja carrega (ex.: role Anonymous na tela) e que o contrato de mensagens exige declarados com motivo.
        expected_file = page.with_suffix(".product.expected.json")
        if expected_file.exists(): expected = json.loads(expected_file.read_text(encoding="utf-8"))
    job = {
        "description": f"Compila a pagina HTML/CSS autorada {page.as_posix()} (sha256 {digest[:12]}) {what}; gerado por scripts/gen_html_job.py --target {a.target}.",
        "base": base,
        "expectValid": True,
        "expectedMessages": expected,
        "ops": [*prelude, html_op],
    }
    out.write_text(json.dumps(job, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{out}: {len(job['ops'])} ops, html {len(html)} chars, sha256 {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
