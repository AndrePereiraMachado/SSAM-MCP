# SSAM Agent desktop app

## Install and activate

On Windows, run the installer. The app opens when installation finishes.
On Mac, drag SSAM Agent from the DMG to Applications and open it.
Enter the activation token supplied by your administrator, then select
**Activate and connect**. The service is preconfigured as `https://mcp.ssam.pro`.
There is no server address or data-folder field. No terminal, SDK or compilation
is required. The token is stored locally with restricted permissions and is
never included in the installer.

## Everyday use

- **Connect** starts the agent connection.
- **Disconnect** stops it gracefully.
- **Check connection** checks service health and the agent's recent connection state.

The status shows whether the computer is connected. **Replace token** is available
for credential rotation. Logs, package details and update configuration are not
shown in the panel. The app keeps running in the system tray/menu bar when the
window closes. Use **Quit SSAM Agent** there to exit completely.

## Updating this unsigned test build

Quit SSAM Agent before replacing it with a new installer. Keep your activation
token private. On Mac, an unsigned build may require approval in System Settings,
Privacy & Security. This build is not notarized and does not update itself.

## Local data

The desktop app manages data under `%APPDATA%/SSAM-Agent/data` on Windows and
`~/Library/SSAM-Agent/data` on Mac. It migrates the recognized old default folder
only when no agent is using it and the destination is absent. Existing custom
folders and conflicting destinations are preserved. Runtime binaries stay in
the installed application; hiding details from the UI is not encryption.

## Validation scope

Installer checks cover package integrity, activation against an isolated test
service, connect/disconnect, service-health failure and the native supervisor.
Live integration with each supported Studio version requires separate testing.
