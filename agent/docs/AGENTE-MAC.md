# The SSAM agent on a Mac (customer guide)

The agent on a Mac is the same agent as on Windows: the same requests, the same checks, the same privacy rules and the
same server. Read [AGENTE-CLIENTE.md](AGENTE-CLIENTE.md) for what the agent is, what the server records about your
access and what the agent does and never does. This guide covers only what is different on macOS.

## What you get from the server owner

| Item | What for |
|---|---|
| `ssam-agent-mac.tar.gz` | the macOS agent pack: the agent code, the Studio bridges (the same files as the Windows pack), `install.sh`, these guides and `pack.json` with the sha256 of each file |
| the server address | `https://mcp.ssam.pro`, unless the owner gives you another one |
| the MCP token (`ssam_...`) | goes in the configuration of your MCP client |
| the agent credential (`ssam_agent_...`) | goes in the agent, when `install.sh` asks for it |

Keep the token and the credential in a password vault, never in a repository or a chat.

## Prerequisites

- macOS 13.5 or newer (ODC Studio itself needs macOS 14, Sonoma, or newer), on Apple silicon or Intel.
- ODC Studio and/or Service Studio 11 installed in `/Applications` or `~/Applications`, in the SAME version as the
  server kernel (`ssam_doctor` of your MCP client shows both versions).
- No .NET and no administrator rights. Node 24: if the Mac has none, `install.sh` downloads the official one from
  `nodejs.org` (about 50 MB) and checks its sha256 against the value fixed in `pack.json`.
- A new folder of its own, without spaces, outside `~/Desktop`, `~/Documents`, `~/Downloads` and iCloud Drive (macOS
  guards those for privacy and the Studio would be asked for access there). The default is `~/SSAM-Agent`. `install.sh`
  refuses `/`, your home folder itself, `~/Library`, the folders of macOS and of the applications (`/Applications`,
  `/Library`, `/usr`, `/opt`, ...) and a folder that already holds anything but this pack (a folder set up before by
  the pack is fine).

## Install (one command)

In Terminal, with the pack in `~/Downloads`:

```sh
mkdir -p ~/SSAM-Agent && tar -xzf ~/Downloads/ssam-agent-mac.tar.gz -C ~/SSAM-Agent && bash ~/SSAM-Agent/install.sh
```

`install.sh` then, without administrator rights and only inside `~/SSAM-Agent`:

1. checks macOS and the processor;
2. removes the download quarantine from this folder only (`xattr -dr com.apple.quarantine ~/SSAM-Agent`);
3. finds Node 24 (with `--use-env-proxy` and `--use-system-ca`) or downloads `node-v24.19.0-darwin-<arm64|x64>.tar.gz`
   from `nodejs.org`, checks the sha256 fixed in `pack.json` and keeps only `bin/node` and its `LICENSE` in
   `agent/node/`;
4. asks for the agent credential: paste it and press Enter (it does not appear on screen). It never goes as an
   argument, is never shown and stays in `private/credential`, in a folder only your user can open (`chmod 700`);
5. records the Node it chose in `private/node` (the agent keeps using it even when a new Terminal finds another `node`
   first), starts the agent, runs the doctor and shows how to connect your MCP client.

Options: `--server <https://...>`, `--credential-file <file>` (never a file in `~/Desktop`, `~/Documents`,
`~/Downloads`, iCloud Drive or a cloud folder, which macOS guards or syncs; delete the file afterwards: the installer
reminds you), `--o11-port <port>` (the local port of the Service Studio bridge, default 4516), `--node <path of a Node
24>`. Running `install.sh` again on a folder that is already set up keeps the credential and the server.

As on Windows, nothing starts by itself when you log in: start the agent with `~/SSAM-Agent/agent/ssam-agent.sh start`.

## Start, stop and check

```sh
~/SSAM-Agent/agent/ssam-agent.sh start     # starts in the background and waits for the connection (up to 30 s)
~/SSAM-Agent/agent/ssam-agent.sh status
~/SSAM-Agent/agent/ssam-agent.sh stop      # clean stop: tells the server and exits
~/SSAM-Agent/agent/ssam-agent.sh doctor    # add --json for the owner
```

