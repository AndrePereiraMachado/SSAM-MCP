# Deploy de produção do servidor SSAM (VPS Linux com Docker Compose)

Passo a passo para pôr o servidor MCP hospedado do SSAM (`ssam serve`, modo hospedado) numa VPS Linux, com HTTPS
automático. Estes arquivos são do monorepo SSAM-MCP e não vêm da linha do servidor:

| Arquivo | Papel |
| --- | --- |
| `server/Dockerfile` | Imagem de produção (contexto = `server/`). Derivada de `docker/ssam-server/Dockerfile`, que continua sendo a de desenvolvimento. |
| `server/deploy/compose.prod.yml` | Serviços `ssam-server`, `caddy`, `ssam-admin` (perfil `admin`) e `ssam-ops` (perfil `ops`). |
| `server/deploy/Caddyfile` | HTTPS automático e proxy reverso sem buffer. |
| `server/deploy/.env.prod.example` | Modelo do `.env` (sem segredo). |
| `server/deploy/build.sh` | A guarda de nomes de cliente e depois o build da imagem (seção 6). |
| `server/deploy/backup.sh`, `restore.sh` | Cópia e volta do estado (volumes). |
| `server/deploy/odc-features-export.ps1` | No Windows: decifra o cache de features do ODC Studio para a VPS (7.2). |

Todos os comandos `docker compose` e `sh` abaixo rodam **dentro da pasta `deploy`** da VPS (seção 5), onde fica o `.env`.

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
  auditoria, `server.log`, atritos e o cache de features do ODC (`Features.plain.xml`, 7.2). A imagem não guarda estado.
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

- A rede `edge` do compose tem IPv6 ligado (`SSAM_EDGE_IPV6`, padrão `true`). Assim uma conexão IPv6 chega ao Caddy com o
  endereço do cliente, e os logs e a auditoria mostram o cliente, não o gateway do Docker.
- Numa VPS sem IPv6, ponha `SSAM_EDGE_IPV6=false` no `.env` e **não** publique AAAA.
- Depois de subir, confira com um cliente IPv6 de verdade (`curl -6 https://ssam.seudominio.com/health`): o
  `remote_ip` do log do Caddy tem de ser o endereço do cliente.

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

## 5. Arquivos de deploy e configuração na VPS

A VPS só precisa da pasta `server/deploy` (compose, Caddyfile, scripts e o `.env`), menos no caminho A da seção 6, que
constrói a imagem ali e precisa do repositório.

**Caminhos B e C** (a imagem vem pronta): só `server/deploy`, do commit aprovado, sem clonar o repositório. Ele leva
`client-denylist.json` (com os nomes dos clientes) e docs internos que a VPS não usa. Na máquina do dono, na raiz do
SSAM-MCP (PowerShell ou bash: um arquivo, sem pipe):

```powershell
git archive -o ssam-deploy.tar <commit aprovado> server/deploy
scp ssam-deploy.tar <usuário>@<vps>:/tmp/
```

Na VPS:

```bash
sudo install -d -o "$USER" -g "$USER" -m 0750 /opt/ssam
tar -xf /tmp/ssam-deploy.tar -C /opt/ssam --strip-components=1 && rm /tmp/ssam-deploy.tar
cd /opt/ssam/deploy
cp .env.prod.example .env && chmod 600 .env
nano .env
```

No upgrade, refaça o `git archive` do commit novo e extraia por cima: o `.env` não está no arquivo e fica.

**Caminho A** (build na VPS): o repositório inteiro, com permissão só para o seu usuário.

