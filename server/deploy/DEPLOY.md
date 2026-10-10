# Deploy de produção do servidor SSAM (VPS Linux com Docker Compose)

Passo a passo para pôr o servidor MCP hospedado do SSAM (`ssam serve`, modo hospedado) numa VPS Linux, com HTTPS
automático. Estes arquivos são do monorepo SSAM-MCP e não vêm da linha do servidor:

| Arquivo | Papel |
| --- | --- |
| `server/Dockerfile` | Imagem de produção (contexto = `server/`). Derivada de `docker/ssam-server/Dockerfile`, que continua sendo a de desenvolvimento. |
| `server/deploy/compose.prod.yml` | Serviços `ssam-server`, `caddy`, `ssam-admin` (perfil `admin`) e `ssam-ops` (perfil `ops`). |
| `server/deploy/Caddyfile` | HTTPS automático e proxy reverso sem buffer. |
| `server/deploy/.env.prod.example` | Modelo do `.env` (sem segredo). |
| `server/deploy/backup.sh`, `restore.sh` | Cópia e volta do estado (volumes). |

Todos os comandos `docker compose` abaixo rodam **dentro de `server/deploy`**, onde fica o `.env`.

## 1. Como fica

```
cliente MCP (https://<domínio>/mcp + token) ─┐
agente do cliente (https://<domínio>/agent) ─┤
                                             ▼
                VPS   :80/:443  caddy  (TLS automático, sem buffer, cabeçalhos de segurança)
                                  │  rede "backend", interna, sem saída para a internet
                                  ▼
                      ssam-server:7310  (uid 10001, sem porta no host)
                      volumes: server-state (/data/server), friction (/data/friction), odc-features (/data/odc-features)
```

- Só o Caddy publica portas. O `ssam-server` não tem porta no host e não alcança a internet: tudo o que toca o tenant ou
  o Studio do cliente passa pelo agente do cliente, que se conecta ao servidor.
- Estado nos volumes: hash SHA-256 de cada token, `kernel.json`, espaço de trabalho de cada cliente (até 5 GiB cada),
  auditoria, `server.log`, atritos e o `Features.xml` do ODC. A imagem não guarda estado.
- `ssam-admin` emite, lista e revoga tokens. `ssam-ops` faz backup, restore e grava arquivos nos volumes. Os dois rodam
  sem rede e só quando chamados.

## 2. Aviso de licença

A imagem leva binários da OutSystems: a parte de cada Studio que os kernels carregam. Os bundles dos Studios também.
Valem para os dois as condições de licença dos Studios:

- guarde a imagem e os bundles só em lugar privado (registro privado com autenticação, a própria VPS, cópia por SSH);
- **nunca** publique a imagem num registro público (Docker Hub público, GHCR público etc.) nem anexe bundles a tickets,
  chats ou repositórios.

O backup do estado também é sensível: leva dados e nomes de clientes e os hashes dos tokens.

## 3. Requisitos

**VPS**

- Ubuntu 24.04 LTS, **x86_64 (amd64)**. A imagem só foi feita para `linux/amd64`.
- Mínimo 4 vCPU, 8 GB de RAM e 60 GB de SSD. Com vários clientes, 8 vCPU, 16 GB e 100 GB ou mais. Cada espaço de
  cliente vai até 5 GiB, e o build na VPS usa alguns GB de cache.
- Acesso SSH com chave, usuário com `sudo`.

**DNS**: um registro A (e AAAA, se a VPS tiver IPv6) de `ssam.seudominio.com` para o IP da VPS. Confira com
`dig +short ssam.seudominio.com` antes de subir o Caddy. O Let's Encrypt precisa alcançar as portas 80 e 443.

