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
- Nenhum arquivo copiado foi editado: os bytes são os da revisão. A única exceção é `server/.dockerignore`, que ganhou
  no fim o bloco do deploy de produção (veja "Deploy de produção").
- São do SSAM-MCP, e não vêm da linha do servidor:
  - `server/README-CAIXA.md`;
  - `server/Dockerfile` (imagem de produção);
  - `server/deploy/` (compose de produção, Caddy, backup e o runbook `DEPLOY.md`).
- Cada caixa guarda o caminho relativo original. A raiz da caixa é a raiz do repositório antigo. Por isso os links dos
  `.csproj` (`../../../../kernel/...`), os imports `../platforms/odc/facade` e os scripts funcionam sem mudança.
- Contagem: `server/` 5155 arquivos, `agent/` 125, 68 nas duas. É a contagem da cópia, sem os arquivos do SSAM-MCP.
  No 24º (`server/r24`): `server/` 6054, `agent/` 145, 76 nas duas.
- Atualizado em 2026-10-10 para o 22º envio: `servidor/fase4-22` (`1fbfa377e243cbd3262000089a70456eed623882`), a
  revisão que está no ar. Entraram em `server/` os 68 arquivos de `e7b2119b..1fbfa377` (53 alterados, 15 novos),
  com os bytes da revisão. Ficaram fora, pela mesma regra da cópia: os overlays de `scripts/release` e
  `docs/OPERACOES-O11.md`. `agent/` não muda (bridges, gancho e agente iguais; pacote atual vale).
  `kernel/tests/Shared/ModuleDigestTests.cs` lê `tests/fixtures/hmisjha`, que não está aqui (material de cliente).
- Atualizado em 2026-10-12 para o 24º envio, na branch `server/r24`: `servidor/fase4-24`
  (`a945838be7410f36959e7c13260e9a7beef28cf4`), que nasceu de `servidor/fase4-23-linux` (`b37715e1`, o 23º com as
  quatro correções de Linux). O Texto do SSAM não está nele (vai num 24.1).
  - Antes da cópia entraram por merge as duas branches do SSAM-MCP: `server/o11-worker-hospedado` (`9661871`, worker O11
    por cliente e as variáveis dele no deploy) e `server/console` (`476125e1`, o painel do dono em `server/deploy/console`).
  - `b37715e1..a945838b` tem 1540 caminhos (1204 novos, 336 alterados, nenhum apagado). Entraram 1199, com os bytes da
    revisão (blob por blob, sem conversão de fim de linha): 1224 entradas nas caixas, 1197 em `server/` e 27 em `agent/`,
    sendo 26 nas duas. O `server/.dockerignore` é a versão da linha mais o bloco final do SSAM-MCP.
  - Ficaram fora 341, pela regra da cópia: 12 de `scripts/release`; 3 de `kernel/tests/Anvil.Bridge.Thin.Tests`;
    `platforms/odc/tests/client-content.test.mjs` (teste de release); e o histórico de `docs/` (provas ao vivo, propostas,
    passagens de bastão e planos): `docs/PORTAL-*`, `docs/SC-*` (menos `docs/SC-PORTAL-USO.md`, o guia de uso),
    `docs/HANDOFF-*`, `docs/DEBUGGER-*`, `docs/PACOTE-*` e `docs/OPERACOES-O11.md`. A linha também tira esses docs da
    imagem (`.dockerignore`). Entraram `docs/PROTOTIPO-NATIVO.md` (o desenho do importador, citado pelo kernel) e
    `docs/FLUXO-O11.md`.
  - Conferido: os 6193 arquivos das duas caixas que vêm da linha (fora os do SSAM-MCP e o `.dockerignore`) têm o mesmo
    blob de `a945838b`, inclusive os quatro arquivos de Linux e os do worker O11.
  - Depois, `a945838b..a415531d` (`a415531d2591bdc0c80400fc7d20b179f9653ed3`): os caminhos dentro de um job hospedado
    ficam no workspace do cliente, o lock de partida do worker nomeia a instância do processo (pid reaproveitado sob o
    `docker-init`), os testes que rodam o código do agente pulam quando a caixa agent não está ao lado, o arquivo de job
    que o portão não lê inteiro vira `JOB_PATHS_UNCHECKED` e os documentos de integração só vêm do workspace do cliente e
    de URLs públicas. São 14 caminhos (5 novos, 9 alterados), 15 entradas: todos em `server/`, e `docs/FASE2-AGENTE.md`
    também em `agent/` (hash novo no `SHARED.md`). Conferido de novo: os 6198 arquivos das duas caixas que vêm da linha
    têm o mesmo blob de `a415531d`.