```bash
sudo install -d -o "$USER" -g "$USER" -m 0750 /opt/ssam
git clone <URL privada do SSAM-MCP> /opt/ssam/SSAM-MCP     # chave de deploy só de leitura
chmod 0700 /opt/ssam/SSAM-MCP
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
- `BACKUP_DIR`: fora do repositório, de preferência num volume de bloco só para ele (seção 9).
- Para testar DNS e firewall sem gastar o limite do Let's Encrypt, use `SSAM_ACME_CA` com a URL de staging. Tire depois.

A pasta dos backups é criada uma vez, com o dono certo. O `backup.sh` roda como o seu usuário (grupo docker, sem root) e
não consegue criar nada em `/var/backups`, que é do root. O log do cron fica na mesma pasta, porque o usuário também não
escreve em `/var/log`:

```bash
sudo install -d -o "$USER" -g "$USER" -m 0700 /var/backups/ssam-server
install -m 0600 /dev/null /var/backups/ssam-server/cron.log
```

Se `BACKUP_DIR` apontar para outro lugar, crie esse lugar do mesmo jeito.

## 6. A imagem

Toda imagem sai do `deploy/build.sh`. Ele roda primeiro a guarda de nomes de cliente
(`platforms/odc/facade/tests/hosted-image-denylist.test.mjs`, no node fixado do `Dockerfile`, sem rede e com a árvore só
de leitura), que lê o contexto exatamente como o Docker, pelas regras do `.dockerignore`. Se ela falhar, nada é
construído. Depois ele faz o build com os bundles e os hashes fixados, põe os rótulos (versão = tag, revisão = commit) e
mostra a tag e o id. Ele **nunca** edita o `.env`: a troca de tag é o passo 3 do upgrade (seção 8), depois de um build bom.

- O `compose.prod.yml` não tem `build:`, de propósito: um `docker compose build` pularia a guarda.
- Tag padrão: `prod-<aaaammdd>-<commit curto>`, com `-dirty` se houver mudança não commitada. `--tag` escolhe outra.
- Lê do ambiente ou do `.env` da pasta `deploy`: `SSAM_IMAGE`, `STUDIO_INSTALLERS_DIR`, `ODC_STUDIO_BUNDLE_SHA256`,
  `SERVICE_STUDIO_BUNDLE_SHA256` e, para outros arquivos de Studio, os nomes da seção 4.
- Precisa de `sh`, `docker` com buildx e `git`: Linux, WSL, ou Git Bash no Windows (provado no Docker Desktop, seção 12).

Escolha um dos três caminhos. Numa VPS de 8 GB, prefira B ou C.

### A. Build na própria VPS

O build (pnpm, NuGet e três projetos .NET) disputa CPU e memória com o servidor no ar e deixa alguns GB de cache. Rode-o
numa hora calma.

No Windows, em `server\`, mande os bundles e os `.sha256` para a VPS:

```powershell
Get-ChildItem docker\installers\*-studio-* | ForEach-Object { scp $_.FullName "<usuário>@<vps>:/opt/ssam/SSAM-MCP/server/docker/installers/" }
```

Na VPS:

```bash
cd /opt/ssam/SSAM-MCP/server/deploy
sh build.sh                                     # guarda, build, tag; o .env não muda
docker builder prune -f --reserved-space 8gb    # limpa o cache de build além de 8 GB
```

- O primeiro build leva dezenas de minutos e precisa de internet. As imagens base estão fixadas por tag e digest.
- Siga na seção 8, passo 3, com a tag que o `build.sh` mostrou.

### B. Build em outra máquina e registro privado

Numa máquina com Docker e o repositório (Linux, WSL, ou Git Bash com Docker Desktop), com os bundles em
`server/docker/installers` e os hashes no ambiente ou no `server/deploy/.env` dela:

```bash
cd server
sh deploy/build.sh --image registry.seudominio.com/ssam/ssam-server --push   # registro PRIVADO, com autenticação
```

O `build.sh` mostra a linha para o `.env` da VPS, **com o digest**: `SSAM_IMAGE_TAG=<tag>@sha256:<digest>`. Com o digest,
uma tag empurrada de novo não muda o que a VPS roda, e o rollback volta exatamente para a imagem anterior.

Na VPS:

```bash
docker login registry.seudominio.com        # token só de leitura
# .env: SSAM_IMAGE=registry.seudominio.com/ssam/ssam-server e SSAM_IMAGE_TAG=<tag>@sha256:<digest>
docker compose -f compose.prod.yml pull ssam-server
```

Serve qualquer registro privado: GHCR com pacote privado, GitLab, ECR, ACR ou um `registry:2` próprio atrás de TLS e
senha. Se o registro tiver tags imutáveis, ligue.

### C. Sem registro (cópia por SSH)

Na máquina do build, depois do `sh deploy/build.sh`, sempre por arquivo e nunca por pipe (no PowerShell 5.1 um pipe de
programa nativo, como `docker save | ssh`, corrompe os bytes):

```powershell
docker save -o ssam-server-<tag>.tar ssam-server:<tag>
(Get-FileHash ssam-server-<tag>.tar -Algorithm SHA256).Hash.ToLower()     # no bash: sha256sum ssam-server-<tag>.tar
scp ssam-server-<tag>.tar <usuário>@<vps>:/tmp/
```

Na VPS:

```bash
sha256sum /tmp/ssam-server-<tag>.tar          # o mesmo hash da máquina do build
docker load -i /tmp/ssam-server-<tag>.tar && rm /tmp/ssam-server-<tag>.tar
```

O `.env` fica com `SSAM_IMAGE=ssam-server` e `SSAM_IMAGE_TAG=<tag>`. Uma imagem carregada por `docker load` não tem
digest de registro: a garantia é o hash conferido do arquivo e o id da imagem (`docker image inspect`).

Confira os rótulos: `docker image inspect ssam-server:<tag> --format '{{json .Config.Labels}}'`.

## 7. Primeira subida

Os passos 7.1 e 7.2 gravam o estado inicial nos volumes antes de o servidor subir. O `ssam-ops` cria os volumes na
primeira vez, já com o dono certo (uid 10001). Para trocar esses arquivos depois, grave do mesmo jeito e rode
`docker compose -f compose.prod.yml restart ssam-server`.

### 7.1 `kernel.json` (obrigatório no Linux)

No Linux o servidor não lê a versão dos Studios nos `.exe`. Sem `kernel.json`, o hub do agente não sabe a versão e
recusa o pacote do cliente (`AGENT_PACK_MISMATCH`). Os valores têm de bater com o pacote do agente (`pack.json`:
`odcBridge` e `o11BuiltFor`), como diz a seção "Compatibilidade entre as caixas" do `README.md` da raiz.

Grave o mesmo `kernel.json` do servidor no ar (hoje no Windows do dono, na pasta de estado dele):

```bash
printf '%s\n' '{"o11":"11.55.91","odc":"1.7.27","odcBridge":"v48","odcBridgeAccepted":["v45"]}' \
  | docker compose -f compose.prod.yml run --rm -T ssam-ops sh -c 'cat > /data/server/kernel.json'
