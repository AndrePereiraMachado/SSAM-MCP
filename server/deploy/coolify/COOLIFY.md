# SSAM hospedado numa VPS com Coolify (runbook)

O mesmo servidor do `compose.prod.yml` (DEPLOY.md), sem o Caddy: o Coolify já instala o Traefik como proxy da VPS, e a
parte do proxy que o Caddyfile fazia está escrita nos rótulos (labels) do `compose.coolify.yml` desta pasta, mais um
arquivo de configuração dinâmica do Traefik (`traefik-ssam.yaml`). A imagem vem de um registro PRIVADO, publicada pela
máquina do dono com `../publish.sh`, fixada por tag e digest. Tudo o que o DEPLOY.md diz sobre o servidor em si continua
valendo: `kernel.json` (7.1), `Features.plain.xml` (7.2), tokens (7.4), upgrade e rollback (8), limites e cuidados (14).
Só muda COMO os arquivos chegam aos volumes e como o container sobe: pelo Coolify e pelo `ssamctl.sh`. E, desde a
imagem com o armazenamento Postgres (a partir do commit `64d4a72` da caixa server, 2026-10-20), os tokens e as credenciais dos agentes ficam
num Postgres que é um recurso de banco do próprio Coolify (seção 6), e não mais em `/data/server/tokens.json`.

Arquivos desta pasta:

| Arquivo | Para quê |
| --- | --- |
| `compose.coolify.yml` | o compose que o Coolify roda: gerado de `versions.json`: roteador, backends por par e painel; somente o roteador recebe rótulos Traefik; admin/ops só por perfil |
| `traefik-ssam.yaml` | configuração dinâmica do Traefik do Coolify: o transporte `ssam@file` (keep-alive de 4 s, sem limite de resposta) |
| `ssamctl.sh` | as operações à mão na VPS, só com `docker`: tokens, `db migrate\|status`, `psql`, `kernel.json`, `Features.plain.xml`, backup (com o dump do banco), restore, log, `console status\|logs\|audit`, `pull` |
| `.env.coolify.example` | a lista das variáveis (no Coolify, as Environment Variables do recurso) |
| `rehearsal.override.yml` | só para o ensaio local (seções 10 e 11.7): publica 7310 em 127.0.0.1:27310 e o painel em 127.0.0.1:27320, e sobe um Postgres descartável no lugar do recurso do Coolify |
| `../publish.sh` | na máquina do dono: empurra uma imagem já construída e provada para o registro privado (nunca uma tag fixa que já existe) sem mover a tag `latest` nesta linha |

## 1. Publicar a imagem no registro privado (máquina do dono)

A imagem carrega binários dos Studios da OutSystems: só registro **privado** (DEPLOY.md seção 2). No Docker Hub, um
repositório criado pelo primeiro `push` nasce PÚBLICO, a não ser que a conta tenha "private" como padrão. Por isso:

1. No Docker Hub, crie antes o repositório `<namespace>/ssam-server` como **Private** (Create repository > Visibility:
   Private). Com um plano gratuito, só um repositório privado por conta.
2. Na máquina do build (Git Bash com Docker Desktop, WSL ou Linux), entre no registro você mesmo, uma vez:
   `docker login` (Docker Hub) ou `docker login <registro>`. O `publish.sh` nunca recebe senha.
3. Publique cada imagem já construída e ensaiada com sua tag imutável. Use as tags e os digests da proposta aprovada:

   `sh server/deploy/publish.sh --source docker.io/andrepereiramachado/ssam-server --image docker.io/andrepereiramachado/ssam-server --tag <tag-da-proposta> --private-repo-ready`

   Não use latest nesta linha. O publicador recusa tags imutáveis existentes e árvores de build sujas. Compare o digest publicado com a proposta. O compose usa a tag fixa porque o parser do Coolify 4.4.6 corrompe referências tag@sha256; o digest esperado fica em versions.json e no rótulo ssam.image.digest.


## 2. Login do registro na VPS (Coolify)

O Coolify puxa a imagem com o `docker login` do usuário com que ele roda o Docker na VPS. Ou pela interface:
**Registries** (barra lateral) ou **Servers > a VPS > Registries > Log in**, provedor Docker Hub (ou o seu), usuário e um
**token só de leitura** (Docker Hub: Account settings > Personal access tokens, permissão Read-only). Ou por SSH, como o
usuário do Coolify (root, no padrão):

```bash
printf '%s' "$REGISTRY_TOKEN" | docker login --username <usuário> --password-stdin
```

A credencial fica no `~/.docker/config.json` daquele usuário (codificada, não cifrada); o Coolify não a guarda no banco.

## 3. O transporte do Traefik (uma vez por VPS)

No Coolify: **Servers > a VPS > Proxy > Dynamic Configurations > Add**, nome `ssam.yaml`, conteúdo de
`traefik-ssam.yaml`. A pasta é vigiada: vale sem reiniciar o proxy. Sem isso o Traefik responde 404 para o roteador
(o serviço aponta para um transporte que não existe).

Por que existe: o Node fecha um socket keep-alive ocioso depois de 5 s; o Traefik guarda os dele por 90 s. Um
`POST /mcp` que pegue um socket que o Node acabou de fechar vira 502, e o Traefik não repete POST. O transporte `ssam`
derruba os ociosos em 4 s, como o Caddyfile fazia (`keepalive 4s`), e espera cabeçalhos por até 65 minutos, como o roteador (um `o11_deliver` leva
até 60 min). Isso não cabe em rótulo: o provedor Docker do Traefik não tem rótulo de `serversTransports`.

## 4. O recurso no Coolify

1. **Projects > o projeto > Add resource > Docker Compose Empty** (ou um repositório git privado com esta pasta; o
   arquivo é `server/deploy/coolify/compose.coolify.yml`). Cole o `compose.coolify.yml`.
2. **Environment Variables**: o Coolify lê cada `${VAR}` do compose e pede as com `:?` antes do primeiro deploy. Preencha
   com a lista de `.env.coolify.example`: as imagens vêm de `versions.json`; configure `SSAM_DATABASE_URL` (a URL interna do recurso Postgres do Coolify, seção 6),
   `SSAM_DOMAIN` (o DNS da VPS, sem `https://`), `SSAM_CPUS`, `SSAM_MEMORY`, `SSAM_BUILD_WORKERS` e o resto pelo tamanho
   da VPS (DEPLOY.md seção 5), mais as do painel do dono (`CONSOLE_DOMAIN` e `CONSOLE_GITHUB_*`, seção 11.3: o deploy
   não sobe sem elas).
3. **Advanced > Docker Compose > Connect to predefined network**: ligado. O Traefik do Coolify só alcança containers na
   rede dele; sem isso o roteador fica sem destino.
4. **Não** ponha domínio em nenhum serviço na interface do Coolify (nem no `ssam-server`, nem no `ssam-console`). Os
   rótulos do compose já são o roteador inteiro (`Host(SSAM_DOMAIN)` só em `/mcp`, `/health`, `/agent` e `/agent/*`;
   `Host(CONSOLE_DOMAIN)` para o painel; TLS pelo resolvedor `letsencrypt`, cabeçalhos de segurança, redirecionamento
   de http para https). Um domínio na interface faria o Coolify gerar um segundo roteador para o mesmo container, sem
   o filtro de caminhos nem o transporte.
5. DNS: o registro A (e AAAA) de `SSAM_DOMAIN` e o de `CONSOLE_DOMAIN` apontando para a VPS antes do deploy, senão o
   Let's Encrypt falha.
