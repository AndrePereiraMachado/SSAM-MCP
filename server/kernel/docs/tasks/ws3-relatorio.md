# WS3 — relatório final (formato 1.7 do plano)

```
WS3 Fachada e MCP únicos, documentação unificada — estado: concluído
Branch/pasta: ws/3-lanes em C:\Users\andre\Anvil-ws3 (commit 43396ad, de anvil 53ef2cb)
              + C:\Users\andre\SSAM-Hybrid-ODC (sem git; arquivos novos e duas secções acrescentadas)
Tarefas: [x] T1 tabela das faixas e run/command  [x] T2 ssam <verbo> --lane / ssam doctor
         [x] T2a ssam mcp com as ferramentas das duas faixas  [x] T3 lanes.test.mjs
         [x] T4 run_job.py --lane odc (documentado, "not available yet" até WS1 e WS2)
         [x] T5 HANDOFF secção "Faixas" + docs\lanes.md no Anvil
Tempo: 01:40
```

## Pré-condições

```
node --test facade\tests\mcp.test.mjs
  ✔ facade serves studio_* and odc_* tools on one stdio server (7030.0876ms)
  ℹ tests 1  ℹ pass 1  ℹ fail 0

python scripts\run_job.py --help
  usage: run_job.py [-h] [--base BASE] [--out OUT] [--producer Name=oml] [--quiet] job
  (nota: não há `python` no PATH desta máquina; o interpretador usado é o do runtime do Codex,
   C:\Users\andre\.cache\...\dependencies\python\python.exe, como o odc.cmd faz com o Node)
```

## Provas por tarefa

**T1 a T3 — `node --test facade\tests\lanes.test.mjs`**

```
✔ each verb builds the lane command line, without running anything (2.5121ms)
✔ the ssam MCP server lists the tools of both lanes (1256.5378ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ duration_ms 1523.0412
```

**T2a — `ssam mcp` por stdio real** (`node lab\ws3-lanes\ssam-stdio-check.mjs`, no SSAM-Hybrid-ODC)

```
tools=40
studio_doctor, studio_attach, studio_status, studio_wait, studio_assets, studio_consumers, studio_deliver,
studio_data, studio_data_insert, studio_data_update, studio_data_delete, studio_open, studio_close,
studio_snapshot, studio_latest, studio_refresh_references, studio_dismiss_dialog, studio_build, studio_inspect,
studio_check_base, studio_preview, studio_merge, studio_authorize, studio_publish, studio_create, studio_command,
odc_status, odc_portal_capabilities, odc_describe_capability, odc_list_apis, odc_search_operations,
odc_describe_operation, odc_read, hybrid_tenants, context, propose, continue, status, o11_job, ssam_doctor
stderr=""
```

As 34 primeiras são a faixa ODC, tal como `.\odc mcp` as serve; `context`, `propose`, `continue` e `status` vêm do
MCP do Anvil (`scripts\ssam_app.py`); `o11_job` e `ssam_doctor` são da fachada. Nenhum nome se repete entre as
faixas, por isso nenhuma ferramenta precisou do argumento `lane` (o código adiciona-o quando houver repetição).

**T4 — `python scripts\run_job.py --lane odc tests\jobs\spec-data.json`** (em `Anvil-ws3`)

```json
{
  "ok": false,
  "lane": "odc",
  "job": "tests\\jobs\\spec-data.json",
  "delegatesTo": "C:\\Users\\andre\\SSAM-Hybrid-ODC\\ssam.cmd deliver --lane odc <feature>",
  "error": "not available yet",
  "why": "run_job.py aplica um job de verbos do Anvil sobre um fixture; na faixa ODC quem aplica e o Adapters.ODC (WS1 headless, WS2 sessao), que ainda nao fechou.",
  "next": "fechados WS1 e WS2, esta opcao passa a executar a linha acima; hoje, para entregar no ODC use C:\\Users\\andre\\SSAM-Hybrid-ODC\\odc.cmd deliver <feature>, ou ssam deliver --lane odc <feature>.",
  "docs": "docs/lanes.md"
}
exit=1
```

Sem `--lane`, o `run_job.py` continua exatamente como era (mesma saída, mesmo caminho de código).

**Pronto quando — `ssam doctor` nas duas faixas** (`ANVIL_ROOT=C:\Users\andre\Anvil`)

