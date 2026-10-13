#!/bin/sh
# Runs host/install.sh and host/uninstall.sh for real, as root, in a throwaway Ubuntu container (test_install_scripts.py
# ContainerTests, opt-in with SSAM_TEST_DOCKER_IMAGE). Only the proxy account is real: systemctl, docker, ss and curl
# are fakes that record their calls, python3 is a fake (the image has none) and systemd-socket-proxyd an empty file.
#
#   docker run --rm --network none -v <SSAM-MCP>/server/deploy:/opt/ssam/deploy:ro ubuntu:26.04 \
#       sh /opt/ssam/deploy/host/tests/fixtures/account-container.sh fresh|collision|reuse|members|primary
#
# Prints every script output and one "ok" line per assertion; exits 1 at the first failed assertion.
set -u
D=/opt/ssam/deploy
CALLS=/tmp/calls.log
FAKES=/tmp/fakes
LINE='ssam-console:x:10001:10001:ssam-console-proxy:/nonexistent:/usr/sbin/nologin'

fail() { echo "FALHOU: $*"; exit 1; }
ok() { echo "ok: $*"; }
snap() { cat /etc/passwd /etc/group /etc/shadow /etc/gshadow | sha256sum | cut -c1-16; }
# sh_run NAME SCRIPT ARGS...: runs a deploy script, keeps its output in /tmp/NAME.out and its exit code in RC.
sh_run() {
    name=$1; shift
    : > "$CALLS"
    echo "---------------------------------------------------------------- $name: sh $*"
    sh "$@" > "/tmp/$name.out" 2>&1
    RC=$?
    cat "/tmp/$name.out"
    echo "---------------------------------------------------------------- $name: exit $RC"
}
has() { grep -qF -- "$2" "/tmp/$1.out" || fail "$1: falta a linha: $2"; }
hasnt() { if grep -qF -- "$2" "/tmp/$1.out"; then fail "$1: linha inesperada: $2"; fi; }
called() { grep -qxF -- "$1" "$CALLS" || fail "chamada ausente: $1"; }

mkdir -p "$FAKES" /run/systemd/system /usr/lib/systemd /etc/systemd/system
cat > "$FAKES/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> /tmp/calls.log
case "$1" in
    is-active) exit 3 ;;
    start) if [ "$2" = ssam-console-collect.service ]; then echo '{}' > /var/lib/ssam-console/host/host.json; fi ;;
esac
exit 0
EOF
cat > "$FAKES/docker" <<'EOF'
#!/bin/sh
echo "docker $*" >> /tmp/calls.log
case "$1" in
    version) echo 29.8.2 ;;
    ps) case "$*" in *service=ssam-server*) echo 0123456789ab ;; esac ;;
