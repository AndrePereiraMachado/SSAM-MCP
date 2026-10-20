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
| `compose.coolify.yml` | o compose que o Coolify roda: `ssam-server` e `ssam-console` (o painel do dono, seção 11) com os rótulos do Traefik; `ssam-admin` e `ssam-ops` só por perfil (nunca sobem com o Coolify) |
| `traefik-ssam.yaml` | configuração dinâmica do Traefik do Coolify: o transporte `ssam@file` (keep-alive de 4 s, sem limite de resposta) |
| `ssamctl.sh` | as operações à mão na VPS, só com `docker`: tokens, `db migrate\|status`, `psql`, `kernel.json`, `Features.plain.xml`, backup (com o dump do banco), restore, log, `console status\|logs\|audit`, `pull` |
| `.env.coolify.example` | a lista das variáveis (no Coolify, as Environment Variables do recurso) |
| `rehearsal.override.yml` | só para o ensaio local (seções 10 e 11.7): publica 7310 em 127.0.0.1:27310 e o painel em 127.0.0.1:27320, e sobe um Postgres descartável no lugar do recurso do Coolify |
| `../publish.sh` | na máquina do dono: empurra uma imagem já construída e provada para o registro privado (nunca uma tag fixa que já existe) e, com `--latest`, move a tag `latest` para ela |

## 1. Publicar a imagem no registro privado (máquina do dono)

A imagem carrega binários dos Studios da OutSystems: só registro **privado** (DEPLOY.md seção 2). No Docker Hub, um
repositório criado pelo primeiro `push` nasce PÚBLICO, a não ser que a conta tenha "private" como padrão. Por isso:

1. No Docker Hub, crie antes o repositório `<namespace>/ssam-server` como **Private** (Create repository > Visibility:
   Private). Com um plano gratuito, só um repositório privado por conta.
2. Na máquina do build (Git Bash com Docker Desktop, WSL ou Linux), entre no registro você mesmo, uma vez:
   `docker login` (Docker Hub) ou `docker login <registro>`. O `publish.sh` nunca recebe senha.
