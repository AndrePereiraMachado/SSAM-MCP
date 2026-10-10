# SSAM-MCP

Monorepo do SSAM hospedado, separado em duas caixas para facilitar o deploy:

| Caixa | O que é | Entrega |
| --- | --- | --- |
| [`server/`](server/README-CAIXA.md) | Servidor MCP hospedado: fachada (`ssam serve`), hub do agente, tokens, kernels O11 e ODC, builder ODC, imagem Docker, painel do dono. | Imagem Docker ou servidor Windows. |
| [`agent/`](agent/README-CAIXA.md) | Agente que roda na máquina do cliente: `ssam-agent`, bridge ODC e cliente de attach, bridge O11 fina, gancho de runtime, conector O11, montagem e varredura do pacote. | `ssam-agent.zip` |

Os arquivos que existem nas duas caixas estão em [`SHARED.md`](SHARED.md), com o sha256 e a regra para mantê-los iguais.

## De onde veio

- Repositório: `C:\Users\andre\SSAM-Hybrid-servidor`.
- Branch: `servidor/fase4`.
- Commit: `e7b2119b9287eaaa1f2c95b8510f950feac175f2`.
- Copiado em 2026-10-10 com `git archive` (só arquivos versionados). Nada de `.local`, tokens, `.env` ou dados de clientes.
- Nenhum arquivo copiado foi editado. Os bytes são os da revisão.
- Cada caixa guarda o caminho relativo original. A raiz da caixa é a raiz do repositório antigo. Por isso os links dos
  `.csproj` (`../../../../kernel/...`), os imports `../platforms/odc/facade` e os scripts funcionam sem mudança.
- Contagem: `server/` 5155 arquivos, `agent/` 125, 68 nas duas.
- Atualizado em 2026-10-10 para o 22º envio: `servidor/fase4-22` (`1fbfa377e243cbd3262000089a70456eed623882`), a
  revisão que está no ar. Entraram em `server/` os 68 arquivos de `e7b2119b..1fbfa377` (53 alterados, 15 novos),
  com os bytes da revisão. Ficaram fora, pela mesma regra da cópia: os overlays de `scripts/release` e
  `docs/OPERACOES-O11.md`. `agent/` não muda (bridges, gancho e agente iguais; pacote atual vale).
  `kernel/tests/Shared/ModuleDigestTests.cs` lê `tests/fixtures/hmisjha`, que não está aqui (material de cliente).

## Aviso: o servidor no ar não mudou

O servidor no ar continua rodando do original:
`C:\Users\andre\SSAM-Hybrid-servidor-wt\fase4\facade\ssam.mjs serve --port 7310`, com estado em
`C:\Users\andre\SSAM-Hybrid-servidor-wt\fase3\.local\server`.
Este monorepo não o substitui nem o toca. Para testar a cópia, nunca use a porta 7310 nem aquela pasta de estado.

## Pré-requisitos

- Windows 10/11 e PowerShell 5.1 (scripts `.ps1` e testes do agente).
- Node 22+ (a imagem usa 24). pnpm 11.19.0 (a conferência usou o 11.25.0 que acompanha o Node do Codex).
- .NET SDK 10. Os kernels são net8.0 com `RollForward=Major`.
- Service Studio 11.55.91 e ODC Studio 1.7.27+. O servidor recusa outro Service Studio (`STUDIO_VERSION_MISMATCH`).
- Python 3.11+ só para `scripts/build.ps1` e os testes Python do kernel.
- Não há `global.json` nem `nuget.config`. O SDK e o feed não estão fixados.

## Caixa server

Comandos a partir de `server/`.

### Compilar

