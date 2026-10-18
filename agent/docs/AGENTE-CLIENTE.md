# The SSAM agent on your machine (customer guide)

## What it is

- You use YOUR MCP client (Claude Code or another one) with YOUR LLM, on YOUR account. It calls the tools of the owner's
  SSAM server over HTTPS, with a token.
- The server keeps what belongs to the owner (kernel, catalog, rules, recipes). **No LLM runs on the server.**
- The SSAM agent runs on your machine and does only what has to touch your machine: talk to the ODC Studio and the
  Service Studio that YOU opened, list those processes, and read and write files inside its own folder.
- The connection is OUTBOUND only, from your machine to the server. No port is opened on your machine.
- Everything that uses your Studio session (ODC Portal/tenant, Service Center, O11 environment) runs inside YOUR Studio.
  The Studio login, cookies and tokens never leave the Studio process; the server receives only the result of each
  step.
- OMLs travel between the server and the agent with a sha256 check. They never go through the LLM.

## Privacy: what the server records about your access

Only the server owner sees the log, the audit and the quality record described below. They stay on the owner's server and are not passed on to third parties.

**Server log.** To know who uses each access and from where, the server writes, on each line, the time, the event and the identifier of your access:

- **When your MCP client opens a session:** the name the owner gave your access, the MCP session number, the IP you connect from, the name and version of the MCP client (for example, Claude Code) and the user-agent. The IP is the public one the tunnel sees. It changes if you switch network, VPN or 4G. When the session closes, the reason.
- **When the agent connects:** the IP, the agent version, the computer name, your Windows user and a machine identifier. The identifier is a hash of the Windows `MachineGuid` with those two and does not allow recovering them. Also the version of each installed Studio (only the number, without the folder). With the Service Studio connected to the agent, also its version, the local port, the process number and the time it opened.
- **When the server does not serve your Studio:** the platform (O11 or ODC), the version of your Studio, the server's version, how the two compare, the cause and the owner's rule for different builds. Once per version, so the owner knows who needs an update (yours or the server's).
- **On each call:** the tools (only those of the server's list; any other name becomes `?`), the size of the answer and the time. In a call to the agent, the kind, the command (only from the agent's list), the time, whether it succeeded and the result code.
- **The agent's channel:** when it connects, drops or comes back, with the reason; and the problems of the channel (a refused request, an unknown message, a file that arrived different or expired), with the code, the type and how many. A file part that is slow to upload is kept with its size, the time and the IP without its last number.

**The first machine is recorded.** On the agent's first connection, the server keeps the computer name, your Windows user, the identifier, the time and the IP. If your credential connects from another machine, the access keeps working, but the owner gets an alert with the time, the name of your access, the two machines and the IP. Changed computers? Tell the owner. Switching network, VPN or 4G does not raise a machine alert.

**What the agent sends and is not stored.** On each connection, the agent also sends the folder it is in (it usually contains your Windows user), the Node version, the system, the time the agent started, what it can do, the installed pack and the folder of each installed Studio. The server uses this data only in memory, to check the versions and for `ssam_doctor`. It does not go to the log, the audit or the quality record.

Nothing else about your machine is sent: no file from outside the agent folder, no history, no other program. If you do not agree, do not install the agent and talk to the owner.

**Audit and quality record.** For each tool call, the server keeps only codes, counts and times. The codes come from a closed SSAM list. A value outside the list becomes a fixed marker, such as `CODE_UNLISTED`, and is only counted.

- **On every line:** the time, the identifier of your access, the name the owner gave it and a digest of the MCP session that does not allow recovering it.
- **The call:** the tool (only from the server's tool list; any other name becomes `?`), the action chosen in it (from the tool's list), the platform (O11 or ODC), the order in the session, the duration, the interval since the previous answer and how many calls were running together.
- **The result:** whether it succeeded, was refused, was left uncertain or failed; the code; the step where it stopped; and whether it was `entregue` (delivered), `entregue e publicado` (delivered and published) or `criado` (created).
- **The answer:** how many problems of each code (by phase, how many were warnings, how many came with a ready fix and whether the list was cut), how many warnings (and how many severe), how many automatic fixes of each rule, the size, whether it came in pages and how the server read it.
- **The time:** how long each phase took (queue, capture, compilation, Studio, verification, publication, environment, transfer, network and the server itself); how many calls to the agent, of which kind and command, with how many bytes, how much time and how many failures; how many times the engine ran and how long it took.
- **The request, only its shape:** how the job came (in the request, in a file or in the agent folder), whether it used `basedOn`, `partial`, `closePrevious`, `publish` or `until`, how many patches and the size in bytes.
- **The MCP session:** when it opened and closed, the reason, how many calls it had and the family of the MCP client (Claude Code, Codex, Cursor...).

Nothing of your work goes into the audit or the quality record: no name of a module, screen, action or entity, no job, expression, message, file path, environment address or text of yours. The owner sees these numbers per customer and summed over all customers, to find the most common errors and what makes SSAM slow.

**For how long.** The owner chooses for how many days each of these records is kept. The default keeps the log for 56 days and the audit and the quality record with no time limit. The 56 days hold with the server's weekly cleanup turned on; without it, the log stays until the owner deletes it. The first-machine record and the other-machine alerts have no time limit: they stay until the owner deletes them. The server's backups carry the same files.

**Your space on the server** (`ws:`) keeps the files of your work (jobs, captures, receipts and journals) and the friction queue of your access: for each call, the operation, the platform, the result, the code, the step and the time, and the text of the reports your MCP client writes with `ssam_friction`. You and the owner see this space.

## What you get from the server owner

| Item | What for |
|---|---|
| `ssam-agent.zip` | the agent pack (the agent code, Node with its license, the Studio bridges, this guide, `pack.json` with the sha256 of each file) |
| the server address (`https://...`) | where the agent and the MCP client connect |
| the MCP token (`ssam_...`) | goes in the configuration of your MCP client |
| the agent credential (`ssam_agent_...`) | goes in the agent, through `setup` |

The token and the credential are different, and neither works in place of the other. Each one is shown to the owner only
once: keep both in a password vault, never in a repository or a chat.

## Prerequisites

- Windows 10 or 11.
- Node: no need to install it. The pack carries `agent\node\node.exe` (Node 24, with the options `--use-env-proxy` and
  `--use-system-ca`) and, next to it, `agent\node\LICENSE`, the Node license, which goes with the binary.
  `ssam-agent.ps1` uses this Node. Only a pack built without Node (the owner tells you) needs Node 24 installed (the
  `doctor` checks the two options).
- The .NET 10 runtime for the attach client of the ODC bridge (`ODC3.Bridge.Client`). For O11, also the .NET 8 runtime
  or newer for the connector (`Anvil.Connect`).
- ODC Studio and/or Service Studio in the SAME version as the server kernel (the `ssam_doctor` of your MCP client shows
  both versions). The ODC Studio must be in the official path, `C:\Program Files\OutSystems\ODC Studio\ODC Studio` (the
  attach client accepts only that one).
- A folder for the agent **without spaces** and **outside `%LOCALAPPDATA%`**. The default is `%USERPROFILE%\SSAM-Agent`;
  if your user name has a space, use `C:\SSAM-Agent`. (The ODC bridge splits its commands at spaces; and the processes
  of Store apps see a different `%LOCALAPPDATA%`, so the Studio would not find the bridge there.)

## Install

```powershell
Expand-Archive .\ssam-agent.zip -DestinationPath C:\SSAM-Agent
C:\SSAM-Agent\agent\node\node.exe C:\SSAM-Agent\agent\ssam-agent.mjs setup --server https://ssam.example.com --root C:\SSAM-Agent
```

In the `node ...` commands of this guide, `node` is the pack's `C:\SSAM-Agent\agent\node\node.exe` (or the installed
Node 24, in a pack without Node).