The exit codes and their meaning are the ones of the Windows guide (2: credential refused, 3: another agent took over,
4: the server does not accept this agent version). The pid, the state and the log stay in `private/` (`agent.log`,
without any secret). Closing the Terminal does not stop the agent.

## The doctor on a Mac

Besides the checks of Windows (Node options, folder, pack integrity, configuration, credential, server), `doctor`
reads, without changing anything:

- macOS, the processor and whether Node runs under Rosetta;
- each Studio bundle found in `/Applications` and `~/Applications`: its version (the ProductVersion of the Studio's
  managed entry assembly, the same four-number build as on Windows, else `Info.plist`), the architectures of its
  executable, where its managed DLLs are, whether startup hooks or the .NET diagnostics are turned off, whether it is
  sandboxed;
- each running Studio: its .NET diagnostic socket (`dotnet-diagnostic-<pid>-*-socket` in the temporary folder), the
  runtime it reports (a read-only ProcessInfo2 request), whether the ODC bridge is attached;
- the temporary folders (`$TMPDIR` and the one macOS gives the apps);
- the readers of a process start time with microseconds (`perl`, `osascript`, `sysctl`), which the Service Studio
  connection needs, each checked on two short processes the agent starts itself;
- a Studio that is installed and not running (open it, then run the doctor again);
- anything in the agent folder that is not of the pack.

Each problem comes with the next step. When the owner asks for it, send the output of
`~/SSAM-Agent/agent/ssam-agent.sh doctor --json`: it has no token and no credential.

## Configure the MCP client

Keep the MCP token in your shell profile (`~/.zshrc`), never in a repository:

```sh
export SSAM_TOKEN="ssam_..."
claude mcp add --transport http ssam https://mcp.ssam.pro/mcp --header "Authorization: Bearer $SSAM_TOKEN"
```

Or this `.mcp.json` in your project: `{"mcpServers":{"ssam":{"type":"http","url":"https://mcp.ssam.pro/mcp","headers":{"Authorization":"Bearer ${SSAM_TOKEN}"}}}}`.

Then, in the MCP client: `ssam_doctor`, `studio_attach` (ODC Studio) and `ssam_connect {lane:"o11"}` (Service Studio).

## How the agent works on a Mac

- **Attach without .NET.** On Windows the pack carries a .NET attach client and `Anvil.Connect`. On a Mac the agent
  itself speaks the .NET diagnostic protocol of the Studio (the Unix socket `dotnet-diagnostic-<pid>-<start>-socket`)
  and asks it to load the bridge of the pack. The checks are the same: the process must be the executable of a Studio
  bundle installed in `/Applications` or `~/Applications`, the DLL must be the pack's own bridge, the process must not
  have restarted in between, and the runtime must be .NET 8 or newer.
- **The ODC bridge pipe** is a Unix socket in the Studio's temporary folder (`CoreFxPipe_ODC3-Bridge-<version>-<pid>`).
  On a Mac a second connection waits in a queue instead of getting "busy", so the agent sends one command at a time to
  each Studio; a command that arrives while another one runs answers `BRIDGE_BUSY` after the wait, as on Windows.
- **Service Studio** checks the start time of its own process, to the microsecond, before it loads the bridge, and a
  wrong value can only be tried again after a restart of Service Studio. The agent reads it with `perl`, `osascript` or
  `sysctl` (parts of macOS), and trusts a reader only after it read, to the microsecond, the start of two short
  processes the agent started itself; each value is also checked against the kernel. With no trusted reader the
  connection is refused before the Studio is touched, and `doctor --json` shows why.
- **Paths.** The agent folder rules are the Windows ones written for POSIX paths: only `agent:<relative path>` from the
  server, no `..`, no absolute path outside the agent folder, links that leave a folder refused. An absolute path must
  spell the agent folder exactly, case included (on a case-sensitive volume another case is another folder).
- **The machine identifier** is a hash of the Mac's `IOPlatformUUID` with the computer name and your user, the same
  rule as the Windows `MachineGuid`.

## Folders

```
~/SSAM-Agent/
  install.sh    the installer                 pack.json   id, lanes, versions, Node pin and sha256 of each file
  agent/        agent code and ssam-agent.sh  agent/node/ the Node of the installer (only when it downloaded one)
  bin/o11/      Service Studio bridge (thin) and hook
  docs/         this guide and AGENTE-CLIENTE.md
  odc/studio/   ODC bridge                    odc/README.md  marker of the root of the ODC bridge
  odc/snapshots/  odc/journal/  odc/lab/  o11/   data (mirror of your space on the server)
  inbox/        files YOU deliver to the server (agent:inbox/<file>)
  private/      config.json, credential, node, installed.json, authority/, agent.log (only your user)
```