- Atualizado em 2026-10-12 para o ODC Studio 1.7.28, na branch `server/r24-odc1728` (de `a857a1ef`, a produção):
  `fase4-24/odc1728`, `a415531d..c48074be` (`f912cb7e`: ODC Studio 1.7.28.10850 e bridge ODC v97; `c48074be`: tira um
  nome de cliente de `docs/SERVIDOR-FASE4.md`, que a guarda do build recusava).
  - 48 caminhos (1 novo, 47 alterados, nenhum apagado). Entraram 47, com os bytes da revisão: 52 entradas, 39 em
    `server/` e 13 em `agent/`, sendo 5 nas duas (`docs/FASE2-AGENTE.md`, `docs/PROVAS-AO-VIVO.md`, `Bridge.csproj`,
    `StartupHook.cs` e `client/Program.cs`, com hash novo no `SHARED.md`). Os testes do agente e
    `docs/AGENTE-CLIENTE.md` só em `agent/`; o catálogo novo `kernel/catalog/odc/verify-messages-1.7.28.10850.json` em
    `server/`.
  - Ficou fora 1, pela regra da cópia: `scripts/release/license/weave-spec.json`.
  - Conferido: os 6199 arquivos das duas caixas que vêm da linha têm o mesmo blob de `c48074be`. Contagem: `server/`
    6055, `agent/` 145, 76 nas duas.
