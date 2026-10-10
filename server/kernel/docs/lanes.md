# Faixas: O11 e ODC numa sessão só

Duas coisas diferentes se chamam "faixa" neste repositório, e é preciso não as confundir:

- **Faixa do Studio (O11)**: `ANVIL_LANE=ss4|ss5`, de `scripts/lanes.py` — duas instalações do Service Studio, duas
  bridges, dois workers, duas pastas `.local`, para que duas sessões trabalhem em paralelo na mesma plataforma.
  Continua exatamente como está descrito em `AGENTS.md`, secção 5. Nada disso muda.
- **Faixa de plataforma (`--lane o11|odc`)**: qual produto recebe a entrega — o OutSystems 11 (este repositório) ou
  o OutSystems Developer Cloud (`C:\Users\andre\SSAM-Hybrid-ODC`). É deste segundo sentido que trata este arquivo.

Uma sessão aberta na raiz controla as duas plataformas por um comando só e um servidor MCP só, sem trocar de pasta
nem de prompt. A entrada é o `ssam` do SSAM-Hybrid-ODC:

```powershell
C:\Users\andre\SSAM-Hybrid-ODC\ssam.cmd doctor                       # as duas faixas lado a lado
C:\Users\andre\SSAM-Hybrid-ODC\ssam.cmd job --lane o11 tests\jobs\<job>.json
C:\Users\andre\SSAM-Hybrid-ODC\ssam.cmd deliver --lane o11 --module Headless_UI --job tests\jobs\<job>.json
C:\Users\andre\SSAM-Hybrid-ODC\ssam.cmd mcp                          # um MCP com as ferramentas das duas faixas
```

**A referência completa é a secção 5.12 "Faixas" de `C:\Users\andre\SSAM-Hybrid-ODC\docs\HANDOFF.md`**: a tabela
verbo a verbo, como a faixa é deduzida pelo módulo, e o que é comum e o que é próprio de cada plataforma. Este
arquivo existe para que uma sessão aberta no Anvil saiba que a outra faixa existe e onde está a referência.

O que a fachada faz do lado do O11, e só isso:

| Verbo `ssam` | Vira, na faixa o11 |
|---|---|
| `inspect`, `deliver` | `dotnet <.local[\lane-ss5]\cli>\anvil.dll <verbo> ...` (a mesma resolução do `scripts/lanes.py`) |
| `job` | `python scripts/run_job.py <job>` (na faixa odc, o mesmo script com `--lane odc`) |
| `doctor` | `python scripts/lanes.py <faixa> --json` mais o Service Studio aberto naquela instalação |
| `data`, `publish` | recusa: dados entram por `records` numa op `spec`; publicar é passo do humano no Studio |

`scripts/anvil_cli.py` é biblioteca (sem entrypoint) e não é o CLI da faixa. `ANVIL_ROOT` e `ANVIL_LANE` dizem à
fachada qual raiz e qual faixa do Studio usar; num worktree, aponte `ANVIL_ROOT` para ele. Resolução da faixa do
Studio na fachada (regra única, `platforms/odc/facade/workspace.mjs`, 23/09/2026): `ANVIL_LANE` explícito prevalece;
sem ele, `o11Lane` de `.ssam-workspace.json` da raiz (hoje `ss4`); sem nenhum dos dois a fachada recusa e diz o que
falta. `scripts/lanes.py` e o CLI continuam com `ss4` por valor fixo quando a variável está vazia: o mesmo valor, por
mecanismo diferente.

## `run_job.py --lane odc` e o CLI `anvil-odc`

Desde 17/09/2026 (WS1 fechado) a faixa ODC tem o seu próprio CLI: `src/Anvil.Cli.Odc` (`anvil-odc`), o **mesmo
kernel** compilado contra o ODC Studio (`src/Anvil.Core.Odc`). O CLI do O11 (`anvil`) não serve aqui, porque o seu
`Program.cs` usa tipos só-SS11 (`HeadlessSession`, `Publisher`, `BridgeClient`, `MergeProbe`).

```powershell
python scripts/build_odc.py                                            # constrói a faixa ODC e deixa o worker de pé
python scripts/run_job.py tests\jobs-odc\screen-basic.json --lane odc   # aplica o job e imprime o mesmo resumo
```

`run_job.py --lane odc` manda o job ao **worker residente** da faixa (abaixo) e, se ele não estiver disponível, roda
um processo frio com o mesmo resultado. O resumo sai no formato da faixa O11 (ops, isValid, validação, timings,
`result.json` ao lado do `.oml`). O trabalho fica em `.local/lane-odc/`. Entregar ao Studio aberto é outro verbo, como
no O11: `anvil-odc deliver` (ou `ssam deliver --lane odc`).