- `setup` asks for the agent credential: paste it and press Enter (it does not appear on screen). Or use
  `--credential-file <file>` (and delete the file afterwards). The credential never goes as an argument, is never shown
  and stays in `private\credential`.
- Before it writes the credential, `setup` restricts `private\` to your user:
  `icacls <folder>\private /inheritance:r /grant:r "<DOMAIN\user>:(OI)(CI)F"`.
- `setup` refuses a folder with a space (pass `--root C:\SSAM-Agent`), an `http://` address that is not of the machine
  itself and a credential outside the `ssam_agent_...` format.
- `--o11-port <port>` changes the local port of the O11 bridge in your Service Studio (default 4516). Use it when another
  tool already uses 4516 on this machine.
- If PowerShell blocks scripts, run the `.ps1` files with `powershell -ExecutionPolicy Bypass -File <script> <action>`.

## Start, stop and check

```powershell
C:\SSAM-Agent\agent\ssam-agent.ps1 start     # starts in the background and waits for the connection (up to 30 s)
C:\SSAM-Agent\agent\ssam-agent.ps1 status
C:\SSAM-Agent\agent\ssam-agent.ps1 stop      # clean stop: tells the server and exits
node C:\SSAM-Agent\agent\ssam-agent.mjs doctor
```

- No Windows service and no administrator. The pid, the state and the log stay in `private\` (`agent.log`, without any
  secret).
- `start` says "connected" only when the process it started has connected. If the agent stops, it says why:

| Code | Reason | What to do |
|---|---|---|
| 2 | credential refused, revoked, expired or replaced | ask the owner for a new credential and run `setup` again |
| 3 | another agent with the same credential took over the account | keep only one agent per account |
| 4 | the server does not accept this agent version | ask the owner for the current pack |

- Network down or server restarted? The agent reconnects by itself (1, 2, 4, 8, 16, 30 s) and continues where it
  stopped: a step already delivered never runs twice.
- While it reconnects, the tools answer `AGENT_RECONNECTING` with `retryAfterSeconds`: your LLM repeats the same call
  after that time. Nothing needs a restart. Only `AGENT_NOT_CONNECTED` asks you to start the agent.
- Since agent 0.2.0: a send of messages gives up after 10 s (plus 1 s per 64 KiB) and goes again; the pong goes in a
  send of its own; a stream without an answer in 15 s is redone at once. A stuck send no longer brings the channel down.
- Since agent 0.2.1: a network or IP change (Wi-Fi, 4G, VPN) in the middle of a task delays a file part by about 11 s
  (before, 20 to 50 s). Each part has its own deadline (10 s, plus 1 s per 64 KiB) and, without an answer, goes again on
  a new connection; connections idle for more than 2 s are not reused; a dead connection drops in about 15 s. Each new
  attempt appears in `private\agent.log` as `blob-retry`.
- Since agent 0.3.0 (the pack with the ODC bridge `v96`): the Service Center through the Studio session (`sc_http`) and
  the list of producers of an ODC module (`reference-producers`). With an older pack, these tools answer
  `STUDIO_BRIDGE_OUTDATED` or `COMMAND_NOT_ALLOWED`: ask the owner for the new pack.
- Agent 0.3.1 (the pack of the 24th release) joins the two and answers the network test of
  `ssam_doctor {network:true}` (throwaway sends on new connections; nothing of the machine is read or written).
- Agent 0.3.2 (the pack of 2026-10-18): its Service Studio bridge runs the Studio's own Manage Dependencies by code,
  without a click: `o11_studio refresh-references` with `add` or `published`, and a delivery that needs new elements of
  a module, an extension or a system producer. With an older pack these calls answer
  `MANAGE_DEPENDENCIES_HOSTED_PENDING` and nothing is sent: install the new pack and restart Service Studio.
  During the Manage Dependencies the bridge closes only the Studio's error report, the dependencies dialog and a box
  with only OK. Any other window (a sign-in, a question, a window you opened in another tab) stays as it is: the call
  then answers `STUDIO_DIALOG_PENDING` with its title. Answer it in the Studio, then repeat the call.
- In the foreground, to see errors on screen:
  `node --use-env-proxy --use-system-ca C:\SSAM-Agent\agent\ssam-agent.mjs run --root C:\SSAM-Agent`.
- `doctor` checks the Node options, the folder, the integrity of the pack (`pack.json`), the configuration, the
  credential (without showing it), the .NET runtimes, the installed Studios and whether the server responds.

## Configure the MCP client

Keep the MCP token in a terminal variable (not in a file of the repository) and use this as the `.mcp.json` of your
project, replacing `<host>`:

```powershell
$env:SSAM_TOKEN = "ssam_..."
```

```json
{"mcpServers":{"ssam":{"type":"http","url":"https://<host>/mcp","headers":{"Authorization":"Bearer ${SSAM_TOKEN}"}}}}
```

Or: `claude mcp add --transport http ssam https://<host>/mcp --header "Authorization: Bearer $env:SSAM_TOKEN"`.