**Docker Engine e Compose** (repositório oficial da Docker):

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"     # saia e entre de novo; o grupo docker equivale a root
docker version && docker compose version
```

**Firewall**: só 22, 80 e 443 de entrada.

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

- Faça o mesmo no firewall do provedor (security group), se houver.
- As portas publicadas pelo Docker passam por fora do ufw. Por isso só o Caddy publica porta. Nunca acrescente `ports:`
  ao `ssam-server`.

## 4. Bundles dos Studios (máquina Windows com os Studios instalados)

A imagem compila os kernels contra a parte dos Studios listada em `docker/ssam-server/studio-<faixa>.txt`. Ela vem de
um bundle feito a partir do Studio instalado. O instalador oficial do ODC Studio 1.7.27 não se consegue baixar.

- Service Studio: a mesma versão dos Studios dos clientes (hoje 11.55.91). O servidor recusa outra
  (`STUDIO_VERSION_MISMATCH`).
- ODC Studio: 1.7.27 ou mais novo.

Na raiz `server\` do SSAM-MCP, no Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docker\ssam-server\studio-bundle.ps1              # ODC Studio
powershell -NoProfile -ExecutionPolicy Bypass -File docker\ssam-server\studio-bundle.ps1 -Lane o11    # Service Studio 11
Get-Content docker\installers\*.sha256
```

- Saem em `docker\installers\`: `odc-studio-<versão>.tar.gz` e `o11-studio-<versão>.tar.gz`, cada um com o `.sha256`.
- **Fixe os dois hashes** no `.env` (`ODC_STUDIO_BUNDLE_SHA256` e `SERVICE_STUDIO_BUNDLE_SHA256`). O build de produção
  recusa um Studio sem hash fixado. Ele também confere cada arquivo do bundle contra o `SHA256SUMS` interno.
- Se a versão não for a padrão, ponha também o nome do arquivo (`ODC_STUDIO_BUNDLE=odc-studio-<versão>.tar.gz`).
- O Service Studio pode entrar pelo instalador oficial `ServiceStudio-11.55.91.65258.exe` em vez do bundle. O hash
  dele já está fixado.
- Os bundles nunca vão para o git (`.gitignore`) nem para o contexto principal da imagem (`.dockerignore`).

## 5. Código e configuração na VPS

```bash
sudo mkdir -p /opt/ssam && sudo chown "$USER" /opt/ssam
git clone <URL privada do SSAM-MCP> /opt/ssam/SSAM-MCP     # chave de deploy só de leitura
cd /opt/ssam/SSAM-MCP && git checkout <commit ou tag aprovado>
cd server/deploy
cp .env.prod.example .env && chmod 600 .env
nano .env
```

No `.env`:

- `SSAM_DOMAIN`: o nome do DNS, sem `https://` e sem porta.
- `ACME_EMAIL`: o contato da conta ACME.
- `SSAM_IMAGE` e `SSAM_IMAGE_TAG`: uma tag por build, por exemplo `prod-20261010-acea75a`. Upgrade e rollback trocam só
  a tag.
- `SSAM_CPUS`, `SSAM_MEMORY` e `SSAM_BUILD_WORKERS`, pelo tamanho da VPS:

  | VPS | `SSAM_CPUS` | `SSAM_MEMORY` | `SSAM_BUILD_WORKERS` |
  | --- | --- | --- | --- |
  | 4 vCPU, 8 GB | 3 | 6g | 2 |
  | 8 vCPU, 16 GB | 7 | 13g | 4 |

  Os valores de memória são estimativa e ainda não foram medidos. O `SSAM_CPUS` não pode passar do número de vCPUs.
- Só para o build na VPS: `ODC_STUDIO_BUNDLE_SHA256` e `SERVICE_STUDIO_BUNDLE_SHA256`.
- `BACKUP_DIR`: fora do repositório.
- Para testar DNS e firewall sem gastar o limite do Let's Encrypt, use `SSAM_ACME_CA` com a URL de staging. Tire depois.

## 6. A imagem

Antes de cada build, rode a guarda de nomes de cliente. Nenhum nome de cliente pode entrar na imagem. A guarda lê o
contexto exatamente como o Docker, pelas regras do `.dockerignore`:

```bash
cd /opt/ssam/SSAM-MCP/server
docker run --rm --network none -v "$PWD":/src:ro -w /src/platforms/odc/facade \
  node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 \
  node --test tests/hosted-image-denylist.test.mjs
```

Escolha um dos três caminhos.

### A. Build na própria VPS

