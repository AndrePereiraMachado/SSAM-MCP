#!/bin/bash
# Installs the SSAM agent on this Mac (docs/AGENTE-MAC.md). One command, after the pack arrived by a private channel:
#   mkdir -p ~/SSAM-Agent && tar -xzf ssam-agent-mac.tar.gz -C ~/SSAM-Agent && bash ~/SSAM-Agent/install.sh
# Options: --server <https://...> (default: the one already set up, else https://mcp.ssam.pro)
#          --credential-file <file> (else the credential is asked on the terminal, without echo; never a file in
#          Desktop, Documents, Downloads, iCloud Drive or a cloud folder; delete the file afterwards)
#          --o11-port <port>   --node <path of a Node 24>
# The folder must be the pack's own: not /, not your home folder, not ~/Library or a folder of macOS or of the
# applications, and holding nothing but this pack (or a folder set up before by it).
# What it does, all inside this folder and without administrator rights:
#   1. checks macOS (13.5 or newer; ODC Studio wants 14) and the processor (Apple silicon or Intel);
#   2. removes the download quarantine from this folder only;
#   3. finds Node 24 (with --use-env-proxy and --use-system-ca) or downloads the official
#      node-v<version>-darwin-<arm64|x64>.tar.gz of nodejs.org and checks the sha256 fixed in pack.json, keeping only
#      bin/node and LICENSE in agent/node/;
#   4. runs the agent setup (the credential never goes as an argument, is never shown and stays in private/), unless this
#      folder is already set up (a new pack over the same folder keeps its credential);
#   5. records the Node it chose in private/node, starts the agent (stopping the old one first), runs the doctor and
#      shows the next step.
# Nothing starts by itself at login (as on Windows): ~/SSAM-Agent/agent/ssam-agent.sh start. Written for bash 3.2.
set -u

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
DEFAULT_SERVER="https://mcp.ssam.pro"
SERVER=""
CREDENTIAL_FILE=""
O11_PORT=""
NODE_OPTION=""

say() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) [ "$#" -ge 2 ] || fail "missing value for --server"; SERVER="$2"; shift 2 ;;
    --credential-file) [ "$#" -ge 2 ] || fail "missing value for --credential-file"; CREDENTIAL_FILE="$2"; shift 2 ;;
    --o11-port) [ "$#" -ge 2 ] || fail "missing value for --o11-port"; O11_PORT="$2"; shift 2 ;;
    --node) [ "$#" -ge 2 ] || fail "missing value for --node"; NODE_OPTION="$2"; shift 2 ;;
    -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    *) fail "unknown option: $1 (see bash $0 --help)" ;;
  esac
done

# ---- 1. the system
[ "$(uname -s 2>/dev/null)" = "Darwin" ] || fail "this installer is for macOS; on Windows use ssam-agent.zip and docs/AGENTE-CLIENTE.md"
MACHINE="$(uname -m 2>/dev/null)"
case "$MACHINE" in
  arm64) ARCH="arm64" ;;
  x86_64)
    # A Terminal under Rosetta says x86_64 on Apple silicon: the native Node is arm64.
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then ARCH="arm64"; else ARCH="x64"; fi ;;
  *) fail "unknown processor $MACHINE (expected arm64 or x86_64)" ;;
esac
MACOS="$(sw_vers -productVersion 2>/dev/null)"
MAJOR="${MACOS%%.*}"
REST="${MACOS#*.}"
MINOR="${REST%%.*}"
case "$MAJOR" in ''|*[!0-9]*) fail "could not read the macOS version (sw_vers said '$MACOS')" ;; esac
case "$MINOR" in ''|*[!0-9]*) MINOR=0 ;; esac
if [ "$MAJOR" -lt 13 ] || { [ "$MAJOR" -eq 13 ] && [ "$MINOR" -lt 5 ]; }; then fail "macOS $MACOS is too old: Node 24 needs macOS 13.5 or newer"; fi
say "macOS $MACOS on $([ "$ARCH" = "arm64" ] && echo 'Apple silicon' || echo 'Intel'); agent folder $ROOT"
if [ "$MAJOR" -lt 14 ]; then say "Warning: ODC Studio needs macOS 14 (Sonoma) or newer."; fi