Then, in the MCP client: `ssam_doctor` shows the agent connected and the versions; `studio_attach` connects the open ODC
Studio; `ssam_connect {lane:"o11"}` connects the open Service Studio. Without the agent, the tools that need your machine
answer `AGENT_NOT_CONNECTED`, and the ones that run only on the server keep working.

## What the agent does

Only these 10 requests. Any other one is refused without running anything (`KIND_NOT_ALLOWED`); the server never sends
code, scripts or DLL paths.

| Request | What it does on your machine |
|---|---|
| `studio.processes` | lists the `ODCStudio.exe` / `ServiceStudio.exe` processes and the version of each one |
| `odc.pipe` | sends a command of the closed list to the ODC bridge of your ODC Studio |
| `odc.attach` | loads into your ODC Studio the ODC bridge OF THE PACK, with the attach client of the pack |
| `o11.bridge` | sends a method of the closed list to the O11 bridge of your Service Studio |
| `o11.connect` | loads into your Service Studio the thin O11 bridge of the pack (ready binaries; nothing is compiled here) |
| `o11.selected` | checks whether the connected Service Studio is still the same one |
| `file.put` / `file.get` / `file.list` | writes, reads and lists files only in the folders below |
| `file.sync` | writes at once the several files of a step (agent 0.2.0), with the same rules as `file.put` |