docker compose -f compose.prod.yml run --rm -T ssam-ops cat /data/server/kernel.json
```

- `odcBridge` é a bridge ODC do pacote atual do agente. `odcBridgeAccepted` lista as bridges mais antigas que o servidor
  ainda atende: um agente com o pacote v45 continua funcionando depois do salto para v48. Sem esse campo, todo cliente
  ainda com o pacote v45 recebe `AGENT_PACK_MISMATCH` na faixa ODC.
- Só tire uma versão de `odcBridgeAccepted` quando nenhum cliente a usar mais. O log do servidor não mostra a bridge do
  agente (`agent-connected` traz só a versão do agente): confirme com cada cliente (`ssam-agent doctor` ou o `pack.json`
  da pasta do agente).
- O `kernel.json` acompanha a versão dos Studios e da bridge: no upgrade e no rollback (seção 8) ele é regravado junto.

### 7.2 Cache de features do ODC (`Features.plain.xml`)

O modelo do ODC consulta o provedor de features (agregados, por exemplo), e nem o instalador nem o bundle trazem esse
cache. Sem ele, `studio_deliver` e o `ssam_map` da faixa ODC falham com `ODC Studio feature cache not found`.

O `Features.xml` que o ODC Studio grava no Windows é cifrado com o DPAPI do usuário do Windows. No Linux, o serviço de
cifra do Studio é outro (ASP.NET Data Protection) e não lê esse arquivo: copiar o `Features.xml` dá
`The provided payload cannot be decrypted because it was not protected with this protection provider` (visto no ensaio
de 2026-10-11). Por isso a VPS recebe o cache **decifrado**, e o kernel o cifra de novo com o serviço do Linux antes de o
provedor ler (`kernel/src/Anvil.Core.Odc/Adapters.ODC/OdcFeatures.cs`).

1. Numa máquina Windows onde o ODC Studio já entrou no tenant, **como o mesmo usuário do Windows** e num PowerShell
   comum (não aberto de dentro de um app MSIX, que tem um `%LocalAppData%` só dele):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File server\deploy\odc-features-export.ps1 -Out C:\t\Features.plain.xml
   ```

   O script decifra `%LocalAppData%\OutSystems\ODC Studio\Features.xml`, confere que é um `<Features>` e mostra a
   contagem e o sha256, nunca o conteúdo. O arquivo tem as flags de features do tenant, sem credencial: trate como
   privado.