6. Prepare os containers na janela de manutenção, antes de liberar o tráfego (seção 5). O Coolify puxa as imagens (seção 2), cria os volumes compartilhados `server-state`, `friction` e os volumes de features/cache próprios de cada par
   (com o prefixo do recurso) e sobe o `ssam-server` e o `ssam-console` (seção 11): `ssam-admin` e `ssam-ops` têm
   `profiles` e nunca sobem sozinhos. Ao subir, o servidor aplica as migrações no banco da seção 6 (o log mostra `db-migrated` na primeira vez e
   `tokens-store` com `backend: postgres`); sem alcançar o banco, ele NÃO sobe (o log diz por quê). O container fica
   `healthy` em uns 10 s e ainda aquece 1 a 2 minutos (DEPLOY.md 7.3).

Nesse primeiro `up` o servidor sobe **sem** `kernel.json` (o log mostra `kernel` com `null` e `kernel-version-missing`):
o hub recusa o pacote de qualquer agente até a seção 5. É esperado.

## 5. Preparar kernel e features de cada versão (somente o dono)

Antes da primeira migração, faça backup. Leve a pasta deploy/ do commit aprovado para a VPS. O ssamctl seleciona containers pelos rótulos ssam.backend, ssam.odc e ssam.o11. Os containers precisam existir, parados, com a imagem e os volumes do compose novo. Não libere o roteador antes dos pins. Use a janela de manutenção para essa preparação inicial; uma instância sem kernel é recusada pelo backend.

Na pasta deploy/coolify, para a janela inicial:

```sh
sh ssamctl.sh status
sh ssamctl.sh kernel write --version odc=1.7.29 /tmp/ssam-multiver/kernel-new.json
sh ssamctl.sh features put --version odc=1.7.29 /tmp/ssam-multiver/features-new.xml
sh ssamctl.sh kernel write --version odc=1.7.28 /tmp/ssam-multiver/kernel-old.json
sh ssamctl.sh features put --version odc=1.7.28 /tmp/ssam-multiver/features-old.xml
```

Os arquivos e hashes exatos estão na proposta. kernel write executa o pair-check na imagem selecionada antes de escrever e exige exit 0. O kernel fica em /data/server/versions/<par>/kernel.json; features e cache são volumes próprios. Se uma versão de faixa aparecer em mais de um par, use SSAM_CONTAINER com o nome exato: ele tem precedência sobre --version e SSAM_VERSION. Não escreva um kernel compartilhado para todos.

Depois de todos os pares preparados, Redeploy. Verifique /health agregado, eventos kernel e warm de cada backend (índices, builder e worker ok), os dois agentes e a reconexão MCP. Não basta healthy: o warm precisa completar. Credenciais e tokens continuam no mesmo Postgres.

## 6. Tokens de cliente (no Postgres)

Os tokens e as credenciais dos agentes (só o SHA-256 de cada um, mais cliente, datas, faixas e estado) ficam na tabela
`server_tokens` de um Postgres que é um **recurso de banco do Coolify**, fora deste compose:

1. No projeto, **Add resource > Database > PostgreSQL** (a versão 17 serve; 16 também). Dê nome, usuário e senha, e
   **Start**. Não publique porta pública: o banco só precisa ser alcançado pela rede interna do Coolify.
2. Na página do banco, copie a **URL interna** (`postgres://<usuário>:<senha>@<host interno>:5432/<banco>`; o host é
   o nome do container, que só a rede do Coolify resolve) e cole em `SSAM_DATABASE_URL` nas Environment Variables do
   recurso do servidor. Os dois recursos ficam na mesma rede quando o servidor tem "Connect to predefined network" ligado
   (seção 4). Se o banco exigir TLS, acrescente `?sslmode=require`.
3. Ligue o backup agendado do próprio Coolify na página do banco (Backups), além do `ssamctl.sh backup` da seção 8.

O `ssam-server` aplica as migrações (`platforms/odc/facade/migrations`) ao subir. Um redeploy, um rollback ou um
container recriado pelo Coolify não perde nenhuma licença: o banco está fora dele. O servidor relê a tabela a cada
segundo: um `revoke` vale em até 1 s.

```bash
sh ssamctl.sh token issue --customer "Nome do cliente" --days 30 --lanes odc,o11
sh ssamctl.sh token list
sh ssamctl.sh token revoke --id tok_...
sh ssamctl.sh token agent-rotate --id tok_...
sh ssamctl.sh db status                       # migrações aplicadas e pendentes
sh ssamctl.sh psql 'select id, customer, expires_at, revoked_at, lanes from server_tokens'
```

O `issue` e o `agent-rotate` mostram o token (`ssam_...`) e a credencial do agente (`ssam_agent_...`) **uma vez só**, no
seu terminal; o container roda sem driver de log, para o Docker não guardar cópia, e fala com o banco pela rede do
servidor (a predefinida do Coolify) com a `SSAM_DATABASE_URL` que o servidor tem. `db`, `psql`, o dump do backup e a
carga do restore rodam um container avulso da imagem oficial `postgres` (fixada por digest no script) na mesma rede,
contra essa URL. O resto é como no DEPLOY.md 7.4 e 7.5.

**Vindo de um servidor com `tokens.json`** (o `compose.prod.yml`, ou um deploy anterior desta pasta sem o banco): com o
volume `server-state` já no lugar, copie os registros uma vez:

```bash
sh ssamctl.sh token import --from /data/server/tokens.json
```

Só hashes viajam (nenhum segredo está no arquivo); o arquivo não é alterado e pode ficar como cópia. Um registro já no
banco com o mesmo id é substituído pelo do arquivo.

O painel do dono (`ssam-console`, seção 11) usa o **mesmo banco**: as licenças se administram pelo painel ou pelo
`ssamctl.sh token`, e o que um muda o outro vê em até 1 s (no painel, como uma linha "fora do painel" no histórico).

## 7. Upgrade e rollback

1. Avise os clientes da janela de manutenção: recriar containers interrompe chamadas; depois reconecte o MCP.
2. Execute ssamctl.sh backup da janela inteira antes de mudar qualquer imagem ou estado. O manifesto interno relaciona container, versões, destino e volume. A restauração exige todos os backends parados e os mesmos mapeamentos de volumes.
3. Revise a proposta local do vigia e seus testes por nome. Publique as tags imutáveis testadas, sem latest, e compare os digests.
4. Aprove o commit de versions.json e do compose gerado. No Coolify, substitua o compose e prepare os containers parados. Grave kernel e features por versão como na seção 5.
5. Faça Redeploy. Compare ssamctl.sh status com a proposta e confira health, warm, roteamento e SESSION_REROUTED.
6. Rollback é restaurar o compose e a janela anteriores, suas tags, pins e features, e fazer Redeploy. Não mova latest nem apague tags. Restore de dados exige todos os backends parados e só é necessário se os dados precisarem ser recuperados.

### 7.1 Imagens publicadas no registro

| Tag | `latest` desde | Digest | O que muda |
| --- | --- | --- | --- |
| `prod-20261021-ac614ad` | 2026-10-21 | `sha256:ccb135efc6082bf14fbc1c9e2934a42cf4edefa3522c1089ebda0d411afcd01e` | o hub escreve um primeiro byte logo atrás dos cabeçalhos do stream do agente (`agent-hub.mjs`): o Traefik (proxy em Go) só repassa os cabeçalhos com o primeiro byte do corpo, e o primeiro ping vinha aos 15 s, o prazo do agente; atrás do Traefik todo stream era abortado aos 15 s (visto em 2026-10-21). Testes do hub 28/28. |
| `prod-20261020-12fae04` | 2026-10-20 | `sha256:bbeaffad076ac04b0156208b4541ef6d761517c945589ab4b59cbf05999318e5` | painel dentro da imagem (11.4) |

## 8. Backup, restore e log

