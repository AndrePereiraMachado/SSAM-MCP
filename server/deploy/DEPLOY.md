# Deploy de produção do servidor SSAM (VPS Linux com Docker Compose)

Passo a passo para pôr o servidor MCP hospedado do SSAM (`ssam serve`, modo hospedado) numa VPS Linux, com HTTPS
automático. Estes arquivos são do monorepo SSAM-MCP e não vêm da linha do servidor:

| Arquivo | Papel |
| --- | --- |
| `server/Dockerfile` | Imagem de produção (contexto = `server/`). Derivada de `docker/ssam-server/Dockerfile`, que continua sendo a de desenvolvimento. |
| `server/deploy/compose.prod.yml` | Serviços `ssam-server`, `caddy`, `ssam-admin` (perfil `admin`), `ssam-ops` (perfil `ops`) e `ssam-console` (perfil `console`, seção 15). |
| `server/deploy/Caddyfile` | HTTPS automático e proxy reverso sem buffer. |
| `server/deploy/.env.prod.example` | Modelo do `.env` (sem segredo). |
| `server/deploy/build.sh` | A guarda de nomes de cliente e depois o build da imagem (seção 6). |
| `server/deploy/backup.sh`, `restore.sh` | Cópia e volta do estado (volumes). |
| `server/deploy/rotate-logs.sh` | Rotação do `server.log` e retenção da auditoria e do índice de módulos (seção 10). |
| `server/deploy/odc-features-export.ps1` | No Windows: decifra o cache de features do ODC Studio para a VPS (7.2). |
| `server/deploy/host/` | Painel do dono, parte do host: coletor (`collect.py`), unidades do systemd, `install.sh` e `uninstall.sh` (seção 15). |
| `server/deploy/console/` | Painel do dono: o servidor (Node, sem dependências) e as páginas, montados no container `ssam-console`; `painel-ssam.ps1` abre o túnel SSH no Windows do dono (seção 15). |

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
                      volumes: server-state (/data/server), friction (/data/friction), odc-features (/data/odc-features),
                               cache (/data/cache)
```

- Só o Caddy publica portas. O `ssam-server` não tem porta no host e não alcança a internet: tudo o que toca o tenant ou
  o Studio do cliente passa pelo agente do cliente, que se conecta ao servidor.
- Estado nos volumes: hash SHA-256 de cada token, `kernel.json`, espaço de trabalho de cada cliente (até 5 GiB cada),
  auditoria, `server.log`, atritos e o cache de features do ODC (`Features.plain.xml`, 7.2). A imagem não guarda estado.
- O volume `cache` guarda o índice de módulos do `ssam_map` (com resumos das capturas dos clientes) e a cópia dos
  leitores. Ele passa por recriações do container (um upgrade não começa frio) e fica fora do backup: o servidor o refaz.
- `ssam-admin` emite, lista e revoga tokens. `ssam-ops` faz backup, restore, rotação de logs e grava arquivos nos
  volumes. Os dois rodam sem rede e só quando chamados.
- `ssam-console` (perfil `console`) é o painel do dono: licenças e monitoração, sem rede nenhuma, alcançado só por um
  túnel SSH a partir do PC do dono (seção 15).

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
um bundle feito a partir do Studio instalado. O instalador oficial do ODC Studio não se consegue baixar.

- Service Studio: a mesma versão dos Studios dos clientes (hoje 11.55.92.65269, `o11-studio-11.55.92.65269.tar.gz`, 145
  arquivos, sha256 `67b44feddd2784e453b81a32294cea23d48448be57f4301e422b9ae1122e79cf`, feito do instalador assinado
  `ServiceStudio-11.55.92.65269.exe`, sha256 `1d82f514e8ab7f78ba5dcef8eb618b6088a1793c1993db424f247c59d6efba49`). O
  servidor recusa outra (`STUDIO_VERSION_MISMATCH`). O 11.55.91 era `o11-studio-11.55.91.65258.tar.gz` (`e9f0751a…`).
- ODC Studio: a mesma versão dos clientes (hoje 1.7.28.10850, `odc-studio-1.7.28.10850.tar.gz`, sha256
  `cbe778bdabf6940fb5ff3a2eb63935f6075a2b7a7768ff85431bc73f63151e8c`). O `odc` do `kernel.json` (7.1) é essa versão, e o
  servidor recusa a faixa ODC de outra (`STUDIO_VERSION_MISMATCH`). O ODC Studio se atualiza sozinho: quando os clientes
  mudarem de versão, refaça o bundle, a imagem, o `kernel.json` e o `Features.plain.xml` (7.2).
- Desde A-M1 (`feat/studio-build-identity`) o servidor compara o build inteiro (4 números) do Studio do cliente com o
  da pasta do Studio da imagem (`ServiceStudio.Framework.dll`). Outro build da mesma versão (1.7.28.10873 numa imagem
  1.7.28.10850) segue `studioBuildPolicy` (7.1): atende com aviso (padrão) ou recusa.

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
- O Service Studio pode entrar pelo instalador oficial `ServiceStudio-11.55.92.65269.exe` em vez do bundle. O hash
  dele já está fixado.
- A imagem declara as versões que serve (`SSAM_IMAGE_O11=11.55.92`, `SSAM_IMAGE_ODC=1.7.28`, rótulos `ssam.kernels.o11`
  e `ssam.kernels.odc`). O build para se a pasta de um Studio tiver outra versão. Com outros Studios, mude as duas no
  `.env` (`SSAM_IMAGE_O11`, `SSAM_IMAGE_ODC`).
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
- `SSAM_O11_WORKERS_MAX` (padrão 2) e `SSAM_O11_WORKER_IDLE_MS` (padrão 600000): os workers O11 residentes dos clientes,
  um por token, com o ambiente daquele cliente. A primeira chamada de cada cliente roda fria e sobe o worker em segundo
  plano para a próxima. Sem vaga, ou com o worker ocupado, a chamada O11 roda no processo frio de antes.
  `SSAM_O11_WORKERS_MAX=0` desliga. `SSAM_O11_WORKER_MIN_IDLE_MS` (padrão 120000): só depois desse tempo ocioso um
  worker cede a vaga a outro cliente.
- Perfil de memória de cada worker, sempre definido pelo servidor: `SSAM_O11_WORKER_BASE_CACHE` (padrão `off`),
  `SSAM_O11_WORKER_HEAP_MB` (padrão 1536, limite do heap do .NET), `SSAM_O11_WORKER_MAX_COMMANDS` (padrão 1000) e
  `SSAM_O11_WORKER_RSS_MB` (padrão 1200: acima disso o worker sai depois da chamada). Com `SSAM_MEMORY=6g` e 2 workers,
  cada um fica abaixo de 1,2 GB; ainda não foi medido na VPS.
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

**Imagem interina (Service Studio 11.55.92 e ODC Studio 1.7.28, `fase4-24/combinada`).** O `kernel.json` sai do
registro das imagens (`release-record.json`, nesta pasta), nunca digitado. A conferência do par roda dentro da imagem que
vai subir, antes da primeira subida (desenho de várias versões, O.6.1 itens 3, 5 e 10). Na pasta `deploy`, com
`TAG` = a tag da interina:

```bash
TAG=prod-AAAAMMDD-xxxxxxx
run_check() { docker run --rm --network none --entrypoint node -v "$PWD/kernel-pair-check.mjs:/c.mjs:ro" "$@"; }
# 1. o kernel.json desta imagem, do registro
run_check -v "$PWD/release-record.json:/r.json:ro" "ssam-server:$TAG" /c.mjs print released /r.json > /tmp/kernel.json; echo "exit $?"
cat /tmp/kernel.json    # {"o11":"11.55.92","odc":"1.7.28","odcBridge":"v97","odcBridgeAccepted":["v96","v48","v45"]}
# 2. a conferência do par, com o node e os Studios da própria imagem
run_check -v /tmp/kernel.json:/k.json:ro "ssam-server:$TAG" /c.mjs check /k.json; echo "exit $?"
#    só siga com exit 0 ("pair-ok") nos dois. 2 = "refused-pair" (o JSON mostra a faixa que não bate), 1 = erro de
#    leitura, 125 = imagem ausente: não suba.
# 3. grava (num upgrade, com o servidor que está no ar parado antes: stop ssam-server; veja a seção 8)
docker compose -f compose.prod.yml run --rm -T ssam-ops sh -c 'cat > /data/server/kernel.json' < /tmp/kernel.json
# 4. esvazia os caches que não têm a versão do Studio (refeitos sob demanda)
docker compose -f compose.prod.yml run --rm -T ssam-ops sh -c \
  'rm -rf /data/cache/module-index/v1/o11 /data/cache/module-index/v1/odc /data/cache/readers/ss4 /data/cache/readers-prefetch/ss4 /data/cache/readers/ss4-prefetch /data/cache/module-index/kernel-studio.json'
rm /tmp/kernel.json
```

- A interina lê só o `kernel.json` v1. Nunca grave um `kernel.v2.json` (ela o ignora e o log diz `kernel-v2-ignored`).
- Faixa com outra versão no `kernel.json` fica desligada (`KERNEL_UNAVAILABLE`); o log diz `kernel-version-missing`
  com a versão do arquivo e a da imagem. A outra faixa continua.
- O passo 4 também acontece sozinho no primeiro início com outra versão (`kernel-cache-reset` no log). Ele continua no
  roteiro porque a imagem do rollback (a857a1e) não faz isso.
- Quem está no Service Studio 11.55.91 (o PC do dono também) perde a faixa O11 hospedada até a imagem de várias
  versões: `STUDIO_VERSION_MISMATCH` com `cause: "STUDIO_UPDATE_REQUIRED"` (até A-M1, `"STUDIO_VERSION_NOT_SERVED"`).
  Pacote novo não resolve. As ferramentas só do servidor continuam, com o aviso `studioNotServed`. Quem está no ODC
  Studio 1.7.27 recebe o mesmo na faixa ODC. Um Studio mais novo que o da imagem recebe
  `cause: "STUDIO_VERSION_NOT_SERVED_YET"` (o servidor ainda não tem; não volte o Studio).

**Build exato do Studio (A-M1 da proposta mínima de várias versões, 15/10).** O servidor identifica o Studio do cliente pelo
build de 4 números e compara com o build da pasta do Studio da imagem (o início grava
`{"event":"studio-builds","builds":{"o11":"11.55.92.65269","odc":"1.7.28.10850"},"studioBuildPolicy":{...}}`).
Para um build diferente com a mesma versão de 3 números, o campo opcional `studioBuildPolicy` do `kernel.json` decide:

- sem o campo, ou `"studioBuildPolicy": "warn"` (opção D-M2a): atende, e toda resposta da faixa traz
  `studioWarning` `studioBuildDiffers` com os dois builds. É o padrão: subir este código sozinho não corta quem é atendido
  hoje;
- `"studioBuildPolicy": "refuse"` (opção D-M2b): recusa como outra versão (`STUDIO_VERSION_MISMATCH`, pela direção);
- por faixa: `"studioBuildPolicy": {"odc": "refuse", "o11": "warn"}`. Valor desconhecido recusa nas duas faixas e o
  `studio-builds` vem com `policyInvalid: true`.

O `kernel.json` continua saindo do registro (passo 1). Para recusar outro build, acrescente o campo no `kernelV1` da
imagem em `release-record.json` (ou no `/tmp/kernel.json` antes do passo 2: `jq '. + {"studioBuildPolicy":"refuse"}'`).
A conferência do par (passo 2) aceita o campo. Só vale depois de reiniciar o `ssam-server`. Cada Studio recusado gera
uma vez `studio-version-unserved` no log (acesso, faixa, versões, motivo); o painel ainda não alerta sobre ele (A-P4).

- Pacote do agente da interina: a fina O11 compilada contra o 11.55.92 (`agent-pack.ps1 -ExpectO11 11.55.92`, com
  `ANVIL_STUDIO_DIR` na pasta extraída do instalador assinado) e a bridge ODC v97. O pacote v97 do 11.55.91 é recusado
  na faixa O11 (`AGENT_PACK_MISMATCH`); a faixa ODC dele continua.

Com a imagem só do ODC 1.7.28 (`prod-20261013-07e14b8`: o 24º envio no ODC Studio 1.7.28, `fase4-24/odc1728`,
`f912cb7e`, bundle `odc-studio-1.7.28.10850`, pacote do agente com a bridge ODC `v97`; a interina acima a substitui):

```bash
printf '%s\n' '{"o11":"11.55.91","odc":"1.7.28","odcBridge":"v97","odcBridgeAccepted":["v96","v48","v45"]}' \
  | docker compose -f compose.prod.yml run --rm -T ssam-ops sh -c 'cat > /data/server/kernel.json'
