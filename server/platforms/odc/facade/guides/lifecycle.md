# SSAM: install, license, setup, connect, update

Everything happens through the MCP tools of this server. No step needs a terminal. A refusal always carries the next call:
`continuation: {tool, arguments, why}`. Follow it; never improvise another route. `ssam://guide/refusals` lists every code.

## First run

1. `ssam_status {}`: release, integrity, signatures, license state, Studios found, connections, registered clients and `nextSteps`.
2. `ssam_license {action:"activate"}`: answers `ACTIVATION_PROMPT_OPENED`. A private Windows window opens; the person types the activation code there, never in the chat. The code is never a tool argument.
3. `ssam_license {action:"status"}`: `active`, with `renewAfter`, `expiresAt` and `graceUntil`.
4. `ssam_setup {action:"plan"}`: Studios found, free ports, tenants seen, registration in each client. If something must change: `ssam_setup {action:"apply", defaultTenant, authorize}` with the user's own words.
5. The person opens the Service Studio or the ODC Studio normally. `ssam_connect {lane, dryRun:true}` only checks; `ssam_connect {lane}` attaches.
6. `ssam_doctor {}`: one line per check (install, license, license-gates, runtimes, signatures, studios, compat, ports, authority, vault, clients, workers).

## Always available

`ssam_status`, `ssam_doctor`, `ssam_license`, `ssam_update` and `ssam_setup {action:"plan"}` answer in every license state, with or without a Studio. The tool list never changes; a lane tool without a valid license refuses with `LICENSE_<STATE>` and its continuation.

## License states

| state | lane tools | next call |
|---|---|---|
| `not_activated` | refuse `LICENSE_NOT_ACTIVATED` | `ssam_license {action:"activate"}` |
| `active` | work | none |
| `expiring` | work; the server renews by itself | `ssam_license {action:"renew"}` if renewal keeps failing |
| `grace` | work; every answer carries `licenseWarning` | `ssam_license {action:"renew"}` |
| `expired` | refuse `LICENSE_EXPIRED` | `ssam_license {action:"renew"}` |
| `revoked` | refuse `LICENSE_REVOKED` | `ssam_license {action:"status"}` |
| `clock_invalid` | refuse `LICENSE_CLOCK_INVALID` | fix the Windows clock, then `ssam_license {action:"renew"}` |
| `installation_mismatch` | refuse | `ssam_license {action:"activate"}` with a new code |
| `release_too_old` | refuse `LICENSE_RELEASE_TOO_OLD` | `ssam_update {action:"install", source:{packagePath}, authorize}` |

A refused call changes no data and no Studio. Bridges already attached refuse per request and come back after renewal, without a new attach.

## Words and secrets

- `authorize` is always the user's own words, quoted verbatim, never a paraphrase and never written by the model. Only their sha256 is kept. A continuation shows `"<the user's own words>"` where the words go: ask the person.
- Credentials and activation codes are never arguments. `ssam_credentials {action:"prompt", kind, host}` opens the private window and answers `CREDENTIAL_PROMPT_OPENED`; `ssam_credentials {action:"status", kind, host}` answers booleans only; `ssam_credentials {action:"forget", kind, host, authorize}` removes an entry.
- Kinds: `o11-service-center`, `o11-lifetime`, `o11-debugger`, `o11-db-connection`, `o11-site-property`, `odc-api-client`, `odc-portal`, `odc-db`, `odc-setting`.

## Connect

- `ssam_connect {lane:"o11"|"odc", pid?, dryRun?}`. The answer has `compat {baseline, bridgeId, failures[]}`, `bridges [{bridgeId, port, state}]`, `selftest.unavailable[]` and, after an update, `upgrade {from, to}`.
- A Studio below the supported base, or with a changed surface, is refused before anything is sent to it (`INCOMPATIBLE_STUDIO`): `ssam_doctor {lane, checks:["compat"]}` shows members and versions.
- A Studio that already holds a checkout bridge is refused by default (`LEGACY_BRIDGE_LOADED`). Prefer another Studio. Going on beside it needs `coexistLegacy:true` and the user's words, after the risk warning.
- Several Studios open: pass `pid` (`ssam_status` lists them).
- Never ask the person to close, save, publish or restart a Studio to connect.

## Update

1. `ssam_update {action:"check"}`.
2. `ssam_update {action:"install", source:{packagePath}, authorize}`: checks the signature, the hashes and `minRelease`, installs beside the current release and answers `reconnectRequired: true`.
3. The person reconnects the client (`/mcp` in Claude Code, or restarts Claude Desktop). Then `ssam_status {}`.
4. `ssam_connect {lane}` attaches the new bridge beside the old one (`upgrade {from, to}`); the old one retires. The Studio stays open.
5. `ssam_update {action:"prune", dryRun:true}`, then `{action:"prune", dryRun:false, authorize}`: removes only releases with no live process and no connection record; never `data`.

`ssam_update {action:"rollback", authorize}` goes back to the previous release.

## In a session

- Information is missing: ask one short question in the chat, never a questionnaire; the rest follows the defaults the answer states.
- A defect of SSAM itself (a wrong refusal, a crash, a missing capability) is already recorded by `ssam_friction`: say so and go on. Its fix is a task for the SSAM developers in an isolated worktree; never edit the active SSAM folder from an app session.

## Long tasks and proofs

A call still running at 25 s returns the same tool with `continueTask`: call it to wait for the final answer, never sleep or repeat; `ssam_task {id}` reads its evidence. `ssam_reprove {lane, scope:"release-stampable"}` reruns the stampable proofs with the release's own tools, in the background. `ssam_friction` reads where a task got stuck (issues and the current task).

## Done by the person, outside the MCP

Run the installer; reconnect the client after installing or updating; type the activation code and credentials in the private window; uninstall through Installed apps; give the words that authorize a publish (once, or as a standing grant); answer in the Studio a web dialog the bridge cannot read; bring an update package to the machine; create O11 user accounts.