2. Copie para a VPS, grave no volume e apague as cópias:

   ```bash
   docker compose -f compose.prod.yml run --rm -T ssam-ops sh -c 'cat > /data/odc-features/Features.plain.xml' < Features.plain.xml
   rm Features.plain.xml
   ```

3. Repita depois de uma troca de versão do ODC Studio ou quando o tenant ganhar features novas.

`FeaturesOverride.xml` (raro) é copiado como está e não foi provado no Linux.

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
- `healthy` sai em uns 10 s, mas o servidor ainda aquece por 1 a 2 minutos depois de cada container novo (`up` com
  imagem nova, `--force-recreate`): refaz os índices do discover e sobe os workers. No ensaio, o primeiro `ssam_discover`
  da faixa O11 nesse intervalo levou 83 s; os seguintes, menos de 1 s. Um `restart` simples mantém esses caches.

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

1. Faça um backup: `sh backup.sh --online` (a pasta já existe desde a seção 5).
2. Gere a imagem nova com uma tag nova (seção 6).
3. Troque `SSAM_IMAGE_TAG` no `.env`.
4. Recrie só o servidor: `docker compose -f compose.prod.yml up -d ssam-server`.
   - As sessões caem por alguns segundos e os agentes reconectam sozinhos.
   - O Caddy espera até 15 s pelo servidor antes de responder 502.
5. Confira `ps` (healthy), `/health` e o log (`listening`, `kernel`, `warm`).
6. Se mudou a versão de um Studio ou da bridge ODC, atualize o `kernel.json` (7.1) e mande o pacote novo do agente aos
   clientes. Num salto de bridge, a anterior entra em `odcBridgeAccepted` até todos os clientes trocarem de pacote.

Para o Caddy, troque a imagem fixada em `compose.prod.yml` (tag e digest, resolvidos com
`docker buildx imagetools inspect caddy:<versão>-alpine`) e rode `up -d caddy`.

**Rollback**

1. Volte `SSAM_IMAGE_TAG` no `.env` para a tag anterior e rode `docker compose -f compose.prod.yml up -d ssam-server`.
   Se o upgrade mudou o `kernel.json`, grave de novo o da versão anterior (7.1) antes do `up -d`.
2. A imagem anterior tem de existir na VPS ou no registro. Não rode `docker image prune -a` enquanto um rollback puder ser
   preciso.
3. Se a versão nova mudou o formato do estado, volte também o backup do passo 1 do upgrade:
   `sh restore.sh <arquivo>`.

## 9. Backup e restore

```bash
sh backup.sh --online        # sem parar o servidor: o modo do cron diário
sh backup.sh                 # para o ssam-server durante a cópia (consistente) e sobe de novo: só numa janela anunciada
sh restore.sh /var/backups/ssam-server/ssam-state-<data>.tar.gz
```

- O backup grava `ssam-state-<data>.tar.gz` em `BACKUP_DIR` (criada na seção 5), com `.sha256` e `.info`. O `.info` diz
  a tag, o id da imagem, a revisão (commit), os digests de registro, o projeto e o modo.
  Leva os três volumes. Não leva os certificados do Caddy (são emitidos de novo) nem a imagem.
- **Parar ou não**: o modo padrão para o servidor, e isso corta toda chamada em curso (um `o11_deliver` leva até 60 min)
  e fecha as sessões e os canais dos agentes. Por isso o cron usa `--online`. O `tokens.json` é gravado por troca atômica
  de nome e os logs só crescem, então numa cópia online o pior caso é a última linha de um log cortada. Faça uma cópia
  parada de vez em quando, numa janela anunciada (por exemplo, semanal).
- Se a VPS reiniciar no meio de uma cópia parada, o `restart: unless-stopped` deixa o servidor parado: rode
  `docker compose -f compose.prod.yml up -d`.