docker compose -f compose.prod.yml run --rm -T ssam-ops cat /data/server/kernel.json
```

- `odc` é a versão do ODC Studio dos clientes, sem o build: o servidor recusa a faixa ODC de um Studio de outra versão
  com `STUDIO_VERSION_MISMATCH` (um cliente que ainda está no 1.7.27 recebe essa recusa; o O11 não muda).
- A v96 continua aceita: carregada contra os assemblies do 1.7.28, 2072 dos 2073 métodos dela compilam. O único que não
  compila é o `refresh-references <Módulo> --producer <Biblioteca>`, porque o 1.7.28 mudou a assinatura de
  `IReferencesManagerService.RefreshSpecificReferencesByKey` (sexto parâmetro opcional). Para um pacote com bridge
  abaixo da v97 num ODC Studio 1.7.28, o servidor recusa esse comando antes de enviar, com `STUDIO_BRIDGE_OUTDATED`
  ("Nothing was sent") e o pedido do pacote novo. A v48 tem a mesma e única quebra. Mande o pacote v97 a todos os clientes
  ODC; tire a v96 de `odcBridgeAccepted` quando nenhum cliente a usar mais.

Com a imagem do 24º no 1.7.27 (`prod-20261012-a857a1e`, a do rollback deste salto), o valor é o anterior:
`{"o11":"11.55.91","odc":"1.7.27","odcBridge":"v96","odcBridgeAccepted":["v48","v45"]}`. Na faixa ODC ela recusa o
pacote v97 (`AGENT_PACK_MISMATCH`) e o ODC Studio 1.7.28 (`STUDIO_VERSION_MISMATCH`): depois desse rollback, a faixa ODC
de quem está no 1.7.28 para, com qualquer pacote; a faixa O11 continua.

Com a imagem do 23º (`prod-20261011-ed0f94b`), o valor é
`{"o11":"11.55.91","odc":"1.7.27","odcBridge":"v48","odcBridgeAccepted":["v45"]}`. O 23º não aceita os pacotes v96 e v97.

- `odcBridge` é a bridge ODC do pacote atual do agente. `odcBridgeAccepted` lista as bridges mais antigas que o servidor
  ainda atende: um agente com o pacote v96, v48 ou v45 continua funcionando depois do salto para v97. Sem esse campo,
  todo cliente ainda com um pacote antigo recebe `AGENT_PACK_MISMATCH` na faixa ODC.
- Um pacote antigo aceito degrada com códigos tipados nas funções novas do 24º: o Service Center responde
  `STUDIO_BRIDGE_OUTDATED` (a fina antiga não tem `sc_http`), e `studio_reference_producers` recebe
  `COMMAND_NOT_ALLOWED` do agente antigo. O resto funciona como antes.
- Só tire uma versão de `odcBridgeAccepted` quando nenhum cliente a usar mais. O log do servidor não mostra a bridge do
  agente (`agent-connected` traz a versão do agente e, desde A-M1, a versão de cada Studio instalado): confirme com cada cliente (`ssam-agent doctor` ou o `pack.json`
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

### 7.6 Migração do servidor Windows no ar

Hoje os clientes usam o servidor do Windows do dono. A virada para a VPS mantém os tokens e as credenciais dos agentes:
o `tokens.json` só tem hashes e é portátil.

1. **Antes**: a VPS no ar e provada com um token de teste (7.3 a 7.5), o backup e o heartbeat funcionando (seção 9).
2. **Janela**: anuncie aos clientes. Daqui até o fim, não emita nem revogue tokens no Windows.
3. **Estado**: da pasta de estado do servidor do Windows (`SSAM_SERVER_DIR`), copie para a VPS só estes arquivos:
   - `tokens.json` (hashes dos tokens e das credenciais dos agentes, com cliente, faixas e validade);
   - `kernel.json` (com `odcBridgeAccepted`, 7.1);
   - `machine-pins.json`, se existir (a máquina de cada agente; sem ele, o primeiro acesso de cada um vira a referência).

   **Não** copie `customers/` (os espaços de trabalho têm caminhos do Windows; o servidor refaz as capturas sob demanda),
   `server.log` nem as auditorias (arquive-as no Windows).
4. Na VPS, grave cada um no volume e reinicie:

   ```bash
   for f in tokens.json kernel.json machine-pins.json; do
     [ -f "$f" ] && docker compose -f compose.prod.yml run --rm -T ssam-ops sh -c "cat > /data/server/$f" < "$f"
   done
   docker compose -f compose.prod.yml restart ssam-server
   docker compose -f compose.prod.yml run --rm ssam-admin server-token list     # os mesmos tokens do Windows
   shred -u tokens.json kernel.json machine-pins.json 2>/dev/null || rm -f tokens.json kernel.json machine-pins.json
   ```

5. **Clientes**, um por um:
   - o cliente MCP troca só a URL para `https://ssam.seudominio.com/mcp` (o token é o mesmo);
   - o agente refaz o `setup --server https://ssam.seudominio.com --root C:\SSAM-Agent` (7.5) com a mesma credencial e
     reinicia (`ssam-agent.ps1 stop` e `start`);
   - confira no log da VPS o `agent-connected` daquele token e um `ssam_doctor` do cliente.
6. **Fim**: quando todos estiverem na VPS, pare o servidor do Windows. Enquanto os dois estiverem no ar, um revoke num
   não vale no outro: faça os dois, ou não revogue nada durante a janela.


## 8. Upgrade e rollback (por tag)

Recriar o `ssam-server` **interrompe** toda chamada em curso (um `o11_deliver` leva até 60 min; o cliente recebe erro e
repete depois) e fecha as sessões MCP e os canais dos agentes. Os agentes reconectam sozinhos em segundos; os clientes MCP
abrem sessão nova. Não há drenagem automática: escolha a hora.

**Antes**: anuncie a janela aos clientes e veja se há trabalho em curso. As últimas chamadas e o horário delas:

```bash
docker compose -f compose.prod.yml run --rm -T ssam-ops sh -c \
  'grep -hE "\"event\":\"(session-opened|agent-call|mcp-response-flushed)\"" /data/server/server.log | tail -n 5 | cut -c1-160'
docker stats --no-stream "$(docker compose -f compose.prod.yml ps -q ssam-server)"    # CPU alta = trabalho em curso
```

Um `agent-call` ou `mcp-response-flushed` de poucos minutos atrás, ou CPU alta, quer dizer que alguém está trabalhando:
espere ou combine.

**Upgrade**

1. Faça um backup: `sh backup.sh --online` (a pasta já existe desde a seção 5). O `.info` grava a tag, o id, a revisão
   (commit) e os digests da imagem que está no ar: é o que o rollback usa.
2. Gere a imagem nova com uma tag nova (seção 6). Nos caminhos B e C, atualize também a pasta `deploy` (seção 5).
3. Troque `SSAM_IMAGE_TAG` no `.env` (no caminho B, com o digest).
4. Recrie só o servidor: `docker compose -f compose.prod.yml up -d ssam-server`.
   - Com o painel do dono ligado (seção 15), recrie os dois: `up -d ssam-server ssam-console`. O painel usa o módulo de
     tokens da imagem e anda com a mesma tag.
   - O Caddy espera até 15 s pelo servidor antes de responder 502.
   - Opcional, para não acumular no volume `cache` as cópias de leitores das versões antigas: antes do `up -d`, pare o
     servidor (`stop ssam-server`) e esvazie a pasta dos leitores com
     `docker compose -f compose.prod.yml run --rm -T ssam-ops find /data/cache/readers -mindepth 1 -delete`.
5. Confira `ps` (healthy), `/health` e o log (`listening`, `kernel`, `warm`).
6. Se mudou a versão de um Studio ou da bridge ODC, atualize o `kernel.json` (7.1) e mande o pacote novo do agente aos
   clientes. Num salto de bridge, a anterior entra em `odcBridgeAccepted` até todos os clientes trocarem de pacote.
   - Quando o `kernel.json`, o `Features.plain.xml` ou os caches mudam com a versão (a interina), a ordem é outra: confira
     o par (7.1, passos 1 e 2) com a imagem antiga ainda no ar; depois pare o servidor (`stop ssam-server`), grave o
     `kernel.json`, esvazie os caches e grave o Features; só então os passos 3 e 4. A imagem antiga nunca roda com o par
     da nova, nem num reboot. Se parar antes do passo 3, grave de volta o `kernel.json` e o Features que estavam no ar e
     rode `start ssam-server` (o mesmo container, sem recriar).

Para o Caddy, troque a imagem fixada em `compose.prod.yml` (tag e digest, resolvidos com
`docker buildx imagetools inspect caddy:<versão>-alpine`) e rode `up -d caddy`.

**Rollback**

O rollback volta a imagem **e** os arquivos que andam com ela: `compose.prod.yml`, `Caddyfile`, scripts e `kernel.json`.

1. Descubra o commit da versão anterior: está no `.info` do backup do passo 1 (`revision`), ou nos rótulos da imagem:
   `docker image inspect <imagem>:<tag anterior> --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'`.
2. Volte a pasta `deploy` para esse commit: no caminho A, `git checkout <commit>` no repositório; nos caminhos B e C, o
   `git archive` desse commit (seção 5). O `.env` fica.
3. Volte `SSAM_IMAGE_TAG` no `.env` para a tag anterior (no caminho B, com o digest anterior).
4. Grave o `kernel.json` da imagem que volta, do registro, e confira o par dentro dela antes de subir (desenho de várias
   versões, O.6.1 itens 5 e 9). Da interina para a `prod-20261012-a857a1e` (`TAG` = a tag que volta; `previous` no
   registro; para outra imagem, a tag dela):

   ```bash
   TAG=prod-20261012-a857a1e
   run_check() { docker run --rm --network none --entrypoint node -v "$PWD/kernel-pair-check.mjs:/c.mjs:ro" "$@"; }
   run_check -v "$PWD/release-record.json:/r.json:ro" "ssam-server:$TAG" /c.mjs print previous /r.json > /tmp/kernel.json
   cat /tmp/kernel.json   # {"o11":"11.55.91","odc":"1.7.27","odcBridge":"v96","odcBridgeAccepted":["v48","v45"]}
   run_check -v /tmp/kernel.json:/k.json:ro "ssam-server:$TAG" /c.mjs check /k.json; echo "exit $?"
   # só siga com exit 0 ("pair-ok"). 2 ("refused-pair"), 1 (erro de leitura) ou 125 (imagem ausente): pare aqui. Não
   # suba essa imagem com esse arquivo; volte a tag da interina no .env. Nada mudou no ar.
   # a parada começa aqui: com a interina parada, ela não refaz os caches com a versão dela depois do rm
   docker compose -f compose.prod.yml stop ssam-server
   docker compose -f compose.prod.yml run --rm -T ssam-ops sh -c 'cat > /data/server/kernel.json' < /tmp/kernel.json
   docker compose -f compose.prod.yml run --rm -T ssam-ops sh -c \
     'rm -rf /data/cache/module-index/v1/o11 /data/cache/module-index/v1/odc /data/cache/readers/ss4 /data/cache/readers-prefetch/ss4 /data/cache/readers/ss4-prefetch /data/cache/module-index/kernel-studio.json'
   rm /tmp/kernel.json
   ```

   - Nunca deixe o `kernel.json` da interina com a a857a1e: ela não tem guarda própria e aceitaria o pacote do 11.55.92,
     rodando o kernel do 11.55.91 contra o Service Studio 11.55.92 do cliente.
   - O passo dos caches tira o índice e os leitores feitos pela versão que sai. A a857a1e refaz o que precisar.
   - Volte também o `Features.plain.xml` do ODC Studio da imagem que volta (7.2), se ele mudou.