No Windows, em `server\`, mande os bundles e os `.sha256` para a VPS:

```powershell
Get-ChildItem docker\installers\*-studio-* | ForEach-Object { scp $_.FullName "<usuário>@<vps>:/opt/ssam/SSAM-MCP/server/docker/installers/" }
```

Na VPS:

```bash
cd /opt/ssam/SSAM-MCP/server/deploy
TAG=prod-$(date -u +%Y%m%d)-$(git rev-parse --short HEAD)
sed -i "s/^SSAM_IMAGE_TAG=.*/SSAM_IMAGE_TAG=$TAG/" .env
SSAM_VCS_REF=$(git rev-parse HEAD) SSAM_BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  docker compose -f compose.prod.yml build ssam-server
```

- O primeiro build leva dezenas de minutos (pnpm, NuGet e três projetos .NET) e precisa de internet.
- As imagens base estão fixadas por tag e digest no `Dockerfile`.

### B. Build em outra máquina e registro privado

Numa máquina com Docker (Linux, WSL ou Docker Desktop), na pasta `server/`:

```bash
TAG=prod-$(date -u +%Y%m%d)-$(git rev-parse --short HEAD)
REG=registry.seudominio.com/ssam/ssam-server       # registro PRIVADO, com autenticação
docker buildx build -f Dockerfile --platform linux/amd64 --build-context installers=docker/installers \
  --build-arg ODC_STUDIO_BUNDLE_SHA256=<sha256> --build-arg SERVICE_STUDIO_BUNDLE_SHA256=<sha256> \
  --build-arg SSAM_VERSION=$TAG --build-arg VCS_REF=$(git rev-parse HEAD) \
  --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t $REG:$TAG --push .
```

Na VPS:

```bash
docker login registry.seudominio.com        # token só de leitura
# .env: SSAM_IMAGE=registry.seudominio.com/ssam/ssam-server e SSAM_IMAGE_TAG=<TAG>
docker compose -f compose.prod.yml pull ssam-server
```

Serve qualquer registro privado: GHCR com pacote privado, GitLab, ECR, ACR ou um `registry:2` próprio atrás de TLS e
senha.

### C. Sem registro (cópia por SSH)

```bash
docker save ssam-server:$TAG | gzip | ssh <usuário>@<vps> 'gunzip | docker load'
```

Na VPS, o `.env` fica com `SSAM_IMAGE=ssam-server` e `SSAM_IMAGE_TAG=<TAG>`.

Confira os rótulos: `docker image inspect ssam-server:$TAG --format '{{json .Config.Labels}}'`.

## 7. Primeira subida

Os passos 7.1 e 7.2 gravam o estado inicial nos volumes antes de o servidor subir. O `ssam-ops` cria os volumes na
primeira vez, já com o dono certo (uid 10001). Para trocar esses arquivos depois, grave do mesmo jeito e rode
`docker compose -f compose.prod.yml restart ssam-server`.

### 7.1 `kernel.json` (obrigatório no Linux)

No Linux o servidor não lê a versão dos Studios nos `.exe`. Sem `kernel.json`, o hub do agente não sabe a versão e
recusa o pacote do cliente (`AGENT_PACK_MISMATCH`). Os valores têm de bater com o pacote do agente (`pack.json`:
`odcBridge` e `o11BuiltFor`), como diz a seção "Compatibilidade entre as caixas" do `README.md` da raiz.

```bash
cd /opt/ssam/SSAM-MCP/server/deploy
printf '%s\n' '{"o11":"11.55.91","odc":"1.7.27","odcBridge":"v48"}' \
  | docker compose -f compose.prod.yml run --rm -T ssam-ops sh -c 'cat > /data/server/kernel.json'