- Atualizado em 2026-10-12 na branch `server/r24-qualidade` (de `server/r24` em `a857a1e`): o registro de qualidade
  (`ssam-quality/1`). Para cada cliente hospedado, só códigos, contagens e tempos: o motivo de cada recusa por código de
  problema, as correções automáticas do motor por regra, o tempo de cada fase da entrega e a sequência de chamadas de cada
  sessão (com o intervalo parado entre elas), mais a aba Qualidade do painel, que soma tudo de todos os clientes.
  - Antes da cópia entrou por merge `server/console-qualidade` (`2682709a`): a aba Qualidade em `server/deploy/console`,
    a rotação e a retenção dos `quality-*.jsonl` e as notas do `DEPLOY.md`.
  - Depois, `a415531d..3262c49f` de `fase4-24/qualidade` (`3262c49fafabd95b44442f78061392f3ea2ed200`, 6 commits): 32
    caminhos (21 novos, 11 alterados, nenhum apagado), 32 entradas: 31 em `server/` e `docs/AGENTE-CLIENTE.md` (o
    parágrafo de privacidade do registro) só em `agent/`, onde o guia do cliente está. Nada ficou fora pela regra da
    cópia; o `SHARED.md` não muda (nenhum arquivo compartilhado mudou).
  - Conferido: os 6219 arquivos das duas caixas que vêm da linha têm o blob de `3262c49f`. As quatro cópias do contrato
    `quality-line.mjs` (fachada, painel e as duas pastas de fixtures) têm o sha256 LF `95d2962a…557d` do desenho.
  - Contagem: `server/` 6075, `agent/` 145, 76 nas duas.
  - Depois, `3262c49f..01795e52` de `fase4-24/qualidade` (`01795e523aa9ba1d4f9c5aa34059cb6aa9819385`, 1 commit, achado de
    privacidade de 2026-10-12): o `command` de `studio_command`, texto do modelo com forma de verbo, chegava ao registro
    (`agent.top`), ao `server.log` e à exportação `linhas` do painel. Os verbos das chamadas ao agente agora saem só das
    listas fechadas que o agente aplica (`AGENT_VERBS` do contrato). 14 caminhos alterados, todos em `server/` (nenhum
    novo, nenhum apagado, nenhum compartilhado; o `SHARED.md` não muda), copiados com os blobs da revisão
    (`C:\t\qual\priv\copy-priv.cjs`). O painel ganhou a mesma cópia do contrato, das fixtures e da paridade. As quatro
    cópias de `quality-line.mjs` têm agora o sha256 LF `200f74ce…ec6c8`.
  - Depois, `01795e52..c24d468d` de `fase4-24/qualidade` (`c24d468d97b9e5216725f75581482547e9485039`, 1 commit, os três
    achados baixos da mesma revisão de privacidade): (1) os códigos, os códigos de problema e as regras das normalizações só
    ficam quando estão nos registros `CODES` e `RULES` do contrato, gerados das fontes do produto
    (`platforms/odc/scripts/quality-registry.mjs`, com teste de deriva); fora deles viram `CODE_UNLISTED` ou
    `RULE_UNLISTED`, contados, nunca o texto; o `debug_<x>` do texto de uma resposta só vira código no depurador, que o
    servidor hospedado não serve; a auditoria usa o mesmo registro; (2) a seção "Privacidade" de
    `docs/AGENTE-CLIENTE.md` diz exatamente o que é gravado, por categoria, com a retenção configurável, quem vê (só o
    dono) e os fatos do `server.log` sobre a máquina do agente; (3) uma expressão mudada por duas regras conta nas duas
    em `norm.byRule`. 22 caminhos (3 novos, 19 alterados, nenhum apagado), 22 entradas: 21 em `server/` e
    `docs/AGENTE-CLIENTE.md` só em `agent/`; nenhum compartilhado (o `SHARED.md` só cita a revisão). Copiados com os blobs
    da revisão (`C:\t\qual\baixos\copy-baixos.cjs`, que também põe os caminhos novos em `server/`). O painel ganhou a
    mesma cópia do contrato e das fixtures, a paridade nova, os testes do dia hostil com as palavras do cliente em campos
    de código e os mocks do cenário `problemas` sem códigos fora do registro. As quatro cópias de `quality-line.mjs` têm
    agora o sha256 LF `cc4440f9…ad239`.
  - Conferido: os 6222 arquivos das duas caixas que vêm da linha têm o blob de `c24d468d`. Contagem: `server/` 6078,
    `agent/` 145, 76 nas duas.
  - Depois, `c24d468d..1b2ce8fe` de `fase4-24/qualidade` (`1b2ce8feadc3a964ddd8611ad2f5dff71d8ef7c1`, 1 commit, os dois
    achados médios da reconferência da mesma revisão de privacidade): (1) os códigos que o produto compõe em tempo de
    execução viravam `CODE_UNLISTED` (uma recusa de preflight com `SET_INVALID` e `SPEC_INVALID` ficava
    `{CODE_UNLISTED: 2}`); o gerador `platforms/odc/scripts/quality-registry.mjs` agora compõe cada família da própria
    fonte, pela regra de quem a compõe: `<VERBO>_INVALID` de cada verbo e operação do kernel e `OP_INVALID`,
    `<OP>_REFUSED` de `rest`, `rest-expose` e `soap`, o código que o formatador dá a cada palavra de `failed`, `stage` e
    `gate` das fontes e `PUBLISH_<GATE>`; (2) `kernel/query-test`, compilado nas duas bridges, não era lido, e os 18
    `QUERY_TEST_*` do `ssam_query_test` hospedado viravam `CODE_UNLISTED`; a pasta entrou nas raízes, e o teste de deriva
    agora também falha quando um fonte compilado nas bridges, no kernel ou no builder ODC, ou o arquivo que registra uma
    ferramenta hospedada, fica fora delas. O registro passa de 1847 para 2004 códigos. 9 caminhos alterados, todos em
    `server/` (nenhum novo, nenhum apagado, nenhum compartilhado; o `SHARED.md` só cita a revisão), copiados com os blobs
    da revisão (`C:\t\qual\baixos\fix\copy-fix.cjs`). O painel ganhou a mesma cópia do contrato e do teste
    compartilhado, o teste novo na sua cópia e a paridade nova. As quatro cópias de `quality-line.mjs` têm agora o
    sha256 LF `a21d9c1e…5157f`.
  - Conferido: os 6222 arquivos das duas caixas que vêm da linha têm o blob de `1b2ce8fe`. Contagem: `server/` 6078,
    `agent/` 145, 76 nas duas.