- Accepted ODC commands: `status`, `wait`, `authorize`, `open`, `snapshot`, `latest`, `check-base`, `preview`, `merge`,
  `publish`, `publish-status`, `publish-log`, `dismiss-dialog`, `close`, `module-info`, `assets`, `consumers`, `create`,
  `create-app`, `templates`, `template-download`, `refresh-references`, `reference-snapshot`, `reference-producers` (the
  producers the open module can reference; read only, ODC bridge `v96`), `data`, `data-insert`, `data-update`,
  `data-delete`, `portal-call`, `portal-session`, `auth-status`, `stop`, `query-test` (the native test of an SQL query or
  Aggregate, ODC bridge `v45`; the capture it reads also stays in the agent folder).
- Accepted O11 methods (the 23 of the thin bridge): `ping`, `bridge_manifest`, `get_active_module`, `list_open_modules`,
  `get_errors`, `open_module`, `close_module`, `publish`, `windows`, `ui_alive`, `close_dialog`, `snapshot_module`,
  `merge_from_oml`, `merge_status`, `environment_session`, `sc_api`, `sc_web`, `sc_http` (the Service Center through the
  Studio's own session, without a window), `studio_login` (only answers that the Studio session is missing; it never
  opens the login dialog), `sc_session`, `publish_log`, `refresh_references` (the Studio's own Refresh References; Ctrl+Z
  undoes it), `answer_dependencies_dialog` (answers Cancel to the "Incompatible or missing dependencies found" dialog;
  then the server asks for the Refresh References).