5. `docker compose -f compose.prod.yml up -d`: recria o servidor e, se o compose ou o Caddyfile mudaram, o Caddy.
6. A imagem anterior tem de existir na VPS ou no registro. Não rode `docker image prune -a` enquanto um rollback puder ser
   preciso.
7. Se a versão nova mudou o formato do estado, volte também o backup do passo 1 do upgrade: `sh restore.sh <arquivo>`.

### 8.1 Interruptor do `ssam_code` hospedado (`SSAM_HOSTED_SSAM_CODE`, marco-a8)

Desde o marco-a8 a imagem serve o `ssam_code` (`grammar`, `read`, `check`, `plan`, `write`) com tudo no workspace do cliente.
O `compose.prod.yml` passa `SSAM_HOSTED_SSAM_CODE` do `.env` ao `ssam-server`, e o servidor lê a variável **uma vez, na
partida**:
- ausente ou vazia: como a imagem manda (servido);
- `off`: o estado de antes do marco-a8, palavra por palavra (`HOSTED_UNAVAILABLE`, causa `SSAM_CODE_HOSTED_PENDING`, continuação
  `ssam_map`; nada roda); `on`: servido. Maiúsculas e espaços não importam; outro valor não liga nada (o evento diz `ignored`).

Desligar sem imagem nova (recria só o `ssam-server`; as sessões MCP reconectam):

```bash
cd /opt/ssam/deploy
printf '\nSSAM_HOSTED_SSAM_CODE=off\n' >> .env       # printf, não echo: um .env sem quebra de linha no fim colaria a linha
docker compose -f compose.prod.yml up -d ssam-server
docker compose -f compose.prod.yml logs ssam-server | grep '"event":"hosted-ssam-code"' | tail -n 1   # "served":false,"switch":"off"
```

Religar: `sed -i '/^SSAM_HOSTED_SSAM_CODE=/d' .env` e o mesmo `up -d ssam-server`; o evento diz `"served":true,"switch":null`.
O `tools/list` tem os mesmos 92 nomes nos dois estados.


## 9. Backup e restore

```bash
sh backup.sh --online        # sem parar o servidor: o modo do cron diário
sh backup.sh                 # para o ssam-server durante a cópia (consistente) e sobe de novo: só numa janela anunciada
sh restore.sh /var/backups/ssam-server/ssam-state-<data>.tar.gz
```

- O backup grava `ssam-state-<data>.tar.gz` em `BACKUP_DIR` (criada na seção 5), com `.sha256` e `.info`. O `.info` diz
  a tag, o id da imagem, a revisão (commit), os digests de registro, o projeto e o modo.
  Leva os três volumes de estado. Não leva o volume `cache` (o servidor o refaz), os certificados do Caddy (são emitidos
  de novo) nem a imagem.
- O backup leva também os registros de qualidade (`quality-AAAAMMDD.jsonl`), que ficam em `/data/server` junto da
  auditoria.
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
  - Com o painel do dono ligado, pare-o antes do restore e reindexe depois (15.6).

**Agendamento diário.** Nesta VPS o operador é o root, e o cron vem do `sh host/install.sh --with-crons` do painel do
dono (seção 15). Ele grava `/etc/cron.d/ssam-backup` só quando o arquivo ainda não existe (um arquivo diferente fica
como está e o script mostra a diferença), cria a pasta dos backups (0700) e o `cron.log` (0600) se faltarem:

```
30 3 * * * root cd /opt/ssam/deploy && sh backup.sh --online >> /var/backups/ssam-server/cron.log 2>&1
```

Antes de ir ao ar, rode o mesmo comando do cron uma vez, de verdade, na pasta `deploy`:

```bash
sh backup.sh --online >> /var/backups/ssam-server/cron.log 2>&1; echo "exit $?"
tail -n 5 /var/backups/ssam-server/cron.log
```

- Tem de dar `exit 0`, e o log tem de mostrar `backup: ... sha256 ...`.
- Com um operador sem root (grupo docker, pasta dos backups com o dono dele, seção 5), grave a mesma linha com o
  usuário dele no lugar de `root` (`sudo tee /etc/cron.d/ssam-backup`) em vez de usar o `--with-crons`.
- O painel (aba VPS) mostra o último backup, a idade dele e as últimas linhas `backup:` do `cron.log`, e alerta quando
  não há backup, quando o mais novo tem mais de 26 h, quando a última linha diz `FAILED` e quando falta o cron.

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
- **O `/health` só prova que o HTTP responde.** Ele continua 200 com o `kernel.json` faltando ou com os workers mortos.
  Alerte também, pelos logs do Docker (ou pelo `server.log`), quando aparecer:
  - `"event":"kernel"` com `"o11":null` ou `"odcBridge":null`: o `kernel.json` não foi lido (7.1);
  - `"event":"warm"` com `failed` ou `error`: um worker não subiu;
  - `"event":"agent-machine-changed"` (também em `access-alerts.jsonl`): a credencial de um agente foi usada de outra
    máquina. No Windows o servidor avisa o dono na tela; na VPS só fica a linha, então o alerta tem de vir do monitor.

  ```bash
  docker compose -f compose.prod.yml logs --since 24h ssam-server \
    | grep -E '"event":"(agent-machine-changed|tokens-unreadable|audit-failed)"|"event":"kernel".*"o11":null|"event":"warm".*(fail|error)'
  ```

  Qualquer linha é alerta. Ponha esse comando num cron com aviso (ou num agente de logs) junto com o monitor externo.
- **O painel do dono (seção 15) cobre essa lista** sem cron: `kernel` com `o11` ou `odcBridge` nulos, aquecimento com
  falha, credencial de agente usada de outra máquina, `tokens-unreadable`, `audit-failed` e `request-failed`, container
  parado, unhealthy, reiniciado ou morto por falta de memória, disco, memória, certificado, backup, rotação e recusas de
  acesso no Caddy. Ele só avisa quem o abre: o monitor externo do `/health` e o heartbeat do backup continuam valendo
  para o aviso fora dele.
- **Logs**: `docker compose -f compose.prod.yml logs -f --since 1h ssam-server caddy`.
  - O servidor escreve eventos JSON: `listening`, `kernel`, `warm`, `session-opened` e `session-closed`,
    `agent-connected`, `agent-call` e `mcp-response-flushed`.
  - O Caddy escreve o log de acesso em JSON, com o `Authorization` tapado.
  - Os dois rodam em `json-file` com rotação (5 arquivos de 20 MB). O `ssam-admin` não guarda log (mostra tokens).
- **Arquivos no volume** (`/data/server`):
  - `server.log`;
  - `audit-AAAAMMDD.jsonl`: uma linha por chamada de ferramenta, com token, cliente, ferramenta, duração e resultado;
  - `quality-AAAAMMDD.jsonl`: uma linha por chamada de ferramenta só com códigos, contagens e tempos (o motivo de cada
    recusa por código, as correções automáticas por regra, as fases da entrega e o intervalo entre chamadas) e uma
    por sessão MCP aberta e fechada. Nenhum conteúdo dos clientes. Só o modo hospedado grava; `SSAM_QUALITY=0` no
    `.env` desliga.
  - `access-alerts.jsonl` e `machine-pins.json`: credencial usada de outra máquina.

  Para ler: `docker compose -f compose.prod.yml run --rm ssam-ops sh -c 'tail -n 50 /data/server/server.log'`.
- **Rotação e retenção** (`rotate-logs.sh`). O servidor anexa cada evento ao `server.log` e nunca o gira, e grava um
  `audit-AAAAMMDD.jsonl` por dia. O script roda dentro do `ssam-ops`, com o dono e o caminho certos (um logrotate do host
  como uid 10001 não atravessa `/var/lib/docker`, que é do root). Ele:
  - gira o `server.log` para `server.log.<data>.gz` (o servidor reabre o arquivo a cada linha, então renomear é seguro);
  - apaga os girados com mais de `LOG_KEEP_DAYS` (padrão 56);
  - comprime as auditorias dos dias anteriores e, com `AUDIT_KEEP_DAYS` maior que 0, apaga as mais velhas que isso;
  - comprime os registros de qualidade dos dias anteriores e, com `QUALITY_KEEP_DAYS` maior que 0, apaga os mais
    velhos que isso (padrão 0: guarda tudo, como a auditoria);
  - com `INDEX_KEEP_DAYS` maior que 0, apaga do volume `cache` os arquivos do índice de módulos sem uso há esse tempo.

  Uma vez por semana, pelo cron que o `sh host/install.sh --with-crons` grava (seção 15; com outro operador, a mesma
  linha com o usuário dele no lugar de `root`). Rode uma vez na mão antes de ir ao ar, na pasta `deploy`:

  ```
  15 4 * * 0 root cd /opt/ssam/deploy && sh rotate-logs.sh >> /var/backups/ssam-server/cron.log 2>&1
  ```

  ```bash
  sh rotate-logs.sh; echo "exit $?"
  ```

  A retenção da auditoria é uma decisão do dono e dos contratos dos clientes: o padrão guarda tudo. Arquive as antigas
  fora da VPS antes de apagar, se o contrato pedir.
- **Disco**:
  - `df -h /var/lib/docker` e `docker system df`;
  - por volume: `docker compose -f compose.prod.yml run --rm ssam-ops`, que mostra o `du` dos quatro.
- **Recursos**: `docker stats`. Os 6 GB de `SSAM_MEMORY` são uma estimativa: meça com duas entregas ao mesmo tempo
  (`docker stats` durante dois `o11_deliver`). Cada processo .NET vê o limite inteiro do container, e um estouro derruba
  todos os workers e as sessões. Alerte quando `docker inspect --format '{{.State.OOMKilled}}'` der `true` ou quando o
  `RestartCount` subir. Se acontecer, suba `SSAM_MEMORY` ou baixe `SSAM_BUILD_WORKERS`.
- **Tentativas de acesso**: o limite do servidor é por token (o token tem 256 bits), não por IP. Rajadas de 401 ou de
  conexões ociosas não têm teto. Use o firewall do provedor (limite de conexões) ou um `fail2ban` sobre o log JSON do
  Caddy (`status` 401/403 por `request.remote_ip`).
- **Certificado**: o Caddy renova sozinho, cerca de 30 dias antes de vencer. Procure erros com
  `docker compose -f compose.prod.yml logs caddy | grep -i error`.

## 11. Corte remoto e desligamento de cliente

- **Um cliente**: `docker compose -f compose.prod.yml run --rm ssam-admin server-token revoke --id tok_...`.
  - Vale sem reinício.
  - Os pedidos novos recebem 403.
  - As sessões MCP abertas e o canal do agente daquele token fecham em cerca de 1 s, e o agente para (código 2).
- **Só a credencial do agente**: `server-token agent-rotate --id tok_...`. A anterior deixa de valer na hora.
- **Todos de uma vez**: `docker compose -f compose.prod.yml stop caddy`. Ninguém de fora chega ao servidor, e o estado
  fica. Para voltar: `start caddy`.
- Tokens emitidos com `--days` vencem sozinhos.

**Desligamento de um cliente** (fim de contrato). O revoke corta o acesso, mas as capturas do cliente continuam no disco:

1. `server-token revoke --id tok_...` e confira com `server-token list`.
2. Apague o espaço de trabalho dele (capturas, jornais, transferências):
   `docker compose -f compose.prod.yml run --rm -T ssam-ops rm -rf /data/server/customers/tok_...`
3. O volume `cache` guarda o índice de módulos de todos os clientes junto, sem separação por cliente. Esvazie-o com o
   servidor parado (`stop ssam-server`, depois
   `docker compose -f compose.prod.yml run --rm -T ssam-ops find /data/cache -mindepth 1 -delete`, depois
   `start ssam-server`). O servidor o refaz.
4. Os backups (locais e fora da VPS) ainda têm os dados dele até saírem pela retenção (`BACKUP_KEEP_DAYS` e a regra do
   bucket). Diga ao cliente esse prazo. A auditoria dele fica pela retenção da seção 10.
5. Os dados dos clientes ficam sem cifra dentro dos volumes. Use um provedor com disco cifrado em repouso (ou cifre o
   volume de bloco) e trate o acesso SSH à VPS como acesso aos dados de todos os clientes.


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

### Resultado dos ensaios de 2026-10-11

Docker Desktop 29.8.2 (linux/amd64), `.env` do ensaio com 3 CPUs, 6 GB e 2 workers, o override acima e o `Caddyfile`
deste repositório. Tudo pelo HTTPS do Caddy em `127.0.0.1:28443`, com a raiz local do Caddy em `NODE_EXTRA_CA_CERTS` (TLS
verificado, sem `-k` nos clientes Node). Segundo ensaio (depois da revisão), imagens `ssam-server:prod-20261011-83f936c`
(22º envio) e `ssam-server:prod-20261011-8ae231d` (23º envio, ver a seção 14).

| Item | Resultado |
| --- | --- |
| Bundles | ODC Studio instalado ainda 1.7.27.10846 e Service Studio 11.55.91.65258: os bundles de 2026-10-10 conferem arquivo por arquivo com os Studios e com as listas `studio-*.txt`. O build confere o SHA-256 fixado de cada um. |
| Guarda no build | `build.sh` com um arquivo de teste com nome de cliente no contexto: a guarda falha e nada é construído. Sem ele: 4/4 e o build segue. |
| Build (`build.sh`) | Guarda ~20 s (bind mount do Windows) + build. Sem cache de camadas (`--no-cache`; bases e NuGet já locais): 45 s de build, 67 s no total. Com cache, numa mudança de código: 32 a 52 s. |
| Tamanho | 1,13 GB descompactada; o `docker save -o` dá um arquivo de 297 MB (camadas já comprimidas). |
| Subida | `healthy` em menos de 10 s. Aquecimento de 1,5 min num container novo (índices do discover, 41 s por faixa); depois de um `restart`, 4 s. |
| Processo e disco | uid/gid 10001, PID 1 `docker-init`, `NoNewPrivs`, nenhuma capability. Código e Studios só de leitura para o `ssam` (gravações recusadas em `/app`, `/studio`, `/usr`, `/etc`); grava só nos volumes, em `/tmp` e nos caches de `/app`. Caddy com raiz só de leitura, `/tmp` em tmpfs e só `NET_BIND_SERVICE`. |
| Rede | `ssam-server` só na rede `backend` (interna): sem DNS nem internet (`EAI_AGAIN`). Portas do host só no Caddy, e só 127.0.0.1:28080/28443. Rede `edge` com IPv6 (sub-rede ULA automática; o Caddy ganhou endereço IPv6). |
| `/health` | 200 pelo Caddy, com HSTS, nosniff, DENY, CSP, CORP e no-referrer, sem `Server`. Outros caminhos: 404. HTTP 28080: 308 para HTTPS. |
| Tokens | emitidos pelo `ssam-admin`, que roda sem log (`docker logs`: "configured logging driver does not support reading"). O `tokens.json` guarda só `sha256` e `agentSha256`. |
| MCP | `initialize` e `tools/list` (79 ferramentas); `ssam_reference` e `ssam_discover` nas duas faixas; `o11_extension` recusado com `HOSTED_UNAVAILABLE` (`XIF_ENGINE_WINDOWS_ONLY`). |
| Acesso negado | sem token, token desconhecido ou credencial de agente no `/mcp`: 401. Token revogado: 403 `Token revoked` no `/mcp` e `AGENT_REVOKED` no canal do agente (por desenho: 401 é "quem é você", 403 é "esse token não vale mais"). |
| `kernel.json` | o evento `kernel` mostra `odcBridgeAccepted: ["v45"]`. |
| Agente (Studios falsos) | 14/14: `studio_status`, `studio_attach`, captura de 6 MiB, `ssam_connect`, `o11_studio`, `o11_deliver` "entregue" (kernel O11 no Linux), `studio_deliver` ODC recusado de uma vez nas quatro fases com `verifyRan:true`, `ssam_map` digest nas duas faixas. Uma entrega ODC de 93 s durante o aquecimento passou 6 keepalives SSE pelo Caddy. |
| Conexão longa | canal do agente aberto 7 min pelo Caddy, consultado a cada 30 s: sem queda nem reconexão. Com o `keepalive 4s`, nenhum 502 em 264 pedidos (191 `POST /agent/v1/messages`). |
| Restart e recriação | tokens e revogações mantidos; o agente reconecta em cerca de 1 s. Depois de `--force-recreate`, o índice de módulos continua no volume `cache` (`ssam_map` em 88 ms, antes 4,6 s). |
| Builder residente | antes da correção de `ssam-server-start`, todo container novo dava `warm` com "the resident builder failed to start"; depois, `builder ok` já na primeira subida. |
| Backup, restore e rotação | como um usuário comum no grupo do socket do Docker, com a pasta `deploy` vinda de `git archive` (caminhos B e C): pasta ausente recusada com o comando que resolve; a linha do cron (online) com cópia cifrada `age` + `rclone` (decifra para o mesmo SHA-256) e heartbeat; falha no envio sai com erro e sem heartbeat; cópia parada com o servidor de volta e healthy; `rotate-logs.sh` gira, comprime e apaga pelas idades; restore que falha antes de mexer no estado sobe o servidor de novo; restore bom com `tokens.json` idêntico. 36 de 38 verificações passaram; as 2 restantes eram erro do próprio teste (revisão `-dirty` e dono mostrado como `ssam` em vez de `10001`). |
| Segredos | nenhum token nem credencial no `server.log`, na auditoria, nos jornais e atritos dos clientes, nos logs do Docker, do Caddy (Authorization `REDACTED`), do agente, do teste de operação e dos builds. |
| Nomes de cliente | nenhum nos arquivos do SSAM na imagem. As 12 ocorrências da varredura são de terceiros: bytes de binários (.NET, ICU, node, um plugin do Service Studio) e pedaços de identificadores dos tipos do AWS SDK. Os arquivos internos do dono (`.mcp.json`, `hosts.json` etc.) não estão na imagem. |

Correções do primeiro ensaio, todas com commit no `main`: cache do NuGet por estágio, pasta de autoridade do dono e
pasta `features` vazia do builder (`server/Dockerfile`); versão da bridge ODC no pipe hospedado; caminhos Linux
apresentados como `ws:` (`hosted/policy.mjs`); `TMPDIR` dos processos do kernel (`executor.mjs`); cache de features do ODC
no Linux (`OdcFeatures.cs`, `odc-features-export.ps1`, 7.2); argumentos dos rótulos só antes do `LABEL`.
Correções do segundo ensaio: `build.sh` desligava a conversão de caminhos do Git Bash para o script inteiro (o `git` não
achava o repositório); `ssam-server-start` cria a chave da autoridade antes do node (builder residente).

### Terceiro ensaio (2026-10-11): imagem candidata à produção

**`ssam-server:prod-20261011-ed0f94b` é a imagem candidata à produção.** É a primeira imagem do `main` com as quatro
correções do primeiro ensaio e a `bfd3ec7` reaplicada (`ed0f94b`, seção 14). As imagens `prod-20261011-8ae231d` e
anteriores não vão para produção.

Mesma máquina, mesmo `.env` (3 CPUs, 6 GB, 2 workers) e mesmo override. Os volumes do segundo ensaio já não existiam:
a primeira subida foi refeita do zero (7.1, 7.2 e 7.4), o que também a prova.

| Item | Resultado |
| --- | --- |
| Imagem | `build.sh` no `main` em `ed0f94b`, árvore limpa: guarda 4/4, 91 s no total (15 s de build com o cache de camadas). Id `sha256:232e6a22dec2788d2964fd87b617ac54ca120906517557b1a0a9616b7b57f174`, 1,13 GB, linux/amd64, uid 10001. Rótulos: versão `prod-20261011-ed0f94b`, revisão `ed0f94ba986867ae132dc72ca97c84e7cb2c4d78` (sem `-dirty`). Só local: nada foi para registro. |
| Primeira subida | `kernel.json` (7.1) e `Features.plain.xml` (7.2, 500 features, exportado pelo `odc-features-export.ps1`; a cópia local foi apagada depois de gravada) nos volumes novos, donos 10001. `healthy` em 7 s; o evento `kernel` mostra `odcBridgeAccepted: ["v45"]`. |
| `/health` | 200 pelo Caddy, com TLS verificado pela raiz local. Cabeçalhos: HSTS, nosniff, DENY, CSP `default-src 'none'; frame-ancestors 'none'`, CORP `same-origin` e `no-referrer`, sem `Server`. Outro caminho: 404. HTTP 28080: 308 para HTTPS. `/mcp` sem token: 401. |
| MCP | 10/10: 401 sem token, com token desconhecido e com a credencial do agente; `initialize` e `tools/list` (79 ferramentas); `ssam_reference` e `ssam_discover` nas duas faixas (o primeiro `ssam_discover` O11 levou 83 s no aquecimento); `o11_extension` recusado com `HOSTED_UNAVAILABLE`. |
| Agente (Studios falsos) | 16/16: os 14 do segundo ensaio e mais dois. `studio_snapshot` devolve `ws:odc/snapshots/...`. `ssam_map` (as duas faixas) e `studio_inspect` aceitam de volta esses caminhos `ws:`. Nas 12 respostas (6 caminhos `ws:` diferentes), nenhuma traz `/ws:` nem `{<servidor>}`, e o `studio_status` mantém o `{app}` das URLs de aplicação: o defeito que a `bfd3ec7` corrige não aparece. `o11_deliver` "entregue" em 5,2 s. `studio_deliver` ODC recusado de uma vez nas quatro fases, em 3,6 s. Nenhuma reconexão do agente em 46 chamadas. |
| Restart e recriação | Um token revogado antes do `restart` e do `--force-recreate`. Depois de cada um, os dois tokens ativos continuam com 200, e o revogado continua com 403 `Token revoked` no `/mcp` e `AGENT_REVOKED` no `hello` e no `stream` do agente. O agente reconecta sozinho. Depois da recriação, `ssam_map` com caminho `ws:` em 63 ms (antes, 4,7 s): o índice ficou no volume `cache`. |
| Backup e restore | 38/38, como operador comum (uid 1000 no grupo do socket), com a pasta `deploy` vinda de `git archive ed0f94b`: linha do cron (online) com cópia cifrada `age` + `rclone` e heartbeat; falha no envio; `rotate-logs.sh`; cópia parada; restore que falha antes de mexer no estado; recusas; restore bom com `tokens.json` idêntico. O `.info` traz a revisão `ed0f94b...` sem `-dirty`. Os dois erros do teste no segundo ensaio foram corrigidos (o dono agora é conferido como uid). Depois do restore: tokens e revogação mantidos, agente reconectado. |
| Segredos | Nenhum token nem credencial em 28 arquivos: `server.log`, auditoria, jornais e atritos dos clientes, logs do Docker (servidor e Caddy, com `Authorization` `REDACTED`), agente, preparação do agente, teste de operação e build. |
| Nomes de cliente | Nenhum nos logs (os 11 termos da lista). Na imagem, as mesmas 12 ocorrências de terceiros do segundo ensaio e nenhuma nova. |
| Recursos | Em repouso, depois do ensaio: `ssam-server` com 415 MiB dos 6 GiB e 34 processos; Caddy com 15 MiB. |

