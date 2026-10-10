"""Piscina de workers residentes: varios processos, um despachante, uma fila logica.

POR QUE EXISTE
--------------
Um worker atende UM pedido de cada vez. Cada `apply` carrega a base do zero (5 a 15 s na faixa ODC,
~1,4 s na O11), por isso N frentes em paralelo enfileiram todas no mesmo processo e o paralelismo
evapora: dez agentes a iterar cinco vezes cada sao cinquenta corridas em serie.

O cliente ja falava por porta (`odc_worker.call(argv, port=...)`, `anvil_cli.call(argv, port=...)`);
o que faltava era quem escolhe a porta. Esta piscina levanta N workers em portas proprias, pergunta
a cada um se esta livre (o proprio `ping` ja devolve `busy`, `queued`, `served`, `workingSetMB`) e
despacha para o menos ocupado; um `apply` vai primeiro ao livre que ja tem pronta (ou esta a preparar) uma
instancia de reserva da sua base (`baseCache` no ping, BaseModelCache do kernel), porque ai o load sai do pedido.

Resolve tambem dois problemas medidos e nao inventados:
  * workers orfaos - em 2026-09-17 havia tres de pe (4547, 4627, 4657), sobras de frentes da manha
    que ninguem parou, porque nada sabia quem era o dono de que porta;
  * crescimento de memoria - medido no SS11: 3,5 GB apos 584 pedidos num so processo. A piscina
    recicla por limiar em vez de deixar crescer.

O REGISTO (.local/<faixa>/pool.json) e uma CONVENIENCIA, nao a verdade. A verdade e o que o worker
responde ao ping: um registo pode estar velho, um processo pode ter morrido, e o despacho tem de
continuar correcto. Por isso todo o caminho quente pergunta ao worker e nunca confia no ficheiro.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import odc_worker  # noqa: E402
import worker_process  # noqa: E402

try:
    import anvil_cli  # noqa: E402
except Exception:  # a faixa O11 pode nao estar construida; a piscina da ODC continua a servir
    anvil_cli = None

# Cada faixa tem o seu cliente, a sua pasta e a sua porta base. As portas da piscina sao
# base, base+10, base+20... deixando espaco para as portas que as frentes reservam a mao
# (4617/4627/4657 estao documentadas em docs/PLANO-COBERTURA.md e nao devem ser pisadas).
_workspace_file = ROOT.parent / '.ssam-workspace.json'
_pool_step = json.loads(_workspace_file.read_text(encoding='utf-8'))['workers']['poolStep'] if _workspace_file.is_file() else 10
FAIXAS = {
    "odc": {"cliente": odc_worker, "local": odc_worker.LOCAL, "base": odc_worker.PORT, "passo": _pool_step},
    "o11": {"cliente": anvil_cli, "local": anvil_cli.LANE.local if anvil_cli else ROOT / '.local', "base": anvil_cli.PORT if anvil_cli else 14517, "passo": _pool_step},
}

LIMITE_MB = int(os.environ.get("ANVIL_POOL_MB", "2500"))


def _faixa(nome: str) -> dict:
    f = FAIXAS.get(nome)
    if f is None or f["cliente"] is None:
        raise ValueError(f"faixa desconhecida ou sem cliente construido: {nome}")
    return f


def portas(nome: str, n: int) -> list[int]:
    f = _faixa(nome)
    return [f["base"] + i * f["passo"] for i in range(n)]


def _registo(nome: str) -> pathlib.Path:
    return _faixa(nome)["local"] / "pool.json"


def _ler(nome: str) -> dict:
    try:
        return json.loads(_registo(nome).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"faixa": nome, "portas": [], "donos": {}}


def _gravar(nome: str, dados: dict) -> None:
    """Grava o registo sem NUNCA rebentar quem chama: ele e conveniencia, a verdade e o ping.
    O temporario leva pid e thread no nome porque varios despachos correm ao mesmo tempo - com um
    `.tmp` fixo, quatro threads colidiram no os.replace do Windows (WinError 32) e mataram a corrida."""
    try:
        caminho = _registo(nome)
        caminho.parent.mkdir(parents=True, exist_ok=True)
        tmp = caminho.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(dados, indent=2), encoding="utf-8")
        tmp.replace(caminho)
    except OSError:
        pass


def estado(nome: str, n: int | None = None) -> list[dict]:
    """Uma linha por porta, perguntando ao worker. O registo so diz QUE portas olhar."""
    cliente = _faixa(nome)["cliente"]
    reg = _ler(nome)
    alvos = portas(nome, n) if n else (reg.get("portas") or portas(nome, 1))
    donos = reg.get("donos") or {}
    linhas = []
    for p in alvos:
        info = cliente.ping(port=p)
        cache = (info or {}).get("baseCache") or {}
        linhas.append({
            "porta": p,
            "de_pe": info is not None,
            "ocupado": bool(info.get("busy")) if info else None,
            "na_fila": info.get("queued") if info else None,
            "servidos": info.get("served") if info else None,
            "mb": info.get("workingSetMB") if info else None,
            "pid": info.get("pid") if info else None,
            "dono": donos.get(str(p)),
            # BaseModelCache: bases com instancia de reserva pronta e bases que o worker esta a preparar (sha16)
            "bases": cache.get("keys") or [],
            "a_aquecer": cache.get("warming") or [],
        })
    return linhas


def _fixture(spec: str, pasta_job: pathlib.Path) -> pathlib.Path | None:
    """A mesma politica de JobSources.FixturePath do kernel: so um OML dentro de tests/fixtures."""
    raiz = next((p for p in (pasta_job, *pasta_job.parents) if (p / "MANIFESTO.md").is_file()), ROOT)
    fixtures = (raiz / "tests" / "fixtures").resolve()
    caminho = pathlib.Path(spec)
    if caminho.is_absolute():
        candidatos = [caminho]
    else:
        candidatos = [pasta_job / spec, raiz / spec, fixtures / spec if caminho.name == spec else raiz / spec]
    for c in candidatos:
        completo = c.resolve()
        if fixtures in completo.parents:
            return completo
    return None


def base_sha(argv: list[str]) -> str | None:
    """sha256 da base que um `apply` vai carregar: --base, senao o campo `base` do job. None quando nao se sabe
    (outro comando, `job:`, binding, ficheiro ausente): o despacho segue a regra de sempre."""
    try:
        args = [str(a) for a in argv]
        if not args or args[0] != "apply":
            return None
        if "--base" in args:
            caminho = pathlib.Path(args[args.index("--base") + 1])
        else:
            job = pathlib.Path(args[args.index("--job") + 1]).resolve()
            dados = json.loads(job.read_text(encoding="utf-8-sig"))
            spec = (dados.get("base") if isinstance(dados, dict) else None) or "tests/fixtures/blank-service.oml"
            if spec.startswith("job:") or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", spec):
                return None
            caminho = _fixture(spec, job.parent)
        return hashlib.sha256(caminho.read_bytes()).hexdigest() if caminho and caminho.is_file() else None
    except (OSError, ValueError, IndexError):
        return None


def levantar(nome: str, n: int, espera: float = 120) -> list[dict]:
    """Garante N workers de pe. Idempotente: quem ja atende fica como esta."""
    cliente = _faixa(nome)["cliente"]
    alvos = portas(nome, n)
    for p in alvos:
        if cliente.ping(port=p) is None:
            cliente.ensure(port=p, wait=espera)
    reg = _ler(nome)
    reg["faixa"] = nome
    reg["portas"] = alvos
    reg.setdefault("donos", {})
    _gravar(nome, reg)
    return estado(nome, n)


def parar(nome: str, n: int | None = None) -> list[dict]:
    cliente = _faixa(nome)["cliente"]
    reg = _ler(nome)
    alvos = portas(nome, n) if n else (reg.get("portas") or [])
    parados = []
    for p in alvos:
        try:
            parados.append({"porta": p, "resultado": cliente.stop(port=p)})
        except Exception as erro:  # parar nunca pode rebentar quem chama
            parados.append({"porta": p, "erro": str(erro)})
    reg["portas"] = []
    reg["donos"] = {}
    _gravar(nome, reg)
    return parados


def escolher(nome: str, dono: str | None = None, espera: float = 300) -> int:
    """A porta do worker livre com menos fila. Se todos estiverem ocupados, espera pelo primeiro
    que vagar; se nenhum estiver de pe, devolve a porta base para o chamador cair no processo frio.

    So escolhe: duas escolhas simultaneas podem dar a mesma porta (uma fila de dois, nao um erro).
    Para despachar, correr() usa reservar_livre(), que reserva o worker antes de enviar.
    """
    limite = time.monotonic() + espera
    while True:
        linhas = [l for l in estado(nome) if l["de_pe"]]
        if not linhas:
            return _faixa(nome)["base"]
        livres = [l for l in linhas if not l["ocupado"]]
        escolha = min(livres or linhas, key=lambda l: (l["na_fila"] or 0, l["servidos"] or 0))
        if livres or time.monotonic() >= limite:
            if dono:
                reg = _ler(nome)
                reg.setdefault("donos", {})[str(escolha["porta"])] = dono
                _gravar(nome, reg)
            return escolha["porta"]
        time.sleep(0.5)


def reciclar(nome: str, limite_mb: int = LIMITE_MB) -> list[dict]:
    """Reinicia o worker que passou do limiar de memoria. So mexe em quem esta OCIOSO: reiniciar
    um worker a meio de um pedido perderia o resultado de quem esta a espera dele."""
    cliente = _faixa(nome)["cliente"]
    feitos = []
    for l in estado(nome):
        if not l["de_pe"] or l["ocupado"] or (l["mb"] or 0) < limite_mb:
            continue
        cliente.stop(port=l["porta"])
        cliente.ensure(port=l["porta"], wait=120)
        feitos.append({"porta": l["porta"], "mb_antes": l["mb"], "servidos": l["servidos"]})
    return feitos


def trabalho(nome: str, porta: int) -> pathlib.Path:
    """A pasta de trabalho DESTE worker. Nao e detalhe: medido em 2026-09-17, quatro workers a
    escrever na MESMA --work custaram metade do ganho (1,3x com pasta unica contra 2,5x com pastas
    separadas, tecto teorico 3,4x). A contenção e de metadados do sistema de ficheiros e nao aparece
    nem na CPU nem na memoria - a maquina estava a 56% de CPU e 6% de RAM nas duas medicoes."""
    p = _faixa(nome)["local"] / "pool" / str(porta) / "work"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _reservar(nome: str, porta: int) -> dict | None:
    """Reserva atomica de um worker para UM despacho: arquivo criado em modo exclusivo com o PID e a
    identidade de criacao do processo, o mesmo padrao do startup_lock. Medido em 2026-09-25: sem ela,
    duas submissoes simultaneas escolheram o mesmo worker livre enquanto o outro ficava parado.
    Devolve None quando outro despachante vivo ja a tem; reserva de processo morto e descartada."""
    path = _faixa(nome)["local"] / "pool" / str(porta) / "claim.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    token = {"pid": os.getpid(), "birth": worker_process.birth(os.getpid()), "thread": threading.get_ident(),
             "created": time.time()}
    for _ in range(2):
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                json.dump(token, stream)
            return {"path": path, "token": token}
        except FileExistsError:
            try:
                owner = json.loads(path.read_text(encoding="utf-8"))
                if owner.get("birth") and worker_process.birth(int(owner["pid"])) != owner["birth"]:
                    path.unlink(missing_ok=True)
                    continue
            except (OSError, ValueError, KeyError):
                pass  # o dono pode estar a escrever o arquivo que acabou de criar
            return None
    return None


def _liberar(reserva: dict | None) -> None:
    if not reserva:
        return
    try:
        if json.loads(reserva["path"].read_text(encoding="utf-8")) == reserva["token"]:
            reserva["path"].unlink()
    except (OSError, ValueError):
        pass


def reservar_livre(nome: str, dono: str | None = None, espera: float = 300,
                   base: str | None = None) -> tuple[int, dict | None]:
    """Como escolher(), mas so devolve um worker livre depois de o reservar. Esgotada a espera sem
    worker livre e sem reserva, cai no comportamento antigo: fila no menos ocupado, sem reserva.

    `base` (sha256 da base do job, base_sha): entre os livres, primeiro o que ja tem a instancia de reserva
    dessa base pronta, depois o que a esta a preparar; sem nenhum, a regra de sempre."""
    limite = time.monotonic() + espera
    while True:
        linhas = [l for l in estado(nome) if l["de_pe"]]
        if not linhas:
            return _faixa(nome)["base"], None
        chave = lambda l: (l["na_fila"] or 0, l["servidos"] or 0)  # noqa: E731
        curta = (base or "")[:16]

        def afinidade(l: dict) -> tuple:
            pronta = 0 if curta and curta in l.get("bases", []) else 1 if curta and curta in l.get("a_aquecer", []) else 2
            return (pronta, *chave(l))

        escolha, reserva = None, None
        for linha in sorted((l for l in linhas if not l["ocupado"]), key=afinidade):
            reserva = _reservar(nome, linha["porta"])
            if reserva:
                escolha = linha
                break
        if escolha is None and time.monotonic() >= limite:
            escolha = min(linhas, key=chave)
        if escolha is not None:
            if dono:
                reg = _ler(nome)
                reg.setdefault("donos", {})[str(escolha["porta"])] = dono
                _gravar(nome, reg)
            return escolha["porta"], reserva
        time.sleep(0.2)


def correr(argv: list[str], nome: str = "odc", dono: str | None = None) -> dict | None:
    """Um job no primeiro worker livre e reservado, com a pasta de trabalho desse worker. Devolve None
    quando nenhum atendeu, para quem chama cair no processo frio (mesmo resultado, mais lento) em vez de
    falhar. O envelope devolvido traz `porta`, o worker que executou."""
    porta, reserva = reservar_livre(nome, dono=dono, base=base_sha(argv))
    try:
        argv = [str(a) for a in argv]
        if "--work" not in argv:
            argv = argv + ["--work", str(trabalho(nome, porta))]
        envelope = _faixa(nome)["cliente"].run(argv, port=porta)
    finally:
        _liberar(reserva)
    if isinstance(envelope, dict):
        envelope["porta"] = porta
    return envelope


def _imprimir(linhas: list[dict]) -> None:
    print(f"{'porta':>6} {'pe':>4} {'ocup':>5} {'fila':>5} {'serv':>6} {'MB':>6}  dono")
    for l in linhas:
        print(f"{l['porta']:>6} {('sim' if l['de_pe'] else 'nao'):>4} "
              f"{('sim' if l['ocupado'] else 'nao') if l['de_pe'] else '-':>5} "
              f"{l['na_fila'] if l['na_fila'] is not None else '-':>5} "
              f"{l['servidos'] if l['servidos'] is not None else '-':>6} "
              f"{l['mb'] if l['mb'] is not None else '-':>6}  {l['dono'] or ''}")


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="piscina de workers residentes")
    p.add_argument("comando", choices=["estado", "levantar", "parar", "reciclar", "escolher"])
    p.add_argument("--faixa", default="odc", choices=sorted(FAIXAS))
    p.add_argument("--n", type=int, default=4)
    p.add_argument("--dono", default=None)
    p.add_argument("--mb", type=int, default=LIMITE_MB)
    a = p.parse_args()

    if a.comando == "estado":
        _imprimir(estado(a.faixa))
    elif a.comando == "levantar":
        _imprimir(levantar(a.faixa, a.n))
    elif a.comando == "parar":
        print(json.dumps(parar(a.faixa), indent=2))
    elif a.comando == "reciclar":
        print(json.dumps(reciclar(a.faixa, a.mb), indent=2))
    elif a.comando == "escolher":
        print(escolher(a.faixa, dono=a.dono))
