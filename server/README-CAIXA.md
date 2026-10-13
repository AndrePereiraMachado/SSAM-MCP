# Caixa server

Servidor MCP hospedado do SSAM: `ssam serve`, hub do agente, tokens, kernels O11 e ODC, builder ODC, imagem Docker e
painel do dono. Cópia de `servidor/fase4` (`e7b2119b`) de `C:\Users\andre\SSAM-Hybrid-servidor`, sem edição,
atualizada para `fase4-24/odc1728` (`c48074be`: o 24º envio `a415531d` no ODC Studio 1.7.28 com a bridge ODC v97,
branch `server/r24-odc1728`; antes, `servidor/fase4-24` `a415531d` na `server/r24`, `fase4-22` `1fbfa377` e `fase4-23`
`e589be22`). Na branch `server/r24-qualidade`, `fase4-24/qualidade` (`3262c49f`, depois `01795e52` com os verbos das
chamadas ao agente só de listas fechadas, `c24d468d` com os códigos e as regras só dos registros gerados das fontes e
`1b2ce8fe` com os códigos compostos pelo produto e os de `kernel/query-test` nesses registros): o registro de qualidade
`ssam-quality/1` (`docs/QUALIDADE.md`). Cada arquivo que vem da linha tem o blob da revisão (`README.md` da raiz, "De
onde veio").
Esta pasta é a raiz do repositório antigo: caminhos relativos, Dockerfile e compose funcionam daqui.

Arquivos do SSAM-MCP nesta caixa, que **não vêm da linha do servidor**:

- este `README-CAIXA.md`;
- `Dockerfile`: a imagem de produção, derivada de `docker/ssam-server/Dockerfile`;
- `deploy/`: compose de produção, Caddyfile, `.env.prod.example`, `backup.sh`, `restore.sh` e o runbook `deploy/DEPLOY.md`;
  o painel do dono (`deploy/console`, o coletor `deploy/host` e o perfil do compose, DEPLOY.md seção 15).

Há uma exceção à regra de não editar arquivos copiados: o `.dockerignore` ganhou no fim um bloco marcado "added by the
SSAM-MCP monorepo". Ele tira da imagem o `Dockerfile`, o `deploy/`, as cópias de estado (`ssam-state-*.tar.gz`), este
README e os dados internos do dono que o servidor hospedado não lê (`.mcp.json`, `.env.example`,
`docs/INTEGRACOES-GITSSAM.md`, `kernel/scripts/service_center/hosts.json`, `kernel/scripts/probes` e os testes do
depurador, inclusive `kernel/debug/tests-witness`, que entrou no 24º). As regras anteriores e a guarda de nomes de
cliente continuam iguais. A parte de cima do arquivo é a da linha do servidor: no 24º ela passou a tirar da imagem
`docs/PORTAL-*`, `docs/SC-*` e `docs/PROTOTIPO-NATIVO.md`.

Ainda vão na imagem, porque são código ou documentação da linha do servidor: caminhos `C:\Users\andre\...` em docs,
catálogos e comentários, e o host do ambiente pessoal do dono em fontes do kernel e da fachada. Isso se corrige na
origem (linha do servidor), não aqui.

O servidor Windows continua rodando do original (`SSAM-Hybrid-servidor-wt\fase4-23`, porta 7310), e a VPS de produção
roda a imagem do 23º (`prod-20261011-ed0f94b`). Não use essa porta para testar esta cópia.

## Compilar

```powershell
pnpm install --frozen-lockfile
pnpm -C platforms/odc install --frozen-lockfile
dotnet build kernel/src/Anvil.Cli -c Release -nologo -v q -nodeReuse:false -p:SSDir="<Service Studio 11.55.91>" -o kernel/.local/cli
dotnet build kernel/src/Anvil.Cli.Odc -c Release -nologo -v q -nodeReuse:false -p:OdcInstall="<ODC Studio 1.7.27+>" -o kernel/.local/lane-odc/cli
dotnet build platforms/odc/studio/builder/Builder.csproj -c Release -nologo -v q -nodeReuse:false -p:OdcInstall="<ODC Studio>"
dotnet build platforms/odc/studio/bridge/Bridge.csproj -c Release -nologo -v q -p:OdcInstall="<ODC Studio>"
dotnet build platforms/odc/studio/bridge/client/Client.csproj -c Release -nologo -v q
```

Ou `scripts/setup-dev.ps1 -Yes -NoUserEnv -SkipInstall -SkipMcp -SkipDoctor`.

## Rodar

```powershell
$env:SSAM_SERVER_DIR = '<pasta de estado>'
.\scripts\servidor.ps1 start -Port <porta>     # status | stop
.\ssam server-token issue --customer "Nome" --days 30 --lanes "odc,o11"
node scripts/dashboard.mjs --dir <pasta de estado> --port 7320
```

## Testar

```powershell
node --test platforms/odc/facade/tests/agent-hub.test.mjs platforms/odc/facade/tests/http-server.test.mjs platforms/odc/facade/tests/server-tokens.test.mjs platforms/odc/facade/tests/fase4-*.test.mjs platforms/odc/facade/tests/hosted-*.test.mjs tests/servidor-ps1.test.mjs tests/tunel.test.mjs
node --test platforms/odc/tests/public-signature-drift.test.mjs
dotnet test platforms/odc/studio/builder/tests/Builder.Tests.csproj -c Release -p:OdcInstall="<ODC Studio>"
```

Em 2026-10-10: 154 de 163 passam. O `hosted-e2e` pula (o agente está na outra caixa). As 8 falhas vêm da falta de
`platforms/odc/tenants.json`, que é dado do dono e ficou de fora. Builder.Tests 7/7.

Em 2026-10-12 (24º, `server/r24`), com `Anvil.Cli` e `Anvil.Cli.Odc` compilados em `kernel/.local` (o discover do
`hosted-evidence` precisa deles): `hosted-*` 138 de 152 (1 pula), e as outras suítes da linha 85 de 86. As 14 falhas são
11 por falta de `tenants.json` e 3 de testes novos que importam a caixa agent (`hosted-inline-job`, `hosted-network`).
Com um `tenants.json` sintético e a caixa agent ao lado, 152/152 e 15/15. Painel do dono:
`node --test deploy/console/tests/` 90 de 91 (1 pula: socket unix), `node --test deploy/console/ui-tests/` 65/65 e
`python -m unittest discover -s deploy/host/tests` 45 de 46 (1 pula: POSIX). Detalhes no `README.md` da raiz.

Em 2026-10-12 (`server/r24-qualidade`, registro de qualidade), com os mesmos CLIs em `kernel/.local`, um `tenants.json`
sintético e a caixa agent ao lado (os dois removidos depois): o conjunto afetado do desenho da qualidade mais as suítes
de antes (`quality-*`, `http-server*`, `agent-hub`, `fase4-*`, `hosted-*`, `kernel-delivery`, `job-runner`, `pa3-wp-*`,
`o11-cycle`, `anvil-worker*`, `integration-documents`, `server-tokens`, o teste do contrato nas fixtures,
`public-signature-drift`, `tests/friction*`, `servidor-ps1` e `tunel`), 49 arquivos: 462 de 463. A falha é o `C26` do
`fase4-server`, que já falha igual em `a415531d` (a linha a registrou entre as falhas da base). Painel do dono:
`node --test deploy/console/tests` 109 de 110 (1 pula: socket unix) e `node deploy/console/ui-tests/run-all.mjs` 71/71.

## Deploy de produção (SSAM-MCP)

VPS Linux com Docker Compose, HTTPS automático pelo Caddy e servidor sem porta no host: siga `deploy/DEPLOY.md`.

- A imagem é a do `Dockerfile` desta pasta. As imagens base são fixadas por tag e digest, roda com uid 10001 e o
  código pertence ao root.
- O build recusa Studio sem SHA256 fixado.
- Os arquivos de deploy são `deploy/compose.prod.yml` (serviços `ssam-server`, `caddy`, `ssam-admin` e `ssam-ops`),
  `deploy/Caddyfile`, `deploy/.env.prod.example`, `deploy/build.sh` (guarda de nomes de cliente e build: o único jeito de
  construir a imagem), `deploy/backup.sh`, `deploy/restore.sh` e `deploy/rotate-logs.sh`.
- Construída e provada no Docker Desktop em 2026-10-11 (`deploy/DEPLOY.md`, seção 12). A imagem candidata à produção é
  `ssam-server:prod-20261011-ed0f94b` (terceiro ensaio); falta uma VPS de verdade. Os bundles dos Studios não estão no
  repositório.
- O 24º envio (`server/r24`) ainda não tem imagem: build, ensaio de upgrade e troca na VPS são as fases E a G do plano
  do 24º. O `kernel.json` dele está na seção 7.1 do DEPLOY.
- A cópia do 23º envio tinha desfeito a correção `bfd3ec7` (caminhos Linux em `platforms/odc/facade/hosted/policy.mjs`).
  Ela foi reaplicada em `ed0f94b`. A linha do servidor tem as quatro correções na branch `servidor/fase4-23-linux`, e as
  próximas cópias saem dela (DEPLOY.md, seção 14).

## Deploy de desenvolvimento (linha do servidor: `docker/ssam-server/Dockerfile` e `docker-compose.yml` com ngrok)

1. Instaladores ou bundles dos Studios em `docker/installers` (veja o README de lá).
2. `.env` a partir de `.env.example` (`NGROK_DOMAIN`, `NGROK_AUTHTOKEN`).
3. `node --test platforms/odc/facade/tests/hosted-image-denylist.test.mjs` antes de cada build.
4. `docker compose build` e `docker compose up -d`.
5. `kernel.json` no volume: `{"o11":"11.55.91","odc":"1.7.28","odcBridge":"v97","odcBridgeAccepted":["v96","v48","v45"]}`
   em `/data/server/kernel.json` (24º no ODC Studio 1.7.28: pacote do agente v97; aceita agentes ainda com a v96, a v48
   ou a v45). Com a imagem do 24º no 1.7.27: `{"o11":"11.55.91","odc":"1.7.27","odcBridge":"v96","odcBridgeAccepted":["v48","v45"]}`.
   Com a do 23º: `{"o11":"11.55.91","odc":"1.7.27","odcBridge":"v48","odcBridgeAccepted":["v45"]}`.
6. `Features.plain.xml` (do `deploy/odc-features-export.ps1`; o `Features.xml` do Windows é DPAPI e o Linux não o lê)
   em `/data/odc-features/` (`deploy/DEPLOY.md`, seção 7.2).
7. Tokens: `docker compose run --rm ssam-admin server-token issue ...`.

Pendências:

- O Docker ainda não foi provado.
- O Dockerfile de desenvolvimento instala `platforms/odc` com `--prod` e deixa de fora `@modelcontextprotocol/client`.
  Esse pacote é uma devDependency que o servidor importa ao criar cada sessão, então nenhuma sessão MCP abriria. O de
  produção já instala o pacote.
- `kernel/Anvil.slnx` lista a bridge fina, que está na caixa agent.
- Os `.mcp.json` apontam para `C:\Users\andre\SSAM-Hybrid` (rode `node scripts/configure-mcp.mjs`).

Detalhes no `README.md` da raiz.