- Never through the agent: the private transport of the Service Center (`sc_private_http`) and the private Portal
  commands (`portal-private-*`). They use a local vault and a local pipe, which do not cross machines.
- The O11 bridge of the pack is the THIN bridge: only the primitive operations of the Studio (open and close a module,
  capture the open module, the native merge of a ready OML, publish, the environment session, the Service Center, data,
  dialogs). It does not carry the SSAM kernel: all the logic runs on the server. The agent talks only to this bridge; if
  the Service Studio already has another Anvil bridge loaded (opened by another shortcut), `o11.connect` refuses with
  `ATTACH_FAILED` without loading anything: close the Service Studio and open it normally.
- Before each step in the Studio, the agent checks the version of the chosen PROCESS against the server kernel
  (`STUDIO_VERSION_MISMATCH`): side-by-side installations and the automatic update of the ODC Studio do not pass. When
  the ODC Studio updates itself (1.7.28, on 2026-10-12), the ODC lane stays refused until the owner puts the kernel of
  that version on the server; the pack you already have stays accepted while its bridge is in `odcBridgeAccepted`.
- After the attach, the agent uses only the O11 bridge that is the file of YOUR pack (sha256 of `pack.json`). Another
  bridge answers `BRIDGE_VERSION_MISMATCH`: nothing more is sent to it; restart the Service Studio.
- A pack with the release hook (the owner tells you) carries `release.json`, `release.sig.jws` and the folder
  `studio\o11\`. The agent checks the signature of the pack before the attach and writes a single request file in
  `%USERPROFILE%\.ssam-hybrid\data\o11\runtime-connect\<pid>-<start>`; the hook checks the files again before it loads the
  bridge. A changed pack file refuses the attach.
- Service Center writes through the O11 bridge of the pack: without `corporateHosts` in your
  `%USERPROFILE%\.ssam-hybrid\config.json`, every environment counts as corporate, and each write needs your explicit
  instruction for that environment.
- The key of the O11 bridge is generated on your machine (`private\authority\bridge.key`) and never leaves it.

## What the agent NEVER does

- Open a port, accept a connection from outside or run an LLM.
- Run another program, script or command that is not in the lists above. `attach` through `odc.pipe`, `login`,
  `export_*`, `find_element` and `get_flow_nodes` are refused.
- Read or write outside the allowed folders: paths with `..`, absolute paths, UNC paths, alternate streams (`:`), device
  names, and links or junctions that escape are refused before any access. The bridge receives only paths inside the
  agent folder, including the ones inside a manifest.
- Send the server your password, the cookies or tokens of the Studio, or the agent credential.
- Show the credential on screen or in a log.

## Folders

```
C:\SSAM-Agent\
  agent\        agent code                  bin\       thin O11 bridge, hook and Anvil.Connect (O11 only)
  agent\node\   node.exe and LICENSE (the Node of the pack and its license)
  docs\         this guide (AGENTE-CLIENTE.md)
  odc\studio\   ODC bridge and client       odc\README.md  marker of the root of the ODC bridge
  odc\snapshots\  odc\journal\  odc\lab\    ODC data (mirror of your space on the server)
  o11\          O11 data (mirror)           inbox\     files YOU deliver to the server
  private\      config.json, credential, authority\, o11-connection.json, agent.log (only your user)
  pack.json     id, lanes, versions and sha256 of each file of the pack
  studio\o11\   only in the pack with the release hook: hook\Anvil.Hook.h1.dll and bridge\b1\ (the thin bridge)
  release.json, release.sig.jws   only in the pack with the release hook: the owner's signature over each file