# ---- the folder (setup checks it again)
case "$ROOT" in *[[:space:]]*) fail "the folder $ROOT has a space; extract the pack to a folder without spaces, such as $HOME/SSAM-Agent" ;; esac
LOWER_ROOT="$(printf '%s' "$ROOT" | tr '[:upper:]' '[:lower:]')"
LOWER_HOME="$(printf '%s' "$HOME" | tr '[:upper:]' '[:lower:]')"
for guarded in Desktop Documents Downloads "Library/Mobile Documents" Library/CloudStorage; do
  lower="$(printf '%s' "$LOWER_HOME/$guarded" | tr '[:upper:]' '[:lower:]')"
  case "$LOWER_ROOT/" in "$lower"/*) fail "the folder $ROOT is inside $HOME/$guarded, which macOS guards for privacy: extract the pack to $HOME/SSAM-Agent" ;; esac
done
case "$LOWER_ROOT/" in /volumes/*|/tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) fail "the folder $ROOT is on another volume or in a temporary folder: extract the pack to $HOME/SSAM-Agent" ;; esac
# A folder of its own (uninstall removes what the installation put in it): never the disk root, the home folder or a
# folder above it, ~/Library, a folder of macOS or of the applications, nor a folder that holds anything else.
LOWER_HOME="${LOWER_HOME%/}"
[ "$ROOT" != "/" ] || fail "the folder / is the root of the disk: extract the pack to a folder of its own, such as $HOME/SSAM-Agent"
[ "$LOWER_ROOT" != "$LOWER_HOME" ] || fail "the folder $ROOT is your home folder itself: extract the pack to a folder of its own, such as $HOME/SSAM-Agent"
case "$LOWER_HOME/" in "$LOWER_ROOT"/*) fail "the folder $ROOT holds your home folder: extract the pack to a folder of its own, such as $HOME/SSAM-Agent" ;; esac
case "$LOWER_ROOT/" in "$LOWER_HOME/library"/*) fail "the folder $ROOT is inside $HOME/Library, where macOS and the applications keep their own data: extract the pack to $HOME/SSAM-Agent" ;; esac
for system in /System /Library /Applications /usr /bin /sbin /etc /opt /private /var /tmp /cores /dev /Volumes /Network; do
  lower="$(printf '%s' "$system" | tr '[:upper:]' '[:lower:]')"
  case "$LOWER_ROOT/" in "$lower"/*) fail "the folder $ROOT is inside $system, a folder of macOS or of the applications: extract the pack to $HOME/SSAM-Agent" ;; esac
done
# An extracted pack (and a folder set up before) has only these names at its top; setup checks the whole folder.
FOREIGN=""
for entry in "$ROOT"/* "$ROOT"/.[!.]* "$ROOT"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name="${entry##*/}"
  if [ -L "$entry" ]; then FOREIGN="$FOREIGN, $name (a link)"; continue; fi
  case "$name" in
    install.sh|pack.json|.DS_Store) [ -f "$entry" ] || FOREIGN="$FOREIGN, $name" ;;
    agent|bin|docs|odc|private|inbox|o11|.install-node) [ -d "$entry" ] || FOREIGN="$FOREIGN, $name" ;;
    *) if [ -d "$entry" ]; then FOREIGN="$FOREIGN, $name/"; else FOREIGN="$FOREIGN, $name"; fi ;;
  esac
