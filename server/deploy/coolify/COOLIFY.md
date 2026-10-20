# SSAM hospedado numa VPS com Coolify (runbook)

O mesmo servidor do `compose.prod.yml` (DEPLOY.md), sem o Caddy: o Coolify já instala o Traefik como proxy da VPS, e a
parte do proxy que o Caddyfile fazia está escrita nos rótulos (labels) do `compose.coolify.yml` desta pasta, mais um
arquivo de configuração dinâmica do Traefik (`traefik-ssam.yaml`). A imagem vem de um registro PRIVADO, publicada pela
máquina do dono com `../publish.sh`, fixada por tag e digest. Tudo o que o DEPLOY.md diz sobre o servidor em si continua
valendo: `kernel.json` (7.1), `Features.plain.xml` (7.2), tokens (7.4), upgrade e rollback (8), limites e cuidados (14).
Só muda COMO os arquivos chegam aos volumes e como o container sobe: pelo Coolify e pelo `ssamctl.sh`.

Arquivos desta pasta:

| Arquivo | Para quê |
| --- | --- |
| `compose.coolify.yml` | o compose que o Coolify roda: `ssam-server` com os rótulos do Traefik; `ssam-admin` e `ssam-ops` só por perfil (nunca sobem com o Coolify) |
| `traefik-ssam.yaml` | configuração dinâmica do Traefik do Coolify: o transporte `ssam@file` (keep-alive de 4 s, sem limite de resposta) |
| `ssamctl.sh` | as operações à mão na VPS, só com `docker`: tokens, `kernel.json`, `Features.plain.xml`, backup, restore, log |
| `.env.coolify.example` | a lista das variáveis (no Coolify, as Environment Variables do recurso) |
| `rehearsal.override.yml` | só para o ensaio local (seção 10): publica 7310 em 127.0.0.1:27310 |
| `../publish.sh` | na máquina do dono: empurra uma imagem já construída e provada para o registro privado e mostra a linha com o digest |

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
   sh deploy/publish.sh --image docker.io/<namespace>/ssam-server --tag prod-20261020-7770621
   ```

   Ele marca `ssam-server:<tag>` como `<image>:<tag>`, empurra, lê o digest de volta e imprime as duas linhas para o
   Coolify (`SSAM_IMAGE` e `SSAM_IMAGE_TAG=<tag>@sha256:<digest>`). No Docker Hub ele ainda confere, sem login, que o
   repositório NÃO é lido por qualquer um: se for público, avisa e sai com código 3 (torne-o privado na hora ou apague a
   tag). Uma imagem construída com a árvore suja (`-dirty`) é recusada.

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
   com a lista de `.env.coolify.example`: `SSAM_IMAGE` e `SSAM_IMAGE_TAG` (as duas linhas do `publish.sh`, com o digest),
   `SSAM_DOMAIN` (o DNS da VPS, sem `https://`), `SSAM_CPUS`, `SSAM_MEMORY`, `SSAM_BUILD_WORKERS` e o resto pelo tamanho
   da VPS (DEPLOY.md seção 5).
3. **Advanced > Docker Compose > Connect to predefined network**: ligado. O Traefik do Coolify só alcança containers na
   rede dele; sem isso o roteador fica sem destino.
4. **Não** ponha domínio no serviço `ssam-server` na interface do Coolify. Os rótulos do compose já são o roteador inteiro
   (`Host(SSAM_DOMAIN)` só em `/mcp`, `/health`, `/agent` e `/agent/*`, TLS pelo resolvedor `letsencrypt`, cabeçalhos de
   segurança, redirecionamento de http para https). Um domínio na interface faria o Coolify gerar um segundo roteador
   para o mesmo container, sem o filtro de caminhos nem o transporte.
5. DNS: o registro A (e AAAA) de `SSAM_DOMAIN` apontando para a VPS antes do deploy, senão o Let's Encrypt falha.
6. **Deploy**. O Coolify puxa a imagem (seção 2), cria os volumes `server-state`, `friction`, `odc-features` e `cache`
   (com o prefixo do recurso) e sobe só o `ssam-server`: `ssam-admin` e `ssam-ops` têm `profiles` e nunca sobem
   sozinhos. O container fica `healthy` em uns 10 s e ainda aquece 1 a 2 minutos (DEPLOY.md 7.3).

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

## 6. Tokens de cliente

```bash
sh ssamctl.sh token issue --customer "Nome do cliente" --days 30 --lanes odc,o11
sh ssamctl.sh token list
sh ssamctl.sh token revoke --id tok_...
sh ssamctl.sh token agent-rotate --id tok_...
```

O `issue` e o `agent-rotate` mostram o token (`ssam_...`) e a credencial do agente (`ssam_agent_...`) **uma vez só**, no
seu terminal; o container roda sem driver de log, para o Docker não guardar cópia. O volume guarda só o SHA-256. O resto é
como no DEPLOY.md 7.4 e 7.5.

## 7. Upgrade e rollback

A regra é a da seção 8 do DEPLOY.md (anuncie a janela: recriar o container corta as chamadas em curso). O que muda:

1. `sh ssamctl.sh backup` (seção 8) antes.
2. Na máquina do dono: construa e ensaie a imagem nova (DEPLOY.md 6 e 12) e publique com `publish.sh` (seção 1).
3. No Coolify, troque `SSAM_IMAGE_TAG` pela linha nova (com o digest) e **Redeploy**. O Traefik responde 502 enquanto
   o container novo não atende (não há "espere pelo servidor" como no Caddy; são uns segundos).
4. Se a versão de um Studio ou da bridge mudou (o `release-record.json` do commit novo diz), a ordem é a do DEPLOY.md 8,
   passo 6: confira o par com a imagem nova (`kernel print`/`check` só funcionam depois do deploy, porque rodam na
   imagem do container), **Stop** no Coolify, `kernel write`, `features put`, **Start**.
5. Rollback: volte `SSAM_IMAGE_TAG` para a linha anterior (o `.info` do backup guarda a imagem e o digest) e Redeploy;
   depois `kernel print previous` (ou a tag), `check`, Stop, `kernel write`, Start, como no DEPLOY.md 8. A imagem anterior
   continua no registro: não apague tags.

## 8. Backup, restore e log

```bash
sudo install -d -o root -m 0700 /var/backups/ssam-server
sh ssamctl.sh backup                     # tar.gz de server, friction e odc-features (+ .sha256 e .info), com o servidor no ar
sh ssamctl.sh backup /outra/pasta
sh ssamctl.sh restore /var/backups/ssam-server/ssam-state-<data>.tar.gz   # só com o servidor PARADO no Coolify (Stop); depois Start
sh ssamctl.sh logs 100                   # as últimas linhas do server.log
sh ssamctl.sh ops sh -c 'du -sh /data/*' # qualquer comando na imagem sobre os volumes, sem rede, como uid 10001
```

O `backup.sh` e o `restore.sh` da pasta de cima dependem do `compose.prod.yml` e não servem aqui. Para uma cópia fora da
VPS e um heartbeat, use o cron da VPS sobre o `ssamctl.sh backup` (o arquivo tem dados de clientes e hashes de tokens:
cifre antes de copiar para fora).

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
cp .env.coolify.example /tmp/ssam-rehearsal.env     # SSAM_IMAGE=ssam-server, SSAM_IMAGE_TAG=<tag local>, SSAM_DOMAIN=ssam.rehearsal.test
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