```bash
sudo install -d -o root -m 0700 /var/backups/ssam-server
sh ssamctl.sh backup                     # o conjunto completo, com o servidor no ar: ssam-tokens (licenças), ssam-db-update_server,
                                         # ssam-db-coolify, ssam-service (compose + .env do recurso) e ssam-state (todo volume do recurso)
sh ssamctl.sh backup --keep-days 14 /var/backups/ssam-server   # o cron diário (SUBIDA: /etc/cron.d/ssam-backup)
sh ssamctl.sh backup /outra/pasta
sh ssamctl.sh restore /var/backups/ssam-server/ssam-state-<data>.tar.gz [/var/backups/ssam-server/ssam-tokens-<data>.sql.gz]
                                         # só com o ssam-server PARADO no Coolify (Stop; o banco fica no ar); depois Start
sh ssamctl.sh logs 100                   # as últimas linhas do server.log
sh ssamctl.sh ops sh -c 'du -sh /data/*' # qualquer comando na imagem sobre os volumes, sem rede, como uid 10001
```

O `backup.sh` e o `restore.sh` da pasta de cima dependem do `compose.prod.yml` e não servem aqui: de 21/10 a 09/11 o
cron da VPS rodou `backup.sh --online` sobre o projeto ssam-prod parado e gravou toda noite o mesmo arquivo (mesmo
sha256) com o estado de 20/10, sem banco nenhum. Agora `backup.sh --online` sem ssam-server rodando recusa
(`BACKUP_SERVER_NOT_RUNNING`), e o cron diário deste host é `ssamctl.sh backup --keep-days 14`.

O que o `ssamctl.sh backup` grava, com um carimbo: as licenças (abaixo); o banco do Update Server (o container postgres
com `POSTGRES_DB=update_server`) e o do Coolify (`coolify-db`), cada um pelo `pg_dump` de dentro do próprio container
(mesmo major), recusados se o major do `pg_dump` e o do servidor diferem ou se faltam as tabelas esperadas; o compose e o
`.env` do recurso (`/data/coolify/services/<recurso>`); e o tar.gz de todo volume nomeado montado por qualquer container
do projeto do backend padrão (v1..vN, router, console: server-state, friction, caches, Features, runtime-css, plugins)
mais os volumes `<recurso>_*` que ninguém monta; volumes anônimos ficam de fora e listados no `.info`. Cada arquivo tem
`.sha256`; o `.info` é gravado por último (sem ele o conjunto está incompleto). A pasta de trabalho fica na pasta do
backup, nunca em /tmp (tmpfs na VPS). Recusa com menos de `SSAM_BACKUP_MIN_FREE_GB` (20) GiB livres ou de 3x o último
arquivo; `--keep-days` só apaga conjuntos antigos da raiz da pasta, depois de um backup bom, nunca as pastas `pre-*`.
Pisos de conteúdo (revisão de 09/11): pelo menos 1 linha em `server_tokens`, `releases` e `servers`
(`BACKUP_DUMP_NO_ROWS`); `kernel.json` e `customers/` no server-state; arquivos e bytes do server-state em pelo menos 50%
do conjunto anterior (`BACKUP_SHRANK`; `SSAM_BACKUP_ALLOW_SHRINK=1` para uma limpeza intencional). Tudo é gravado em
`.set-<stamp>/` e só vai para a pasta no fim, com o `.info` por último: uma falha não deixa dump órfão. A retenção é por
conjunto: os 7 conjuntos completos mais novos (`SSAM_BACKUP_KEEP_SETS`) ficam sempre, qualquer que seja a idade; só os
outros saem por idade. O conjunto leva também `coolify-source.env` (o APP_KEY do Coolify) dentro do `ssam-service`, só
root. Nenhuma senha vai para linha de comando: as licenças saem por `docker exec` no socket local do container do banco
(depois de conferir que a URL aponta para o `POSTGRES_DB` dele), e uma base remota recebe a URL pelo ambiente
(`-e SSAM_DATABASE_URL`, sem `=`). Os dumps e os volumes não são do mesmo instante (minutos de diferença), e uma cópia
online pode cortar a última linha de um log que cresce. As travas ficam na linha do cron, não no ssamctl (o
`backup-before-redeploy.sh` roda dentro da janela de release): `flock -n /var/lock/ssam-backup.lock timeout 3h flock -w
5400 /var/lock/ssam-release.lock sh ssamctl.sh backup ...`.
Para uma cópia fora da VPS e um heartbeat, acrescente ao cron (os arquivos têm dados de clientes e hashes de tokens:
cifre antes de copiar para fora).

O dump é SQL puro (`pg_dump --no-owner`, num container avulso da imagem do próprio container do banco, o host da
`SSAM_DATABASE_URL`, para o `pg_dump` ter sempre a versão do servidor; `PG_IMAGE` força outra), carregado de volta com `psql` contra
a mesma URL (os outros dois bancos voltam à mão: `gzip -dc <dump> | docker exec -i <container> psql`). O backup recusa alto (código `BACKUP_*`, nada fica com o nome final) um dump vazio, um dump sem as tabelas
de licença (`server_tokens`, `schema_migrations`) e um `pg_dump` mais velho que o servidor (01/11: o 17 contra o 18.6
gerava arquivo vazio). Antes de todo Stop/Redeploy, rode desta pasta, na sua máquina, `sh backup-before-redeploy.sh <sha>`:
ele leva este `ssamctl.sh` por SSH e grava em `/var/backups/ssam-server/pre-<sha>`; o restore do dump apaga a tabela e a recria do arquivo. Os dois arquivos têm dados de clientes e hashes de tokens: cifre antes de
copiar para fora.

## 9. O que é diferente de Caddy para Traefik

| Caddyfile | Aqui | Observação |
| --- | --- | --- |
| sem buffer (`flush_interval -1`) | padrão do Traefik | nenhum middleware de buffering é usado |
| timeouts de 65 min | `responseHeaderTimeout 3900s` e `writeTimeout 0` (padrão) | 65 minutos para cabeçalhos; o `readTimeout` do entrypoint (60 s no Traefik v3) só limita a leitura do pedido |
| `keepalive 4s` para o upstream | `idleConnTimeout 4s` em `traefik-ssam.yaml` | obrigatório (seção 3) |
| `lb_try_duration 15s` | não existe | 502 por alguns segundos num redeploy |
| `request_body max_size 20MB` | nenhum limite no proxy | o servidor recusa acima de 16 MiB (MCP) e 4 MiB (parte do agente) com 413 |
| só `/mcp`, `/agent`, `/agent/*`, `/health` | a mesma regra no roteador | o resto é 404 do Traefik |
| cabeçalhos de segurança | middleware `ssam-headers` nos rótulos | os mesmos cabeçalhos |
| rede `backend` interna, sem saída | **não existe** | o `ssam-server` fica na rede do proxy, que tem saída para a internet |

Sobre a última linha: o servidor nunca precisa de internet (toda operação no tenant ou no Studio passa pelo agente do
cliente, que conecta para dentro). O `compose.prod.yml` tirava a saída por defesa em profundidade; com o Traefik do
Coolify isso não dá, porque o proxy só alcança containers na rede dele. Quem quiser a mesma garantia bloqueia a saída
do container no host, na cadeia `DOCKER-USER` do iptables (regra por IP do container ou pela rede do Coolify), fora do
escopo deste runbook.

## 10. Ensaio local (Docker Desktop, 2026-10-20)

Feito nesta máquina com a imagem `ssam-server:prod-20261020-7770621` (a candidata do `release-record.json`), sem Coolify
e sem Traefik (os rótulos ficam inertes), com o `rehearsal.override.yml` publicando 127.0.0.1:27310:

```bash
cd server/deploy/coolify
cp .env.coolify.example /tmp/ssam-rehearsal.env     # SSAM_IMAGE=ssam-server, SSAM_IMAGE_TAG=<tag local>, SSAM_DOMAIN=ssam.rehearsal.test,
                                                    # SSAM_REHEARSAL_DB_PASSWORD=<x> e SSAM_DATABASE_URL=postgres://ssam:<x>@postgres:5432/ssam
docker compose -p ssam-coolify-rehearsal --env-file /tmp/ssam-rehearsal.env -f compose.coolify.yml -f rehearsal.override.yml config
docker compose -p ssam-coolify-rehearsal --env-file /tmp/ssam-rehearsal.env -f compose.coolify.yml -f rehearsal.override.yml up -d ssam-server
```

Resultado:

- `config`: as variáveis resolvem; a regra do roteador sai `Host(\`ssam.rehearsal.test\`) && (Path(\`/mcp\`) || ...)`,
  o serviço aponta para `ssam@file` e a porta 7310; `ssam-admin` e `ssam-ops` ficam fora do `up` (perfis).
- `ssamctl.sh status`: acha o container pelo rótulo, mostra a imagem, o digest, `running / healthy` e os 4 volumes.
- `kernel print released` imprime `{"o11":"11.55.92","odc":"1.7.28","odcBridge":"v97","odcBridgeAccepted":["v96","v48","v45"]}`;
  `kernel check` responde `pair-ok` (exit 0); `kernel write` grava e esvazia os caches. Antes do restart o log mostrava
  `kernel` com `null` e `kernel-version-missing`; depois do restart, `kernel` com as versões e `kernel-cache-reset`.
- `/health` responde `{"ok":true,"pid":7}`; `/mcp` sem token responde 401.
- `token issue` (cliente "Rehearsal Customer", 1 dia, `odc`) mostra o token e a credencial uma vez; `token list` vê o
  `tok_...` com `state: active`.
- `backup` escreve o tar.gz, o `.sha256` e o `.info` (imagem, id, revisão, container, `mode=online`); `restore` com o
  servidor no ar é recusado; com ele parado, o `tokens.json` apagado volta do arquivo, e depois do `start` o `token list`
  vê o token de novo.
- `logs` e `ops` rodam na imagem como `uid=10001(ssam)`, sem rede.

O que o ensaio NÃO prova: o Traefik do Coolify (o roteador, o resolvedor `letsencrypt`, o transporte `ssam@file`, a
rede do proxy) e o `docker login` do registro. Isso só numa VPS com Coolify, DNS e o repositório privado.

**Segundo ensaio (2026-10-20, com o Postgres):** a imagem do commit `64d4a72` (os tokens no banco), o Postgres
descartável do `rehearsal.override.yml` no papel do recurso do Coolify, e `SSAM_DATABASE_URL` no `.env` do ensaio.

- `up -d ssam-server` sobe o Postgres (`healthy` pelo `pg_isready`) e depois o servidor; o log do servidor mostra
  `db-migrated 0001 server-tokens`, `tokens-store` com `backend: postgres` e a URL sem a senha, e `listening`.
- `ssamctl.sh status` mostra a linha `tokens: postgres (...)` com a contagem de registros e "reachable" (um `psql`
  avulso contra a URL do servidor); `db status` lista a migração `0001` aplicada e nenhuma pendente.
- `token issue` grava na tabela (`psql 'select ...'` mostra o registro, sem segredo); `token list` responde com
  `database: true`; `/data/server` não tem `tokens.json`.
- `POST /mcp`: token desconhecido 401; o token emitido 200; depois de `token revoke`, 403 em menos de 2 s.
- `backup` escreve o tar.gz dos volumes e `ssam-tokens-<data>.sql.gz` com `.sha256`; com o servidor parado, as duas
  tabelas apagadas no `psql` e `restore <tar.gz> <sql.gz>`, o `start` volta `healthy`, `token list` vê os dois tokens
  e `db status` a migração.

## 11. Painel do dono (`ssam-console`) com login pelo GitHub

O painel do DEPLOY.md seção 15 (licenças: emitir, renovar, faixas, credencial do agente, revogar; monitoração do
servidor e do uso), no mesmo compose, com três diferenças em relação ao modo do túnel SSH:

| DEPLOY.md 15 (compose.prod.yml) | Aqui (Coolify) |
| --- | --- |
| sem rede: socket unix, túnel SSH pelo `painel-ssam.ps1`, chave de acesso em `access.key` | TCP na rede do compose (`CONSOLE_LISTEN`, padrão `0.0.0.0:7320` no modo GitHub, sem porta no host), roteador próprio do Traefik em `https://CONSOLE_DOMAIN`, **login pelo GitHub** |
| licenças em `tokens.json` | licenças no Postgres do servidor (`SSAM_DATABASE_URL`): a gravação é relida da tabela antes de o painel responder |
| coletor do host (`host.json`, aba VPS) | não existe: a aba VPS mostra o coletor como ausente; o resto (servidor, sessões, agentes, uso, qualidade, eventos, histórico) é o mesmo |

Só entra quem está em `CONSOLE_GITHUB_ALLOWED_LOGINS` (a sua conta do GitHub; maiúsculas não importam). Qualquer outra
conta do GitHub vê a página "conta não autorizada", ganha uma linha na auditoria (`signin-refused`) e conta como
tentativa errada: dez em um minuto travam o painel por 60 s (só `/healthz` responde). A sessão dura 12 h num cookie
assinado (HttpOnly, Secure, SameSite=Lax); o botão **Sair** encerra a sessão no servidor. Toda ação de escrita leva o
token CSRF da sessão num cabeçalho: um formulário de outro site não consegue emitir nem revogar nada. O token do GitHub
é usado uma vez (para ler o login) e nunca é guardado; nada do segredo da OAuth App vai para o log. O túnel do
DEPLOY.md 15 continua válido para o `compose.prod.yml`; no Coolify o painel é **só** este modo (TCP + GitHub).

### 11.1 A OAuth App no GitHub (uma vez)