```

### 7.2 `Features.xml` do ODC

O modelo do ODC consulta o provedor de features (agregados, por exemplo), e nem o instalador nem o bundle trazem esse
cache.

1. Numa máquina Windows onde o ODC Studio já entrou no tenant, copie `%LocalAppData%\OutSystems\ODC Studio\Features.xml`
   (e `FeaturesOverride.xml`, se houver) para a VPS.
2. Grave os arquivos no volume e apague as cópias:

   ```bash
   docker compose -f compose.prod.yml run --rm -T ssam-ops sh -c 'cat > /data/odc-features/Features.xml' < Features.xml
   docker compose -f compose.prod.yml run --rm -T ssam-ops sh -c 'cat > /data/odc-features/FeaturesOverride.xml' < FeaturesOverride.xml
   rm Features.xml FeaturesOverride.xml
   ```

### 7.3 Subir

```bash
docker compose -f compose.prod.yml up -d
docker compose -f compose.prod.yml ps                       # ssam-server "healthy" em até ~1 min
docker compose -f compose.prod.yml logs --tail 50 ssam-server caddy
curl -fsS https://ssam.seudominio.com/health                 # {"ok":true,"pid":...}
curl -s -o /dev/null -w '%{http_code}\n' https://ssam.seudominio.com/mcp   # 401 sem token
```

- O log do `ssam-server` mostra `kernel` com as versões do `kernel.json`, depois `listening` com `mode: "hosted"` e,
  uns segundos depois, `warm`.
- Se `kernel` sair com `null`, o `kernel.json` não foi lido: refaça o 7.1.

### 7.4 Token de cliente

```bash
docker compose -f compose.prod.yml run --rm ssam-admin server-token issue --customer "Nome do cliente" --days 30 --lanes odc,o11
```

- A resposta mostra **uma vez só** o `token` (`ssam_...`) e a `agentCredential` (`ssam_agent_...`). O volume guarda só o
  SHA-256 de cada um.
- Mande os dois ao cliente por canais seguros e separados.
- `--lanes odc`, `o11` ou `odc,o11`. `--days` de 1 a 3650. Sem `--days`, o token não expira.
- O servidor no ar vê o token novo no pedido seguinte, sem reinício.

Outros comandos:

```bash
docker compose -f compose.prod.yml run --rm ssam-admin server-token list
docker compose -f compose.prod.yml run --rm ssam-admin server-token revoke --id tok_...
docker compose -f compose.prod.yml run --rm ssam-admin server-token agent-rotate --id tok_...
```

### 7.5 Configuração do cliente

**Cliente MCP**: URL `https://ssam.seudominio.com/mcp` com o token no cabeçalho `Authorization`. Por exemplo, no
`.mcp.json` (modelo em `server/docs/exemplos/mcp-cliente-hospedado.json`), com o token na variável `SSAM_TOKEN` da
máquina do cliente:

```json
{"mcpServers":{"ssam":{"type":"http","url":"https://ssam.seudominio.com/mcp","headers":{"Authorization":"Bearer ${SSAM_TOKEN}"}}}}
```

No Claude Code: `claude mcp add --transport http ssam https://ssam.seudominio.com/mcp --header "Authorization: Bearer <token>"`.

**Agente** (Windows do cliente, pacote `ssam-agent.zip` da caixa `agent/`): o pacote tem de ser o que bate com o
`kernel.json` do servidor. Guia completo em `agent/docs/AGENTE-CLIENTE.md`.

```powershell
Expand-Archive .\ssam-agent.zip -DestinationPath C:\SSAM-Agent
C:\SSAM-Agent\agent\node\node.exe C:\SSAM-Agent\agent\ssam-agent.mjs setup --server https://ssam.seudominio.com --root C:\SSAM-Agent
powershell -ExecutionPolicy Bypass -File C:\SSAM-Agent\agent\ssam-agent.ps1 start
C:\SSAM-Agent\agent\node\node.exe C:\SSAM-Agent\agent\ssam-agent.mjs doctor --root C:\SSAM-Agent
```

- O `setup` pede a credencial do agente sem mostrá-la.
- No cliente MCP, chame `ssam_doctor`: o agente aparece conectado.
- Depois, `ssam_connect` com o Studio aberto.
- No servidor, o log mostra `agent-connected`.

## 8. Upgrade e rollback (por tag)

**Upgrade**

1. Faça um backup: `sh backup.sh`.
2. Gere a imagem nova com uma tag nova (seção 6).
3. Troque `SSAM_IMAGE_TAG` no `.env`.
4. Recrie só o servidor: `docker compose -f compose.prod.yml up -d ssam-server`.
   - As sessões caem por alguns segundos e os agentes reconectam sozinhos.
   - O Caddy espera até 15 s pelo servidor antes de responder 502.
5. Confira `ps` (healthy), `/health` e o log (`listening`, `kernel`, `warm`).
6. Se mudou a versão de um Studio ou da bridge ODC, atualize o `kernel.json` (7.1) e mande o pacote novo do agente aos
   clientes.

Para o Caddy, troque a imagem fixada em `compose.prod.yml` (tag e digest, resolvidos com
`docker buildx imagetools inspect caddy:<versão>-alpine`) e rode `up -d caddy`.

**Rollback**