- Combinado em 2026-10-12 na branch `server/r24-combinada` (de `a857a1ef`, a produção), a imagem interina do desenho de
  várias versões (`C:\t\multiver\DESIGN.md`, revisão 3, O.6.1): Service Studio 11.55.92, ODC Studio 1.7.28 e o
  registro de qualidade numa imagem só.
  - Merges: `server/r24-odc1728` (`07e14b81`), `server/r24-qualidade` (`36c2e51b`; 5 conflitos de texto destes
    documentos, as duas histórias mantidas) e `server/painel-usuario` (`bc9b00a0`, a conta `ssam-console` do host).
  - Depois, `a415531d..3d6f232c` de `fase4-24/combinada` (`3d6f232c`: os merges de `fase4-24/odc1728`, `fase4-24/o11-115592` e
    `fase4-24/qualidade` e o commit da imagem interina), copiado com os blobs da revisão (`C:\t\comb\copy-comb.cjs`): 96
    caminhos, 100 entradas, 81 só em `server/`, 9 só em `agent/` (os testes do agente, `docs/AGENTE-CLIENTE.md` e
    `scripts/agent-pack.ps1`) e 5 nas duas (`docs/FASE2-AGENTE.md`, `docs/PROVAS-AO-VIVO.md` e as 3 fontes da bridge ODC
    v97); ficou fora `scripts/release/license/weave-spec.json` pela regra da cópia. Nenhum apagado.
  - Conferido (`C:\t\comb\verify-comb.cjs`): os 6229 arquivos das duas caixas que vêm da linha têm o blob de `3d6f232c`,
    inclusive os 4 de Linux e os do worker. As quatro cópias de `quality-line.mjs` (fachada, fixtures, painel e fixtures do
    painel) têm o blob `f63aaa92`, sha256 LF `8625d52c…a015`. Contagem: `server/` 6085, `agent/` 145, 76 nas duas.
  - Do SSAM-MCP: `server/Dockerfile` (Service Studio 11.55.92, `SSAM_IMAGE_O11`/`SSAM_IMAGE_ODC` em ENV e nos rótulos
    `ssam.kernels.*`, a conferência das versões no build), `deploy/build.sh`, `deploy/.env.prod.example`,
    `deploy/kernel-pair-check.mjs` e `deploy/release-record.json` (o par imagem/`kernel.json` e o registro de cada
    imagem), `deploy/DEPLOY.md` (4, 7.1, 8, 13 e 14) e o painel (`console/tool-names.mjs`: só nomes de ferramenta do
    catálogo hospedado; o código de erro da auditoria pelo contrato).

## Aviso: o servidor no ar não mudou

O servidor no ar continua rodando do original:
`C:\Users\andre\SSAM-Hybrid-servidor-wt\fase4\facade\ssam.mjs serve --port 7310`, com estado em
`C:\Users\andre\SSAM-Hybrid-servidor-wt\fase3\.local\server`.
Este monorepo não o substitui nem o toca. Para testar a cópia, nunca use a porta 7310 nem aquela pasta de estado.

## Pré-requisitos