## Update the agent (new pack)

1. `~/SSAM-Agent/agent/ssam-agent.sh stop`.
2. Quit ODC Studio and Service Studio after saving your work (each keeps the old bridge loaded until it quits).
3. Extract the new pack over the same folder: `tar -xzf ~/Downloads/ssam-agent-mac.tar.gz -C ~/SSAM-Agent`.
4. `bash ~/SSAM-Agent/install.sh`: it keeps the credential and the server and starts the new agent.

## Uninstall

`~/SSAM-Agent/agent/ssam-agent.sh uninstall` stops the agent and removes exactly what the pack and `install.sh` put
there: the files listed in `pack.json`, `pack.json`, the Node of the installer (`agent/node/node` and its `LICENSE`),
the files of `private/` that the setup recorded in `private/installed.json` (configuration, credential, Node path,
key, state and log) and, when they are left empty, the folders the pack and the setup created. It never deletes through
a link: a link anywhere in a path keeps that item, and the result names it. Anything else, such as folders that still
hold your work (`inbox/`, `odc/`, `o11/`), is kept and named; delete it yourself when you no longer need it. A bridge
already loaded stays in an open Studio until it quits.

## Corporate proxy and certificates

- Proxy: `export HTTPS_PROXY=http://proxy.company:8080` (and `NO_PROXY` if needed) in `~/.zshrc`, open a new Terminal
  and run `~/SSAM-Agent/agent/ssam-agent.sh stop` and `start`.
- Company certificate (TLS inspection): install the company CA in the macOS keychain; the agent starts Node with
  `--use-system-ca`, which trusts it.

## Known limits

- The attach needs the Studio's .NET diagnostic socket and its startup hooks. A Studio build that turns either off
  cannot be attached (the doctor says so).
- The Service Studio connection needs one trusted start time reader (`perl`, `osascript` or `sysctl`); the doctor
  shows which ones work on your Mac and why the others do not.
- The bridges are the ones of the Windows pack; dialogs and windows of the Studio on macOS have not been proven in
  every operation yet. Report anything odd with `ssam_friction` and send `doctor --json` to the owner.

### Bundle detection and connection are separate checks

On macOS the lane names `ServiceStudio.exe` and `ODCStudio.exe` are protocol labels, not files to find.
The agent reads application bundles in `/Applications` and `~/Applications` (also one vendor folder below them).
Within `Contents` it looks for any marker of the family:

- ODC: `ODCStudio.dll` or `OutSystems.Model.dll`.
- Service Studio 11: `ServiceStudio.dll`, `ServiceStudio.Framework.dll` or `OutSystems.Model.V1.dll`.

ODC markers take precedence across the bundle, since ODC can include Service Studio assemblies too.
The markers need not share a folder. There is no fixed depth limit inside `Contents`; framework resource folders
are included. The scan reads at most 400 folders, does not follow links and does not enter nested helper apps.
A bundle name alone is not enough. A scan that exceeds the folder budget is not classified.
The version comes from the entry DLL's ProductVersion, then a family marker DLL, then `Info.plist`.
The running process must still match `Contents/MacOS/CFBundleExecutable` exactly.

Detection does not mean the bridge supports that Studio version. The pack's built-for version and the server's
version checks still apply. Connecting also needs the .NET diagnostic socket, .NET 8 or newer, startup hooks,
and for Service Studio the checked start time and readable loaded DLL list. A Studio using another runtime or
process layout can be detected without being attachable. These conditions need a test on the actual Mac.

For a detection problem, send the output of `bash ~/SSAM-Agent/agent/ssam-agent.sh doctor --json` and only the
`agent.log` file, with the installed pack ID, the Studio version and whether it was open. Never send the whole
`private` folder, `credential`, `config.json` or keys. If the bundle is still absent, the owner may also need a
list of DLL and runtimeconfig file paths under its `Contents` and the Info.plist version and executable fields;
no Studio DLL needs to be sent.