- `BACKUP_KEEP_DAYS` apaga os arquivos mais velhos que esse número de dias. Com 0, guarda todos. Dimensione o disco:
  dias guardados × tamanho de um arquivo (cada cliente vai até 5 GiB de espaço de trabalho).
- O restore confere o hash e o conteúdo e pede a palavra `restore`.
  - Ele para o servidor e salva o estado atual em `BACKUP_DIR/pre-restore`. Se essa cópia falhar, o servidor volta a
    subir e nada mudou.
  - Depois esvazia os volumes, extrai e espera o servidor ficar healthy. Se a extração falhar, o servidor **fica parado**
    (o estado está pela metade) e a mensagem diz qual arquivo de `pre-restore` restaurar para voltar.
  - Restaure com a tag que fez o backup (o `.info` diz qual) ou uma mais nova.
  - Tokens revogados depois do backup voltam a valer: revogue-os de novo.

**Agendamento diário**, como o seu usuário (grupo docker), com o log na pasta dos backups:

```bash
echo "30 3 * * * $USER cd $PWD && sh backup.sh --online >> /var/backups/ssam-server/cron.log 2>&1" \
  | sudo tee /etc/cron.d/ssam-backup
sudo -u "$USER" sh -c "cd $PWD && sh backup.sh --online >> /var/backups/ssam-server/cron.log 2>&1"; echo "exit $?"
tail -n 5 /var/backups/ssam-server/cron.log
```

- Rode o `echo` dentro da pasta `deploy` (o `$PWD` vira o caminho dela).
- A segunda linha roda o mesmo comando do cron uma vez, de verdade, antes de ir ao ar: tem de dar `exit 0`, e o log tem
  de mostrar `backup: ... sha256 ...`.

**Aviso quando o backup não roda.** Um backup que falha no cron não avisa ninguém. Use um monitor do tipo "dead man's
switch" (healthchecks.io, Uptime Kuma em modo push, Better Stack heartbeat): crie uma verificação diária com tolerância de
2 h e ponha a URL em `BACKUP_HEARTBEAT_URL` no `.env`. O `backup.sh` só faz o GET no fim de um backup bom, depois da cópia
para fora. Assim o monitor alerta se o cron não rodou, se o disco encheu ou se qualquer passo falhou.
Sem monitor externo, um teste local que pode ir para qualquer alerta é este (falha se o backup mais novo tiver mais de
26 h): `find /var/backups/ssam-server -maxdepth 1 -name 'ssam-state-*.tar.gz' -mmin -1560 | grep -q .`

**Cópia fora da VPS (cifrada).** Os backups no disco da VPS somem junto com ela. Com `BACKUP_AGE_RECIPIENT` e
`BACKUP_RCLONE_REMOTE` no `.env`, cada backup bom também vai, cifrado, para outro lugar:

1. Na sua máquina (não na VPS): `age-keygen -o ssam-backup.key`. Guarde a chave privada fora da VPS, com o mesmo cuidado
   de um segredo. A linha `# public key: age1...` é o `BACKUP_AGE_RECIPIENT`.
2. Na VPS: `sudo apt-get install -y age rclone` e `rclone config` para um armazenamento de objetos (B2, S3, R2 etc.), com
   um usuário que só escreve naquele bucket. O nome do remoto com o caminho é o `BACKUP_RCLONE_REMOTE`, por exemplo
   `offsite:ssam-backups`.
3. O `backup.sh` manda `<arquivo>.age` (o tar.gz cifrado no caminho, sem cópia em claro a mais), o `.sha256` e o `.info`.
   Uma falha no envio faz o backup sair com erro (e sem heartbeat).
4. A retenção do lado de lá é do provedor (regra de ciclo de vida do bucket).
5. Para voltar: baixe os três arquivos, `age -d -i ssam-backup.key -o <arquivo> <arquivo>.age`, e então
   `sh restore.sh <arquivo>` (o `.sha256` confere o arquivo decifrado).