- Windows 10/11 e PowerShell 5.1 (scripts `.ps1` e testes do agente).
- Node 22+ (a imagem usa 24). pnpm 11.19.0 (a conferência usou o 11.25.0 que acompanha o Node do Codex).
- .NET SDK 10. Os kernels são net8.0 com `RollForward=Major`.
- Service Studio 11.55.92 e ODC Studio 1.7.28 (a versão do `kernel.json`; o ODC nunca mais velho que 1.7.27). O servidor
  recusa outro Studio na faixa dele (`STUDIO_VERSION_MISMATCH`; um Studio mais velho com `cause: "STUDIO_VERSION_NOT_SERVED"`).
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
# Servidor Windows: a versão da bridge ODC (v97) sai da bridge compilada, se o kernel.json não a fixar.
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

### Deploy de produção (do SSAM-MCP)

Para uma VPS Linux com Docker Compose, siga [`server/deploy/DEPLOY.md`](server/deploy/DEPLOY.md). Esses arquivos são do
SSAM-MCP e não vêm da linha do servidor.

- `server/Dockerfile`: imagem de produção, com contexto `server/`.
  - Deriva do Dockerfile de desenvolvimento e usa os mesmos scripts de `docker/ssam-server`.
  - Imagens base fixadas por tag e digest; o build recusa Studio sem SHA256 fixado.
  - Roda com uid 10001, com o código pertencendo ao root, `HEALTHCHECK` em `/health` e rótulos OCI.
- `server/deploy/compose.prod.yml`:
  - `ssam-server` sem porta no host, numa rede interna sem saída para a internet;
  - `caddy` em 80/443 com HTTPS automático e proxy sem buffer;
  - `ssam-admin` (tokens) e `ssam-ops` (backup e restore).
- `server/deploy/build.sh`: o único jeito documentado de construir a imagem. Roda antes a guarda de nomes de cliente e
  não edita o `.env`. O compose não tem `build:`.
- `server/deploy/Caddyfile`, `.env.prod.example`, `backup.sh`, `restore.sh`, `odc-features-export.ps1` e `DEPLOY.md`.
- O `.dockerignore` tira tudo isso da imagem, mais as cópias de estado `ssam-state-*.tar.gz` e o `Features.plain.xml`.

