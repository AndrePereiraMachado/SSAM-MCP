#!/bin/sh
# SSAM owner console ("Painel do dono") - host install. Owned by the SSAM-MCP monorepo (server/deploy/host); runbook in
# DEPLOY.md section 15. As root, from the deploy folder (/opt/ssam/deploy):
#
#   sh host/install.sh [--port 7320] [--with-crons] [--dry-run]
#
# Idempotent: run it again after a new `git archive` to update collect.py and the units. It
#   - checks root, python3 >= 3.10, docker, systemd, systemd-socket-proxyd, the proxy account, the port free on
#     127.0.0.1 and the project's containers (nothing is changed when a check fails);
#   - makes sure uid and gid 10001 exist on the host: ssam-console-proxy.service runs as User=10001 Group=10001 and
#     systemd refuses an id the host does not know (status 217/USER). An existing uid or gid 10001 is used under any
#     name; a missing one is created as the system group and user ssam-console (no home, nologin, password locked).
#     Lookups go through getent (NSS: LDAP, sssd and userdb count too). The name ssam-console already taken by another
#     id, when that id has to be created, fails the checks. No other account is ever changed;
#   - creates /var/lib/ssam-console/{host,collector,state,sock} with their owners and modes (the console runs as 10001);
#   - copies collect.py to /usr/local/lib/ssam-console (a root-run script never changes silently with an archive) and
#     collector.conf.example to /etc/ssam-console/collector.conf only when that file is absent;
#   - installs the four systemd units (the port written into the proxy units), daemon-reload, enables the collector
#     timer and the proxy socket, runs the collector once and checks host.json; curls /healthz when the console runs;
#   - with --with-crons: /etc/cron.d/ssam-backup (daily online backup) and /etc/cron.d/ssam-rotate (weekly log
#     rotation) when absent (an existing different file is kept and shown as a diff), BACKUP_DIR 0700 and cron.log 0600
#     when missing.
# It never edits .env, never restarts ssam-server or caddy and never starts the console container.
# --dry-run runs the read-only checks, prints every change and changes nothing. SSAM_CONSOLE_ROOT=<absolute dir>
# prefixes every host path written (tests).
set -eu