1. Volte `SSAM_IMAGE_TAG` no `.env` para a tag anterior e rode `docker compose -f compose.prod.yml up -d ssam-server`.
2. A imagem anterior tem de existir na VPS ou no registro. Não rode `docker image prune -a` enquanto um rollback puder ser
   preciso.
3. Se a versão nova mudou o formato do estado, volte também o backup do passo 1 do upgrade:
   `sh restore.sh <arquivo>`.

## 9. Backup e restore

```bash
sh backup.sh                 # para o ssam-server durante a cópia (consistente) e sobe de novo
sh backup.sh --online        # sem parar (um arquivo sendo escrito pode sair cortado)
sh restore.sh /var/backups/ssam-server/ssam-state-<data>.tar.gz
```

- O backup grava `ssam-state-<data>.tar.gz` em `BACKUP_DIR`, com `.sha256` e `.info` (tag da imagem, projeto e modo).
  Leva os três volumes. Não leva os certificados do Caddy (são emitidos de novo) nem a imagem.
- `BACKUP_KEEP_DAYS` apaga os arquivos mais velhos que esse número de dias. Com 0, guarda todos.
- O restore confere o hash e o conteúdo e pede a palavra `restore`.
  - Ele salva o estado atual em `BACKUP_DIR/pre-restore`, esvazia os volumes, extrai e espera o servidor ficar healthy.
  - Restaure com a tag que fez o backup (o `.info` diz qual) ou uma mais nova.
  - Tokens revogados depois do backup voltam a valer: revogue-os de novo.
- Agendamento diário (o usuário precisa estar no grupo docker e poder escrever em `BACKUP_DIR`):

  ```bash
  echo '30 3 * * * <usuário> cd /opt/ssam/SSAM-MCP/server/deploy && sh backup.sh >> /var/log/ssam-backup.log 2>&1' \
    | sudo tee /etc/cron.d/ssam-backup
  ```

- Mande uma cópia **cifrada** para fora da VPS (por exemplo, `age` ou `gpg` e depois `rclone` ou `rsync`). Teste um
  restore de tempos em tempos numa VPS de ensaio.

## 10. Monitoração

- **Saúde**: `docker compose -f compose.prod.yml ps` (coluna STATUS `healthy`). Um monitor externo deve fazer
  `GET https://<domínio>/health` a cada minuto e alertar na falha. O Docker não reinicia um container `unhealthy`:
  investigue e rode `docker compose -f compose.prod.yml restart ssam-server`.
- **Logs**: `docker compose -f compose.prod.yml logs -f --since 1h ssam-server caddy`.
  - O servidor escreve eventos JSON: `listening`, `kernel`, `warm`, `session-opened` e `session-closed`,
    `agent-connected`, `agent-call` e `mcp-response-flushed`.
  - O Caddy escreve o log de acesso em JSON, com o `Authorization` tapado.
  - Os dois rodam em `json-file` com rotação (5 arquivos de 20 MB).
- **Arquivos no volume** (`/data/server`):
  - `server.log`;
  - `audit-AAAAMMDD.jsonl`: uma linha por chamada de ferramenta, com token, cliente, ferramenta, duração e resultado;
  - `access-alerts.jsonl` e `machine-pins.json`: credencial usada de outra máquina.

  Para ler: `docker compose -f compose.prod.yml run --rm ssam-ops sh -c 'tail -n 50 /data/server/server.log'`.
- **Rotação do `server.log`**: o servidor anexa cada evento a esse arquivo e nunca o gira. Ele reabre o arquivo a cada
  linha, então renomear é seguro. Use o logrotate do host, em `/etc/logrotate.d/ssam-server`:

  ```
  /var/lib/docker/volumes/ssam-prod_server-state/_data/server.log {
    su 10001 10001
    weekly
    rotate 8
    compress
    missingok
    notifempty
    nocreate
  }
  ```

  O caminho usa o nome do projeto: confira com `docker volume inspect ssam-prod_server-state`.
- **Disco**:
  - `df -h /var/lib/docker` e `docker system df`;
  - por volume: `docker compose -f compose.prod.yml run --rm ssam-ops`, que mostra o `du` dos três;
  - os `audit-*.jsonl` acumulam (um por dia). Arquive os antigos fora da VPS conforme a sua política.
