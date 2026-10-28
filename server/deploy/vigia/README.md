# Automatic Studio release watcher

The default CLI mode detects official releases, tests the new Studio pair, builds signed client bridges and the image, publishes an immutable private tag, commits the digest locally and deploys through Coolify. A failed deployment restores the actual previous compose through the same API and verifies the previous images. Nothing pushes a Git branch or moves the `latest` tag. Set `automatic: false` only to retain the older proposal/approval workflow.

## Owner activation

Copy `config.example.json` to an absolute private operational path and fill in the workspace, tools, Coolify URL/resource UUID, SSH host/known_hosts, remote directory, exact Compose project name and PostgreSQL container. The running user's Docker registry login must already work. The remote host needs Python 3.12+, Docker, curl, tar, logger, and permission to back up all SSAM volumes. Host keys must already be trusted; this watcher never disables host-key checking.

Run `set-secrets.ps1` in your own terminal. It reads the Coolify token, base64 SSH private key, certificate thumbprint and optional webhook with `Read-Host -AsSecureString`, generates Ed25519 once, protects every value with DPAPI CurrentUser and prints only the public key. The code-signing certificate and its private key must be installed in the current user's certificate store. Pin the printed public key and certificate identity in the agent before enabling downloads. The vault is not overwritten on a second invocation.

Then run `vigia.ps1 -Config <absolute-config> -DryRun`, review the complete plan, and run `install-task.ps1 -Config <absolute-config> -Workspace <absolute-worktree>`. `install-task.ps1 -Show` only displays the two-hour and logon triggers; it does not register them. The interactive task runs under the vault owner, retains the existing process-identity lock and stops overlapping rounds. Its first logon run is delayed 15 minutes. An unavailable Docker builder or another active Docker build defers the round; dotnet builds/tests remain serialized across the machine.

The execution branch defaults to `server/vigia-auto`. Pins stay on that branch. Integrate it into main separately; do not configure main as the execution branch. Self-update uses the configured local ref and fast-forward only. The scheduled task and vault setup are owner actions; the test suite never installs them.

## Detection and build

The installed updater configuration identifies `releaseshub/v1/latest`, component `ODCStudio`, stable channel. The public endpoint takes `component`, `version`, `luv`, `releaseline=stable`, and `platform=Windows`. The same official API serves `ServiceStudio`. The official O11 download page was investigated but is not a stable machine-readable installer manifest; the updater endpoint supplies its release and download link. Requests do not borrow a browser login or Studio credentials. Source failure is reported in the dry-run and preserves installed-version detection.

Downloads accept HTTPS OutSystems domains and the specific official CDN `dxejw4oyledi.cloudfront.net`, validating every redirect. Installers are saved by lane/full version under `installersDir` with SHA-256. Existing hashes must match; executables are never launched. Extraction uses the existing `nsis_extract.py`, followed by the same DLL-version and runtime checks as an installed Studio. A new ODC release still needs its matching tenant features; a stale cache defers the lane instead of reusing another version's features.

Runtime properties, Docker inputs and the thin O11 bridge are inherited from `server/r33-r1`. The active versions remain the existing baseline until the automatic transaction pins the candidate. `versions.json`, `gen-compose.mjs`, `compose.template.json` and `r1-kernels.json` describe a window of up to three pairs. Old frozen bundles use their net8.0 pin. New bundles use the Studio runtime checked through MSBuild.

## Bridge contract

Artifacts are inside the pair's image at `/app/bridges/<lane>/<studioVersion>/<protocol>/`, brought in via the `client-bridges` Docker build context. Each contains the exact signed `manifest.json`, binary `manifest.sig`, and hashed files. The public verification key is `/app/bridges/public-key.pem`. All executable outputs are Authenticode signed and verified by `scripts/odc-runtime-signing.ps1 -Mode Artifacts`; the thumbprint is read from DPAPI, never a command argument.

An updated agent advertises `capabilities: {bridgeOffer: true}` (the array form `['bridgeOffer']` is also accepted). Only a package mismatch for an otherwise served Studio can become `BRIDGE_UPDATE_REQUIRED` with `bridgeOffer`. The offer has exactly the contract fields: lane, studioVersion, protocol, manifest and base64 signature. An agent without the capability retains `AGENT_PACK_MISMATCH`. The agent still verifies Ed25519, file hashes, Authenticode, monotonic protocol and atomic local installation under its own pinned trust anchors.

`GET /agent/bridges/<lane>/<studioVersion>/<protocol>/<sha256>` requires a valid agent bearer token with that lane. Only the backend's own pair and kernel-accepted protocols are available. Files and manifest signatures are rechecked before an offer/download; invalid signatures, unknown hashes, traversal and altered files are refused. No server path is returned.

## Transaction and rollback

`release.json` holds public build metadata; `deployment.json` journals publication, local pin, snapshot, backup, preparation, deploy and checks. Secret values never enter either. The actual Coolify response is DPAPI encrypted under the private `tempRoot/rollback`. The API uses GET `/api/v1/services/<uuid>`, PATCH with base64 `docker_compose_raw` and `instant_deploy: false`, and POST `/api/v1/services/<uuid>/restart`. These match the [Coolify update](https://coolify.io/docs/api/endpoints/services/update-service-by-uuid) and [restart](https://coolify.io/docs/api/endpoints/services/restart-service-by-uuid) contracts.

SSH backs up PostgreSQL with pg_dump plus every volume mounted by current backends. A temporary stopped container mounts the future pair's exact Compose volumes. `ssamctl.sh` from the pinned deploy archive writes and checks kernel/features through that container. It is removed without `-v`; then Coolify owns deployment. There is no remote `compose up`. The SSH key is temporarily materialized only in a private ACL-restricted directory, passed by filename, and removed in `finally`; it is never a command value or log entry.

Verification compares the full running pair window and actual image digests, waits for every backend's indexes/builder/worker warm event, checks public aggregate health, runs synthetic authenticated hello on both lanes, checks signed bridge offers/downloads, and validates total/core listing budgets. Synthetic tokens remain in memory and are revoked. Rollback compares the exact previous pair/image identities and repeats protocol, warm, listing and health checks. A rollback failure produces a distinct result requiring owner attention; it is never called successful. Volumes leaving the window are never deleted.

Notifications are at most one attempt per release event: detected, live, failed/rolled back. The Windows toast, local event journal, remote system journal and optional vault webhook receive only event metadata. The server console has no supported event-ingestion API in this baseline; the remote system journal is the available channel.

## Proof and limits

Tests use a loopback Coolify HTTP server, fake SSH/Docker/compilers and temporary stores. They cover success, API/warm failure and rollback, partial publication, missing secrets, source/local detection and signed delivery. Real certificate signing, registry publication, VPS access and task installation are deliberately not exercised during development. The first owner activation must validate its external credentials, precise Coolify volume naming and remote prerequisites. Build outputs are not proof of live Studio bridge loading; that belongs to the agent's validation and rollback.