usage() {
    echo "uso: sh host/install.sh [--port 7320] [--with-crons] [--dry-run]   (root, na pasta deploy; DEPLOY.md secao 15)" >&2
    exit "${1:-2}"
}

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
deploy=$(dirname -- "$here")
R=${SSAM_CONSOLE_ROOT:-}
case "$R" in ''|/*) ;; *) echo "install: SSAM_CONSOLE_ROOT tem de ser um caminho absoluto" >&2; exit 2 ;; esac

PORT=7320
WITH_CRONS=0
DRY=0
while [ $# -gt 0 ]; do
    case "$1" in
        --port) [ $# -ge 2 ] || usage; PORT=$2; shift 2 ;;
        --port=*) PORT=${1#--port=}; shift ;;
        --with-crons) WITH_CRONS=1; shift ;;
        --dry-run) DRY=1; shift ;;
        -h|--help) usage 0 ;;
        *) echo "install: argumento desconhecido: $1" >&2; usage ;;
    esac
done
case "$PORT" in ''|*[!0-9]*) echo "install: --port precisa ser um numero" >&2; exit 2 ;; esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then echo "install: --port fora de 1024..65535" >&2; exit 2; fi

CONSOLE_UID=10001
# The account of the proxy unit: User=10001 Group=10001 in ssam-console-proxy.service (CONSOLE_GID of collector.conf is
# only the group of host.json and of the host folders).
ACCOUNT=ssam-console
ACCOUNT_GID=10001
CONSOLE_DIR=/var/lib/ssam-console
LIB_DIR=/usr/local/lib/ssam-console
CONF_DIR=/etc/ssam-console
UNIT_DIR=/etc/systemd/system
CRON_DIR=/etc/cron.d
PYTHON=/usr/bin/python3
PROXYD=/usr/lib/systemd/systemd-socket-proxyd
UNITS="ssam-console-collect.service ssam-console-collect.timer ssam-console-proxy.socket ssam-console-proxy.service"

# Settings shared with the collector: the installed collector.conf, else the example (never the deploy .env).
confval() {
    f="$R$CONF_DIR/collector.conf"
    [ -f "$f" ] || f="$here/collector.conf.example"
    sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$f" | tail -n 1 | sed 's/[[:space:]]*$//; s/^"\(.*\)"$/\1/'
}
PROJECT=$(confval COMPOSE_PROJECT); PROJECT=${PROJECT:-ssam-prod}
SERVER_SERVICE=$(confval SERVER_SERVICE); SERVER_SERVICE=${SERVER_SERVICE:-ssam-server}
CONSOLE_SERVICE=$(confval CONSOLE_SERVICE); CONSOLE_SERVICE=${CONSOLE_SERVICE:-ssam-console}
CONSOLE_GID=$(confval CONSOLE_GID); CONSOLE_GID=${CONSOLE_GID:-10001}
BACKUP_DIR=${BACKUP_DIR:-$(confval BACKUP_DIR)}; BACKUP_DIR=${BACKUP_DIR:-/var/backups/ssam-server}
case "$PROJECT$SERVER_SERVICE$CONSOLE_SERVICE" in *[!A-Za-z0-9_.-]*) echo "install: nome de projeto ou servico invalido no collector.conf" >&2; exit 2 ;; esac
case "$CONSOLE_GID" in ''|*[!0-9]*) echo "install: CONSOLE_GID invalido no collector.conf" >&2; exit 2 ;; esac
case "$BACKUP_DIR" in /*) ;; *) echo "install: BACKUP_DIR tem de ser absoluto: $BACKUP_DIR" >&2; exit 2 ;; esac
case "$BACKUP_DIR" in *[!A-Za-z0-9._/-]*|*..*) echo "install: BACKUP_DIR com caracteres nao aceitos: $BACKUP_DIR" >&2; exit 2 ;; esac

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
# run CMD...: prints it and runs it (stops the script when it fails); with --dry-run only prints it.
run() {
    if [ "$DRY" = 1 ]; then say "  (dry-run) $*"; else say "  + $*"; "$@"; fi
}
# run_ok CMD...: the same, a failure is reported and ignored.
run_ok() {
    if [ "$DRY" = 1 ]; then say "  (dry-run) $*"; else say "  + $*"; "$@" || say "    (falhou; seguindo)"; fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

MODE=""
[ "$DRY" = 1 ] && MODE=" | DRY-RUN (nada sera alterado)"
say "SSAM - painel do dono: instalacao no host (DEPLOY.md secao 15)"
say "pasta deploy: $deploy | projeto: $PROJECT | porta: 127.0.0.1:$PORT${R:+ | raiz: $R}$MODE"

# ---------------------------------------------------------------------------------------------------------- checks
step "Verificacoes"
FAILED=0
check() {
    desc=$1; shift
    if "$@" >/dev/null 2>&1; then say "  ok     $desc"; else say "  FALHA  $desc"; FAILED=$((FAILED + 1)); fi
}
is_root() { [ "$(id -u)" = 0 ]; }
python_ok() { [ -x "$PYTHON" ] && "$PYTHON" -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; }
docker_ok() { command -v docker && docker version --format '{{.Server.Version}}'; }
systemd_ok() { [ -d /run/systemd/system ] && command -v systemctl; }
proxyd_ok() { [ -x "$PROXYD" ]; }
port_free() {
    # Our own socket unit already listening on that port is a re-install, not a conflict.
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet ssam-console-proxy.socket \
        && grep -qx "ListenStream=127.0.0.1:$PORT" "$R$UNIT_DIR/ssam-console-proxy.socket"; then
        return 0
    fi
    command -v ss >/dev/null 2>&1 || return 1
    [ -z "$(ss -Hltn "sport = :$PORT")" ]
}
containers_ok() {
    [ -n "$(docker ps -a -q --filter "label=com.docker.compose.project=$PROJECT" \
        --filter "label=com.docker.compose.service=$SERVER_SERVICE")" ]
}
# dbent DB KEY FIELD: one field of the getent entry (a number is looked up as an id, a name as a name); empty if none.
dbent() { getent "$1" "$2" 2>/dev/null | head -n 1 | cut -d: -f"$3"; }
GROUP_NAME=$(dbent group "$ACCOUNT_GID" 1)   # the group that has gid 10001, under any name
USER_NAME=$(dbent passwd "$CONSOLE_UID" 1)   # the user that has uid 10001, under any name
GROUP_TAKEN=""
USER_TAKEN=""
[ -n "$GROUP_NAME" ] || GROUP_TAKEN=$(dbent group "$ACCOUNT" 3)   # gid of a group already named ssam-console
[ -n "$USER_NAME" ] || USER_TAKEN=$(dbent passwd "$ACCOUNT" 3)    # uid of a user already named ssam-console
account_problems() {
    if ! command -v getent >/dev/null 2>&1; then echo "getent nao encontrado (pacote libc-bin)"; return; fi
    [ -z "$GROUP_TAKEN" ] || echo "o grupo $ACCOUNT ja existe com o gid $GROUP_TAKEN (o proxy roda com o gid $ACCOUNT_GID)"
    [ -z "$USER_TAKEN" ] || echo "o usuario $ACCOUNT ja existe com o uid $USER_TAKEN (o proxy roda com o uid $CONSOLE_UID)"
    [ -n "$GROUP_NAME" ] || command -v groupadd >/dev/null 2>&1 || echo "groupadd nao encontrado (pacote passwd)"
    [ -n "$USER_NAME" ] || command -v useradd >/dev/null 2>&1 || echo "useradd nao encontrado (pacote passwd)"
}
ACCOUNT_PROBLEMS=$(account_problems)
account_ok() { [ -z "$ACCOUNT_PROBLEMS" ]; }
check "root" is_root
check "python3 >= 3.10 em $PYTHON" python_ok
check "docker (cliente e daemon)" docker_ok
check "systemd" systemd_ok
check "systemd-socket-proxyd em $PROXYD" proxyd_ok
check "uid $CONSOLE_UID e gid $ACCOUNT_GID do ssam-console-proxy (existem ou podem ser criados)" account_ok
if [ -n "$ACCOUNT_PROBLEMS" ]; then
    printf '%s\n' "$ACCOUNT_PROBLEMS" | sed 's/^/         - /'
    say "         o install.sh nunca muda outro usuario ou grupo: resolva a mao (DEPLOY.md secao 15.10)"
fi
check "porta 127.0.0.1:$PORT livre (ou ja do ssam-console-proxy.socket)" port_free
check "containers do projeto $PROJECT ($SERVER_SERVICE)" containers_ok
[ -f "$deploy/console/server.mjs" ] || say "  aviso  $deploy/console/server.mjs nao existe: o container ssam-console nao vai subir com esta pasta deploy"
if [ "$FAILED" -gt 0 ]; then
    if [ "$DRY" = 1 ]; then
        say "  ($FAILED verificacao(oes) falharam; no dry-run a lista de mudancas segue mesmo assim)"
    else
        say ""
        say "install: $FAILED verificacao(oes) falharam; nada foi alterado."
        exit 1
    fi
fi

# --------------------------------------------------------------------------------------------------- proxy account
step "Conta do proxy (User=$CONSOLE_UID e Group=$ACCOUNT_GID do ssam-console-proxy.service)"
ACCOUNT_CREATED=0
if [ -n "$GROUP_NAME" ]; then
    say "  existe  grupo $GROUP_NAME (gid $ACCOUNT_GID)"
elif [ -n "$GROUP_TAKEN" ]; then
    say "  FALHA   grupo $ACCOUNT ja existe com o gid $GROUP_TAKEN: nada criado"
else
    run groupadd -r -g "$ACCOUNT_GID" "$ACCOUNT"
    ACCOUNT_CREATED=1
fi
if [ -n "$USER_NAME" ]; then
    say "  existe  usuario $USER_NAME (uid $CONSOLE_UID)"
elif [ -n "$USER_TAKEN" ]; then
    say "  FALHA   usuario $ACCOUNT ja existe com o uid $USER_TAKEN: nada criado"
else
    # System user without home or login shell; useradd leaves the password locked ("!"). It warns that 10001 is above
    # SYS_UID_MAX: expected, the id is the one of the units and of the image.
    run useradd -r -u "$CONSOLE_UID" -g "$ACCOUNT_GID" -M -d /nonexistent -s /usr/sbin/nologin -c ssam-console-proxy "$ACCOUNT"
    ACCOUNT_CREATED=1
fi
if [ "$ACCOUNT_CREATED" = 1 ] && [ "$DRY" != 1 ]; then
    if [ -z "$(dbent passwd "$CONSOLE_UID" 1)" ] || [ -z "$(dbent group "$ACCOUNT_GID" 1)" ]; then
        say "install: o uid $CONSOLE_UID ou o gid $ACCOUNT_GID ainda nao aparece no getent; veja getent passwd $CONSOLE_UID"
        exit 1
    fi
    say "  ok     getent passwd $CONSOLE_UID -> $(getent passwd "$CONSOLE_UID")"
fi

# ----------------------------------------------------------------------------------------------------- directories
step "Pastas"
run install -d -o root -g root -m 0755 "$R$CONSOLE_DIR"
run install -d -o root -g "$CONSOLE_GID" -m 0750 "$R$CONSOLE_DIR/host"
run install -d -o root -g root -m 0700 "$R$CONSOLE_DIR/collector"
run install -d -o "$CONSOLE_UID" -g "$CONSOLE_GID" -m 0700 "$R$CONSOLE_DIR/state"
run install -d -o "$CONSOLE_UID" -g "$CONSOLE_GID" -m 0750 "$R$CONSOLE_DIR/sock"

# ------------------------------------------------------------------------------------------------ collector and conf
step "Coletor"
run install -d -o root -g root -m 0755 "$R$LIB_DIR"
if [ -f "$R$LIB_DIR/collect.py" ] && cmp -s "$here/collect.py" "$R$LIB_DIR/collect.py"; then
    say "  igual   $R$LIB_DIR/collect.py"
else
    run install -o root -g root -m 0755 "$here/collect.py" "$R$LIB_DIR/collect.py"
fi
run install -d -o root -g root -m 0755 "$R$CONF_DIR"
if [ -e "$R$CONF_DIR/collector.conf" ]; then
    say "  mantido $R$CONF_DIR/collector.conf (um re-install nunca o sobrescreve)"
else
    run install -o root -g root -m 0644 "$here/collector.conf.example" "$R$CONF_DIR/collector.conf"
fi

# ----------------------------------------------------------------------------------------------------------- units
step "Unidades do systemd"
PROXY_CHANGED=0
for u in $UNITS; do
    case "$u" in
        ssam-console-proxy.*) sed "s/127\.0\.0\.1:7320/127.0.0.1:$PORT/g" "$here/$u" > "$tmp/$u" ;;
        *) cp "$here/$u" "$tmp/$u" ;;
    esac
    if [ -f "$R$UNIT_DIR/$u" ] && cmp -s "$tmp/$u" "$R$UNIT_DIR/$u"; then
        say "  igual   $R$UNIT_DIR/$u"
    else
        run install -o root -g root -m 0644 "$tmp/$u" "$R$UNIT_DIR/$u"
        case "$u" in ssam-console-proxy.*) PROXY_CHANGED=1 ;; esac
    fi
done
run systemctl daemon-reload
if [ "$PROXY_CHANGED" = 1 ] || [ "$ACCOUNT_CREATED" = 1 ]; then
    # A new port, new proxy settings or a new account take effect only on a fresh socket (no-op on a first install).
    run_ok systemctl stop ssam-console-proxy.service ssam-console-proxy.socket
fi
if [ "$ACCOUNT_CREATED" = 1 ]; then
    # A proxy that failed before the account existed (status 217/USER) stays failed until this (DEPLOY.md 15.10).
    run_ok systemctl reset-failed ssam-console-proxy.service ssam-console-proxy.socket
fi
run systemctl enable --now ssam-console-collect.timer ssam-console-proxy.socket

# ------------------------------------------------------------------------------------------------- first collector run
step "Primeira coleta"
HOST_JSON="$CONSOLE_DIR/host/host.json"
if [ "$DRY" = 1 ]; then
    say "  (dry-run) systemctl start ssam-console-collect.service"
    say "  (dry-run) $PYTHON -I - $R$HOST_JSON   (confere o schema ssam-console-host/1)"
else
    say "  + systemctl start ssam-console-collect.service"
    if ! systemctl start ssam-console-collect.service; then
        say "install: o coletor falhou; veja: journalctl -u ssam-console-collect -n 30 --no-pager"
        exit 1
    fi
    n=0
    while [ ! -s "$R$HOST_JSON" ] && [ "$n" -lt 10 ]; do sleep 1; n=$((n + 1)); done
    if ! "$PYTHON" -I - "$R$HOST_JSON" <<'PYEOF'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as handle:
    doc = json.load(handle)
if doc.get('schema') != 'ssam-console-host/1':
    print('  host.json com schema inesperado: %r' % doc.get('schema'))
    sys.exit(1)
failed = [name for name, value in doc.items() if isinstance(value, dict) and value.get('ok') is False]
errors = (doc.get('collector') or {}).get('errors') or []
print('  ok     host.json %s em %s ms; secoes com erro: %s'
      % (doc.get('collectedAt'), (doc.get('collector') or {}).get('durationMs'), ', '.join(failed) or 'nenhuma'))
for line in errors[:20]:
    print('         - %s' % line)
PYEOF
    then
        say "install: host.json ausente ou invalido em $R$HOST_JSON; veja: journalctl -u ssam-console-collect -n 30 --no-pager"
        exit 1
    fi
fi

# ----------------------------------------------------------------------------------------------------------- crons
if [ "$WITH_CRONS" = 1 ]; then
    step "Crons (backup diario e rotacao semanal)"
    case "$deploy" in
        *[!A-Za-z0-9._/-]*) say "install: a pasta deploy tem caracteres que uma linha de cron nao aceita: $deploy"; exit 1 ;;
    esac
    if [ ! -d "$R$CRON_DIR" ]; then
        say "install: $R$CRON_DIR nao existe (o cron esta instalado? apt-get install -y cron)"
        [ "$DRY" = 1 ] || exit 1
    fi
    if [ -d "$R$BACKUP_DIR" ]; then
        say "  existe  $R$BACKUP_DIR"
    else
        run install -d -o root -g root -m 0700 "$R$BACKUP_DIR"
    fi
    if [ -e "$R$BACKUP_DIR/cron.log" ]; then
        say "  existe  $R$BACKUP_DIR/cron.log"
    else
        run install -o root -g root -m 0600 /dev/null "$R$BACKUP_DIR/cron.log"
    fi
    cron_file() {
        f="$R$CRON_DIR/$1"
        printf '# %s\n%s\n' "$2" "$3" > "$tmp/$1"
        if [ ! -e "$f" ]; then
            run install -o root -g root -m 0644 "$tmp/$1" "$f"
            say "          $3"
        elif cmp -s "$tmp/$1" "$f"; then
            say "  igual   $f"
        else
            say "  DIFERENTE $f: mantido como esta. O que este script gravaria (diff -u atual novo):"
            diff -u "$f" "$tmp/$1" | sed 's/^/    /' || true
        fi
    }
    cron_file ssam-backup "SSAM: daily online backup of the state volumes (DEPLOY.md sections 9 and 15; host/install.sh --with-crons)" \
        "30 3 * * * root cd $deploy && sh backup.sh --online >> $BACKUP_DIR/cron.log 2>&1"
    cron_file ssam-rotate "SSAM: weekly rotation of server.log and audit retention (DEPLOY.md sections 10 and 15; host/install.sh --with-crons)" \
        "15 4 * * 0 root cd $deploy && sh rotate-logs.sh >> $BACKUP_DIR/cron.log 2>&1"
fi

# ---------------------------------------------------------------------------------------------------------- console
step "Painel"
HEALTH_FAILED=0
cid=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$CONSOLE_SERVICE" --filter status=running 2>/dev/null || true)
if [ -z "$cid" ]; then
    say "  o container $CONSOLE_SERVICE nao esta rodando (normal na primeira instalacao: veja os proximos passos)"
elif [ "$DRY" = 1 ]; then
    say "  (dry-run) curl -fsS --max-time 5 http://127.0.0.1:$PORT/healthz"
elif out=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz" 2>&1); then
    say "  ok     http://127.0.0.1:$PORT/healthz -> $out"
else
    HEALTH_FAILED=1
    say "  FALHA  http://127.0.0.1:$PORT/healthz: $out"
    say "         confira: ls -l $CONSOLE_DIR/sock; docker compose -f compose.prod.yml logs --tail 30 $CONSOLE_SERVICE;"
    say "         journalctl -u ssam-console-proxy -n 30 --no-pager. Se o systemd recusar PrivateNetwork= ou"
    say "         RestrictAddressFamilies= com o socket herdado, tire essas duas linhas de"
    say "         $UNIT_DIR/ssam-console-proxy.service e rode systemctl daemon-reload (DEPLOY.md secao 15)."
fi

step "Proximos passos (DEPLOY.md secao 15)"
say "  1. Backup feito a mao uma vez:  sh backup.sh --online; echo \"exit \$?\"   (tem de dar exit 0)"
say "  2. No .env desta pasta:         COMPOSE_PROFILES=console"
say "  3. Subir o painel:              docker compose -f compose.prod.yml up -d $CONSOLE_SERVICE"
say "  4. Conferir:                    curl -fsS http://127.0.0.1:$PORT/healthz"
say "  5. No PC do dono:               powershell -ExecutionPolicy Bypass -File <SSAM-MCP>\\server\\deploy\\console\\painel-ssam.ps1"
if [ "$DRY" = 1 ]; then
    say ""
    say "dry-run: nada foi alterado ($FAILED verificacao(oes) falharam)."
fi
exit "$HEALTH_FAILED"
