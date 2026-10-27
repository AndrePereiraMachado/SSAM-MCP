# SSAM Agent, the desktop app (customer guide)

The SSAM agent of `AGENTE-CLIENTE.md` (Windows) and `AGENTE-MAC.md` (macOS), delivered as a desktop app that runs in
the background: an icon in the tray (Windows) or the menu bar (macOS), no window until you open the panel, the agent
started with the app and kept running, and the app itself updated from the server owner's update server.

What the agent does, what it sends and what it never does are exactly what those guides say. The app runs its
bundled agent from the installation, shows its state and stops it cleanly. The agent folder holds writable data.

## What you get from the server owner

| Item | For what |
|---|---|
| `SSAM Agent` installer (`ssam-agent-app-<version>-setup.exe` on Windows, `ssam-agent-app-<version>-mac-<arm64 or x64>.dmg` on macOS) | the app, with the agent pack inside |
| server address (`https://...`) | where the agent and your MCP client connect |
| MCP token (`ssam_...`) | goes in the configuration of your MCP client |
| agent credential (`ssam_agent_...`) | goes in the app, in the setup panel |

The token and the credential are different and one does not work in place of the other. Each is shown to the owner
once only: keep both in a password manager, never in a repository or a chat.

## Prerequisites

- Windows 10 or 11, or macOS 13 or newer (Apple silicon or Intel).
- No Node to install: the app carries its own.
- Windows: the .NET 10 runtime for the ODC attach client and, for O11, the .NET 8 runtime or newer for the connector
  (`AGENTE-CLIENTE.md`). macOS: nothing of .NET (`AGENTE-MAC.md`).
- ODC Studio and/or Service Studio in the SAME version as the server's kernel (`ssam_doctor` in your MCP client shows
  both).
- An agent folder **without spaces**, of its own. The default is `%USERPROFILE%\SSAM-Agent` on Windows and
  `~/SSAM-Agent` on macOS. On Windows it must be outside `%LOCALAPPDATA%` (the installer puts the APP there; the
  agent folder is another one); if your user name has a space, use `C:\SSAM-Agent`.

## Install and set up

1. Run the installer. Windows: a per-user install, no administrator, the app starts at the end. macOS: open the DMG
   and drag `SSAM Agent` to Applications, then open it.
2. The first time, the panel opens by itself ("Not set up"). Enter the server address, paste the agent credential (it
   is not shown and never shown again), keep or change the agent folder, and press **Save and start**.
3. The app verifies its installed agent pack and saves the credential in the data folder in a file only your user can read
   (`private\credential`; on macOS `private/credential`, mode 0600 in a folder closed with 0700), starts the agent and
   shows **Connected** when the server accepted it.
4. **Run doctor** in the panel checks the same things the agent's own `doctor` checks: the folder, the pack, the
   runtimes, the Studios and whether the server answers.

The app opens with the computer: it registers itself as a login item of your user and, at login, starts minimized to
the tray (no window) with the agent connected. "Open SSAM Agent when I log in" in the panel and the tray turns that
off; then nothing starts by itself, as with the command-line agent.

## The tray

The icon shows the state: grey (stopped), amber (starting or reconnecting), green (connected), red (needs you: not
set up, or the agent stopped for good). The menu: open the panel, start or stop the agent, open the agent folder and
log, check for updates (or restart to install one), start at login, quit. On Windows a click on the icon opens the
panel; on macOS a click opens the menu.

## The panel

- **Agent**: the server, the folder, the pack (id, lanes, bridge versions) and the process. Buttons for the folder,
  the agent log, the doctor and **Change setup** (a new credential after a rotation, another server or folder; the
  agent is stopped first).
- **App updates**: the version, the state of the last check, **Check for updates** and, when one is downloaded,
  **Restart to update**. Under "Update server" you may replace the server the build fixed (https only); empty means the
  built-in one.
- **Agent log**: the last lines of `private\agent.log` (no secret is ever written there).

## When the agent stops

The app starts the agent with the app and starts it again after a crash (5, 10, 20, 40, then 60 s). It does NOT start
it again when the agent stopped for a reason only you can fix; the icon goes red and a notification says which:

| Code | Reason | What to do |
|---|---|---|
| 2 | credential refused, revoked, expired or replaced | ask the owner for a new credential and use **Change setup** |
| 3 | another agent with the same credential took over the account | leave one agent per account |
| 4 | the server does not accept this version of the agent | install the current version of the app |

Network gone or server restarted: the agent itself reconnects (1, 2, 4, 8, 16, 30 s); the icon stays amber meanwhile
and the tools of your MCP client answer `AGENT_RECONNECTING`.

## App updates

The owner publishes new versions of the app on an update server. The app asks it shortly after each start and every
6 hours, downloads a new version in the background and installs it by itself a few seconds later: the agent is
stopped cleanly, the app restarts and the agent reconnects. No click is needed; the panel shows what is going on, and
**Restart to update now** installs it at once. A new version of the app carries the agent pack that goes with it:
on the next start the app runs the new installed pack, keeping `private\`, `inbox\`, `odc\` and `o11\` as
they are. Old source copies from earlier installations are preserved but are no longer executed. Quit ODC Studio and Service Studio before, as the
guides say: a Studio keeps the old bridge loaded until it quits.

Without an update server (the panel says "Updates are off"), the owner sends you the new installer; run it over the
installed app.

## Folders

- The app: `%LOCALAPPDATA%\Programs\ssam-agent-app` (Windows) or `/Applications/SSAM Agent.app` (macOS). Its own
  settings and log (`settings.json`, `app.log`): `%APPDATA%\ssam-agent-app` or `~/Library/Application Support/ssam-agent-app`.
- The agent folder (`SSAM-Agent`): the layout of "Folders" in `AGENTE-CLIENTE.md` and `AGENTE-MAC.md`. Files you
  deliver to the server go in `inbox\`, as before. The app does not copy its source tree into this folder.
  ODC bridge v98 or newer binds its snapshots and journal here before it accepts application commands.

## Corporate proxy and certificates

The app starts the agent with the two Node options the guides describe: `--use-env-proxy` (the `HTTPS_PROXY` and
`NO_PROXY` of your user) and `--use-system-ca` (the certificates of Windows or of the macOS keychain). Set the
variables for your user, then quit and reopen the app. The app's own update check follows the system proxy.

## What the app never does

- Open a port, run an LLM, or run anything on your machine the agent would not run ("What the agent NEVER does" in
  `AGENTE-CLIENTE.md`).
- Show, log or send the credential anywhere but to the agent's own `private\credential`.
- Install an update it did not fetch over HTTPS from the update server, or one that is not a newer version.
- Touch `private\`, `inbox\`, `odc\` or `o11\` of the agent folder, beyond what the agent itself does.

## Uninstall

Quit the app (the agent stops cleanly), then remove it: Windows, "Apps" in Settings (or the uninstaller in the app's
folder); macOS, drag `SSAM Agent.app` to the Trash. The agent folder stays with your work; delete it yourself. A
bridge already loaded stays in an open Studio until it quits.