```powershell
corepack enable; corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm -C platforms/odc install --frozen-lockfile
dotnet build kernel/src/Anvil.Cli -c Release -nologo -v q -nodeReuse:false -p:SSDir="<Service Studio 11.55.91>" -o kernel/.local/cli
dotnet build kernel/src/Anvil.Cli.Odc -c Release -nologo -v q -nodeReuse:false -p:OdcInstall="<ODC Studio 1.7.27+>" -o kernel/.local/lane-odc/cli
dotnet build platforms/odc/studio/builder/Builder.csproj -c Release -nologo -v q -nodeReuse:false -p:OdcInstall="<ODC Studio>"
# Servidor Windows: a versão da bridge ODC (v48) sai da bridge compilada, se o kernel.json não a fixar.
dotnet build platforms/odc/studio/bridge/Bridge.csproj -c Release -nologo -v q -p:OdcInstall="<ODC Studio>"
dotnet build platforms/odc/studio/bridge/client/Client.csproj -c Release -nologo -v q
```

Alternativa Windows que faz tudo: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-dev.ps1 -Yes -NoUserEnv -SkipInstall -SkipMcp -SkipDoctor`.

### Rodar no Windows

```powershell
$env:SSAM_SERVER_DIR = '<pasta de estado do servidor>'
$env:ANVIL_STUDIO_DIR = 'C:\Program Files\OutSystems\Service Studio 11\Service Studio'
.\scripts\servidor.ps1 start -Port <porta>      # status | stop
node scripts/tunel.mjs start --port <porta>     # túnel rápido cloudflared
.\ssam server-token issue --customer "Nome" --days 30 --lanes "odc,o11"
.\ssam server-token list
.\ssam server-token revoke --id <id>
.\ssam server-token agent-rotate --id <id>
node scripts/dashboard.mjs --dir <pasta de estado> --port 7320
```

Primeiro plano: `node facade/ssam.mjs serve --port <porta> --log-file <pasta de estado>\server.log`.
`SSAM_NO_WARM=1` desliga o warm. `SSAM_BUILD_WORKERS` ajusta o pool.

### Deploy com Docker

1. Coloque em `docker/installers` o instalador oficial ou o studio bundle de cada Studio (veja `docker/installers/README.md`).
   São binários OutSystems: guarde num registro privado.
2. `Copy-Item .env.example .env` e preencha `NGROK_DOMAIN` e `NGROK_AUTHTOKEN`.
3. Antes do build, rode o guarda de nomes de cliente sobre a raiz da caixa:
   `node --test platforms/odc/facade/tests/hosted-image-denylist.test.mjs`.
4. `docker compose build` e `docker compose up -d` (ssam-server em 127.0.0.1:7310 e túnel ngrok).
5. Grave o kernel no volume: `docker compose cp kernel.json ssam-server:/data/server/kernel.json`, com
   `{"o11":"11.55.91","odc":"1.7.27","odcBridge":"v48"}`. No Linux a detecção por versão de exe não roda.
6. Copie `Features.xml` de `%LocalAppData%\OutSystems\ODC Studio` de uma máquina já logada no tenant:
   `docker compose cp Features.xml ssam-server:/data/odc-features/`.
7. Tokens: `docker compose run --rm ssam-admin server-token issue --customer "Nome" --days 30 --lanes "odc,o11"`.

Sem compose: `docker buildx build -f docker/ssam-server/Dockerfile --build-context installers=docker/installers -t ssam-server .`

### Testar

```powershell
pnpm test   # suíte JS inteira
node --test platforms/odc/facade/tests/agent-hub.test.mjs platforms/odc/facade/tests/http-server.test.mjs platforms/odc/facade/tests/server-tokens.test.mjs platforms/odc/facade/tests/fase4-server.test.mjs platforms/odc/facade/tests/fase4-wp-load.test.mjs platforms/odc/facade/tests/hosted-*.test.mjs tests/servidor-ps1.test.mjs tests/tunel.test.mjs
node --test platforms/odc/tests/public-signature-drift.test.mjs
dotnet test platforms/odc/studio/builder/tests/Builder.Tests.csproj -c Release -p:OdcInstall="<ODC Studio>"
dotnet test kernel/tests/Anvil.Tests -c Release -p:SSDir="<Service Studio 11.55.91>"
dotnet test kernel/tests/Anvil.Tests.Odc -c Release -p:OdcInstall="<ODC Studio>"
dotnet test kernel/tests/Anvil.CSharp.Tests -c Release
dotnet test kernel/query-test/tests/QueryTest.Tests.csproj -c Release
Push-Location kernel; python -m unittest discover -s tests -p "test_*.py"; Pop-Location
bash docker/ssam-server/prova-linux.sh   # WSL Ubuntu 24.04
```

## Caixa agent

Comandos a partir de `agent/`, no PowerShell 5.1.

### Compilar e montar o pacote

```powershell
$env:TEMP = 'C:\t\ssam-mcp\tmp'; $env:TMP = $env:TEMP          # TEMP curto: o pack estoura MAX_PATH com TEMP longo
$env:ANVIL_STUDIO_DIR = 'C:\Program Files\OutSystems\Service Studio 11\Service Studio'   # obrigatório nesta caixa
$env:SSAM_NODE = '<node.exe 24 que vai no pacote>'
dotnet build platforms\odc\studio\bridge\Bridge.csproj -c Release -nologo -v q "-p:OdcInstall=C:\Program Files\OutSystems\ODC Studio\ODC Studio"
dotnet build platforms\odc\studio\bridge\client\Client.csproj -c Release -nologo -v q
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent-pack.ps1 -Out <pasta>\ssam-agent.zip -Lanes odc,o11 -NodeLicense <LICENSE do Node>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-ip-scan.ps1 -Zip <pasta>\ssam-agent.zip
```

O `agent-pack.ps1` compila a bridge O11 fina, o `Anvil.RuntimeHook` (como `.Agent`) e o `Anvil.Connect`.
Sem `ANVIL_STUDIO_DIR` ele tenta importar a fachada do servidor, que não está nesta caixa.
Só ODC: `-Lanes odc`. Gancho de release h1: veja `docs/O11-BRIDGE-FINA.md` seção 13.

### Testar

```powershell
$env:ANVIL_WORKER = '0'; $env:ANVIL_ODC_NO_WORKER = '1'; $env:SSAM_ODC_OFFLINE = '1'
node --test agent/tests/*.test.mjs tests/prova-verbos.test.mjs
dotnet test platforms\odc\studio\bridge\tests\Bridge.Tests.csproj -c Release
```

### Instalar no cliente

Guia completo: `agent/docs/AGENTE-CLIENTE.md`. Resumo (pasta sem espaço, fora de `%LOCALAPPDATA%`):

```powershell
Expand-Archive .\ssam-agent.zip -DestinationPath C:\SSAM-Agent
C:\SSAM-Agent\agent\node\node.exe C:\SSAM-Agent\agent\ssam-agent.mjs setup --server https://<host> --root C:\SSAM-Agent
powershell -ExecutionPolicy Bypass -File C:\SSAM-Agent\agent\ssam-agent.ps1 start    # status | stop
C:\SSAM-Agent\agent\node\node.exe C:\SSAM-Agent\agent\ssam-agent.mjs doctor --root C:\SSAM-Agent
```

## Compatibilidade entre as caixas

- `pack.json` do agente: `odcBridge` tem de ser o `kernel.odcBridge` do servidor (hoje v48, aceita v45).
- `o11BuiltFor` tem de ser o Service Studio do kernel do servidor (hoje 11.55.91).
- Senão o hub responde `AGENT_PACK_MISMATCH`. Um bump de bridge mexe nas duas caixas no mesmo commit.

## Conferência de 2026-10-10

Feita na máquina do dono, com ambiente isolado (`ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_NO_WARM=1`, TEMP,
caches de NuGet e pnpm em `C:\t\ssam-mcp`). Service Studio 11.55.91 e ODC Studio 1.7.27.

Caixa server:

- `pnpm install --frozen-lockfile` na raiz e em `platforms/odc`: ok.
- `Anvil.Cli` (O11), `Anvil.Cli.Odc`, `Builder.csproj`, `Bridge.csproj` (v48) e `Client.csproj`: compilam, 0 erros.
- `Builder.Tests`: 7/7.
- Linha do servidor (agent-hub, http-server, server-tokens, fase4-*, hosted-*, servidor-ps1, tunel, public-signature-drift):
  163 testes, 154 passam, 1 pula, 8 falham.
- O pulo é `hosted-e2e`: ele precisa de `agent/ssam-agent.mjs`, que está na outra caixa.
- As 8 falhas vêm todas da falta de `platforms/odc/tenants.json` (veja abaixo). Com uma cópia temporária do original,
  `hosted-tools` e `http-server` passaram 23/23. A cópia foi apagada.
- `scripts/examples-odc-matrix.mjs --check` falha igual na revisão original: a `matriz.json` de `e7b2119b` está
  desatualizada (436 contra 438 linhas).

Caixa agent:

- `Bridge.csproj` (ODC3.Bridge.v48), `Client.csproj`, `Anvil.Bridge.Thin`, `Anvil.RuntimeHook` (.Agent) e
  `Anvil.Connect`: compilam, 0 erros.
- `Bridge.Tests`: 149/149.
- `agent/tests` e `tests/prova-verbos.test.mjs`: 69 testes, 68 passam, 1 falha. A falha (bloco congelado de
  `o11-wire.mjs` contra `o11-bridge.mjs`) acontece igual na worktree original: a revisão já tinha essa deriva.
- `agent-pack.ps1 -Lanes odc,o11`: pacote com 38 arquivos, `odcBridge` v48, `o11BuiltFor` 11.55.91, gancho dev.
- `pack-ip-scan.ps1` sobre o ZIP: ok, nenhum achado.

## O que ficou fora das duas caixas

- `publisher/` (publicador do dono) e `scripts/release/**`, exceto `client-content.json`.
- Linha de release: `SSAM.License`, `SSAM.Runtime`, `SSAM.Prompt` e os testes deles, mais 7 testes de release em
  `platforms/odc/tests`.
- `kernel/tests/Anvil.Bridge.Thin.Tests`, `kernel/tools/Anvil.Connect.Tests`, `kernel/tests/RuntimeConnect` e
  `tests/runtime-connect.integration.mjs`. Precisam do kernel e de `scripts/release/overlay` juntos.
- `platforms/odc/tenants.json`: lista de tenants da máquina do dono, com tenants de clientes.
- Material com nome de cliente no caminho (capturas wrightflood e hmisjha, DCIPS), features do builder, `platforms/odc/jobs`.
- Histórico: `docs/evidence` (menos os dois inventários lidos pelo código), planos, handoffs, medições, `kernel/tests/archive`.
- Bench (`scripts/bench`, `tests/bench`), `scripts/prove-reading.mjs`, `gen_tracks_agentes.py` (vazio).

## O que falta para o deploy

- O build Docker e o runtime Linux ainda não foram provados, nem no original.
- `server/kernel/Anvil.slnx` ainda lista `Anvil.Bridge.Thin` e `Anvil.Bridge.Thin.Tests`. Compile os projetos um a um.
- Os `.mcp.json` versionados apontam para `C:\Users\andre\SSAM-Hybrid`. Regenere com `node scripts/configure-mcp.mjs`.
- O modo local (`--local-studios`) e 8 testes precisam de um `platforms/odc/tenants.json`. O modo hospedado não precisa.
- Os testes entre caixas pedem um job de CI no nível do monorepo: `hosted-e2e`, o teste de deriva do agente e
  `Anvil.Bridge.Thin.Tests`.
- A bateria completa do kernel (`Anvil.Tests`, `Anvil.Tests.Odc`) não rodou aqui. Parte dela lê capturas de cliente que
  ficaram de fora.
- `server-identity.mjs` e `configure-mcp.mjs` leem `<raiz>/.git`. Numa subpasta do monorepo o `gitHead` sai null.
- O commit é local. O push é decisão do dono.