A pilha do ensaio foi derrubada com `docker compose down`, e os volumes do ensaio ficaram.

## 13. Problemas comuns

| Sintoma | Causa provável |
| --- | --- |
| 502 do Caddy | `ssam-server` parado ou ainda subindo: `ps` e `logs ssam-server`. |
| Certificado não sai | DNS não aponta para a VPS, porta 80 ou 443 fechada, ou limite do Let's Encrypt (use staging). |
| 401 `Unknown token` / 403 `Token revoked` ou `expired` | Token errado, revogado ou vencido: `server-token list`. |
| `AGENT_PACK_MISMATCH` | `kernel.json` (7.1) não bate com o pacote do agente do cliente: a bridge do pacote não é `odcBridge` nem está em `odcBridgeAccepted`, ou o `o11BuiltFor` não é o `o11`. |
| `STUDIO_VERSION_MISMATCH` | O servidor não atende o Studio do cliente (7.1). `cause` diz a direção: `STUDIO_UPDATE_REQUIRED` (Studio mais velho: o cliente atualiza), `STUDIO_VERSION_NOT_SERVED_YET` (mais novo: pede imagem e `kernel.json` novos, bundle da seção 4, features da 7.2), `STUDIO_BUILD_UNKNOWN` (com `studioBuildPolicy: "refuse"`, o agente não mandou o build) ou `STUDIO_VERSION_UNKNOWN` (o agente não leu a versão). A resposta traz os dois builds e o texto em pt-BR (`userMessage`). |
| `studioWarning` `studioBuildDiffers` numa resposta | O cliente está noutro build da mesma versão e `studioBuildPolicy` é `warn` (7.1): atendido, sem prova do par. Imagem com o build novo, ou `refuse`. |
| `studioWarning` `studioNotServed` numa resposta | Ferramenta só de servidor rodou enquanto o Studio do cliente não é atendido (as do Studio são recusadas). |
| 403 `Origin not allowed` | Cliente de navegador com uma origem diferente de `https://<SSAM_DOMAIN>`. |
| `HOSTED_UNAVAILABLE` em `o11_extension`, `odc_external_library`, depurador ou preview | Esperado: essas ferramentas não rodam no servidor hospedado Linux. |
| `HOSTED_UNAVAILABLE` em `ssam_debug_server`, `ssam_debug_client` ou `ssam_debug_matrix` | Esperado (24º): o depurador continua fora do hospedado, como o `ssam_debug`. |
| `HOSTED_UNAVAILABLE` com `cause:"API_CLIENT_ONLY"` em `odc_native_package`, `odc_generated_code`, `odc_asset_source` ou `odc_asset_revision` | Esperado (24º): só funcionam com o API Client do cofre e baixam para o journal local. A resposta traz a continuação pela sessão do Studio. |
| `HOSTED_UNAVAILABLE` com `cause:"PROTOTYPE_SOURCE_LOCAL"` em `o11_deliver`, `studio_deliver`, `ssam_job` ou `o11_job` | Esperado (24º): o op `prototype` (importador de protótipo) é recusado no hospedado antes de qualquer captura; vale também em job composto. |
| `HOSTED_STUDIO_SESSION_ONLY` ou `HOSTED_PROMPT_UNAVAILABLE` no Service Center ou no Portal | Esperado (24º): no hospedado vale só a sessão do Studio do cliente (`sc_http` e `portal-session`). Perfil privado, cofre, janela de credencial, prompt, `select-profile`, `portal-credential`, `portal-private-*`, SSO, identidade e LifeTime são recusados antes de tentar. |
| `STUDIO_BRIDGE_OUTDATED` no Service Center, ou `COMMAND_NOT_ALLOWED` em `studio_reference_producers` | O cliente está com um pacote do agente anterior ao v96 (7.1). Mande o pacote novo. |
| `STUDIO_BRIDGE_OUTDATED` em `refresh-references --producer` (faixa ODC) | Pacote com bridge abaixo da v97 num ODC Studio 1.7.28: nada foi enviado (7.1). Mande o pacote v97. |
| 429 | Limite por token: `SSAM_RATE_PER_MINUTE`, ou 8 sessões abertas por token. |
| Build para em "has no pinned SHA256" | Falta `*_BUNDLE_SHA256` (ou `*_SHA256` do instalador) no `.env` (seção 4). |
| `ODC Studio feature cache not found` ou `ODC feature provider could not load the local cache` | Falta o `Features.plain.xml` no volume, ou foi copiado o `Features.xml` cifrado do Windows (7.2). |
| Primeiro `ssam_discover` demora mais de 1 min | Aquecimento depois de um container novo (7.3). |
| `DESTRUCTIVE_HOSTED_OFF` (`HOSTED_UNAVAILABLE`) num apagar ou em `o11_access apply` | Esperado (marco-a5 e marco-a6): apagar fica desligado no hospedado, a prévia e a execução, com ou sem `confirmationToken`. O usuário apaga no Service Center ou no Portal. |
| `VERIFIED_PATCH_LOCAL` num job | Esperado (marco-a5): `patch:"verified"` não roda no hospedado; mande o patch explícito. |
| `state: "running"` com `continueTask` numa resposta | Esperado (marco-a6): a chamada passou de 25 s e segue no servidor. O cliente continua com `continueTask` ou lê com `ssam_task {id}`. A continuação só acha tarefa do próprio token (outro token: `TASK_NOT_FOUND`). |
| `HTML_BASE_CHANGED`, `DDL_BASE_UNKNOWN` ou `FLOW_BASE_CHANGED` depois de uma leitura antiga | Esperado (marco-a6): no hospedado um job só usa a leitura guardada da captura em que roda (`ANVIL_KEPT_READINGS=own`). Leia de novo e mande a edição sobre a leitura nova. |
| `ANSWER_ORIGIN_UNKNOWN` no `ssam_evidence` de um `ws:o11/answers/...` | Esperado (marco-a7): a resposta foi guardada antes da troca, sem o registro de origem em `<ws>/state/answer-origins`. O cliente repete a chamada que devolveu o caminho. |
| `REFERENCE_DAY_LIMIT` no `ssam_reference` | Esperado (marco-a7): 256 KB por dia por token, somando todas as sessões do token; volta à meia-noite UTC. `check-job` e `check-delivery` ficam fora do limite. Os totais estão em `/data/server/exposure/served-<dia>.json` (só ids `tok_` e bytes). |
| `MANAGE_DEPENDENCIES_HOSTED_PENDING` (`HOSTED_UNAVAILABLE`) em `o11_studio refresh-references` com `add` ou `published` | Esperado (marco-a7): o Manage Dependencies por código precisa de um pacote do agente novo; nada foi enviado ao Studio. |
| `DELIVERY_STILL_RUNNING` numa entrega repetida | Esperado (marco-a8): entregas e criações rodam até o fim numa chamada (sem `running` aos 25 s). A repetição idêntica junta-se à que roda (`joined`) ou, até 10 min depois, recebe a resposta guardada (`resumedFrom`); com outro conteúdo (job, `ws:` ou arquivo `agent:` mudado), `DELIVERY_STILL_RUNNING` "changed" e nada começa. Parar: `ssam_task {id, stop:true}`. Timeout de ferramenta do cliente: 10 min ou mais |
| `HOSTED_UNAVAILABLE` / `SSAM_CODE_HOSTED_PENDING` no `ssam_code` | O interruptor está em `off` (8.1). Sem ele o `ssam_code` é servido desde o marco-a8 |
| `AGENT_FOLDER_UNKNOWN` no `ssam_code plan` | O plano leva prompts e `plan.json` à pasta do agente do cliente, e o agente não disse a pasta: o cliente reconecta o agente |
| `PATH_OUTSIDE_WORKSPACE` com o texto genérico ("outside the folders the agent reads … nothing was read there") | Esperado (marco-a9): o caminho não volta na recusa. O cliente põe o arquivo na `inbox` do agente e manda `agent:inbox/<arquivo>` (o `fix` e a continuação dizem como) |
| `DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED` numa carga por arquivos (`o11_data` `request.files`, `studio_data_insert/update` `files`) | Esperado (marco-a9, CX13): linhas que mudariam param antes de escrever (`updatePreview`, arquivos como `ws:`) até `confirmUpdates` com as palavras do dono. Plano e diário ficam em `ws:o11/data/loads` e `ws:odc/journal/data/loads` do cliente |
| `patchesApplied` e `nextBasedOn` numa entrega ou num job | Esperado (marco-a9, X3): as correções certas entram na mesma chamada; o job corrigido volta como `ws:o11/jobs/...`. `autoPatch:false` desliga. O licenciado não recebe `patchedJob` |
| `<server>` no lugar de um caminho numa resposta | Esperado (marco-a7): caminho do servidor (volumes de `/data`, `/studio`, `/tmp`, `/app`) nunca sai numa resposta; os do workspace do cliente saem como `ws:...`. |

## 14. Limitações conhecidas

- Imagem interina: uma versão de cada Studio (Service Studio 11.55.92, ODC Studio 1.7.28). Cliente num Studio mais
  velho fica sem aquela faixa hospedada até a imagem de várias versões (`STUDIO_UPDATE_REQUIRED`, 7.1).
- A imagem foi construída e provada no Docker Desktop (seção 12), mas ainda não numa VPS: o certificado do
  Let's Encrypt, o DNS, o firewall, o IPv6 da rede `edge` com um cliente IPv6 real e o cron como usuário comum não foram
  provados lá. Os bundles dos Studios não estão neste repositório.
  - No ensaio não apareceu `EACCES`, `EROFS`, `EPERM` nem `HOSTED_CONTEXT_LOST`. Numa VPS, procure de novo no log.
- Quatro correções do ensaio mexem em arquivos de produto copiados da linha do servidor
  (`platforms/odc/facade/hosted/agent-executor.mjs`, `hosted/policy.mjs`, `executor.mjs` e
  `kernel/src/Anvil.Core.Odc/Adapters.ODC/OdcFeatures.cs`). A linha do servidor precisa fazer a mesma mudança na origem,
  senão a próxima cópia desfaz.
  - **Já aconteceu**: a cópia do 23º envio (`935c4ad`) trouxe o `hosted/policy.mjs` da linha do servidor e desfez a
    correção `bfd3ec7`. Numa imagem do `main` a partir dela, as respostas hospedadas no Linux saem com `/ws:odc/...`
    (um caminho que nenhuma ferramenta aceita de volta: `studio_snapshot` e `ssam_map` falham) e qualquer `app` vira
    `<servidor>`. Não faça deploy dessa imagem (`prod-20261011-8ae231d` e anteriores).
  - **Estado atual**: a correção foi reaplicada no `main` em `ed0f94b`. A imagem `prod-20261011-ed0f94b` passou no
    terceiro ensaio (seção 12) e é a candidata à produção.
  - A linha do servidor ganhou as quatro correções na branch `servidor/fase4-23-linux` (`77a38635`, `05c6e6de`,
    `867cf3c9` e `b37715e1`, sobre o 23º envio `e589be22`). Os quatro arquivos e o teste `hosted-policy.test.mjs` têm
    lá os mesmos bytes do `main`. As próximas cópias para esta caixa saem dessa branch (ou de uma linha que a contenha),
    não de `servidor/fase4-23`.
  - **24º envio** (`server/r24`): a cópia saiu de `servidor/fase4-24` (`a945838b`, depois `a415531d` com as correções dos caminhos de job hospedado, do
    lock de partida do worker e dos documentos de integração), que nasceu de
    `servidor/fase4-23-linux` (`b37715e1`). Conferido blob a blob: os quatro arquivos, os do worker O11 e todos os outros
    arquivos das duas caixas (fora os do SSAM-MCP) são iguais aos da linha.
  - **ODC Studio 1.7.28** (`server/r24-odc1728`): a cópia saiu de `fase4-24/odc1728` (`c48074be`, sobre `a415531d`):
    bundle ODC 1.7.28.10850, bridge ODC v97, catálogo de verificação do 1.7.28 e a guarda do executor para bridge abaixo
    da v97. Conferido blob a blob de novo: os 6199 arquivos das duas caixas que vêm da linha são iguais aos de `c48074be`.
  - **Imagem interina** (`server/r24-combinada`): a cópia saiu de `fase4-24/combinada` (`3d6f232c`, sobre `a415531d`): ODC
    Studio 1.7.28, Service Studio 11.55.92, registro de qualidade e os itens do O.6.1. Conferido blob a blob: os 6229
    arquivos das duas caixas que vêm da linha são iguais aos de `3d6f232c`.
  - **Registro de qualidade** (`server/r24-qualidade`): mais `fase4-24/qualidade` (`3262c49f`, sobre `a415531d`; depois
    `01795e52`, os verbos das chamadas ao agente só de listas fechadas; `c24d468d`, os códigos e as regras só dos
    registros gerados das fontes; e `1b2ce8fe`, os códigos compostos pelo produto e os de `kernel/query-test` nesses
    registros), conferido do mesmo jeito: os quatro arquivos de
    Linux continuam iguais aos da linha.