Teste um restore de tempos em tempos numa VPS de ensaio, com um arquivo vindo de fora.

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
- Um override do compose, fora do repositório, que só dá o domínio, o `tls internal` e as portas do host. O `Caddyfile`
  que roda é o deste repositório, sem cópia: a linha `{$SSAM_CADDY_TLS}` dele fica vazia em produção e vira
  `tls internal` aqui. O `!override` troca a lista de portas inteira, então nem um `.env` errado publica 80 ou 443.

  ```yaml
  # compose.prova.yml: docker compose -p ssam-prova-prod --env-file <.env do ensaio> -f compose.prod.yml -f compose.prova.yml ...
  services:
    ssam-server:
      environment:
        SSAM_PUBLIC_HOST: localhost
    caddy:
      environment:
        SSAM_DOMAIN: localhost
        SSAM_CADDY_TLS: tls internal
      ports: !override
        - "127.0.0.1:28080:80"
        - "127.0.0.1:28443:443"
  ```

- O Caddy avisa `failed to install root certificate`: é só a CA local, sem efeito.
- Teste com `curl -k https://localhost:28443/health`. Clientes Node confiam na raiz local do Caddy
  (`/data/caddy/pki/authorities/local/root.crt`, copiada com `docker compose exec caddy cat ...`) por
  `NODE_EXTRA_CA_CERTS`, sem desligar a verificação TLS.
- Agente: o pacote da caixa agent com binários de mentira e os Studios **falsos** dos testes da caixa
  (`platforms/odc/facade/tests/fixtures/fake-studios-process.mjs` e `agent-process.mjs`). Nunca os Studios reais da
  máquina.
- Nunca use as portas 80, 443 ou 7310 de uma máquina que já roda outro servidor SSAM.

### Resultado do ensaio de 2026-10-11

Imagem `ssam-server:prod-20261011-2761cb8`, Docker Desktop 29.8.2 (linux/amd64), `.env` do ensaio com 3 CPUs, 6 GB e
2 workers. Tudo pelo HTTPS do Caddy em `127.0.0.1:28443`.

| Item | Resultado |
| --- | --- |
| Build sem cache de camadas (bases e cache do NuGet já locais) | 92 s. Rebuild de uma mudança de código: 6 a 40 s. |
| Tamanho | 1,13 GB descompactada; cerca de 295 MB comprimida (`docker save`). |
| Subida | `healthy` em 8 a 10 s; aquecimento de 1 a 2 min depois de um container novo (7.3). |
| Processo e disco | uid/gid 10001, `NoNewPrivs`, nenhuma capability. Código e Studios só de leitura para o `ssam`; ele grava só nos volumes, em `/tmp` e nos caches de `/app` (seção 14). |
| Rede | `ssam-server` só na rede `backend` (interna): sem DNS nem saída para a internet. Portas do host só no Caddy. |
| `/health` | 200 pelo Caddy, com HSTS, nosniff, DENY, CSP, CORP e no-referrer, sem `Server`. Outros caminhos: 404. |
| Tokens | emitidos pelo `ssam-admin`; o volume guarda só os hashes. |
| MCP | `initialize` e `tools/list` (79 ferramentas) com o token; `ssam_reference` e `ssam_discover` nas duas faixas; `o11_extension` recusado com `HOSTED_UNAVAILABLE` (`XIF_ENGINE_WINDOWS_ONLY`). |
| Acesso negado | sem token, token desconhecido ou credencial de agente no `/mcp`: 401. Token revogado: 403 `Token revoked`, também para a credencial do agente dele. |
| Agente (Studios falsos) | `studio_status`, `studio_attach`, captura de 6 MiB, `ssam_connect`, `o11_studio`, `o11_deliver` "entregue" (kernel O11 no Linux), `studio_deliver` ODC recusado de uma vez nas quatro fases com `verifyRan:true` (kernel ODC no Linux), `ssam_map` digest nas duas faixas. |
| Conexão longa | canal do agente aberto 7 min pelo Caddy, sem queda nem reconexão. |
| Restart e recriação | tokens e revogações mantidos; o agente reconecta sozinho em 1 a 5 s. |
| Segredos | nenhum token nem credencial no `server.log`, na auditoria, nos logs do Docker, do Caddy (Authorization `REDACTED`) e do agente. |
| Nomes de cliente | nenhum nos arquivos do SSAM na imagem. As 12 ocorrências da varredura são de terceiros: pedaços de identificadores (tipos do AWS SDK, runtime .NET) e bytes de binários. |