- **Recursos**: `docker stats`. Se o container morrer por memória (`docker inspect --format '{{.State.OOMKilled}}'`),
  suba `SSAM_MEMORY` ou baixe `SSAM_BUILD_WORKERS`.
- **Certificado**: o Caddy renova sozinho, cerca de 30 dias antes de vencer. Procure erros com
  `docker compose -f compose.prod.yml logs caddy | grep -i error`.

## 11. Corte remoto

- **Um cliente**: `docker compose -f compose.prod.yml run --rm ssam-admin server-token revoke --id tok_...`.
  - Vale sem reinício.
  - Os pedidos novos recebem 403.
  - As sessões MCP abertas e o canal do agente daquele token fecham em cerca de 1 s, e o agente para (código 2).
- **Só a credencial do agente**: `server-token agent-rotate --id tok_...`. A anterior deixa de valer na hora.
- **Todos de uma vez**: `docker compose -f compose.prod.yml stop caddy`. Ninguém de fora chega ao servidor, e o estado
  fica. Para voltar: `start caddy`.
- Tokens emitidos com `--days` vencem sozinhos.

## 12. Ensaio local (Docker Desktop)

Para provar a pilha numa máquina de desenvolvimento sem tocar em portas em uso:

- `.env` com `COMPOSE_PROJECT_NAME=ssam-prova-prod`, `SSAM_DOMAIN=localhost`, qualquer endereço em `ACME_EMAIL`,
  `SSAM_HTTP_PORT=127.0.0.1:28080`, `SSAM_HTTPS_PORT=127.0.0.1:28443` e `BACKUP_DIR` numa pasta de rascunho.
- Para `localhost`, o Caddy usa a CA interna dele, sem ACME.
- Teste com `curl -k https://localhost:28443/health`.
- Nunca use as portas 80, 443 ou 7310 de uma máquina que já roda outro servidor SSAM.

## 13. Problemas comuns

| Sintoma | Causa provável |
| --- | --- |
| 502 do Caddy | `ssam-server` parado ou ainda subindo: `ps` e `logs ssam-server`. |
| Certificado não sai | DNS não aponta para a VPS, porta 80 ou 443 fechada, ou limite do Let's Encrypt (use staging). |
| 401 `Unknown token` / 403 `Token revoked` ou `expired` | Token errado, revogado ou vencido: `server-token list`. |
| `AGENT_PACK_MISMATCH` | `kernel.json` (7.1) não bate com o pacote do agente do cliente. |
| `STUDIO_VERSION_MISMATCH` | O Service Studio do cliente não é o da imagem (11.55.91). |
| 403 `Origin not allowed` | Cliente de navegador com uma origem diferente de `https://<SSAM_DOMAIN>`. |
| `HOSTED_UNAVAILABLE` em `o11_extension`, `odc_external_library`, depurador ou preview | Esperado: essas ferramentas não rodam no servidor hospedado Linux. |
| 429 | Limite por token: `SSAM_RATE_PER_MINUTE`, ou 8 sessões abertas por token. |
| Build para em "has no pinned SHA256" | Falta `*_BUNDLE_SHA256` (ou `*_SHA256` do instalador) no `.env` (seção 4). |

## 14. Limitações conhecidas

- A imagem de produção ainda não foi construída nem provada numa VPS: os bundles dos Studios não estão neste repositório.
  - No ensaio, procure no log `EACCES` ou `EROFS`: seria um lugar onde o servidor grava e que a imagem não liberou.
  - Procure também `HOSTED_CONTEXT_LOST`.
- O container não roda com o sistema de arquivos raiz só de leitura.
  - A linha do servidor grava caches em `/app/.local` e `/app/platforms/odc/.local`, e os locks e logs dos workers ao
    lado dos CLIs, em `/app/kernel/.local`.
  - A imagem libera só esses lugares, `/tmp` e os volumes. O resto de `/app` e `/studio` é do root.
  - Esses caches ficam na camada do container e se perdem ao recriá-lo. São reconstruídos depois.
- O `kernel.json` é manual (7.1) e precisa ser revisto a cada troca de versão de Studio ou bridge.
- O `server.log` não gira sozinho (seção 10).
- O painel do dono (`scripts/dashboard.mjs`) escuta só em loopback e ainda não foi adaptado ao Docker.
- Uma VPS só: sem alta disponibilidade. O tempo fora do ar de um upgrade é o de recriar o container.