done
[ -z "$FOREIGN" ] || fail "the folder $ROOT already holds files that are not of an SSAM agent pack: ${FOREIGN#, }. Extract the pack to a new folder of its own, such as $HOME/SSAM-Agent"
[ -f "$ROOT/pack.json" ] && [ -f "$ROOT/agent/ssam-agent.mjs" ] || fail "this folder is not an extracted SSAM agent pack (pack.json or agent/ssam-agent.mjs is missing)"
# --credential-file: never from a folder macOS guards or syncs to the cloud (setup checks it again).
if [ -n "$CREDENTIAL_FILE" ]; then
  case "$CREDENTIAL_FILE" in /*) CREDENTIAL_PATH="$CREDENTIAL_FILE" ;; *) CREDENTIAL_PATH="$PWD/$CREDENTIAL_FILE" ;; esac
  LOWER_CREDENTIAL="$(printf '%s' "$CREDENTIAL_PATH" | tr '[:upper:]' '[:lower:]')"
  for guarded in Desktop Documents Downloads "Library/Mobile Documents" Library/CloudStorage; do
    lower="$(printf '%s' "$LOWER_HOME/$guarded" | tr '[:upper:]' '[:lower:]')"
    case "$LOWER_CREDENTIAL" in "$lower"/*) fail "the credential file $CREDENTIAL_FILE is inside $HOME/$guarded, which macOS guards or syncs to the cloud: move it to your home folder, or run install.sh without --credential-file and paste the credential when it asks" ;; esac
  done
fi

# ---- 2. the quarantine of this folder only (files that came by a browser or a chat carry it)
xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true
chmod 755 "$ROOT/install.sh" "$ROOT/agent/ssam-agent.sh" 2>/dev/null || true

# ---- 3. Node 24
# A Node 24 with both options answers the word below (any other program, or another Node, does not).
node_ok() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  [ "$("$1" -e 'const major = Number(process.versions.node.split(".")[0]); const flags = process.allowedNodeEnvironmentFlags; process.stdout.write(major === 24 && flags.has("--use-env-proxy") && flags.has("--use-system-ca") ? "ssam-node-24" : "no")' 2>/dev/null)" = "ssam-node-24" ]
}
NODE=""
for candidate in "$NODE_OPTION" "${SSAM_NODE:-}" "$ROOT/agent/node/node" "$(command -v node 2>/dev/null)"; do
  if node_ok "$candidate"; then NODE="$candidate"; break; fi
done
if [ -n "$NODE_OPTION" ] && [ "$NODE" != "$NODE_OPTION" ]; then fail "--node $NODE_OPTION is not a Node 24 with --use-env-proxy and --use-system-ca"; fi

# One value of a JSON file by its key path (a.b.c): plutil, else JavaScript for Automation (both are part of macOS).
json_get() {
  plutil -extract "$2" raw -o - "$1" 2>/dev/null && return 0
  osascript -l JavaScript -e 'function run(a) { var v = JSON.parse($.NSString.stringWithContentsOfFileEncodingError(a[0], $.NSUTF8StringEncoding, null).js); a[1].split(".").forEach(function (k) { v = v === null || v === undefined ? undefined : v[k]; }); return v === null || v === undefined ? "" : String(v); }' "$1" "$2" 2>/dev/null
}
pin() { json_get "$ROOT/pack.json" "$1"; }
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else openssl dgst -sha256 "$1" | awk '{print $NF}'; fi
}
if [ -z "$NODE" ]; then
  VERSION="$(pin node.version)"
  FILE="$(pin "node.$ARCH.file")"
  EXPECTED="$(pin "node.$ARCH.sha256")"
  case "$VERSION" in ''|*[!0-9.]*) fail "pack.json has no Node version for this Mac (node.version)" ;; esac
  case "$FILE" in "node-v$VERSION-darwin-$ARCH.tar.gz") ;; *) fail "pack.json names an unexpected Node file for $ARCH: '$FILE'" ;; esac
  case "$EXPECTED" in *[!0-9a-f]*|'') fail "pack.json has no sha256 for $FILE" ;; esac
  [ "${#EXPECTED}" -eq 64 ] || fail "pack.json has no sha256 for $FILE"
  URL="https://nodejs.org/dist/v$VERSION/$FILE"
  WORK="$ROOT/.install-node"
  rm -rf "$WORK"
  mkdir "$WORK" || fail "could not create $WORK"
  chmod 700 "$WORK" 2>/dev/null || true
  say "No Node 24 found: downloading $URL"
  if ! curl -fL --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 20 -o "$WORK/$FILE" "$URL"; then
    rm -rf "$WORK"; fail "the download of $URL failed; check the network and the proxy (HTTPS_PROXY), or install Node 24 and run install.sh again"
  fi
  ACTUAL="$(sha256_of "$WORK/$FILE")"
  if [ "$ACTUAL" != "$EXPECTED" ]; then rm -rf "$WORK"; fail "$FILE has the sha256 $ACTUAL, not the $EXPECTED fixed in pack.json: nothing was installed"; fi
  say "sha256 checked: $ACTUAL"
  tar -xzf "$WORK/$FILE" -C "$WORK" "node-v$VERSION-darwin-$ARCH/bin/node" "node-v$VERSION-darwin-$ARCH/LICENSE" || { rm -rf "$WORK"; fail "could not extract $FILE"; }
  mkdir -p "$ROOT/agent/node"
  mv -f "$WORK/node-v$VERSION-darwin-$ARCH/bin/node" "$ROOT/agent/node/node" && mv -f "$WORK/node-v$VERSION-darwin-$ARCH/LICENSE" "$ROOT/agent/node/LICENSE" || { rm -rf "$WORK"; fail "could not move Node into $ROOT/agent/node"; }
  rm -rf "$WORK"
  chmod 755 "$ROOT/agent/node/node"
  xattr -d com.apple.quarantine "$ROOT/agent/node/node" 2>/dev/null || true
  node_ok "$ROOT/agent/node/node" || fail "the downloaded Node does not run on this Mac ($ROOT/agent/node/node)"
  NODE="$ROOT/agent/node/node"
fi
say "Node: $NODE ($("$NODE" --version))"

# ---- 4. setup (the credential is read by the agent itself: from the terminal without echo, or from --credential-file)
CONFIGURED=0
if [ -f "$ROOT/private/credential" ] && [ -f "$ROOT/private/config.json" ]; then CONFIGURED=1; fi
if [ "$CONFIGURED" = "1" ] && [ -z "$SERVER" ] && [ -z "$CREDENTIAL_FILE" ] && [ -z "$O11_PORT" ]; then
  say "Already set up (private/config.json and private/credential stay as they are)."
else
  if [ -z "$SERVER" ]; then
    SERVER="$(json_get "$ROOT/private/config.json" server)"
    [ -n "$SERVER" ] || SERVER="$DEFAULT_SERVER"
  fi
  set -- setup --server "$SERVER" --root "$ROOT"
  if [ -n "$CREDENTIAL_FILE" ]; then set -- "$@" --credential-file "$CREDENTIAL_FILE"; fi
  if [ -n "$O11_PORT" ]; then set -- "$@" --o11-port "$O11_PORT"; fi
  if [ -z "$CREDENTIAL_FILE" ] && [ ! -t 0 ] && [ -r /dev/tty ]; then
    "$NODE" "$ROOT/agent/ssam-agent.mjs" "$@" < /dev/tty || fail "setup did not finish (see the message above); run install.sh again"
  else
    "$NODE" "$ROOT/agent/ssam-agent.mjs" "$@" || fail "setup did not finish (see the message above); run install.sh again"
  fi
fi

# ---- 5. start, doctor, next step
# The Node chosen here is the one agent/ssam-agent.sh takes later, even when a new Terminal has another node first on
# its PATH (it checks it is still a Node 24).
if printf '%s\n' "$NODE" > "$ROOT/private/node"; then chmod 600 "$ROOT/private/node" 2>/dev/null || true
else say "Warning: could not write $ROOT/private/node; agent/ssam-agent.sh will look for a Node 24 itself."; fi
export SSAM_NODE="$NODE"
bash "$ROOT/agent/ssam-agent.sh" stop >/dev/null 2>&1 || true
bash "$ROOT/agent/ssam-agent.sh" start
STARTED=$?
say ""
say "Doctor:"
bash "$ROOT/agent/ssam-agent.sh" doctor || true
SERVER_NOW="$(json_get "$ROOT/private/config.json" server)"
[ -n "$SERVER_NOW" ] || SERVER_NOW="$DEFAULT_SERVER"
say ""
say "Next step: connect your MCP client to $SERVER_NOW/mcp with your MCP token (ssam_..., not the agent credential)."
say "  Keep the token in your shell profile (~/.zshrc), never in a repository:  export SSAM_TOKEN=\"ssam_...\""
say "  Claude Code:  claude mcp add --transport http ssam $SERVER_NOW/mcp --header \"Authorization: Bearer \$SSAM_TOKEN\""
say "  Or a .mcp.json:  {\"mcpServers\":{\"ssam\":{\"type\":\"http\",\"url\":\"$SERVER_NOW/mcp\",\"headers\":{\"Authorization\":\"Bearer \${SSAM_TOKEN}\"}}}}"
say "Then, in the MCP client: ssam_doctor, studio_attach (ODC Studio) and ssam_connect {lane:\"o11\"} (Service Studio)."
say "Agent: $ROOT/agent/ssam-agent.sh start|status|stop|doctor|uninstall. Guide: $ROOT/docs/AGENTE-MAC.md"
if [ -n "$CREDENTIAL_FILE" ]; then say "Delete $CREDENTIAL_FILE now: the credential is saved in private/credential (rm \"$CREDENTIAL_FILE\")."; fi
exit "$STARTED"
