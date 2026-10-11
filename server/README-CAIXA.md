# Caixa server

Servidor MCP hospedado do SSAM: `ssam serve`, hub do agente, tokens, kernels O11 e ODC, builder ODC, imagem Docker e
painel do dono. Cópia de `servidor/fase4` (`e7b2119b`) de `C:\Users\andre\SSAM-Hybrid-servidor`, sem edição,
atualizada para `servidor/fase4-22` (`1fbfa377`, 22º envio).
Esta pasta é a raiz do repositório antigo: caminhos relativos, Dockerfile e compose funcionam daqui.

Arquivos do SSAM-MCP nesta caixa, que **não vêm da linha do servidor**:

- este `README-CAIXA.md`;
- `Dockerfile`: a imagem de produção, derivada de `docker/ssam-server/Dockerfile`;
- `deploy/`: compose de produção, Caddyfile, `.env.prod.example`, `backup.sh`, `restore.sh` e o runbook `deploy/DEPLOY.md`.

Há uma exceção à regra de não editar arquivos copiados: o `.dockerignore` ganhou no fim um bloco marcado "added by the
SSAM-MCP monorepo". Ele tira da imagem o `Dockerfile`, o `deploy/`, as cópias de estado (`ssam-state-*.tar.gz`), este
README e os dados internos do dono que o servidor hospedado não lê (`.mcp.json`, `.env.example`,
`docs/INTEGRACOES-GITSSAM.md`, `kernel/scripts/service_center/hosts.json`, `kernel/scripts/probes` e os testes do
depurador). As regras anteriores e a guarda de nomes de cliente continuam iguais.

Ainda vão na imagem, porque são código ou documentação da linha do servidor: caminhos `C:\Users\andre\...` em docs,
catálogos e comentários, e o host do ambiente pessoal do dono em fontes do kernel e da fachada. Isso se corrige na
origem (linha do servidor), não aqui.

O servidor no ar continua rodando do original (`SSAM-Hybrid-servidor-wt\fase4-22`, porta 7310). Não use essa porta para testar esta cópia.

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
- A cópia do 23º envio tinha desfeito a correção `bfd3ec7` (caminhos Linux em `platforms/odc/facade/hosted/policy.mjs`).
  Ela foi reaplicada em `ed0f94b`. A linha do servidor tem as quatro correções na branch `servidor/fase4-23-linux`, e as
  próximas cópias saem dela (DEPLOY.md, seção 14).

## Deploy de desenvolvimento (linha do servidor: `docker/ssam-server/Dockerfile` e `docker-compose.yml` com ngrok)

1. Instaladores ou bundles dos Studios em `docker/installers` (veja o README de lá).
2. `.env` a partir de `.env.example` (`NGROK_DOMAIN`, `NGROK_AUTHTOKEN`).
3. `node --test platforms/odc/facade/tests/hosted-image-denylist.test.mjs` antes de cada build.
4. `docker compose build` e `docker compose up -d`.
5. `kernel.json` no volume: `{"o11":"11.55.91","odc":"1.7.27","odcBridge":"v48","odcBridgeAccepted":["v45"]}` em
   `/data/server/kernel.json`, o mesmo do servidor no ar (aceita agentes ainda com a bridge v45).
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
