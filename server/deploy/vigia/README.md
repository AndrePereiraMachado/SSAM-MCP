# Studio watcher: reviewed execution and guarded deployment

This watcher may run automatically only from the dedicated `vigia-run` worktree, branch `server/vigia-run`, whose clean HEAD equals reviewed local `main`. Start its launcher from that worktree; it only fast-forwards from main. Development worktrees cannot load the vault, build client bridges, sign or publish. A separate immutable `vigia/pin-*` branch records each release pin; pinning never moves the execution checkout ahead of main.

## Activation prerequisites

Do not activate until R1 is live and merged into main, these changes are reviewed and merged, the agent implements Bridges Amendment 1, and the publisher checks pass for the actual inputs. The current locally installed `ServiceStudio.Framework.dll` was observed without Authenticode; the watcher deliberately refuses it under the pinned-publisher rule. Do not disable that check as a workaround.

Use a dedicated Windows account for the scheduled task. Restrict its vault, temp directory and checkout write access to that account and administrators. Install the code-signing certificate with a **non-exportable private key** (prefer a hardware-backed provider). That account needs the registry login and the configured SSH authorization. It must be logged on for this interactive scheduled task.

Prepare the clean execution worktree from reviewed main. Set `workspace`, `updateFrom: main`, `node`, private directories, Coolify resource, SSH known_hosts and the exact Compose project/PostgreSQL container in the configuration. `agentReleaseCommit` must be a full immutable commit on the reviewed `agent/release` line (`agent/release-*` and `agent/release/...` also work); the watcher archives that commit's `agent/` tree for O11 builds instead of using the server branch's agent tree. Do not point this at an agent development branch.

Run `set-secrets.ps1` from an ordinary Windows PowerShell terminal as the dedicated account. A virtualized MSIX LOCALAPPDATA is refused before any prompt/write. The script encrypts each secret with DPAPI CurrentUser plus application/purpose-specific entropy, generates Ed25519 once, and prints only its public key. Existing v1 vaults are refused; recreate/migrate deliberately, preserving the signing key. Pin the public key and signer identity in the reviewed agent release. The agent must preserve valid original Microsoft dependency signatures rather than expecting the owner's leaf signer on third-party assemblies.

Run the execution checkout's `vigia.ps1 -Config <absolute-config> -DryRun`, then its `install-task.ps1 -Config <absolute-config> -Workspace <absolute-vigia-run>` only after the prerequisites above. `-Show` never registers a task. The schedule is two hours plus logon with a 15-minute delay; existing process-identity lock, IgnoreNew and 8-hour task limit remain.

## Production baseline and transaction

An automatic round reads the actual Coolify compose and every running backend's pair, tag, registry digest, kernel, listing budget and telemetry. Local versions.json is never the automatic deployment baseline. An already served version is idle. Every retained pair keeps its live image and digest. Custom live environment settings, networks and volume declarations survive generation of the new compose.

The live response is encrypted under the private rollback directory. Only its hash, safe identities and encrypted-file reference travel through the release state. `deployment.json` never contains raw Coolify responses. Before backup and again immediately before PATCH, the live compose hash must equal the snapshot. Drift aborts without PATCH or restart.

Before a critical phase, the watcher requires the entire configured `deploymentMaxMinutes` reserve (default 180 minutes, including rollback) before its round deadline. It checks `C:/ssam-priv/vigia/PAUSE` and any additional configured pause file. A paused watcher only reports the deferral. A deployment/recovery already in progress completes under protection; its commands use `evenWhenStopping` and the round's seven-hour timer does not kill it.

A persistent SSH connection holds `flock -x /var/lock/ssam-release.lock` from before preflight/backup until successful checks or completed rollback. Every remote mutation requires that lease. The remote process has its own bounded timeout. Temporary private-key directories are removed in all handled outcomes; a trusted round cleans stale `ssh-<uuid>` directories before reading the vault.

All manual production writers must use the same lock:

```sh
sh /path/to/reviewed/deploy/vigia/with-release-lock.sh sh /path/to/manual-release.sh
# For individual kernel/features commands:
sh /path/to/reviewed/deploy/vigia/with-release-lock.sh sh /path/to/deploy/coolify/ssamctl.sh kernel write --version odc=VERSION /private/kernel.json
```

Do not use the Coolify UI or unwrapped scripts concurrently with a watcher deployment. The lease prevents cooperating writers, while the hash guards detect completed compose changes made before the PATCH.

Remote preflight reads `/proc/meminfo` and requires 1024 MiB MemAvailable per backend in the proposed window: 3072 MiB for three. It checks backup disk space before creating the backup. PostgreSQL and all live mounted volumes are backed up; the five latest complete backups are retained. Incomplete backups remain available for diagnosis and low disk prevents another run.

The staging container has a deterministic private name. Its old instance is removed by that exact name before creation. A pair already running is never prepared again. Kernel/features are written only through the stopped staging container, and the features copy is removed even if pull or creation fails. No volume is removed. A preparation failure cannot restart production: rollback begins only after `mutationStarted` is recorded.

Coolify writes use PATCH with base64 compose and `instant_deploy:false`, followed by POST restart. A failed mutation restores the encrypted original compose. Verification compares the original snapshot's images, kernels, listing counts/bytes, warm state, health and hello; it does not require the new release's listing budget. A rollback failure is always notified. A rolled-back candidate is latched until the owner uses `-Retry` or a different full Studio build appears; the pin commit does not trigger another automatic retry.

## Source and bridge chain

Only exact hosts `api.outsystems.com` and `dxejw4oyledi.cloudfront.net` are accepted. Every redirect is checked. Installers are never executed. Before extraction/use, the installer, Studio executable and `ServiceStudio.Framework.dll` must have valid Authenticode from the pinned OutSystems publisher; unsigned files are refused. Publisher renewal requires review.

Bridge builds use MSBuild's evaluated runtime without an `OdcBridgeRuntime` override. The Artifacts signer signs only owned binaries. Microsoft dependencies must retain their valid original signatures. Client entrypoints and runtime are checked before a manifest is signed.

Each `{lane, studioVersion}` receives a monotonically increasing persisted `sequence`. ODC includes its verified client. The downloaded O11 development hook is `d1`, in `o11BridgeAccepted`; it does **not** enable the `h1` policy, so legacy dev-hook agents remain accepted. The real package identity stays in hello; an authenticated, matching installed/active bridge report can satisfy compatibility.

Offers and downloads are served by the same backend and signed storage identity `{lane,studioVersion,protocol}`. The route no longer equates the requested version to serverKernel[lane]. Hello reports are normalized into telemetry/friction. Failed identities are not offered again until a higher sequence exists. Older agents still receive their existing refusal and never receive an unsupported offer.

Recent telemetry prevents eviction: if a version leaving the normal window has clients seen in the last 14 days, its pair stays and the window grows. A retained event tells the owner; no automatic eviction overrides recent use. The memory floor grows with that window.

## Validation

`review-safety.test.mjs` can select an unmodified baseline with `VIGIA_REVIEW_ROOT`. Its R0-R14 regressions fail on adfc641 and pass after the fixes. `automatic.test.mjs` exercises the actual HTTP adapter against a fake Coolify server; remote commands, signing and compilers remain fake. `remote-release.test.py` tests memory, disk, retention, preparation cleanup, staging names and rollback budgets without Docker or SSH. `vault.test.mjs` uses synthetic values with real DPAPI and refuses development signing.

No production activation is implied by green unit tests. The unsigned upstream framework and the agent Amendment 1 integration remain explicit activation prerequisites.
