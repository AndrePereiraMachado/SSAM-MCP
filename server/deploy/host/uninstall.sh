#!/bin/sh
# SSAM owner console ("Painel do dono") - host uninstall. Owned by the SSAM-MCP monorepo (server/deploy/host); runbook
# in DEPLOY.md section 15. As root, from the deploy folder:
#
#   sh host/uninstall.sh [--purge] [--crons] [--dry-run]
#
# Stops and disables the collector timer and the proxy socket, removes the four units and /usr/local/lib/ssam-console.
#   --purge  also removes /var/lib/ssam-console (host.json, the console's access key, checkpoint and aggregates) and
#            /etc/ssam-console; refused while the ssam-console container runs (remove it first, DEPLOY.md 15). The
#            license history (console-audit.jsonl) lives in the state volume and stays.
#   --crons  also removes /etc/cron.d/ssam-backup and /etc/cron.d/ssam-rotate (the daily backup and the weekly rotation
#            stop: schedule them again some other way).
# Never touches .env, the backups, the Docker volumes, ssam-server or caddy. --dry-run prints and changes nothing.
# SSAM_CONSOLE_ROOT=<absolute dir> prefixes every host path (tests).
set -eu

usage() {
    echo "uso: sh host/uninstall.sh [--purge] [--crons] [--dry-run]   (root; DEPLOY.md secao 15)" >&2
    exit "${1:-2}"
}

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
R=${SSAM_CONSOLE_ROOT:-}
case "$R" in ''|/*) ;; *) echo "uninstall: SSAM_CONSOLE_ROOT tem de ser um caminho absoluto" >&2; exit 2 ;; esac

PURGE=0
CRONS=0
DRY=0
while [ $# -gt 0 ]; do
    case "$1" in
        --purge) PURGE=1; shift ;;
        --crons) CRONS=1; shift ;;
        --dry-run) DRY=1; shift ;;
        -h|--help) usage 0 ;;
        *) echo "uninstall: argumento desconhecido: $1" >&2; usage ;;
    esac
done

CONSOLE_DIR=/var/lib/ssam-console
LIB_DIR=/usr/local/lib/ssam-console
CONF_DIR=/etc/ssam-console
UNIT_DIR=/etc/systemd/system
CRON_DIR=/etc/cron.d
UNITS="ssam-console-collect.timer ssam-console-collect.service ssam-console-proxy.socket ssam-console-proxy.service"

confval() {
    f="$R$CONF_DIR/collector.conf"
    [ -f "$f" ] || f="$here/collector.conf.example"
    sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$f" | tail -n 1 | sed 's/[[:space:]]*$//; s/^"\(.*\)"$/\1/'
}
PROJECT=$(confval COMPOSE_PROJECT); PROJECT=${PROJECT:-ssam-prod}
CONSOLE_SERVICE=$(confval CONSOLE_SERVICE); CONSOLE_SERVICE=${CONSOLE_SERVICE:-ssam-console}

say() { printf '%s\n' "$*"; }
run() {
    if [ "$DRY" = 1 ]; then say "  (dry-run) $*"; else say "  + $*"; "$@"; fi
}
run_ok() {
    if [ "$DRY" = 1 ]; then say "  (dry-run) $*"; else say "  + $*"; "$@" >/dev/null 2>&1 || say "    (nada a fazer ou falhou; seguindo)"; fi
}

say "SSAM - painel do dono: remocao do host (DEPLOY.md secao 15)$( [ "$DRY" = 1 ] && echo ' | DRY-RUN (nada sera alterado)' || true)"
if [ "$DRY" != 1 ] && [ "$(id -u)" != 0 ]; then
    say "uninstall: rode como root."
    exit 1
fi

running=""
if command -v docker >/dev/null 2>&1; then
    running=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
        --filter "label=com.docker.compose.service=$CONSOLE_SERVICE" --filter status=running 2>/dev/null || true)
fi
if [ "$PURGE" = 1 ] && [ -n "$running" ]; then
    say "uninstall: o container $CONSOLE_SERVICE esta rodando e usa $CONSOLE_DIR. Primeiro tire COMPOSE_PROFILES=console do"
    say "           .env e rode: docker compose -f compose.prod.yml rm -sf $CONSOLE_SERVICE"
    [ "$DRY" = 1 ] || exit 1
fi

say ""
say "== Unidades do systemd"
run_ok systemctl disable --now ssam-console-collect.timer ssam-console-proxy.socket
run_ok systemctl stop ssam-console-collect.service ssam-console-proxy.service
for u in $UNITS; do
    if [ -e "$R$UNIT_DIR/$u" ]; then run rm -f "$R$UNIT_DIR/$u"; fi
done
run_ok systemctl daemon-reload
run_ok systemctl reset-failed $UNITS

say ""
say "== Arquivos"
if [ -e "$R$LIB_DIR" ]; then run rm -rf "$R$LIB_DIR"; fi
if [ "$PURGE" = 1 ]; then
    if [ -e "$R$CONSOLE_DIR" ]; then run rm -rf "$R$CONSOLE_DIR"; fi
    if [ -e "$R$CONF_DIR" ]; then run rm -rf "$R$CONF_DIR"; fi
else
    say "  mantidos $R$CONSOLE_DIR e $R$CONF_DIR (--purge apaga)"
fi
if [ "$CRONS" = 1 ]; then
    for f in ssam-backup ssam-rotate; do
        if [ -e "$R$CRON_DIR/$f" ]; then run rm -f "$R$CRON_DIR/$f"; fi
    done
    say "  sem cron, o backup diario e a rotacao semanal param (DEPLOY.md secoes 9 e 10)"
fi

say ""
if [ -n "$running" ]; then
    say "Falta o container: tire COMPOSE_PROFILES=console do .env e rode docker compose -f compose.prod.yml rm -sf $CONSOLE_SERVICE"
else
    say "Se o .env ainda tiver COMPOSE_PROFILES=console, tire a linha (sem as pastas o container nao sobe)."
fi
[ "$DRY" = 1 ] && say "dry-run: nada foi alterado."
exit 0