1. No GitHub, com a sua conta: **Settings > Developer settings > OAuth Apps > New OAuth App**
   (<https://github.com/settings/developers>). Não é um "GitHub App": é **OAuth App**.
2. **Application name**: `Painel SSAM` (qualquer nome; aparece na tela de autorização).
3. **Homepage URL**: `https://<CONSOLE_DOMAIN>` (por exemplo `https://painel.ssam.example.com`).
4. **Authorization callback URL**: `https://<CONSOLE_DOMAIN>/auth/github/callback`, exatamente (o GitHub recusa a
   entrada se o painel pedir um callback diferente deste).
5. **Enable Device Flow**: desligado. **Register application**.
6. Na página da app: copie o **Client ID** (`CONSOLE_GITHUB_CLIENT_ID`). Em **Client secrets > Generate a new client
   secret**: o segredo aparece **uma vez**; cole direto em `CONSOLE_GITHUB_CLIENT_SECRET` no Coolify (não guarde em
   arquivo). Para trocar, gere outro, troque a variável e dê **Restart** no `ssam-console`; depois apague o antigo.
7. A app não pede escopo nenhum (só o login público da conta). O GitHub mostra a tela de autorização na primeira entrada;
   em **Settings > Applications > Authorized OAuth Apps** dá para revogá-la a qualquer hora.

### 11.2 DNS e Traefik

- Um registro A (e AAAA) para `CONSOLE_DOMAIN` apontando para a VPS, **diferente** do `SSAM_DOMAIN` (o painel nunca
  fica no host público do `/mcp`; o cliente não precisa saber que ele existe).
- Nada a fazer no Traefik: os rótulos do `ssam-console` no compose são o roteador (`Host(CONSOLE_DOMAIN)`, todos os
  caminhos, Let's Encrypt, redirecionamento de http). O middleware de cabeçalhos é o `ssam-console-headers`: os mesmos
  do `ssam-headers` (HSTS, nosniff, frame deny, referrer, `Server` vazio) **menos** o `Content-Security-Policy` e o
  `Cross-Origin-Resource-Policy`, que o próprio painel manda (o CSP do servidor, `default-src 'none'`, substituiria o do
  painel e a página não rodaria). O transporte `ssam@file` não é usado (o painel não tem chamadas longas).

### 11.3 Variáveis no Coolify

Nas **Environment Variables** do recurso (o Coolify pede as com `:?` antes do deploy; `.env.coolify.example` tem a
lista):

| Variável | Valor |
| --- | --- |
| `CONSOLE_DOMAIN` | o DNS do painel, sem `https://` (`painel.ssam.example.com`) |
| `CONSOLE_GITHUB_CLIENT_ID` | o Client ID da OAuth App (11.1) |
| `CONSOLE_GITHUB_CLIENT_SECRET` | o client secret da OAuth App (11.1); marque como secreto no Coolify |
| `CONSOLE_GITHUB_ALLOWED_LOGINS` | o seu login do GitHub (vários separados por vírgula; o painel não sobe com a lista vazia) |
| `CONSOLE_SESSION_SECRET` | opcional (vazio: gerado na primeira subida e guardado em `/data/server/.console/session.secret`, 0600; uma troca derruba as sessões abertas) |
| `CONSOLE_LICENSE_WRITES` | opcional: `auto` (padrão; grava, porque o Postgres trava entre gravadores), `on` ou `off` |

`SSAM_DATABASE_URL` e `SSAM_DOMAIN` são as mesmas do servidor (o painel mostra a URL pública do servidor nas telas de
emissão). **Advanced > Docker Compose > Connect to predefined network** continua ligado: é por essa rede que o Traefik
chega ao painel e que o painel chega ao banco.

### 11.4 O código do painel vem na imagem

Desde a `prod-20261020-12fae04` (a `latest` do registro desde 2026-10-20; digest
`sha256:bbeaffad076ac04b0156208b4541ef6d761517c945589ab4b59cbf05999318e5`), o `.dockerignore` inclui `deploy/console`
(sem os testes e os mocks) e o `ssam-console` roda `node /app/deploy/console/server.mjs` **da própria imagem**: nada é
montado da VPS, nenhuma pasta precisa ser copiada, e uma mudança no painel se publica como qualquer outra
(publicação da tag imutável e **Redeploy** da janela; seção 7). O painel importa o módulo de tokens da mesma imagem
(`/app/platforms/odc/facade/server-tokens.mjs`), então servidor e painel nunca divergem de versão. Imagens anteriores
(`2b46244`, `e2ff91b`) não têm o painel dentro: com elas o serviço `ssam-console` não sobe.

### 11.5 Deploy e conferências

1. Variáveis (11.3), DNS (11.2), **Redeploy**. O log do `ssam-console` (Coolify, ou `sh ssamctl.sh console logs`) deve
   mostrar `db-migrated` (na primeira vez) ou `tokens-store` com `backend: postgres`, `listening` com as capacidades
   todas `true`, e `auth` com `mode: github` e o número de logins. Se o banco não responder na subida, o painel sobe
   **só leitura** (`token-module-failed`, capacidades `false`) e tenta de novo a cada 30 s (`token-store-reconnected`).
2. `curl -fsS https://<CONSOLE_DOMAIN>/healthz` responde `{"ok":true}`; `curl -s -o /dev/null -w '%{http_code}\n'
   https://<CONSOLE_DOMAIN>/` responde 302 (para `/auth/signin`); `https://<CONSOLE_DOMAIN>/api/meta` responde 401
   `SESSION_REQUIRED`.
3. No navegador: `https://<CONSOLE_DOMAIN>` > **Entrar com GitHub** > a tela do GitHub (autorize a app) > o painel. O
   nome da sua conta aparece no botão **Sair**.
4. Com outra conta do GitHub (num navegador anônimo): a página "Esta conta do GitHub não está autorizada neste painel".
   `sh ssamctl.sh console audit` mostra a linha `signin-refused` com o login.
5. `sh ssamctl.sh console status` mostra o container, a imagem, a saúde, a URL e os logins permitidos.

### 11.6 No dia a dia

- As licenças: pelo painel (aba Licenças) ou pelo `ssamctl.sh token` (seção 6); os dois gravam no mesmo Postgres e um
  vê a mudança do outro em até 1 s (no painel, uma linha "fora do painel" no histórico).
- A auditoria do painel (`/data/server/console-audit.jsonl`, no volume `server-state`: vai no backup da seção 8) tem
  cada ação, cada entrada (`signin`), recusa (`signin-refused`) e saída (`signout`), nunca um segredo.
- O estado do painel (checkpoint, agregados de uso e qualidade, o segredo da sessão) fica em `/data/server/.console`,
  dentro do mesmo volume: um volume próprio nasceria de root e o painel roda como uid 10001. O servidor nunca lê essa
  pasta; o backup a leva junto.
- Para derrubar todas as sessões abertas: **Restart** no `ssam-console` não basta (o segredo é guardado); troque
  `CONSOLE_SESSION_SECRET` (ou apague `/data/server/.console/session.secret` com `ssamctl.sh ops`) e reinicie.
- Para tirar alguém: retire o login de `CONSOLE_GITHUB_ALLOWED_LOGINS` e reinicie; a sessão dele, mesmo aberta, deixa de
  valer (a lista é conferida a cada pedido).

### 11.7 Ensaio local (Docker Desktop, 2026-10-20)

Feito nesta máquina com a imagem publicada `ssam-server:prod-20261020-2b46244` (a mesma do Docker Hub), o código do
painel deste commit montado em `/console` (o esquema da época), o Postgres descartável do `rehearsal.override.yml` e um GitHub falso: um
servidor HTTP local (`github.com` e `api.github.com` numa porta só, respondendo o login que se escolhe), apontado pelas
variáveis de teste `CONSOLE_GITHUB_BASE_URL`/`CONSOLE_GITHUB_API_URL` (no override, `CONSOLE_REHEARSAL_GITHUB_URL`).
Sem Traefik e sem TLS (`CONSOLE_PUBLIC_URL=http://localhost:27320`).

```bash
cd server/deploy/coolify
# .env do ensaio: SSAM_IMAGE=ssam-server, SSAM_IMAGE_TAG=prod-20261020-2b46244, SSAM_DOMAIN=ssam.rehearsal.test,
# SSAM_REHEARSAL_DB_PASSWORD, SSAM_DATABASE_URL=postgres://ssam:<x>@postgres:5432/ssam, CONSOLE_DOMAIN=localhost:27320,
# CONSOLE_GITHUB_CLIENT_ID/SECRET (os do GitHub falso), CONSOLE_GITHUB_ALLOWED_LOGINS=owner-login,
# CONSOLE_REHEARSAL_GITHUB_URL=http://host.docker.internal:27399
docker compose -p ssam-console-rehearsal --env-file /tmp/ssam-console-rehearsal.env -f compose.coolify.yml -f rehearsal.override.yml up -d ssam-server ssam-console
```

Resultado (um cliente Node no papel do navegador, com o cookie e o cabeçalho CSRF; cada passo conferido):

- `config` resolve: o `ssam-console` com `CONSOLE_LISTEN=0.0.0.0:7320`, o roteador `Host(CONSOLE_DOMAIN)` no
  middleware `ssam-console-headers`; nenhuma porta no host fora do override. (Neste primeiro ensaio o código do painel
  era montado da árvore; desde 11.4 ele vem na imagem, e o ensaio foi repetido assim: ver o fim desta seção.)
- A subida: o log do painel mostra `db-migrated 0001`, `tokens-store` com `backend: postgres`, `session-secret-created`,
  `listening` com todas as capacidades `true` (modo `auto`: o Postgres conta como armazenamento com trava) e `auth` com
  `mode: github`. O healthcheck (com o `Host` do painel) fica `healthy`.
- Sem sessão: `GET /` responde 302 para `/auth/signin`; a página tem o link **Entrar com GitHub**; `/api/meta` responde
  401 `SESSION_REQUIRED`.
- Login permitido (`Owner-Login`): o painel manda para `/login/oauth/authorize` com `client_id`, o `redirect_uri` do
  callback, um `state` de 32 caracteres e `allow_signup=false`; o GitHub falso devolve o `code`; o painel troca o code
  pelo token (`Accept: application/json`, `User-Agent: ssam-console/1.0.0`) e lê `/user` (`Accept:
  application/vnd.github+json`, `Authorization: Bearer`, `X-GitHub-Api-Version: 2022-11-28`) **uma vez**; responde 302
  para `/` com `ssam_console_session=...; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Lax`. Com o cookie,
  `/api/meta` traz `auth: {mode: "github", login: "Owner-Login", csrf: ...}` e `GET /` é a página do painel.
- Escritas: `POST /api/licenses` sem o cabeçalho `X-SSAM-Console-CSRF` responde 403 `CSRF_REQUIRED`; com um token
  errado, 403; com o da sessão, 201 e o token e a credencial aparecem uma vez. `renew`, `lanes`, `agent-rotate` e
  `revoke` respondem 200 e `/api/history` mostra as cinco ações; `sh ssamctl.sh token list` (o `ssam-admin`, pelo banco
  do servidor) vê o mesmo `tok_...` como `revoked`, e `/data/server` **não** tem `tokens.json`.
- Logout: `POST /api/auth/logout` responde `{ok: true}` e apaga o cookie; o cookie antigo passa a responder 401
  `SESSION_INVALID` e `GET /` manda para `/auth/signin?r=expirou`.
- Login fora da lista (`intruder`): a página "não está autorizada" (403) com o login, sem cookie; `ssamctl.sh console
  audit` mostra `signin-refused` com `LOGIN_NOT_ALLOWED` e o login. `OWNER-LOGIN` entra (a lista não distingue
  maiúsculas). Um `Host` estranho responde 403 `HOST_REFUSED`. `/api/key/rotate` não existe (404).
- Reconexão: num reinício do Docker Desktop o painel subiu antes do Postgres (`token-module-failed` com `ENOTFOUND`,
  capacidades `false`) e, 30 s depois, `token-store-reconnected` com `backend: postgres` e as capacidades de volta, sem
  reiniciar o container: é o que acontece no Coolify quando o recurso do banco sobe depois do compose.
- `ssamctl.sh console status|logs|audit` funcionam ao lado dos comandos do servidor.

**Ensaio repetido com o painel dentro da imagem (2026-10-20, `ssam-server:prod-20261020-12fae04`):** o compose sem o
bind mount (o container só monta o volume `server-state`), `/app/deploy/console` na imagem sem `tests`, `ui-tests`,
`public/mock` e `painel-ssam.ps1`; o `ssam-console` sobe `healthy` com `listening` em `0.0.0.0:7320` e `auth` com
`mode: github`; o mesmo roteiro de cima (entrada, CSRF, as cinco ações no Postgres, saída, login recusado, `Host`
estranho) passou inteiro. Essa é a imagem publicada como `latest`.

O que o ensaio NÃO prova: o GitHub de verdade (a tela de autorização, o `client_secret` real, a conta do dono), o
Traefik do Coolify com o roteador do painel e o certificado do Let's Encrypt para `CONSOLE_DOMAIN`, o cookie `Secure`
atrás do TLS do proxy (no ensaio o cliente Node o aceita em http; um navegador exige https, ou `localhost`). Isso só
numa VPS com Coolify e DNS.

## 12. Versions window

A janela padrão é 3 pares, configurada em versions.json (window) e injetada como SSAM_VERSION_WINDOW. A janela inicial tem dois pares: O11 11.55.93 + ODC 1.7.29 (padrão) e O11 11.55.92 + ODC 1.7.28. Cada imagem leva os dois Studios. Uma versão de faixa é servida se aparecer em qualquer par. Ao entrar um par além do limite, sai o mais antigo. Volumes de pares removidos podem permanecer para rollback, mas nenhum container fora da janela deve continuar rodando.

```sh
node server/deploy/coolify/gen-compose.mjs
```

O arquivo gerado permanece no Git. Não edite seus serviços manualmente. Os nomes dos volumes de features/cache usam o par, não a posição v1/v2, e não trocam de significado quando a janela roda. server-state e friction são compartilhados; arquivos mutáveis por processo ficam sob versions/<par>. Somente ssam-router recebe rótulos Traefik, inclusive para encaminhar o painel. Seus timeouts são 65 minutos e ele repassa cabeçalhos e bytes sem buffering.

O Hello do agente escolhe primeiro a versão ODC instalada; sem ODC, escolhe O11; sem nenhuma, o padrão. MCP usa a mesma associação por licença, persistida em state/routing.json. Uma mudança de associação encerra a afinidade antiga com SESSION_REROUTED uma vez; o cliente abre outra sessão. Não há migração do estado MCP entre containers.

O painel exibe Studio versions: versão, container, situação, clientes e último visto. default é o par padrão, served é servido, unserved é versão observada fora da janela, leaving é uma saída explicitamente proposta. A contagem dos pares é por associação do cliente; uma versão não servida aparece também em linha própria. O aviso "ODC Studio X.Y.Z not served: N customers" usa o motor de alertas existente. Leituras combinam a observação mais nova de cada licença e não expõem credenciais.

Para sinalizar uma saída antes do deploy, o dono pode fornecer state/proposed-versions.json no volume compartilhado, com {"leaving":{"odc":["1.7.28"],"o11":["11.55.92"]}}. O painel nunca deduz leaving só porque a janela está cheia. Remova o arquivo após aprovar ou abandonar a proposta. Esse arquivo não muda o roteamento.

O vigia Windows está em ../vigia/README.md. Roda a cada 6 h pela tarefa agendada (install-task.ps1) numa worktree própria que se atualiza de main, detecta versões locais ou instaladores O11 baixados, faz bundle, testes filtrados sequenciais, imagem e smoke local, e deixa branch e PROPOSTA.md para o dono; ODC e O11 novos juntos viram um só par. Só publica com o comando do dono (vigia.ps1 -Approve <par>), que confere o digest, publica a tag sem latest, fixa o digest em versions.json e no compose (commit na branch da proposta) e imprime os passos que faltam (backup, kernel e features do par novo, colar o compose literal no Coolify, Redeploy) e a volta. Nunca acessa a VPS nem o Coolify. O pacote do agente de cada par vem de agentPack/agentPackByRuntime da configuração; as provas ao vivo de bridge continuam do dono.

O seletor --version aceita odc=1.7.29 e o11=11.55.93; a forma sem faixa também é aceita quando identifica um único container. Uma seleção ambígua lista os candidatos. Sem SSAM_CONTAINER, --version prevalece sobre SSAM_VERSION; sem ambos, usa-se o padrão. Atualizar só uma faixa mantém a outra na versão do par vigente, sem repetir combinações na janela.


## 13. Capacity sizing (hot pair)

Measured on the KVM 8 (8 vCPU EPYC 9354P, MemTotal 31.3 GiB) on 2026-11-09: `C:\t\r5\capacity\RESULTADO.md` and
`RESULTADO-R2.md`, `RESULTADO-R3.md`. One cold kernel build uses about 1.25 vCPU and 0.4 to 1.3 GB; builds share the CPU cap, so a backend's
vCPUs set its build throughput. `versions.json` `sizing` gives ONE backend the "hot" tier and the rest the "other" tier:

| Tier | cpus | memory | cpu_shares (cgroup v2 weight) | SSAM_BUILD_WORKERS | SSAM_O11_WORKERS_MAX | SSAM_BUILD_QUEUE_MS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| hot (most used pair) | 5 | 10g | 5776 (400) | 4 | 2 | 240000 |
| other | 2 | 4240m | 1024 (100, the default) | 1 | 1 | 240000 |

Option (c) of RESULTADO-R3.md (no image rebuild): the backends run images without the memory gate, so each tier is sized
for its worst case without admission (server 0.4 GB + a worker in a call 1.7 GB each + an O11 build 1.33 GB each): hot
8698 MiB of 10240, other 3271 MiB of 4240. Budget 10240 + 4 x 4240 + 512 + 256 = 27968 of 27993 MiB.
| router | 1 | 512m | (100) | | | |

- Hot = the pair of most REAL USE (`sizing.usage`): the most heavy calls of
  the last 7 days (`studio_deliver`, `o11_deliver`, `ssam_code` in that pair's quality log), then the most clients active in
  the last 14 days (real clients only: no verification, no revoked license); ties and no counts go to the router's default
  pair (the first of the window). The newest pair is "other" until it is the most used. Licenses ever routed
  (`state/routing.json`) are not use: routes never expire. The hot pair therefore MOVES WITH USE: each deploy the watcher
  makes recounts it and the tier follows the heaviest pair. The owner's pin `sizing.hotPair` exists for an emergency only and
  is not set in `versions.json`: a pin stays while its pair stays in the window, even after the use there has gone (review
  R3 M1), so a pin must be removed by hand as soon as it is no longer needed.
- The watcher counts use (counts only, never a token id or a customer) with `vigia/usage-count.cjs`, run read-only inside a
  live backend by its remote snapshot at each deploy it makes anyway, writes them into `sizing.usage` of the pinned
  manifest, and sends the owner a `hot-pair` event (`HOT_PAIR_CHANGED`) once the deploy is live when the hot pair changed; a
  notice that reached nobody is sent again by the next round. A shift of use never triggers a deploy. Usage is advisory:
  unreadable or odd counts keep the recorded ones and send a `usage-warning` (`USAGE_UNREADABLE`, `USAGE_PARTIAL`); they
  never stop or defer a round. Its rotation keeps the counts of the pairs that stay, folds the counts of a leaving pair into
  the new default pair (where the router sends its clients), keeps a pin while its pair stays and drops it when it leaves.
- The live router's `ssam.sizing` label is how the watcher reads the sizing back from Coolify; live backends with a tier
  label and a router without it stop the round (`LIVE_INVALID`), so a lost label never clones the hot limits into a new pair.
- A change of `sizing` in `versions.json` (a tier, the pin) does NOT reach production through the watcher: its automatic
  deploy keeps the sizing of the live router label. It goes live only with a manual compose apply (the owner's `-Approve`
  path or the deploy kit of the integrator, as in `RESULTADO-R2.md`).
- The hot tier wins CPU contention through its weight (4x the default 100); the other tiers, the router, the console,
  Coolify and Postgres keep the default weight, and the other caps stay at 2 vCPU, so no pair regresses. The VPS runs runc
  1.5.1 (cgroup v2, systemd driver), which converts shares with the quadratic of opencontainers/cgroups
  (`gen-compose.mjs` `cpuWeight`): 1024 -> 100 (measured there), 5768..5784 -> 400, 2598 -> 210, 10463 -> 650. The linear
  `1 + (shares - 2) x 9999 / 262142` of runc before 1.3 is not this host's (review R3 A1). A runc or Docker upgrade can
  change the mapping again: the deploy check (`env-check.sh`) reads `cpu.weight` back and a mismatch stops the release.
- Every tier value is literal in the compose (no `${...}`): Coolify 4.4.6 stored the defaults of `${VAR:-default}` of the
  environment sections as resource variables (the rows of 2026-10-20 equal the defaults), so a tier variable could freeze
  or override a tier without any check. A sized backend no longer reads `SSAM_CPUS`, `SSAM_MEMORY`, `SSAM_BUILD_WORKERS` or
  `SSAM_O11_WORKERS_MAX`; those Coolify variables stay only for an unsized (rolled back) compose.
- `sizing.host` (`32089m`, the MemTotal; reserve `4g`): hot + (pairs - 1) x other + router + console must fit
  MemTotal - reserve. Five pairs use 27968 of 27993 MiB. A sixth pair does not fit: the generator and the watcher's
  rotation refuse it with `CAPACITY_WINDOW` (environmental: the round waits and the owner is told) instead of shrinking any
  backend; a pair has to leave, or the owner changes `sizing`.
- The memory gate (`platforms/odc/facade/memory-room.mjs`) admits every kernel process (build-pool slot, cold O11/ODC
  process, a customer's worker start) by the room under the container's cgroup limit, not by the host's MemAvailable:
  `SSAM_MEMORY_RESERVE_MB` (1400) per O11 process, `SSAM_MEMORY_RESERVE_ODC_MB` (600) per ODC one (measured only for the
  ODC `apply`, ~0.45 GB; not for the other cold ODC paths). A build without that room waits in the pool queue; a cold
  process waits at most `SSAM_MEMORY_WAIT_MS` (120 s) and is then refused, nothing sent (`BUILD_QUEUE_TIMEOUT`,
  `waitedFor: memory`). **The gate is server code: it holds only in backends whose image was built from e04cfb7 or later.**
  A compose-only release keeps the images, and the watcher never rebuilds a retained pair, so a pair whose image predates
  the gate runs its tier's memory limit WITHOUT admission (review R3 A2): see `RESULTADO-R3.md` for the owner's options.
- Option (c) (`server/capacity-hot-pair-c`, review R4): the tiers fit the measured worst case WITHOUT the gate (other
  4240m with 1 build and 1 worker, hot 10g with 4 builds). The model counts the server, the workers and the pool builds;
  the cold processes (`coldKernel`/`runCold`, one `dotnet` per call with no limit in the r43b/r44 images) are OUTSIDE it:
  one cold process of the 100-action size (~1268 MiB) next to a full other already passes 4240m, as it passes 6g today
  (review R4 M2). The read-only `r45/oom-check.sh` runs daily during the first week; any `oom_kill` > 0 is the rollback
  trigger.
- The deploy kit is committed in `r45/` and made from ONE commit (`node r45/kit.mjs --option c --pin <main> --out <dir>
  --reviewed <reviewed kit>`): its generators, `r45-window.sh`, `rollback-check.sh`, `oom-check.sh`, `../vigia/with-release-lock.sh`
  and the backup scripts are that commit's bytes, and `--reviewed` proves that only PIN, MARK and LABEL moved. The window
  (`r45-window.sh apply`) leaves one copy of the stored compose, `/root/ssam-r45/coolify-before.json` (0600), for the
  rollback; `cleanup`, after the owner confirms, deletes it and logs it in `/root/ssam-r45/cleanup.log`. Roll back with
  `SSAM_LOCK_WAIT=900` (a backup cron may hold the lock).

## 14. Window 4x4 (one backend per ODC version; phase S1, not deployed)

Design B (`C:\t\r5\janela-4x4\DESENHO.md`): the window serves the newest ODC Studio and the three before it, and the
newest Service Studio and the three before it, in every combination. One backend per ODC version; each image carries
every Service Studio of the window and one O11 kernel compiled against each:

- Image: `node server/deploy/gen-dockerfile.mjs <o11-kernels.json>` writes `deploy/.generated/Dockerfile.o11k` from
  `server/Dockerfile` (every bundle pinned by its SHA256 in the generated file); `SSAM_DOCKERFILE=deploy/.generated/Dockerfile.o11k
  sh deploy/build.sh ...` builds it, one image per ODC Studio. Layout `/studio/o11/<x.y.z>`, `/app/kernel/.local/o11/<x.y.z>/cli`,
  ENV `SSAM_IMAGE_O11` (the list), `SSAM_O11_STUDIO_ROOT`, `SSAM_O11_CLI_ROOT`; `ANVIL_STUDIO_DIR` and `/app/kernel/.local/cli`
  are the default kernel's (the one kernel.json pins). The single-O11 `server/Dockerfile` is unchanged.
- Server: the hub hands each customer the kernel of its own Service Studio (`welcome.kernel.o11`, `builds.o11`;
  `platforms/odc/facade/o11-kernels.mjs`), its hosted calls run that kernel's CLI and Studio folder, and its O11 module index
  is `<SSAM_MODULE_INDEX_ROOT>/o11-kernel/<x.y.z>`. A Service Studio outside the window is judged by the default kernel, as
  on the pairs (older: update required; newer: served with the notice).
- Compose: a `versions.json` with `backends` instead of the `odc`/`o11` lists:
  `{"window":4,"o11":{"served":["11.55.92","11.55.93","11.55.94","11.55.95"]},"sizing":{...},"backends":[{"odc":"1.7.32","image":"...","tag":"...","sha256":"..."},...]}`.
  `gen-compose.mjs` names each backend `odc-<x.y.z>` (volumes `cache-odc-<v>`, `odc-features-odc-<v>`, runtime
  `/data/server/versions/odc-<v>`), puts the newest ODC first (`ssam-server-v1`, the router's default), gives EVERY backend
  the same `SSAM_SERVED_VERSIONS` (all ODC versions of the window, `o11.served`), label `ssam.o11` = the served list, and
  mounts the shared signed-bridge store `ssam-bridges` read-only at `/data/bridges` (`SSAM_BRIDGES_DIR`; the public key stays
  in the image). The router selects by the ODC Studio only. Sizing (section 13) is unchanged and keyed by backend name
  (`usage`, `hotPair`: `odc-<v>`); `withUsage` folds the counts of a pair into the backend of its ODC version.
- Not yet: the watcher (S2) still rotates and checks a window of pairs and must stay paused while a backend window is live;
  `ssamctl --version o11=<v>` no longer identifies a backend (use `odc=<v>`). The first deploy kit is planned in
  `C:\t\r5\janela-4x4\S1-KIT-PLANO.md` (rename of the odc-features volumes, kernel.json per new runtime dir, Coolify PATCH, rollback).
- Resident O11 readers (review S1 M2, R3): each Service Studio version a customer brings has its own resident
  `read-serve` (`reader-client.mjs`, idle exit 15 min), which section 13's model never counted. On a multi-O11 image a
  new reader generation first stops the idle readers past the ceiling `SSAM_O11_READERS_MAX` (least recently used; a
  reader that serves, or read within `SSAM_O11_READER_MIN_IDLE_MS`, default 60 s, is never stopped), drops the copies
  of retired versions, and is admitted by the memory gate with `SSAM_MEMORY_RESERVE_READER_MB` (default 800, NOT
  measured: the first-deploy kit measures one reader's RSS and sets `sizing.<tier>.o11ReaderMb`). The ceiling only
  limits (`gen-compose`: every O11 version of the window, or `sizing.<tier>.o11Readers`); the gate decides how many
  fit (relief below). Its startup deadline
  runs from the spawn, after the admission, and a reader that misses it is killed (no reader without its reserve). A
  switch between two versions on a full backend costs one cold reader start (seconds), at most once a minute.
- Resident ODC lane worker (S1 R2/R3): `anvil-odc serve` (`anvil-worker.mjs`), measured on v5 (other) 2026-11-09 at
  VmRSS 1498 MiB, VmHWM 2116 MiB, was in no model either: other 3271 + 2116 = 5387 MiB against 4240m, hot 8698 + 2116
  = 10814 against 10240m, at the worst case of section 13 with no reader. Production r45 (oom-check 2026-11-09): v5
  peaked at 3772 of 4240 MiB with no OOM, v2 1556, the others ~400; the worst case did not coincide. In the S1 images:
  - its start is admitted by the memory gate with `SSAM_MEMORY_RESERVE_ODC_WORKER_MB` (default 2150, the measured peak),
    as a STANDING hold on its pid while it lives: every later admission (builds, O11 workers, readers) counts its growth
    still to come (reserve minus RSS, 652 MiB at 1498). A worker already up is adopted the same way. A start without room
    within `SSAM_MEMORY_WORKER_WAIT_MS` (15 s) launches nothing and the command runs cold, admitted with the ODC cold
    reserve (600) or inside the build slot that reserved it; a wait that runs out there refuses with
    `BUILD_QUEUE_TIMEOUT` (outcome not-sent). After a start found no room, that port goes cold at once for 60 s
    unless the gate fits the worker right then (review R3 B-R3-1).
  - Relief and progress (S1 R4, review R3 M6): every wait of the gate (a build slot, a cold run, an ODC or O11 worker
    start, a reader start) first asks the idle caches to leave, one per 2 s turn (`SSAM_MEMORY_EVICT_TURN_MS`): idle O11
    readers first (a waiting reader spares those read within 60 s; any other waiter evicts a reader idle for 5 s), then
    idle ODC and O11 workers of this backend with no call in flight. An evicted ODC worker keeps its standing hold,
    marked leaving, until its process is gone (review R4 B-R4-2); an ODC worker used within 60 s is never asked, as the
    readers (B-R4-3). A worker or reader serving a call is never asked. The server registers the evictor of its O11
    reader folder at start, so readers left by a previous server process are evictable too (B-R4-1). When nothing more
    is evictable and no other consumer is admitted (a standing hold is no consumer), the waiter enters: a lone delivery
    is never refused for an idle cache or for a resident worker's growth still to come. That rule never admits a
    STANDING request (S1 R5, review R4 M7): the ODC worker's start has the cold run as its alternative and starts only
    with real room (the 60 s no-room cache asks the same), so a consumer entering by the rule never stacks on a worker
    that started without room. Measured by the review's probe (other: server 400, ODC worker RSS 1498, an
    idle reader of 300/600/800 MiB): the O11 delivery (1400) is admitted in every case.
  - Hot: each build slot past the first has its own ODC worker (`base + index*step`, `build-pool.mjs`), so up to 4 W
    on the hot tier (4 builds), each started through the gate with its own standing hold and each an evictable cache
    when idle. A build that runs on its slot's worker reserves once: the slot's hold is marked covered while the worker's
    standing hold counts that worker's growth (review R3 B-R3-2).
  - `gen-compose` writes `ANVIL_WORKER_IDLE_MINUTES` per tier (`sizing.<tier>.workerIdleMinutes`; default hot 120,
    other 30; the kernel's own default is 240): the idle ODC worker leaves memory sooner. The hosted O11 workers set
    their own; the readers keep their 15 min.
  - The owner's 4240m for other stays. No kernel process STARTS without admission (the ODC worker included) and the ODC
    worker's growth is reserved; that is not "never an OOM": a call on a resident worker (O11 or ODC) has no reservation of
    its own beyond the first 15 s (`growMs`), the progress rule admits a lone consumer when nothing more can be evicted,
    and `debug-run.mjs`'s cold apply outside a slot runs unadmitted. The gate only exists in images built from e04cfb7
    on, which every S1 image is; the live r45 images have none.