- **marco-a6** (`server/r26-marco-a6`, imagem `prod-20261015-bbdbdee`): a cópia saiu de `fase4-26/marco-a6` (`75c8940c`), que
  já tem a trava destrutiva e o A-M1 com os bytes desta caixa. Conferido blob a blob: as 6704 entradas da caixa server que
  vêm da linha são iguais às de `75c8940c`; ficam com os bytes de `42d473e` só os compartilhados `.gitignore` e
  `docs/FASE2-AGENTE.md`, e a caixa agent não mudou (o pacote do agente é o mesmo). O `o11-bridge.mjs` difere entre as
  caixas de propósito (`SHARED.md`). No hospedado ficam desligadas as sondas de travamento da CX14
  (`ANVIL_BRIDGE_PROBE_MS=0`; a bridge fina nunca sonda) até um pacote do agente com a CX14, e a pré-checagem de tela da
  CX16. A lista das mudanças de comportamento está em `C:\t\vps-a6\LINHA.md` §7.
- **marco-a7** (`server/r27-marco-a7`, imagem `prod-20261018-ebb0e9a`; a `prod-20261018-90c33b5` foi **descartada**: o `error` de
  `INPUT_INVALID` do licenciado saía estragado, item 6 da revisão no-internals-7): a cópia saiu de `fase4-26/marco-a7` (`7b14280a`,
  depois os 5 caminhos de `b606ee7b`),
  sobre a caixa da `r26` (linha `75c8940c`). Conferido blob a blob: as 6850 entradas da caixa server que vêm da linha são
  iguais às de `b606ee7b`; o `docs/FASE2-AGENTE.md` compartilhado foi para as duas caixas com os bytes da linha; a caixa
  agent só ganhou documentos e um teste (o pacote do agente é o mesmo, bridge ODC v97). O `debug.mcp.json` da linha (os
  caminhos do dono) fica fora da imagem. A guarda de nomes do `build.sh` roda com um `/tmp` em memória, porque os testes
  da fachada agora isolam o perfil em `os.tmpdir()`. As mudanças de comportamento estão em `C:\t\vps-a7\LINHA.md` §8,
  `LINHA-2.md` §6, `LINHA-3.md` §7 e `LINHA-4.md` §3.
- **marco-a8** (`server/r28-marco-a8`, imagem `prod-20261018-130b493`; a `prod-20261018-dab1c86` da linha `52562a86` foi superada): a
  cópia saiu de `fase4-26/marco-a8` (`87e12565`; a fase 7 é o M1 da revisão `vps-a8`: o prazo hospedado só lê arquivos do workspace
  do próprio cliente), sobre a caixa da `r27` (linha `b606ee7b`). Conferido blob a blob: as 6881 entradas da caixa server que vêm
  da linha são iguais às de `87e12565`; os compartilhados `docs/FASE2-AGENTE.md` e `docs/O11-BRIDGE-FINA.md` foram para as duas caixas; a caixa agent
  ganhou as fontes da fina O11 da linha (Manage Dependencies por código; o pacote novo é montado à parte, o de 13/10 continua
  servido). O `compose.prod.yml` passa `SSAM_HOSTED_SSAM_CODE` (8.1). As mudanças de comportamento estão em
  `C:\t\vps-a8\LINHA.md` §8 e §12.8.
- **marco-a9** (`server/r29-marco-a9`, imagem `prod-20261019-b882605`): a cópia saiu de `fase4-26/marco-a9` (`2aede778`), sobre a caixa da
  `r28` (linha `87e12565`). Conferido blob a blob: as 6959 entradas da caixa server que vêm da linha são iguais às de
  `2aede778`; a caixa agent não mudou (o pacote do agente é o mesmo, bridge ODC v97; o `BridgeDataIndexes.cs` novo vai só para a
  caixa server, a bridge não o compila). `compose.prod.yml`, `Caddyfile`, scripts e `kernel.json` não mudam. As mudanças de
  comportamento estão em `C:\t\vps-a9\LINHA.md` §8.
- O índice do `ssam_discover` e os outros caches de `/app` se perdem a cada container novo: 1 a 2 min de aquecimento
  (7.3). O índice de módulos e a cópia dos leitores ficam no volume `cache` e passam pela recriação.
- O container não roda com o sistema de arquivos raiz só de leitura.
  - A linha do servidor grava caches em `/app/.local` e `/app/platforms/odc/.local` (o índice do discover, por exemplo),
    e os locks e logs dos workers ao lado dos CLIs, em `/app/kernel/.local`. Falta uma variável para mudar esses lugares.
  - A imagem libera só esses lugares, `/tmp` e os volumes. O resto de `/app` e `/studio` é do root.
  - Esses caches ficam na camada do container e se perdem ao recriá-lo. São reconstruídos depois.
- O `kernel.json` é manual (7.1) e precisa ser revisto a cada troca de versão de Studio ou bridge.
- O `Features.plain.xml` (7.2) vem do tenant do dono e vale para todos os clientes. Um tenant de cliente com outras flags
  de features pode ver outro comportamento do modelo ODC. Ainda não há um cache por cliente.
- Não há drenagem: upgrade, restart e backup parado interrompem as chamadas em curso (seção 8).
- O build depende do estado do apt (o `libsqlite3-0` não tem versão fixada) e do nuget.org na hora (sem `nuget.config` nem
  lock do NuGet nos projetos da linha do servidor). As imagens base e os Studios são fixados por digest e SHA-256.
- O Caddy roda como uid 0 dentro do container, só com `NET_BIND_SERVICE`, sem as outras capabilities e com
  `no-new-privileges`.
- O painel do dono da VPS é o da seção 15 (o `scripts/dashboard.mjs` da linha do servidor é só do servidor Windows). Ele
  só avisa quem o abre: não manda e-mail nem push. Renovar e mudar faixas pelo painel dependem da imagem do 24º envio.
  O servidor não registra o pacote do agente nem as respostas 401, 403 e 429: o painel mostra `—` no pacote e tira as
  recusas do log do Caddy, só por IP.
- O `server.log` mostra o IP que o Caddy viu. No Docker Desktop é sempre o gateway da rede (o encaminhamento de portas
  dele não preserva a origem); numa VPS Linux, o IPv4 do cliente.
- Uma VPS só: sem alta disponibilidade. O tempo fora do ar de um upgrade é o de recriar o container.
- A aba Qualidade do painel aproxima o pedido do usuário pela cadeia de chamadas de uma sessão MCP até "entregue", e o
  tempo parado entre chamadas inclui a rede e o próprio cliente MCP: o servidor não vê as mensagens do usuário.

## 15. Painel do dono

Uma página só para o dono, com as licenças (emitir, renovar, mudar faixas, trocar a credencial do agente, revogar) e a
monitoração da VPS, dos containers, do servidor SSAM e do uso. Não tem rota pública: só se chega a ela por um túnel SSH
a partir do PC do dono.

```
PC do dono (Windows)                          VPS
painel-ssam.ps1                               sshd :22
  ssh -L 127.0.0.1:7320:127.0.0.1:7320  ==>     127.0.0.1:7320  ssam-console-proxy.socket (systemd, só loopback)
  navegador http://localhost:7320                 -> systemd-socket-proxyd (uid 10001, sem rede)
                                                  -> /var/lib/ssam-console/sock/console.sock
                                                container ssam-console (mesma imagem do servidor, network_mode: none)
                                                  lê o volume de estado e /var/lib/ssam-console/host/host.json
                                                ssam-console-collect.timer (a cada 30 s, root) -> collect.py -> host.json
```

- O container `ssam-console` não tem rede nenhuma: escuta num socket unix. O Caddy, o ufw e as portas públicas não
  mudam; a única porta nova é `127.0.0.1:7320`, no loopback do host.
- O coletor do host (`host/collect.py`, o Python 3 do sistema, só biblioteca padrão) roda como root a cada 30 s e grava
  `/var/lib/ssam-console/host/host.json` (0640 root:10001): Docker, `/proc`, discos, ufw, sshd, atualizações, o
  certificado do Caddy e os backups. Ele roda só comandos fixos, sem shell, e nunca lê o `.env`, o `tokens.json`, o
  `kernel.json`, os espaços dos clientes, chaves nem cabeçalhos HTTP.
- O painel grava o `tokens.json` só pelo módulo de tokens da própria imagem (o mesmo do `ssam-admin`), registra cada ação
  em `/data/server/console-audit.jsonl` (no volume de estado: vai no backup junto com as licenças) e guarda o resto em
  `/var/lib/ssam-console/state`.
- Um segredo novo (token e credencial do agente) aparece uma vez só, na tela da ação. O painel não o guarda, não o
  registra e não o manda de novo.

### 15.1 Instalação

Na VPS, como root, na pasta `deploy` do commit aprovado (seção 5):

```bash
cd /opt/ssam/deploy
sh host/install.sh --dry-run --with-crons     # mostra cada verificação e cada mudança, sem mudar nada
sh host/install.sh --with-crons
```

- O `install.sh` confere root, python3 3.10 ou mais novo, docker, systemd, `systemd-socket-proxyd`, a conta do proxy,
  a porta 127.0.0.1:7320 livre e os containers do projeto. Se algo falhar, não muda nada.
- Garante o uid e o gid 10001 no host. O `ssam-console-proxy.service` roda com `User=10001` e `Group=10001`, e o systemd
  não sobe a unidade com um id que o host não conhece (`217/USER`, 15.10). Um uid ou gid 10001 que já existe é usado,
  com qualquer nome. O que faltar vira o grupo e o usuário de sistema `ssam-console`, sem home, sem shell e com a senha
  travada:

  ```bash
  groupadd -r -g 10001 ssam-console
  useradd -r -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin -c ssam-console-proxy ssam-console
  ```

  O `useradd` avisa que 10001 passa de `SYS_UID_MAX` (999): é esperado. As consultas passam pelo `getent`, então
  contam também contas de LDAP, sssd ou userdb. Se for preciso criar o grupo (ou o usuário) e o nome `ssam-console` já
  existir com outro gid (ou uid), a verificação falha e nada muda. Nenhum outro usuário ou grupo é tocado. Quando cria
  a conta, o `install.sh` também roda `systemctl reset-failed` no proxy antes de ligar o socket. Rodar de novo não
  muda a conta.
