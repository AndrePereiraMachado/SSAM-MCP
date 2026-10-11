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
SSAM-MCP monorepo". Ele tira da imagem o `Dockerfile`, o `deploy/` e as cópias de estado (`ssam-state-*.tar.gz`). As
regras anteriores e a guarda de nomes de cliente continuam iguais.

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
  `deploy/Caddyfile`, `deploy/.env.prod.example`, `deploy/backup.sh` e `deploy/restore.sh`.
- Ainda não foi construída nem provada: os bundles dos Studios não estão no repositório.

## Deploy de desenvolvimento (linha do servidor: `docker/ssam-server/Dockerfile` e `docker-compose.yml` com ngrok)

1. Instaladores ou bundles dos Studios em `docker/installers` (veja o README de lá).
2. `.env` a partir de `.env.example` (`NGROK_DOMAIN`, `NGROK_AUTHTOKEN`).
3. `node --test platforms/odc/facade/tests/hosted-image-denylist.test.mjs` antes de cada build.
4. `docker compose build` e `docker compose up -d`.
5. `kernel.json` no volume: `{"o11":"11.55.91","odc":"1.7.27","odcBridge":"v48"}` em `/data/server/kernel.json`.
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