```

| The server may | Folders |
|---|---|
| write | `odc\snapshots`, `odc\journal`, `odc\lab`, `o11` |
| read | the same ones and `inbox` |

`agent\`, `bin\`, `docs\`, `studio\`, `private\`, `odc\studio\`, `odc\README.md`, `pack.json`, `release.json` and
`release.sig.jws` are never read or written by the server.

## Deliver a file to the server

Put the file in `C:\SSAM-Agent\inbox\` and tell your LLM the name `agent:inbox/<file>` (for example
`agent:inbox/Quotes.oml`). Jobs do not go through there: the LLM sends the job inside the call itself (inline, in compact
JSON), straight to the server, without an upload through the agent. A job that is already in the inbox still works.
An absolute path inside the agent folder
(`C:\SSAM-Agent\inbox\job.json`) counts as the same `agent:` path; any other path is refused with the exact place to
write it. `ssam_doctor` shows the folder (`agent.inbox`). The server reads this file only when a tool asks for it. The
paths the tools return appear as `ws:odc/...`, `ws:o11/...` or `ws:inbox/...` (your space on the server).

## Network test

Slow or stuck deliveries? Ask your LLM for `ssam_doctor {network:true}`. In about 5 s the agent uploads a few small
sends and two of 1 MB, each one on a new connection, and the server tells, per exit of your internet, whether the
uploads go through. For example: one of your internet exits (177.26.87.x) loses packets on uploads. This happens with a
router with two exits in load balancing, or with 5G and a tethered phone. The bytes of the test are random and
discarded; nothing of your computer is read.

## Corporate proxy and certificates

- Proxy: set `HTTPS_PROXY` (and, if needed, `NO_PROXY`) for your user, for example
  `setx HTTPS_PROXY http://proxy.company:8080`, open a new terminal and restart the agent. `ssam-agent.ps1` starts Node
  with `--use-env-proxy`, which makes the agent use these variables.
- If the company proxy refuses the connections of agent 0.2.1 and agent 0.2.0 worked, set `SSAM_AGENT_HTTP=fetch` for
  your user (`setx SSAM_AGENT_HTTP fetch`), open a new terminal, restart the agent and tell the owner.
- Company certificate (TLS inspection): install the company CA in the Windows certificate store. The agent starts with
  `--use-system-ca`, which trusts that store.
- When you run `node ... run` by hand, pass the two options yourself (example in the section "Start, stop and check").

## Update the agent (new pack)

When the owner sends a new pack (for example, the one with the ODC bridge `v97`, compiled against ODC Studio 1.7.28):

1. `C:\SSAM-Agent\agent\ssam-agent.ps1 stop`.
2. Close the ODC Studio and Service Studio, after saving your work (each keeps the old bridge loaded until it closes;
   Windows does not let the pack replace a bridge that a Studio has loaded).
3. Extract the new pack OVER the same folder:
   `Expand-Archive .\ssam-agent.zip -DestinationPath C:\SSAM-Agent -Force`. `private\` (configuration, credential, key),
   `inbox\`, `odc\` and `o11\` stay as they were: the pack does not carry those files.
4. `C:\SSAM-Agent\agent\ssam-agent.ps1 start` and `node C:\SSAM-Agent\agent\ssam-agent.mjs doctor`.
5. Open the ODC Studio normally and, in your MCP client, call `ssam_doctor`: `agent.agentVersion` shows the version of
   the new agent and the ODC lane is `ok`. Then `studio_attach` (or `ssam_connect {lane:"odc"}`) loads the new bridge;
   open Service Studio normally and `ssam_connect {lane:"o11"}` loads its new bridge.

Do not run `setup` again: the credential and the server address stay the same. An old pack with the new server answers
`AGENT_PACK_MISMATCH` (`ssam_doctor` shows both versions).

## Revocation and credential change

- The owner revoked your token (or it expired): the agent gets the notice and stops within 1 second (code 2); the calls
  of the MCP client get 403. Nothing else runs on your machine.
- The owner replaced the agent credential (`agent-rotate`): the agent stops (code 2, "rotated"). Run `setup` again with
  the new credential (the rest of the configuration stays) and then `start`.
- Another agent with the same credential started: the first one stops (code 3) so as not to compete with the second.

## Uninstall

`C:\SSAM-Agent\agent\ssam-agent.ps1 stop` and delete the folder. A bridge already loaded stays in the open Studio until
it closes.