Correções que o ensaio trouxe, todas com commit no `main`: cache do NuGet por estágio, pasta de autoridade do dono e
pasta `features` vazia do builder (`server/Dockerfile`); versão da bridge ODC no pipe hospedado; caminhos Linux
apresentados como `ws:` (`hosted/policy.mjs`); `TMPDIR` dos processos do kernel (`executor.mjs`); cache de features do ODC
no Linux (`OdcFeatures.cs`, `odc-features-export.ps1`, 7.2); argumentos dos rótulos só antes do `LABEL`, para reaproveitar
as camadas entre versões.

## 13. Problemas comuns

| Sintoma | Causa provável |
| --- | --- |
| 502 do Caddy | `ssam-server` parado ou ainda subindo: `ps` e `logs ssam-server`. |
| Certificado não sai | DNS não aponta para a VPS, porta 80 ou 443 fechada, ou limite do Let's Encrypt (use staging). |
| 401 `Unknown token` / 403 `Token revoked` ou `expired` | Token errado, revogado ou vencido: `server-token list`. |
| `AGENT_PACK_MISMATCH` | `kernel.json` (7.1) não bate com o pacote do agente do cliente: a bridge do pacote não é `odcBridge` nem está em `odcBridgeAccepted`, ou o `o11BuiltFor` não é o `o11`. |
| `STUDIO_VERSION_MISMATCH` | O Service Studio do cliente não é o da imagem (11.55.91). |
| 403 `Origin not allowed` | Cliente de navegador com uma origem diferente de `https://<SSAM_DOMAIN>`. |
| `HOSTED_UNAVAILABLE` em `o11_extension`, `odc_external_library`, depurador ou preview | Esperado: essas ferramentas não rodam no servidor hospedado Linux. |
| 429 | Limite por token: `SSAM_RATE_PER_MINUTE`, ou 8 sessões abertas por token. |
| Build para em "has no pinned SHA256" | Falta `*_BUNDLE_SHA256` (ou `*_SHA256` do instalador) no `.env` (seção 4). |
| `ODC Studio feature cache not found` ou `ODC feature provider could not load the local cache` | Falta o `Features.plain.xml` no volume, ou foi copiado o `Features.xml` cifrado do Windows (7.2). |
| Primeiro `ssam_discover` demora mais de 1 min | Aquecimento depois de um container novo (7.3). |

## 14. Limitações conhecidas

- A imagem foi construída e provada no Docker Desktop (seção 12), mas ainda não numa VPS: o certificado do
  Let's Encrypt, o DNS e o firewall da VPS não foram provados. Os bundles dos Studios não estão neste repositório.
  - No ensaio não apareceu `EACCES`, `EROFS`, `EPERM` nem `HOSTED_CONTEXT_LOST`. Numa VPS, procure de novo no log.
- Quatro correções do ensaio mexem em arquivos de produto copiados da linha do servidor
  (`platforms/odc/facade/hosted/agent-executor.mjs`, `hosted/policy.mjs`, `executor.mjs` e
  `kernel/src/Anvil.Core.Odc/Adapters.ODC/OdcFeatures.cs`). A linha do servidor precisa fazer a mesma mudança na origem,
  senão a próxima cópia desfaz.
- O índice do discover e os outros caches de `/app` se perdem a cada container novo: 1 a 2 min de aquecimento (7.3).
- O container não roda com o sistema de arquivos raiz só de leitura.
  - A linha do servidor grava caches em `/app/.local` e `/app/platforms/odc/.local`, e os locks e logs dos workers ao
    lado dos CLIs, em `/app/kernel/.local`.
  - A imagem libera só esses lugares, `/tmp` e os volumes. O resto de `/app` e `/studio` é do root.
  - Esses caches ficam na camada do container e se perdem ao recriá-lo. São reconstruídos depois.
- O `kernel.json` é manual (7.1) e precisa ser revisto a cada troca de versão de Studio ou bridge.
- O `server.log` não gira sozinho (seção 10).
- O painel do dono (`scripts/dashboard.mjs`) escuta só em loopback e ainda não foi adaptado ao Docker.
- Uma VPS só: sem alta disponibilidade. O tempo fora do ar de um upgrade é o de recriar o container.