- Cria `/var/lib/ssam-console/{host,collector,state,sock}` com os donos certos (o painel roda como uid 10001), copia o
  `collect.py` para `/usr/local/lib/ssam-console`, grava `/etc/ssam-console/collector.conf` (só se não existir; um
  re-install nunca o sobrescreve), instala e liga `ssam-console-collect.timer` e `ssam-console-proxy.socket`, roda o
  coletor uma vez e confere o `host.json`.
- `--with-crons` grava `/etc/cron.d/ssam-backup` (backup online diário, 03:30 UTC) e `/etc/cron.d/ssam-rotate`
  (rotação semanal, domingo 04:15 UTC), com o log em `/var/backups/ssam-server/cron.log` (seções 9 e 10).
- Nunca edita o `.env`, nunca reinicia o `ssam-server` nem o Caddy e não sobe o painel. Pode rodar de novo a qualquer
  hora. `--port N` troca a porta do loopback (padrão 7320; no PC, `painel-ssam.ps1 -RemotePort N`).

Confira as unidades na VPS (o `systemd-analyze` não roda no Windows, então esta verificação é só aqui):

```bash
systemd-analyze verify /etc/systemd/system/ssam-console-collect.service /etc/systemd/system/ssam-console-collect.timer \
  /etc/systemd/system/ssam-console-proxy.socket /etc/systemd/system/ssam-console-proxy.service
systemctl list-timers ssam-console-collect.timer
```

Rode o primeiro backup à mão, com o mesmo comando do cron (seção 9):

```bash
sh backup.sh --online >> /var/backups/ssam-server/cron.log 2>&1; echo "exit $?"     # tem de dar exit 0
tail -n 3 /var/backups/ssam-server/cron.log
```

Ligue o painel: no `.env`, descomente (ou acrescente) a linha `COMPOSE_PROFILES=console` e suba só ele:

```bash
nano .env                                                    # COMPOSE_PROFILES=console
docker compose -f compose.prod.yml up -d ssam-console
docker compose -f compose.prod.yml ps ssam-console           # "healthy" em até ~30 s
curl -fsS http://127.0.0.1:7320/healthz                      # {"ok":true}
```

- Com `COMPOSE_PROFILES=console`, todo `docker compose up -d` também sobe o painel.
- Sem as pastas do `install.sh`, o container não sobe (`create_host_path: false` no compose): é de propósito, para o
  Docker não criar pastas do root que o uid 10001 não consegue usar.
- O painel usa a mesma imagem e a mesma tag do servidor: nada é construído.

### 15.2 Uso no dia a dia

No PC do dono, na raiz do SSAM-MCP:

```powershell
powershell -ExecutionPolicy Bypass -File server\deploy\console\painel-ssam.ps1
```

1. O script lê por SSH a chave de acesso atual do painel (sem mostrá-la).
2. Abre o túnel `127.0.0.1:7320` do PC para `127.0.0.1:7320` da VPS e espera o `/healthz`.
3. Troca a chave para esta sessão e abre o navegador em `http://localhost:7320/#k=...`. A página tira a chave do
   endereço na hora.
4. Enter (ou `q`) fecha: o script troca a chave de novo e derruba o túnel. Uma chave que ficou no histórico do navegador
   já não vale.

- Parâmetros: `-VpsHost` (padrão `$env:SSAM_VPS_HOST`, senão o IP da VPS de produção), `-User` (`root`), `-Key`
  (`$env:USERPROFILE\.ssh\ssam_vps`), `-LocalPort` (7320; se estiver ocupada, a próxima livre até 7339), `-RemotePort`
  (7320, a do `install.sh --port`), `-NoBrowser` e `-DryRun` (mostra os dois comandos ssh e não roda nada).
- **Uma sessão por vez**: rodar o script de novo troca a chave, e a aba anterior mostra "Chave de acesso inválida ou
  trocada".
- Códigos de saída: 2 = painel parado na VPS (sem chave), 3 = SSH ou túnel falhou, 4 = o painel respondeu com erro.

### 15.3 O que cada aba mostra

| Aba | Conteúdo |
| --- | --- |
| Visão geral | Alertas (gravidade, desde quando; silenciar por 24 h ou 7 dias, ou marcar como visto; um alerta silenciado que piora, de atenção para crítico, ou que acontece de novo volta na hora, com um evento), o resumo por área (servidor, licenças, uso de hoje, agentes, sessões, VPS, containers, backup, TLS, coletor) e os 10 últimos eventos. |
| Licenças | Cada licença com estado, faixas, validade, agente, máquina registrada, sessões abertas, chamadas e falhas de hoje, uso de 14 dias, espaço em disco e última atividade; detalhes e ações por linha; Emitir licença. |
| Uso | Chamadas por cliente e por ferramenta, falhas por código, por dia (com p50 e p90) e os acessos recusados (401, 403, 429) do log do Caddy, por IP; hoje, 7 dias, 30 dias ou um dia. |
| Qualidade | Os códigos de erro mais comuns, os problemas das recusas por código (e quantos o motor já sabia corrigir), as correções automáticas por regra, as fases da entrega (p50/p90 por ferramenta), as voltas até entregar e o que mais gera voltas, por cliente ou de todos os clientes; exporta CSV e JSON. Só códigos, contagens e tempos. |
| Agentes e sessões | Agentes (estado, versão, Studio O11, máquina, IP, chamadas e falhas da última hora, motivo do fechamento), sessões MCP abertas, processos do servidor (worker ODC; workers O11 quando a imagem os tiver) e sessões encerradas hoje por motivo. |
| VPS | Host (CPU, memória, discos, rede, carga, relógio, unidades com falha), atualizações e reinício pendente, segurança (ufw, SSH, falhas de login), servidor SSAM (imagem, kernel em uso e `kernel.json`, aquecimento, `/health`, tamanho dos logs), containers, volumes, certificados TLS, backups e o fim do `cron.log`. |
| Eventos | O fluxo de eventos (sessões, agentes, chamadas, licenças, servidor e VPS), com filtros e pausa. |
| Histórico | Toda ação de licença, feita pelo painel ou fora dele (`ssam-admin`), com o resultado. |

### 15.4 Ações de licença

| Ação | Efeito |
| --- | --- |
| Emitir | Cria o token e a credencial do agente (aparecem uma vez, com a configuração pronta do cliente MCP e do agente). Validade de 30, 90 ou 365 dias, outra ou sem validade; faixas ODC e O11. Uma licença nova não revoga a antiga do mesmo cliente. |
| Renovar | Estende a validade a partir da validade atual (ou de hoje, se já venceu). Vale na hora: uma licença vencida volta a valer, o agente reconecta sozinho e o cliente abre sessões novas. |
| Faixas | Muda ODC e O11. Vale para sessões **novas**: as abertas mantêm as faixas antigas até fecharem (60 min sem uso ou reconexão do cliente). |
| Credencial do agente | A credencial atual para na hora e o canal do agente fecha em até 1 s. O cliente refaz o `setup` do agente com a nova (7.5). |
| Revogar | Definitivo: o token e a credencial param na hora (403), e as sessões e o canal do agente fecham em até 1 s. O espaço de trabalho fica no disco (seção 11). |

- Toda ação pede o nome do cliente digitado como confirmação e entra no Histórico.
- **As ações de licença precisam da imagem do 24º envio.** O módulo de tokens dela trava o `tokens.json` entre o painel
  e o `ssam-admin` (`tokens.json.lock`) e traz `renew` e `setLanes`. O da imagem `prod-20261011-ed0f94b` não trava: um
  `ssam-admin` que grava no mesmo instante que o painel pode apagar a mudança do outro (um `revoke` que o CLI disse ok e
  não valeu) ou publicar um `tokens.json` pela metade (o servidor responde 500 e fecha as sessões abertas). Quem decide
  é `CONSOLE_LICENSE_WRITES`, no `.env`:

  | Valor | Efeito |
  | --- | --- |
  | `auto` (padrão) | Ações só com um módulo que trava (o do 24º envio). Na imagem `prod-20261011-ed0f94b` as licenças ficam só leitura: o painel diz isso numa linha, esconde Emitir e recusa as ações com 501. Emita, renove e revogue pelo `ssam-admin` (7.4 e 11). Depois do upgrade da imagem (seção 8), as ações aparecem sozinhas. |
  | `on` | Ações com qualquer módulo. Só em ensaio ou com a garantia de que ninguém roda `ssam-admin` enquanto o painel grava. Na imagem atual: Emitir, Credencial do agente e Revogar (Renovar e Faixas continuam esperando o 24º). |
  | `off` | Licenças só leitura, com qualquer imagem. |

  Depois de mudar o valor: `docker compose -f compose.prod.yml up -d ssam-console`.
- Em produção, troque a imagem pela do 24º envio antes de usar Emitir e Revogar no painel. Montar o módulo novo só no
  painel (como no ensaio, 15.11) não basta: o `ssam-admin` da imagem antiga continua sem a trava.
- Depois de cada gravação o painel relê o `tokens.json` por uma instância nova do módulo. Se a mudança não está lá (ou o
  arquivo não abre), a resposta é "A gravação não se confirmou no arquivo de licenças" (409), nenhum segredo aparece, a
  tentativa entra no Histórico como erro `WRITE_NOT_CONFIRMED` e sobe o alerta crítico "... não se confirmou no
  tokens.json". Confira a licença e repita a ação.