### O worker residente da faixa ODC

`anvil-odc serve --port 4547` é o mesmo desenho do `anvil serve` da faixa O11: uma linha JSON por pedido em
`127.0.0.1`, o mesmo Dispatch em processo, com as DLLs do ODC Studio já ligadas e o provedor de features já
inicializado. Sem ele, cada job paga de novo esse arranque.

| Caminho | Tempo do mesmo job (`html-visual-alert`, módulo de 59 667 objetos) |
|---|---|
| Processo frio (sem worker) | 13 a 14 s, toda vez |
| Primeiro pedido num worker novo | ~15 s (JIT e primeira carga) |
| Pedidos seguintes | **~3 s** (5 s quando o job encadeia outro job como base) |

Como na faixa O11, **cada `apply` carrega a base do zero**: não há estado de modelo entre pedidos. Os ~2,7 s que
sobram são a carga de um OML de 6,5 MB, e são por desenho, não desperdício.

O cliente é `scripts/odc_worker.py` (`ping`, `ensure`, `stop`, ou `apply ...` direto), e ele usa a mesma credencial
local do worker do O11 (`BridgeAccess`). Com o worker de pé o build falha com as DLLs presas, por isso construa
sempre por `python scripts/build_odc.py`, que para o worker, constrói e o levanta de novo. Para desligar:
`python scripts/odc_worker.py stop`; para rodar sem worker: `ANVIL_ODC_NO_WORKER=1`.

Comandos do `anvil-odc`, um envelope JSON por comando (`{ok, command, elapsedMs, data}`, igual ao da faixa O11):

| Sem Studio aberto (kernel) | Com o ODC Studio aberto (bridge) |
|---|---|
| `apply --job <j> --out <oml> [--base <oml>] [--producer N=<oml>]` | `status` |
| `check-job --job <j>` | `snapshot --module <M>` |
| `create-blank --kind <SegmentationKind> --name <N> --out <oml> [--connection ai-model\|mcp\|knowledge-base:<Nome>]...` (módulo em branco de outro tipo, offline: Mobile, BusinessProcess, AIAgent, AgentDefinition...; as fixtures `tests/fixtures/odc/blank-*.oml`) | |
| `create-app --kind reactive\|mobile\|library\|mobile-library --name <App> --out <dir> [--module <M>] [--template-oml <oml> --template-key <k>] [--color #RRGGBB] [--description <t>] [--icon <png>] [--tenant <host>] [--author <email>] [--plugins-dir <dir>]` (app nova como o Create app do Studio: clone do template ou `ESpace.Create` da library; grava OML, recibo e manifesto de criação; MCP `studio_create_app`) | |
| `inspect --oml <m.oml>`, `references --oml <m.oml>` | `merge --manifest <m.json>` |
| `verify-catalog [--id <VerifyId>] [--out <f>]` (as definições do ODC instalado; `--out catalog/odc/verify-messages-<versão>.json` grava só os ids, o manifesto de `expectedMessages` desta faixa) | `deliver --module <M> --job <j> --evidence <dir> --feature <n> --owners <a,b> --change "<texto>"` |
| `api --op logic\|spec\|screen\|html\|html-visual\|verbs` (`verbs` = a tabela dos verbos crus, a mesma que `ModelSession.ApplyOne` impõe a cada op via `VerbSurface.Check`, mais a gramática de referências, curada; `SurfaceTests` prende os nomes ao dispatcher e todas as ops das suítes ao contrato) | `refresh --consumer <C> [--producer <P>]`, `publish --manifest <m> --authorization "<texto>"` |
| `serve [--port 4547] [--log-dir <dir>]`, `ping`, `gc` | |

`publish` recusa sem `--authorization`: o texto é o que o dono escreveu, nunca inventado. Códigos de saída:
0 ok, 1 recusado (o JSON diz porquê), 2 uso, 3 transporte do bridge, 4 erro.

## MCP

`ssam mcp` serve, no mesmo servidor stdio, as ferramentas da faixa ODC (`studio_*`, `odc_*`, `hybrid_tenants`) e as
da faixa O11 (`context`, `propose`, `continue`, `status` de `scripts/ssam_app.py`), mais `o11_job`, `ssam_job`
(o mesmo runner com `lane: o11|odc`) e `ssam_doctor`.
Registre `ssam` **ou** o servidor de uma faixa só, nunca os dois ao mesmo tempo. Receita de registro:
`C:\Users\andre\SSAM-Hybrid-ODC\docs\mcp-registration.md`, secção "ssam".