`.\ssam.cmd doctor --lane o11` (recortado):

```json
{ "ok": false, "lanes": { "o11": {
  "lane": "o11", "platform": "OutSystems 11 (Service Studio)", "root": "C:\\Users\\andre\\Anvil",
  "anvilLane": { "name": "ss5", "bridge": 4536, "cdp": 9246, "worker": 4537,
    "studioDir": "C:\\Users\\andre\\OutSystems\\Service Studio 11 - Anvil 4536\\Service Studio",
    "studioExists": true, "cli": "C:\\Users\\andre\\Anvil\\.local\\lane-ss5\\cli\\anvil.dll" },
  "cli": { "path": "C:\\Users\\andre\\Anvil\\.local\\lane-ss5\\cli\\anvil.dll", "built": true },
  "studio": { "image": "ServiceStudio.exe", "lane": "ss5", "open": false, "pids": [], "otherInstallations": [11024] },
  "catalog": { "file": "C:\\Users\\andre\\Anvil\\.local\\lane-ss5\\inventory.json", "listed": false, "modules": [],
    "hint": "dotnet <cli> inventory --out <.local dir> writes inventory.json with the modules of the connected environment" },
  "ok": false, "hint": "scripts\\open_studio.ps1 -Lane ss5" } } }
```

`.\ssam.cmd doctor` (as duas, recortado):

```
ok=False
studiosOpen: {"o11":false,"odc":true}
o11: cli.built=True studio.open=False catalog.listed=False hint=scripts\open_studio.ps1 -Lane ss5
odc: cli.built=True studio.open=True catalog=57 modules @ wrightflood.outsystems.dev
odc checks:
  dotnet: ok=True
  bridge built: ok=True
  bridge client built: ok=True
  builder built: ok=True
  ODC Studio running: ok=True
  bridge attached: ok=False
  asset catalog: ok=False
  portal personal-nv0s5uly.outsystems.dev: ok=False
  portal wrightflood.outsystems.dev: ok=True
  journal: ok=True
```

`ok=false` é o estado real da máquina, não uma falha da fachada: o Service Studio da faixa SS5 não está aberto
(há um ServiceStudio.exe de outra instalação, pid 11024), o bridge do ODC não está anexado ao Studio aberto
(pid 24640) e não há credencial do Portal para o tenant pessoal. A fachada reporta o que cada faixa diz.

**Regressão** — `node --test facade\tests\mcp.test.mjs` depois de tudo: `ℹ tests 1  ℹ pass 1  ℹ fail 0`.

## Arquivos criados/alterados

No `C:\Users\andre\SSAM-Hybrid-ODC` (sem git):

| Arquivo | O quê |
|---|---|
| `facade\lanes.mjs` | novo: a tabela das faixas, `command(lane, verbo, args)` (monta e não executa), `run` (monta e executa), `catalog`, `laneOfModule`, `studioProcesses`, `anvilLaneFacts` |
| `facade\ssam.mjs` | novo: `ssam <verbo> --lane`, dedução da faixa pelo módulo, `ssam doctor` das duas, `ssam mcp` (`createSsamServer`) |
| `facade\tests\lanes.test.mjs` | novo: linha de comando de cada verbo nas duas faixas sem executar; o servidor MCP sobe e lista as duas faixas |
| `ssam.cmd` | novo, na raiz, com a mesma resolução de Node do `odc.cmd` |
| `docs\HANDOFF.md` | **só acrescentada** a secção 5.12 "Faixas" (antes da secção 6); nada mais mudou |
| `docs\mcp-registration.md` | **só acrescentada** a secção "`ssam`: as duas faixas num servidor só" e duas linhas em "Verificar" |
| `lab\ws3-lanes\ssam-stdio-check.mjs` | evidência da prova por stdio (pasta de evidências do WS3, como manda 1.4) |
| `lab\ws3-relatorio.md` | cópia deste relatório |
| `docs\PROGRESSO-UNIFICACAO.md` | linha do WS3 e entrada de diário (obrigatório por 1.4.7) |

No `C:\Users\andre\Anvil-ws3` (commit `43396ad`):