- Mudanças feitas fora do painel (`ssam-admin server-token ...`, um restore, o arquivo editado à mão) entram no Histórico
  como "fora do painel" em até 5 s: emissão, revogação, revogação desfeita (alerta crítico "A revogação da licença de ...
  foi desfeita"), licença removida do arquivo (alerta), validade estendida ou encurtada, faixas, credencial do agente e
  nome do cliente.

### 15.5 Upgrade

- **Imagem nova** (troca de `SSAM_IMAGE_TAG`, seção 8): `docker compose -f compose.prod.yml up -d ssam-server ssam-console`.
  O painel anda com a mesma tag do servidor e usa o módulo de tokens dela.
- **Código do painel novo** (pasta `deploy` de um commit novo, seção 5):
  `docker compose -f compose.prod.yml up -d --force-recreate ssam-console`. O código é montado da pasta `console`: sem
  recriar, o processo continua com o código antigo.
- **Coletor ou unidades novos**: `sh host/install.sh` de novo. Ele copia o `collect.py` e as unidades e mantém o
  `collector.conf`.
- Cada partida do painel gera chave nova: rode o `painel-ssam.ps1` de novo. As posições de leitura dos logs ficam no
  checkpoint, então nada é contado duas vezes.

### 15.6 Depois de um restore

O `restore.sh` troca os arquivos do volume de estado por baixo do painel, e as posições de leitura deixam de valer. Pare
o painel antes e reindexe depois:

```bash
docker compose -f compose.prod.yml stop ssam-console
sh restore.sh /var/backups/ssam-server/ssam-state-<data>.tar.gz
rm -rf /var/lib/ssam-console/state/checkpoint.json /var/lib/ssam-console/state/agg /var/lib/ssam-console/state/agg-quality
docker compose -f compose.prod.yml start ssam-console
```

- Ao subir, o painel relê em segundo plano tudo o que o restore trouxe (`server.log`, os girados e as auditorias). A
  linha de status mostra "indexando histórico" até terminar.
- Os registros de qualidade voltam com o backup e o painel os reindexa sozinho (a aba Qualidade mostra o progresso).
- O Histórico volta ao do backup: o `console-audit.jsonl` está no volume de estado, junto com as licenças.
- **Não apague o `/var/lib/ssam-console/state/tokens-snapshot.json`**: ele fica de propósito com as licenças de antes do
  restore. Ao subir, o painel compara e registra no Histórico, como "fora do painel", tudo o que o restore mudou: uma
  licença revogada depois do backup volta a valer (alerta crítico "A revogação da licença de ... foi desfeita"; revogue
  de novo em Licenças), uma emitida depois do backup some (alerta "A licença de ... sumiu do tokens.json"), validades e
  faixas voltam às do backup.

### 15.7 Chave de acesso

- 32 bytes aleatórios, nova a cada partida do painel e trocada pelo `painel-ssam.ps1` ao abrir e ao fechar. Fica em
  `/var/lib/ssam-console/state/access.key` (0600, uid 10001), lida só pelo script, por SSH.
- Uma sessão por vez: a segunda execução derruba a aba da primeira.
- 10 chaves erradas em 1 minuto bloqueiam o painel por 60 s (429).
- Para matar a sessão atual sem abrir outra: `docker compose -f compose.prod.yml restart ssam-console`.

### 15.8 Caminho de emergência (sem as unidades do proxy)

Se o `ssam-console-proxy.socket` não subir, o OpenSSH encaminha direto para o socket unix (o sshd da VPS permite
encaminhamento de socket):

```powershell
ssh -i $env:USERPROFILE\.ssh\ssam_vps -N -L 7320:/var/lib/ssam-console/sock/console.sock root@<vps>
```

Em outro terminal, leia a chave com `ssh -i $env:USERPROFILE\.ssh\ssam_vps root@<vps> cat /var/lib/ssam-console/state/access.key`
e abra `http://localhost:7320/#k=<chave>`. Esse caminho não troca a chave: no fim, rode
`docker compose -f compose.prod.yml restart ssam-console` na VPS.

Se o `install.sh` disser que o `/healthz` falhou e o `journalctl -u ssam-console-proxy` mostrar o systemd recusando
`PrivateNetwork=` ou `RestrictAddressFamilies=` com o socket herdado: tire essas duas linhas de
`/etc/systemd/system/ssam-console-proxy.service` e rode `systemctl daemon-reload` e
`systemctl restart ssam-console-proxy.socket`. Um `install.sh` novo regrava a unidade: repita depois de cada um (ou
tire as linhas também de `host/ssam-console-proxy.service` no repositório).

### 15.9 Remoção

```bash
nano .env                                              # tire (ou comente) COMPOSE_PROFILES=console
docker compose -f compose.prod.yml rm -sf ssam-console
sh host/uninstall.sh                                   # unidades do systemd e /usr/local/lib/ssam-console
sh host/uninstall.sh --purge                           # também /var/lib/ssam-console, /etc/ssam-console e a conta ssam-console
sh host/uninstall.sh --crons                           # também os crons de backup e rotação (o backup diário para)
```

- `--dry-run` mostra o que faria. O `--purge` recusa enquanto o container `ssam-console` roda.
- O `console-audit.jsonl` fica no volume de estado, e os backups ficam onde estão.
- Sem `--purge`, o usuário e o grupo `ssam-console` ficam. O `--purge` apaga só os do `install.sh`: o usuário
  `ssam-console` do `/etc/passwd` com uid 10001 e grupo principal 10001, e o grupo `ssam-console` do `/etc/group` com
  gid 10001. Um `ssam-console` de LDAP, sssd ou userdb, ou com outro grupo principal, fica. Um uid ou gid 10001 com
  outro nome nunca é apagado.
- O usuário fica se algum processo rodar como uid 10001 depois de parar o proxy. O `ssam-server` e o painel rodam como
  10001 nos containers: com eles no ar, a conta fica e o script diz por quê.
- O grupo fica se tiver outros membros (por exemplo, um operador posto nele para ler o `host.json`) ou se for o grupo
  principal de outro usuário. No Ubuntu, o `userdel` já leva o grupo junto quando ninguém mais o usa.

### 15.10 Problemas

| Sintoma | O que olhar |
| --- | --- |
| `painel-ssam.ps1`: "chave ausente" | O container não está rodando: `docker compose -f compose.prod.yml ps ssam-console` e `docker compose -f compose.prod.yml logs --tail 50 ssam-console`. |
| "O tunel SSH nao abriu" | A porta local ou a 7320 da VPS está ocupada: `systemctl status ssam-console-proxy.socket` e `ss -ltn 'sport = :7320'` na VPS. |
| "O painel nao respondeu em 15 s" | Na VPS: `curl -fsS http://127.0.0.1:7320/healthz`, `ls -l /var/lib/ssam-console/sock` (tem de ter `console.sock` do uid 10001) e `journalctl -u ssam-console-proxy -n 30 --no-pager`. |
| `ssam-console-proxy.service` falha com `status=217/USER` e `Failed to determine credentials for user '10001': Unknown user` (o túnel abre e o painel não responde) | O host não tem o uid 10001: o `install.sh` de antes desta correção não criava a conta. Rode `sh host/install.sh` de novo (15.1), ou à mão: `groupadd -r -g 10001 ssam-console`, `useradd -r -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin -c ssam-console-proxy ssam-console`, `systemctl reset-failed ssam-console-proxy.service ssam-console-proxy.socket` e `systemctl restart ssam-console-proxy.socket`. Confira com `getent passwd 10001` e `curl -fsS http://127.0.0.1:7320/healthz`. Em produção a conta foi criada à mão assim em 2026-10-12; um `install.sh` novo a encontra e não muda nada. |
| `install.sh`: "o usuario ssam-console ja existe com o uid N" (ou "o grupo ... com o gid N") | O nome é de outra conta, e o `install.sh` não mexe nela. Apague ou renomeie essa conta, ou crie à mão o uid e o gid 10001 com outro nome (`groupadd -r -g 10001 <nome>` e `useradd -r -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin <nome>`): o `install.sh` usa o uid e o gid 10001 com qualquer nome. |
| Container não sobe: `bind source path does not exist` | Faltou o `sh host/install.sh` (as pastas não existem). |
| Container reinicia com `EACCES` | `state` ou `sock` não são do uid 10001: rode `sh host/install.sh` de novo. |
| Aba VPS: "coletor parado" ou dados velhos | `systemctl status ssam-console-collect.timer`, `journalctl -u ssam-console-collect -n 30 --no-pager` e `ls -l /var/lib/ssam-console/host`. |
| "Coleta parcial" | A seção com erro está em `collector.errors` do `host.json`: `python3 -c 'import json; print(json.load(open("/var/lib/ssam-console/host/host.json"))["collector"]["errors"])'`. |
| A aba mostra "Chave de acesso inválida ou trocada" | Outra sessão abriu ou o painel reiniciou: rode o `painel-ssam.ps1` de novo. |
| Renovar e Faixas não aparecem | Imagem anterior ao 24º envio (15.4). |
| Nenhuma ação de licença, "Ações de licença desligadas" | `CONSOLE_LICENSE_WRITES=auto` numa imagem sem a trava do `tokens.json`, ou `off` (15.4). |
| "A gravação não se confirmou no arquivo de licenças" | Outro processo (um `ssam-admin`) gravou o `tokens.json` ao mesmo tempo. Confira a licença e repita; o alerta some quando marcado como visto (15.4). |

### 15.11 Ensaio local (Docker Desktop, 2026-10-12)

Projeto `ssam-painel-ensaio` só local, imagem `ssam-server:prod-20261011-ed0f94b`, o código do painel montado da árvore
de trabalho, portas só em 127.0.0.1 (Caddy 28180/28543, painel 27320). No lugar do `host/install.sh`, um container de
uma vez (uid 0) deu as pastas `state` e `sock` ao uid 10001; no lugar do `systemd-socket-proxyd`, um repasse TCP para o
socket unix na mesma imagem. O coletor rodou a cada 30 s com a parte Linux do host vinda das fixtures (`--fixture-host`)
e a parte Docker real (`--docker docker`). Nada tocou a VPS. A pilha foi derrubada com `down -v` e os tokens do ensaio
foram apagados.

| Item | Resultado |
| --- | --- |
| Pilha | `ssam-console` healthy, `NetworkMode: none`, nenhuma porta; capacidades `renew:false, lanes:false` com o módulo da imagem. |
| Leitura | Todos os GET do painel batem com os formatos da seção 4 do desenho (25 de 25 em cada uma das 7 leituras). Chamadas e falhas iguais às linhas da auditoria (29/27 e, no fim, 37/34), `AGENT_NOT_CONNECTED` igual, 5 recusas 401 do Caddy em `/mcp`, filtro por licença, dia e faixas de 7 e 30 dias. |
| Alertas | Os do host do ensaio (`backup-ausente`, `backup-sem-cron`, `rotacao-sem-cron`, `reinicio-pendente`, `ssh-senha`), `nao-aquecido:worker` (o worker ODC não sobe no Docker Desktop), `licenca-vence` crítico para a licença de 2 dias, `acesso-outra-maquina` depois do segundo PC e `pico-falhas` (as falhas foram de propósito). Nada além. |
| Ações na imagem atual | Renovar e Faixas recusados com 501 e a linha da seção 15.4; Emitir (segredos uma vez só, `no-store`, nenhuma outra resposta os devolve, o token novo abre sessão); Credencial do agente (evento em 3 ms, canal fechado com "credencial trocada" em 1,8 s); Revogar (sessão aberta fechada com "licença revogada" em 1,9 s, o token passa a 403, revogar de novo dá 409). 33 de 33. |
| Ações com o módulo do 24º envio | Montado sobre o da imagem: Renovar (+30 dias a partir da validade, o alerta some depois de 2 avaliações com o evento "Resolvido"), Faixas (ODC, O11 → ODC com 1 sessão aberta avisada), recusas `STALE`, `NO_CHANGE`, `NO_EXPIRY`, `TOKEN_REVOKED`, `EXPIRY_TOO_FAR`; o `server-token list` da imagem lê o arquivo gravado pelo módulo novo; um `revoke` pelo `ssam-admin` entra no Histórico como "fora do painel" em 2 s. 26 de 26. |
| Segurança | Sem chave 401, chave errada 401, `Host: evil.example` 403, `Origin` de outro site 403, `Sec-Fetch-Site: cross-site` 403, `text/plain` 415, 9 KiB 413, JSON ruim 400, campo a mais 400, confirmação errada 400, `OPTIONS` 405 sem `Access-Control-*`, `/mock/*` e caminhos com `..` 404, cabeçalhos (CSP, `no-store` etc.). 10 chaves erradas em 60 s: a 11ª e as seguintes, mesmo com a chave certa, recebem 429 com `Retry-After: 60`. |
| Robustez | Reiniciar o painel: contagens iguais e chave nova (a aba velha mostra a mensagem da chave). `rotate-logs.sh` com o `.env` do ensaio: nada contado duas vezes, sessões abertas mantidas, nenhum trecho perdido. Coletor parado: aviso depois de 120 s; `host.json` apagado: alerta crítico, aviso na aba VPS e os alertas do host somem; túnel caído: linha "Sem conexão" e volta sozinho. `docker compose restart ssam-server`: evento "ssam-server reiniciou." |
| Navegador | As 7 abas a 1440x900 e a 375x812, claro e escuro; a 360 px nenhuma rola de lado. Sem erro de JavaScript nem de CSP. Painel de segredos mascarado, `Fechar` só depois da caixa marcada, nada do segredo no DOM depois de fechar. |
| Segredos | Nenhum token nem credencial na saída do painel, nos logs do servidor, do Caddy e do repasse, no volume de estado do painel, no `console-audit.jsonl`, no volume de estado do servidor nem nos arquivos do ensaio fora da pasta dos segredos. |

Correções do ensaio, no mesmo commit: dias restantes contados em dias de calendário local (o alerta dizia "2 dias" e a
tabela "1 dia" para a mesma data); trocar o período ou o cliente no Uso enquanto uma leitura estava a caminho deixava a
resposta antiga na tela; a coluna Imagem mostrava o digest (`2.11.7-alpine@sha256:...`); o Histórico mostrava só as
faixas numa licença sem validade e "11/11/2026 → —" numa renovação recusada; um reinício feito à mão não gerava evento.

Fica do lado do servidor: um `DELETE /mcp` é registrado como `transport-closed`, então "o cliente encerrou" não aparece
(o painel mostra "a conexão caiu").