Construída e provada no Docker Desktop em 2026-10-11, três vezes (`server/deploy/DEPLOY.md`, seção 12). A imagem
candidata à produção é `ssam-server:prod-20261011-ed0f94b` (terceiro ensaio), 1,13 GB, com a correção dos caminhos
Linux em `hosted/policy.mjs` reaplicada (`ed0f94b`). Não faça deploy de `prod-20261011-8ae231d` nem das anteriores
(seção 14 do DEPLOY). Falta uma VPS de verdade (Let's Encrypt, DNS, firewall). Os bundles dos Studios não estão no
repositório.

O 24º envio (`server/r24`) ainda não tem imagem: o build, o ensaio de upgrade e a troca na VPS são as fases E a G do
plano do 24º. Até lá, `prod-20261011-ed0f94b` é a imagem no ar e a do rollback.

### Deploy com Docker (desenvolvimento, linha do servidor: túnel ngrok)

1. Coloque em `docker/installers` o instalador oficial ou o studio bundle de cada Studio (veja `docker/installers/README.md`).
   São binários OutSystems: guarde num registro privado.
2. `Copy-Item .env.example .env` e preencha `NGROK_DOMAIN` e `NGROK_AUTHTOKEN`.
3. Antes do build, rode o guarda de nomes de cliente sobre a raiz da caixa:
   `node --test platforms/odc/facade/tests/hosted-image-denylist.test.mjs`.
4. `docker compose build` e `docker compose up -d` (ssam-server em 127.0.0.1:7310 e túnel ngrok).
5. Grave o kernel no volume: `docker compose cp kernel.json ssam-server:/data/server/kernel.json`, com
   `{"o11":"11.55.91","odc":"1.7.28","odcBridge":"v97","odcBridgeAccepted":["v96","v48","v45"]}` (24º envio no ODC
   Studio 1.7.28: pacote do agente com a bridge v97; aceita agentes ainda com a v96, a v48 ou a v45). No Linux a detecção
   por versão de exe não roda.
6. Cache de features do ODC: o `Features.xml` do Windows é cifrado com DPAPI e o Linux não o lê. Numa máquina já
   logada no tenant, como o mesmo usuário, gere `Features.plain.xml` com `server\deploy\odc-features-export.ps1` e
   grave em `/data/odc-features/` (detalhes no `server/deploy/DEPLOY.md`, seção 7.2).
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

- `pack.json` do agente: `odcBridge` tem de ser o `kernel.odcBridge` do servidor ou estar em `odcBridgeAccepted` (24º no
  ODC Studio 1.7.28: v97, aceita v96, v48 e v45; 24º no 1.7.27: v96, aceita v48 e v45).
- O ODC Studio do cliente tem de ter a versão `kernel.odc` (hoje 1.7.28); outra recebe `STUDIO_VERSION_MISMATCH` na
  faixa ODC. Um pacote com bridge abaixo da v97 num ODC Studio 1.7.28 recebe `STUDIO_BRIDGE_OUTDATED` só em
  `refresh-references --producer` (a única chamada que o 1.7.28 quebrou); o resto funciona.
- `o11BuiltFor` tem de ser o Service Studio do kernel do servidor (hoje 11.55.92: o pacote da imagem interina leva a fina
  compilada contra o 11.55.92, `agent-pack.ps1 -ExpectO11 11.55.92`). Quem está no Service Studio 11.55.91 recebe
  `STUDIO_VERSION_MISMATCH` com `cause: "STUDIO_VERSION_NOT_SERVED"` com qualquer pacote, até a imagem de várias versões.
- Senão o hub responde `AGENT_PACK_MISMATCH`. Um bump de bridge mexe nas duas caixas no mesmo commit.
- Um pacote antigo aceito degrada com códigos tipados no 24º: o Service Center responde `STUDIO_BRIDGE_OUTDATED` e
  `studio_reference_producers` recebe `COMMAND_NOT_ALLOWED`. O 23º não aceita o pacote v96: no rollback do servidor, os
  clientes voltam ao pacote v48.

## Conferência de 2026-10-12 (ODC Studio 1.7.28, `server/r24-odc1728`)

Máquina do dono, `ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_NO_WARM=1`, TEMP e caches em `C:\t\odc28`, ODC Studio
1.7.28.10850 e Service Studio 11.55.91 instalados (nenhum processo de Studio usado).

- Pacote do agente: `C:\t\pack-v97\ssam-agent.zip`, id `pack-20261013-003406`, sha256
  `99b65a62466cbbd8be427e665beba2d904c01c32770de51d79c973a32cebbe37`, 40 entradas, montado com `scripts/agent-pack.ps1`
  na worktree de `fase4-24/odc1728`. `pack.json`: `odcBridge` `v97`, `o11BuiltFor` `11.55.91`, gancho dev.
  `pack-ip-scan.ps1`: ok, nenhum achado.
- A v96 no 1.7.28 (decide o `odcBridgeAccepted` do `kernel.json`, `server/deploy/DEPLOY.md` 7.1): a
  `ODC3.Bridge.v96.dll` do pacote do 24º, carregada num `AssemblyLoadContext` que resolve os assemblies do ODC Studio
  1.7.28 instalado, com cada método compilado (`RuntimeHelpers.PrepareMethod`): 391 tipos, 2072 de 2073 métodos. O único
  que falha é o lambda de `RefreshReferences` com `MissingMethodException` em
  `IReferencesManagerService.RefreshSpecificReferencesByKey` (o 1.7.28 ganhou um sexto parâmetro). A mesma DLL contra o
  bundle 1.7.27: 2073 de 2073. A v97 contra o 1.7.28: 2073 de 2073. A v48: 1911 de 1912, a mesma quebra. Os metadados
  (todas as referências de tipo e membro da bridge contra a pasta do Studio) dizem o mesmo: 1 problema na v96 e na v48,
  0 na v97. Como o servidor recusa esse comando para bridge abaixo da v97 (`STUDIO_BRIDGE_OUTDATED`), a v96 continua
  aceita.
- Caixa server (`pnpm install --frozen-lockfile` na raiz e em `platforms/odc`; `Anvil.Cli` e `Anvil.Cli.Odc` compilados
  em `kernel/.local` contra os Studios instalados), com um `tenants.json` sintético e a junção temporária
  `server/agent` → `agent/agent` (os dois apagados depois): `agent-hub`, `anvil-worker*`, `fase4-*`, `hosted-*` (23
  arquivos), `http-server`, `integration-documents`, `job-runner`, `server-tokens`, `servidor-ps1`, `tunel` e
  `public-signature-drift`: 299 testes, 298 passam. A falha é o C26 de `fase4-server.test.mjs`, que falha igual em
  `a415531d` (a produção). O `hosted-image-denylist` achou um nome de cliente em `docs/SERVIDOR-FASE4.md` do `f912cb7e`;
  corrigido na origem (`c48074be`), depois 4/4. `Builder.Tests` (contra o 1.7.28): 7/7.
- Caixa agent: `node --test agent/tests/*.test.mjs tests/prova-verbos.test.mjs` 86/86; `Bridge.Tests` (contra o 1.7.28)
  311/311; `Bridge.csproj` compila `ODC3.Bridge.v97` da caixa, e a DLL tem 0 referências quebradas no 1.7.28.
- `SHARED.md`: 76 arquivos, a conferência dele sai sem nada.

## Conferência de 2026-10-12 (24º envio, `server/r24`)

Máquina do dono, `ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_NO_WARM=1`, TEMP em `C:\t\r24f`. Service Studio
11.55.91 e ODC Studio 1.7.27. Nada foi compilado a partir das caixas para o pacote: o ZIP sai da linha do servidor
(mesmos bytes), e a caixa agent foi compilada à parte para provar que fecha sozinha.

Pacote do agente (fase C do plano), montado com `scripts/agent-pack.ps1` na worktree de `servidor/fase4-24`:
- `C:\t\pack-v96\ssam-agent.zip`, id `pack-20261012-074714`, sha256
  `09c3d438a1fff3ce8f38d095f45955e9d06bec32adb91afeb5c3c69c79148b10`, 40 entradas.
- `pack.json`: `odcBridge` `v96`, `o11BuiltFor` `11.55.91`, gancho dev; agente `0.3.1`. Nenhum `.cs`; `.mjs` só em
  `agent/`. `pack-ip-scan.ps1`: ok, nenhum achado.
- O pacote do rollback continua em `C:\t\pack-v48\ssam-agent.zip` (v48).

Caixa server (`pnpm install --frozen-lockfile` na raiz e em `platforms/odc`; `Anvil.Cli` e `Anvil.Cli.Odc` compilados
em `kernel/.local`, 0 erros):
- `platforms/odc/facade/tests/hosted-*.test.mjs` (20 arquivos, com `hosted-image-denylist`): 152 testes, 138 passam,
  1 pula, 13 falham. As 13 falhas são de ambiente, nenhuma de código:
  - 10 em `hosted-tools` por falta de `platforms/odc/tenants.json` (as de sempre, agora 10 com os testes do 24º);
  - 3 em `hosted-inline-job` e `hosted-network`, testes novos do 24º que importam `agent/ssam-agent.mjs` e
    `agent/lib/*.mjs`, que estão na outra caixa. O pulo é o `hosted-e2e`, pelo mesmo motivo.
  - Com um `tenants.json` sintético (um tenant fictício, não o do dono) e uma junção temporária `server/agent` para a
    pasta do agente da outra caixa, os 152 passam, inclusive o `hosted-e2e`. Os dois foram apagados depois.
- `agent-hub`, `http-server`, `server-tokens`, `fase4-server`, `fase4-wp-load`, `servidor-ps1`, `tunel` e
  `public-signature-drift`: 86 testes, 85 passam. A falha é do `http-server`, por falta de `tenants.json`; com o
  sintético, 15/15.
- Painel do dono: `server/deploy/console/tests` 91 testes, 90 passam e 1 pula (socket unix, provado no Linux);
  `ui-tests` 65/65; `server/deploy/host/tests` (Python) 46, 45 passam e 1 pula (POSIX).
  - Os testes do painel tomavam o módulo de tokens da caixa como "o da imagem atual" (o do 23º, sem trava, `renew` nem
    `setLanes`). Com o módulo do 24º na caixa, 5 deles falhavam pelo motivo certo: o painel passou a ver as ações. O
    comportamento do 23º (a imagem do rollback) segue coberto por uma cópia exata do módulo dele,
    `tests/fixtures/server-tokens-23.mjs` (`ed0f94b`), e os testes novos cobrem o do 24º: `auto` grava (trava do
    `tokens.json`), `renew` e `lanes` de ponta a ponta, e `STORE_INVALID` num arquivo quebrado.

Caixa agent:
- `node --test agent/tests/*.test.mjs tests/prova-verbos.test.mjs`: 86/86 (o `drift.test.mjs` passa desde o 24º).
- `Bridge.Tests`: 311/311.
- Compilam sozinhos, a partir da caixa: `Bridge.csproj` (`ODC3.Bridge.v96`), `Client.csproj`, `Anvil.Bridge.Thin`,
  `Anvil.RuntimeHook` (`.Agent`) e `Anvil.Connect`. Todo `Compile Include` dos `.csproj` das duas caixas acha o arquivo
  dentro da própria caixa.

`SHARED.md`: 76 arquivos, o script de conferência dele sai sem nada.

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
  Desde o 24º, também as provas ao vivo, propostas e passagens de bastão da linha SC/Portal e do depurador:
  `docs/PORTAL-*`, `docs/SC-*` (menos o guia `docs/SC-PORTAL-USO.md`), `docs/HANDOFF-*` e `docs/DEBUGGER-*`. O código
  só cita esses nomes em comentários e em rótulos de evidência; nenhum teste os lê.
- Bench (`scripts/bench`, `tests/bench`), `scripts/prove-reading.mjs`, `gen_tracks_agentes.py` (vazio).

## O que falta para o deploy

- O build Docker e o runtime Linux ainda não foram provados, nem no original. Isso vale também para a imagem de
  produção (`server/Dockerfile`).
- O Dockerfile de desenvolvimento instala `platforms/odc` com `--prod` e deixa de fora `@modelcontextprotocol/client`.
  Esse pacote é uma devDependency que `createSsamServer` importa, então nenhuma sessão MCP abriria. O de produção já
  instala o pacote. A correção na origem é a linha do servidor mover o pacote para `dependencies`.
- `server/kernel/Anvil.slnx` ainda lista `Anvil.Bridge.Thin` e `Anvil.Bridge.Thin.Tests`. Compile os projetos um a um.
- Os `.mcp.json` versionados apontam para `C:\Users\andre\SSAM-Hybrid`. Regenere com `node scripts/configure-mcp.mjs`.
- O modo local (`--local-studios`) e 11 testes (10 de `hosted-tools` e 1 de `http-server`, no 24º) precisam de um
  `platforms/odc/tenants.json`. O modo hospedado não precisa.
- Os testes entre caixas pedem um job de CI no nível do monorepo: `hosted-e2e`, o teste de deriva do agente e
  `Anvil.Bridge.Thin.Tests`. No 24º entraram mais três: `hosted-inline-job` (1) e `hosted-network` (2) importam o
  agente e, ao contrário do `hosted-e2e`, falham em vez de pular quando a caixa agent não está ao lado. A correção é na
  origem (linha do servidor): pular sem `agent/`, como o `hosted-e2e`.
- A bateria completa do kernel (`Anvil.Tests`, `Anvil.Tests.Odc`) não rodou aqui. Parte dela lê capturas de cliente que
  ficaram de fora.
- `server-identity.mjs` e `configure-mcp.mjs` leem `<raiz>/.git`. Numa subpasta do monorepo o `gitHead` sai null.
- O commit é local. O push é decisão do dono.