3. Publique a imagem já construída e ensaiada (DEPLOY.md seções 6 e 12):

   ```bash
   cd server
   sh deploy/publish.sh --image docker.io/<namespace>/ssam-server --tag prod-20261020-e2ff91b --private-repo-ready --latest
   ```

   Ele marca `ssam-server:<tag>` como `<image>:<tag>`, empurra, lê o digest do próprio push e, com `--latest`, empurra
   a mesma imagem também como `<image>:latest` (conferindo que o digest é o mesmo). No Coolify fica `SSAM_IMAGE` e
   `SSAM_IMAGE_TAG=latest`, uma vez só: cada publicação nova entra com um **Redeploy**, sem mexer em variável (seção
   7). Quem quiser fixar uma imagem põe a tag fixa (`prod-<aaaammdd>-<commit>`, a tag SÓ: o parser de compose do
   Coolify transforma `<tag>@sha256:<digest>` em `<imagem>@sha256@sha256:...` e o pull falha com "invalid reference
   format", visto em 2026-10-20); num `compose.prod.yml` com `.env`, a forma com digest. A tag fixa vale como o digest
   porque o `publish.sh` **nunca empurra uma tag fixa que já existe no registro** (recusa, código 2): um build novo
   tem tag nova; só a `latest` se move. `--latest-only` move a `latest` para uma tag já publicada (o rollback da
   `latest`, ou a `latest` de uma imagem publicada antes de existir a opção). O digest sai impresso para comparar na
   VPS com `ssamctl.sh status`. Antes de empurrar, no Docker Hub, ele confere
   sem login que o repositório NÃO é lido por qualquer um (público = recusa, código 3). De fora, um repositório privado e
   um que não existe parecem iguais (404 anônimo; "no such manifest" com login), e um push num repositório que não
   existe o CRIA PÚBLICO: por isso o `--private-repo-ready` é a sua palavra de que o passo 1 foi feito, e sem ele o
   script não empurra para o `docker.io`. Depois do push ele confere de novo e, se o repositório estiver público, avisa
   e sai com 3. Foi o que aconteceu na primeira publicação (2026-10-20): o repositório não existia, nasceu público e
   teve de ser fechado à mão na hora. Uma imagem construída com a árvore suja (`-dirty`) é recusada.

   Serve qualquer registro privado (GHCR, GitLab, ECR, ACR, `registry:2` próprio): só muda o `--image`.

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
derruba os ociosos em 4 s, como o Caddyfile fazia (`keepalive 4s`), e não põe limite na resposta (um `o11_deliver` leva
até 60 min). Isso não cabe em rótulo: o provedor Docker do Traefik não tem rótulo de `serversTransports`.

## 4. O recurso no Coolify

1. **Projects > o projeto > Add resource > Docker Compose Empty** (ou um repositório git privado com esta pasta; o
   arquivo é `server/deploy/coolify/compose.coolify.yml`). Cole o `compose.coolify.yml`.
2. **Environment Variables**: o Coolify lê cada `${VAR}` do compose e pede as com `:?` antes do primeiro deploy. Preencha
   com a lista de `.env.coolify.example`: `SSAM_IMAGE` e `SSAM_IMAGE_TAG=latest` (ou uma tag fixa do `publish.sh`, sem
   digest), `SSAM_DATABASE_URL` (a URL interna do recurso Postgres do Coolify, seção 6),
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
6. **Deploy**. O Coolify puxa a imagem (seção 2), cria os volumes `server-state`, `friction`, `odc-features` e `cache`
   (com o prefixo do recurso) e sobe o `ssam-server` e o `ssam-console` (seção 11): `ssam-admin` e `ssam-ops` têm
   `profiles` e nunca sobem sozinhos. Ao subir, o servidor aplica as migrações no banco da seção 6 (o log mostra `db-migrated` na primeira vez e
   `tokens-store` com `backend: postgres`); sem alcançar o banco, ele NÃO sobe (o log diz por quê). O container fica
   `healthy` em uns 10 s e ainda aquece 1 a 2 minutos (DEPLOY.md 7.3).

Nesse primeiro `up` o servidor sobe **sem** `kernel.json` (o log mostra `kernel` com `null` e `kernel-version-missing`):
o hub recusa o pacote de qualquer agente até a seção 5. É esperado.

## 5. Primeira subida: `kernel.json` e `Features.plain.xml` (SSH na VPS)

Leve para a VPS a pasta `server/deploy` do commit aprovado (DEPLOY.md seção 5, `git archive`): o `ssamctl.sh` precisa de
`kernel-pair-check.mjs` e `release-record.json` ao lado da pasta `coolify`. Tudo abaixo roda de `deploy/coolify`, com
`docker` (sem compose e sem `.env`): o script acha o container `ssam-server` que o Coolify criou pelo rótulo
`com.docker.compose.service` e usa a imagem e os volumes dele.

```bash
cd /opt/ssam/deploy/coolify
sh ssamctl.sh status                                      # imagem, digest, estado, os 4 volumes
sh ssamctl.sh kernel print released > /tmp/kernel.json    # o kernel.json da imagem no ar, do registro (nunca digitado)
cat /tmp/kernel.json
sh ssamctl.sh kernel check /tmp/kernel.json; echo "exit $?"   # a conferência do par dentro da imagem: só siga com 0
sh ssamctl.sh kernel write /tmp/kernel.json               # grava e esvazia os caches de versão
rm /tmp/kernel.json
```

Depois, no Coolify, **Restart** no `ssam-server` (o servidor lê o `kernel.json` ao subir): o log passa a mostrar
`kernel` com as versões e `kernel-cache-reset`. O `Features.plain.xml` sai da máquina Windows como no DEPLOY.md 7.2 e
entra com:

```bash
sh ssamctl.sh features put /tmp/Features.plain.xml && rm /tmp/Features.plain.xml
```

Conferências: `curl -fsS https://<domínio>/health` (`{"ok":true,...}`), `curl -s -o /dev/null -w '%{http_code}\n'
https://<domínio>/mcp` (401 sem token) e `curl -s -o /dev/null -w '%{http_code}\n' https://<domínio>/` (404 do Traefik:
o caminho não é roteado).

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

A regra é a da seção 8 do DEPLOY.md (anuncie a janela: recriar o container corta as chamadas em curso). O que muda:

1. `sh ssamctl.sh backup` (seção 8) antes: os volumes e o dump do banco.
2. Na máquina do dono: construa e ensaie a imagem nova (DEPLOY.md 6 e 12) e publique com `publish.sh --latest`
   (seção 1).
3. No Coolify, **Redeploy** (com `SSAM_IMAGE_TAG=latest` não há variável a trocar; com uma tag fixa, troque-a antes).
   Depois, `ssamctl.sh status` mostra o digest da imagem puxada: compare com o que o `publish.sh` imprimiu. O compose
   tem `pull_policy: always` no `ssam-server` e no `ssam-console`: cada `up` do Coolify busca a tag no registro (sem
   isso o Coolify reaproveitava a `latest` que já estava na VPS, visto em 2026-10-20). Se mesmo assim o digest
   continuar o antigo, `sh ssamctl.sh pull` e Redeploy de novo. O
   Traefik responde 502 enquanto o container novo não atende (não há "espere pelo servidor" como no Caddy; são uns
   segundos).
4. Se a versão de um Studio ou da bridge mudou (o `release-record.json` do commit novo diz), a ordem é a do DEPLOY.md 8,
   passo 6: confira o par com a imagem nova (`kernel print`/`check` só funcionam depois do deploy, porque rodam na
   imagem do container), **Stop** no Coolify, `kernel write`, `features put`, **Start**.
5. Rollback: na máquina do dono, `sh deploy/publish.sh --image ... --tag <tag anterior> --private-repo-ready
   --latest-only` (a `latest` volta a apontar para a imagem anterior; o `.info` do backup guarda a imagem e o id) e
   Redeploy; ou ponha a tag fixa anterior em `SSAM_IMAGE_TAG` e Redeploy. Depois `kernel print previous` (ou a tag),
   `check`, Stop, `kernel write`, Start, como no DEPLOY.md 8. As imagens anteriores continuam no registro com as tags
   fixas: não apague tags.

## 8. Backup, restore e log

```bash
sudo install -d -o root -m 0700 /var/backups/ssam-server
sh ssamctl.sh backup                     # tar.gz de server, friction e odc-features (+ .sha256 e .info) E o dump do banco
                                         # (ssam-tokens-<data>.sql.gz + .sha256), com o servidor no ar
sh ssamctl.sh backup /outra/pasta
sh ssamctl.sh restore /var/backups/ssam-server/ssam-state-<data>.tar.gz [/var/backups/ssam-server/ssam-tokens-<data>.sql.gz]
                                         # só com o ssam-server PARADO no Coolify (Stop; o banco fica no ar); depois Start
sh ssamctl.sh logs 100                   # as últimas linhas do server.log
sh ssamctl.sh ops sh -c 'du -sh /data/*' # qualquer comando na imagem sobre os volumes, sem rede, como uid 10001
```

O `backup.sh` e o `restore.sh` da pasta de cima dependem do `compose.prod.yml` e não servem aqui. Para uma cópia fora da
VPS e um heartbeat, use o cron da VPS sobre o `ssamctl.sh backup` (o arquivo tem dados de clientes e hashes de tokens:
cifre antes de copiar para fora).

O dump é SQL puro (`pg_dump --no-owner`, num container avulso da imagem `postgres`), carregado de volta com `psql` contra
a mesma URL; o restore do dump apaga a tabela e a recria do arquivo. Os dois arquivos têm dados de clientes e hashes de tokens: cifre antes de
copiar para fora.

## 9. O que é diferente de Caddy para Traefik

| Caddyfile | Aqui | Observação |
| --- | --- | --- |
| sem buffer (`flush_interval -1`) | padrão do Traefik | nenhum middleware de buffering é usado |
| timeouts de 65 min | `responseHeaderTimeout 0` e `writeTimeout 0` (padrão) | sem limite de resposta; o `readTimeout` do entrypoint (60 s no Traefik v3) só limita a leitura do pedido |
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
(`publish.sh --latest` e **Redeploy**; seção 7). O painel importa o módulo de tokens da mesma imagem
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