| Arquivo | O quê |
|---|---|
| `scripts\run_job.py` | só `--lane {o11,odc}`: `odc` devolve o JSON de T4 e sai; `o11` é o caminho de sempre, intocado |
| `docs\lanes.md` | novo: aponta para a secção "Faixas" do HANDOFF e separa "faixa do Studio (ss4/ss5)" de "faixa de plataforma (o11/odc)" |

`git diff --stat anvil` em `Anvil-ws3`: `docs/lanes.md | 49 +`, `scripts/run_job.py | 33 +, 1 -` — nenhum arquivo
fora da lista do brief. `odc.mjs`, `lib.mjs`, `mcp.mjs`, `AGENTS.md` e `CLAUDE.md` não foram tocados.

## Fora do brief

Dois acréscimos, ambos exigidos por outra parte do próprio brief ou da secção 1:

- `docs\mcp-registration.md`, secção `ssam`: pedida literalmente pelo T2a, embora o arquivo não esteja na lista
  "Arquivos seus". Só acrescentei a secção.
- `docs\PROGRESSO-UNIFICACAO.md` e `lab\ws3-*`: exigidos pela secção 1.4 (itens 4 e 7) e pelo próprio
  PROGRESSO ("Como retomar", passo 5).

Nada mais. Nenhum arquivo do Anvil fora de `scripts\run_job.py` e `docs\lanes.md`.

## Duas correções ao brief, decididas pelo integrador antes de eu implementar

Estavam na secção 1.4 ("se algo não bater com o código, pare e reporte"); perguntei e o integrador corrigiu o
plano na mesma sessão (diário de 21:20):

1. `scripts\anvil_cli.py` **não é** o CLI da faixa O11: é biblioteca, sem `__main__`. O CLI é
   `dotnet <.local[\lane-ss5]\cli>\anvil.dll`, resolvido na mesma ordem do `scripts\lanes.py`.
2. O CLI do Anvil não tem os verbos `doctor`, `data` nem `publish` (`src\Anvil.Cli\Program.cs`, linhas 130-180).
   `doctor` passou a ser composto pela fachada nas duas faixas; `data` e `publish` recusam em O11 com a
   alternativa escrita (dados por `records` numa op `spec`; publicar é passo do humano no Studio), nunca só
   "não disponível".

## Dúvidas para o integrador

1. **`snapshots\modules.json` tem BOM.** O `readJson` do `facade\lib.mjs` rejeita-o, e por isso o próprio
   `.\odc doctor` reporta `asset catalog: ok=false` com o arquivo presente e válido. O `facade\lanes.mjs` tira o
   BOM antes de ler (por isso `ssam doctor` mostra os 57 módulos). `lib.mjs` não é arquivo meu: a correção de uma
   linha (`.replace(/^\uFEFF/, '')` em `readJson`) fica para quem o tem.
2. **`propose` do O11 pelo MCP `ssam`.** O `scripts\ssam_app.py` fixa o contrato do módulo por *elicitation*, e o
   proxy não declara essa capacidade porque não a consegue honrar: o protocolo 2026-07-28 substituiu o pedido
   servidor→cliente por rondas `input_required`, que um proxy não repassa entre eras. Pelo `ssam mcp`, `propose`
   devolve a frase do próprio servidor O11 ("Client does not support user contract acceptance; controlled
   delivery remains blocked"); as outras três ferramentas O11 e todas as do ODC passam normalmente. Se o INT
   precisar de `propose` na sessão fria, a saída hoje é registar também o `ssam_hybrid` (`scripts\ssam_app.py`)
   à parte — o que contraria 1.1a. Decidir se isso vira um brief novo.
3. **Catálogo do O11.** O brief dizia "`catalog\` no Anvil", mas `catalog\` guarda o Model API e os blocos de UI,
   não módulos. Usei `.local[\lane-ss5]\inventory.json` (o que `anvil inventory --out` escreve). Enquanto esse
   arquivo não existir, `ssam <verbo> <Módulo>` sem `--lane` recusa nomeando o comando que o cria, em vez de
   adivinhar a faixa. Confirmar se é a fonte certa.
4. **Raízes absolutas.** `ANVIL_ROOT`, `ANVIL_LANE` e `SSAM_HYBRID_ODC_ROOT` sobrepõem as raízes da tabela, para
   a sessão poder correr num worktree e para o passo 7 do INT (mover o ODC para `platforms\odc`) não exigir
   editar `lanes.mjs`. Os valores por omissão são os do brief.