esac
exit 0
EOF
printf '#!/bin/sh\nexit 0\n' > "$FAKES/ss"
printf '#!/bin/sh\necho "curl $*" >> /tmp/calls.log\nexit 7\n' > "$FAKES/curl"
cat > /usr/bin/python3 <<'EOF'
#!/bin/sh
# Fake python3 of the container test: the version check passes; the host.json check reads its program and says ok.
[ "${2:-}" = -c ] && exit 0
cat > /dev/null
echo "  ok     host.json (python3 falso do teste)"
EOF
printf '#!/bin/sh\nexit 0\n' > /usr/lib/systemd/systemd-socket-proxyd
chmod +x "$FAKES"/* /usr/bin/python3 /usr/lib/systemd/systemd-socket-proxyd
PATH="$FAKES:$PATH"
export PATH
. /etc/os-release
echo "imagem: $PRETTY_NAME | $(dpkg-query -W -f '${Package} ${Version}' passwd 2>/dev/null || true)"

case "${1:-}" in
fresh)
    base=$(snap)
    sh_run dry "$D/host/install.sh" --dry-run
    [ "$RC" = 0 ] || fail "dry-run saiu com $RC"
    has dry "ok     uid 10001 e gid 10001 do ssam-console-proxy"
    has dry "(dry-run) groupadd -r -g 10001 ssam-console"
    has dry "(dry-run) useradd -r -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin -c ssam-console-proxy ssam-console"
    [ "$(snap)" = "$base" ] || fail "o dry-run mudou /etc/passwd, group ou shadow"
    [ -z "$(getent passwd 10001)" ] || fail "o dry-run criou o uid 10001"
    [ ! -e /var/lib/ssam-console ] || fail "o dry-run criou /var/lib/ssam-console"
    if grep -v -e '^systemctl is-active' -e '^docker version' -e '^docker ps' "$CALLS"; then fail "o dry-run chamou um comando que muda"; fi
    ok "dry-run so imprimiu"

    sh_run install "$D/host/install.sh"
    [ "$RC" = 0 ] || fail "install saiu com $RC"
    [ "$(getent passwd 10001)" = "$LINE" ] || fail "getent passwd 10001: $(getent passwd 10001)"
    [ "$(getent group 10001)" = "ssam-console:x:10001:" ] || fail "getent group 10001: $(getent group 10001)"
    passwd -S ssam-console | grep -q '^ssam-console L ' || fail "senha nao travada: $(passwd -S ssam-console)"
    [ ! -e /nonexistent ] || fail "/nonexistent foi criado"
    [ "$(stat -c %U:%G /var/lib/ssam-console/state)" = ssam-console:ssam-console ] || fail "dono de state: $(stat -c %U:%G /var/lib/ssam-console/state)"
    called "systemctl reset-failed ssam-console-proxy.service ssam-console-proxy.socket"
    called "systemctl enable --now ssam-console-collect.timer ssam-console-proxy.socket"
    has install "+ groupadd -r -g 10001 ssam-console"
    has install "ok     getent passwd 10001 -> $LINE"
    echo "getent passwd 10001: $(getent passwd 10001)"
    echo "getent group 10001:  $(getent group 10001)"
    echo "passwd -S:           $(passwd -S ssam-console)"
    echo "ls -ld state sock:   $(ls -ld /var/lib/ssam-console/state /var/lib/ssam-console/sock | awk '{print $1, $3, $4, $9}' | tr '\n' ';')"
    ok "install criou grupo e usuario ssam-console 10001, senha travada, sem home"
    created=$(snap)

    sh_run again "$D/host/install.sh"
    [ "$RC" = 0 ] || fail "segunda execucao saiu com $RC"
    has again "existe  grupo ssam-console (gid 10001)"
    has again "existe  usuario ssam-console (uid 10001)"
    hasnt again "groupadd"
    hasnt again "useradd"
    if grep -q 'reset-failed' "$CALLS"; then fail "segunda execucao rodou reset-failed"; fi
    [ "$(snap)" = "$created" ] || fail "segunda execucao mudou as contas"
    ok "segunda execucao nao mudou nada nas contas"

    sh_run keep "$D/host/uninstall.sh"
    [ "$RC" = 0 ] || fail "uninstall saiu com $RC"
    has keep "mantidos usuario ssam-console e grupo ssam-console (--purge apaga o ssam-console criado pelo install.sh)"
    [ "$(snap)" = "$created" ] || fail "uninstall sem --purge mudou as contas"
    ok "uninstall sem --purge manteve a conta"

    setpriv --reuid=10001 --regid=10001 --clear-groups sleep 300 &
    busy=$!
    sleep 1
    sh_run busy "$D/host/uninstall.sh" --purge
    [ "$RC" = 0 ] || fail "uninstall --purge (processo do 10001) saiu com $RC"
    has busy "mantido o usuario ssam-console: 1 processo(s) rodam como uid 10001"
    has busy "mantido o grupo ssam-console: e o grupo principal de ssam-console"
    [ "$(snap)" = "$created" ] || fail "uninstall --purge com processo do 10001 mudou as contas"
    [ ! -e /var/lib/ssam-console ] || fail "--purge nao apagou /var/lib/ssam-console"
    ok "--purge manteve a conta com um processo do uid 10001 rodando"
    kill "$busy"
    wait "$busy" 2>/dev/null

    sh_run dry_purge "$D/host/uninstall.sh" --purge --dry-run
    [ "$RC" = 0 ] || fail "uninstall --purge --dry-run saiu com $RC"
    has dry_purge "(dry-run) userdel ssam-console"
    [ "$(snap)" = "$created" ] || fail "uninstall --purge --dry-run mudou as contas"
    ok "uninstall --purge --dry-run so imprimiu"

    sh_run purge "$D/host/uninstall.sh" --purge
    [ "$RC" = 0 ] || fail "uninstall --purge saiu com $RC"
    has purge "+ userdel ssam-console"
    has purge "o grupo ssam-console saiu junto com o usuario (userdel)"
    hasnt purge "groupdel"
    [ -z "$(getent passwd 10001)$(getent group 10001)" ] || fail "uid ou gid 10001 ainda existe"
    [ "$(snap)" = "$base" ] || fail "as contas nao voltaram ao estado inicial"
    ok "--purge apagou usuario e grupo; passwd, group, shadow e gshadow iguais aos do inicio"
    ;;
collision)
    { groupadd -g 999 ssam-console && useradd -u 999 -g 999 -M -d /var/lib/outro -s /usr/sbin/nologin -c outro ssam-console; } \
        2>&1 || fail "preparo"
    base=$(snap)
    sh_run collision "$D/host/install.sh"
    [ "$RC" = 1 ] || fail "install com nome ocupado saiu com $RC (esperado 1)"
    has collision "FALHA  uid 10001 e gid 10001 do ssam-console-proxy (existem ou podem ser criados)"
    has collision "- o grupo ssam-console ja existe com o gid 999 (o proxy roda com o gid 10001)"
    has collision "- o usuario ssam-console ja existe com o uid 999 (o proxy roda com o uid 10001)"
    has collision "install: 1 verificacao(oes) falharam; nada foi alterado."
    [ "$(snap)" = "$base" ] || fail "install recusado mudou as contas"
    [ ! -e /var/lib/ssam-console ] && [ ! -e /etc/systemd/system/ssam-console-proxy.service ] || fail "install recusado criou arquivos"
    if grep -v -e '^systemctl is-active' -e '^docker version' -e '^docker ps' "$CALLS"; then fail "install recusado chamou um comando que muda"; fi
    ok "nome ssam-console com outro id: verificacao falhou antes de qualquer mudanca"
    sh_run purge "$D/host/uninstall.sh" --purge
    [ "$RC" = 0 ] || fail "uninstall --purge saiu com $RC"
    has purge "nenhum usuario com o uid 10001 e nenhum grupo com o gid 10001"
    [ "$(snap)" = "$base" ] || fail "uninstall --purge mexeu no ssam-console de outro id"
    ok "uninstall --purge nao tocou no ssam-console de outro id"
    ;;
reuse)
    { groupadd -g 10001 app && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin app; } 2>&1 || fail "preparo"
    base=$(snap)
    sh_run reuse "$D/host/install.sh"
    [ "$RC" = 0 ] || fail "install saiu com $RC"
    has reuse "existe  grupo app (gid 10001)"
    has reuse "existe  usuario app (uid 10001)"
    hasnt reuse "groupadd"
    hasnt reuse "useradd"
    [ "$(snap)" = "$base" ] || fail "install mudou as contas"
    [ "$(stat -c %U:%G /var/lib/ssam-console/state)" = app:app ] || fail "dono de state: $(stat -c %U:%G /var/lib/ssam-console/state)"
    ok "uid e gid 10001 de outro nome reaproveitados, nada criado"
    sh_run purge "$D/host/uninstall.sh" --purge
    [ "$RC" = 0 ] || fail "uninstall --purge saiu com $RC"
    has purge "mantido o usuario app (uid 10001): nao e o ssam-console do install.sh"
    has purge "mantido o grupo app (gid 10001): nao e o ssam-console do install.sh"
    [ "$(snap)" = "$base" ] || fail "uninstall --purge mexeu na conta app"
    ok "uninstall --purge nao tocou na conta app"
    ;;
members)
    # An operator in the group ssam-console (to read host.json): --purge removes the user, never the operator's group.
    useradd -M -s /usr/sbin/nologin operador 2>&1 || fail "preparo"
    sh_run install "$D/host/install.sh"
    [ "$RC" = 0 ] || fail "install saiu com $RC"
    usermod -aG ssam-console operador || fail "usermod"
    sh_run purge "$D/host/uninstall.sh" --purge
    [ "$RC" = 0 ] || fail "uninstall --purge saiu com $RC"
    has purge "+ userdel ssam-console"
    has purge "mantido o grupo ssam-console: tem outros membros (operador)"
    hasnt purge "groupdel"
    [ -z "$(getent passwd 10001)" ] || fail "o usuario ssam-console ficou"
    [ "$(getent group 10001)" = "ssam-console:x:10001:operador" ] || fail "getent group 10001: $(getent group 10001)"
    id -nG operador | tr ' ' '\n' | grep -qx ssam-console || fail "operador saiu do grupo: $(id -nG operador)"
    ok "--purge apagou o usuario e manteve o grupo com o operador dentro"
    ;;
primary)
    # ssam-console on uid 10001 whose primary group is another ssam-console (gid 999): install.sh reuses it, and
    # --purge must not run userdel (shadow's userdel would take the group of gid 999 along).
    { groupadd -g 999 ssam-console && groupadd -g 10001 app \
        && useradd -u 10001 -g 999 -M -s /usr/sbin/nologin ssam-console; } 2>&1 || fail "preparo"
    base=$(snap)
    sh_run install "$D/host/install.sh"
    [ "$RC" = 0 ] || fail "install saiu com $RC"
    has install "existe  grupo app (gid 10001)"
    has install "existe  usuario ssam-console (uid 10001)"
    [ "$(snap)" = "$base" ] || fail "install mudou as contas"
    sh_run purge "$D/host/uninstall.sh" --purge
    [ "$RC" = 0 ] || fail "uninstall --purge saiu com $RC"
    has purge "mantido o usuario ssam-console (uid 10001): no /etc/passwd tem uid 10001 e grupo principal 999"
    has purge "mantido o grupo app (gid 10001): nao e o ssam-console do install.sh"
    hasnt purge "userdel"
    hasnt purge "groupdel"
    [ "$(snap)" = "$base" ] || fail "uninstall --purge mexeu nas contas"
    ok "--purge nao tocou no ssam-console de outro grupo principal nem no grupo ssam-console 999"
    ;;
*)
    fail "cenario desconhecido: ${1:-} (fresh, collision, reuse, members ou primary)"
    ;;
esac
echo "OK cenario $1"
