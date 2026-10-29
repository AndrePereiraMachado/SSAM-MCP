# Automatic Studio watcher

Development checkouts support tests and `--dry-run` only. Dry runs read local metadata and official public sources; they never read the vault or contact deployment endpoints.

## Execution account and clone

Activate only an owner-reviewed release in a dedicated Windows account's own clone, named `vigia-run`, on `server/vigia-run`. `.git` must be a directory owned by that account. Shared worktrees, foreign owners, reparse points, alternate object stores, writable foreign ACL entries and executable/included Git configuration are refused. Provision restrictive ACLs before activation. The private item and its whole tree accept no write by another account, including an inheritable ACE that later descendants would receive. Ancestors (C:\ included, left at its Windows default) are refused only for an untrusted owner or a right that can replace the child: Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership or GENERIC_ALL; their inherit-only ACEs do not apply to them.

Copy `config.example.json` to `C:\ssam-priv\vigia\config.json`. Set the exact HTTPS `trustedRemote`, agent release commit/ref, baseline bundle pins and deployment destinations. Automatic output, bundle, installer, temporary, configuration and vault paths must be private under `C:\ssam-priv\`. Never activate the development worktree.

Updates fetch main from the fixed remote and fast-forward. Watcher Git calls disable hooks, fsmonitor, external diffs, credential helpers, external/file transports and global/system configuration. Automatic mode requires `ownerSigningPublicKey`, and fetched/executed commits must pass `git verify-commit`. The only alternative is the owner's explicit `acceptUnsignedMain:true` in private configuration; every round then sends the `unsigned-main` notification (toast, optional webhook and the VPS journal through `logger -t ssam-vigia`). No key is invented.

Keep the Authenticode key nonexportable in the dedicated account. Use an unpackaged PowerShell terminal for vault setup; `Windows.ApplicationModel.Package.Current` detects packaged execution. `set-secrets.ps1` provisions a new vault without replacing an existing one. `initialize-journal-key.ps1 -Vault <private path>` adds only a DPAPI-protected random HMAC key to an existing schema-2 vault, preserving the other encrypted values. These are owner actions, never development-test operations.

`attempt.json`, `release.json` and `deployment.json` use HMAC-SHA256 bound to their absolute paths. Invalid, relocated and unsigned journals stop the round; they are never silently migrated.

## Installer and bridge custody

Candidates always come from verified installers downloaded from exact allowlisted hosts. The main-reviewed `publisher-pins.json` pins the OutSystems subject and CA. There is no installed-Studio fallback. Internal unsigned files inherit installer trust; any signature present must be valid. Unpinned installers stop the lane and notify the owner.

Installer hash, signer and the extracted content tree travel with the release and `/app/studio-provenance.json`; an image label records the metadata hash. Custody is checked before bundles, tests, bridge builds, image context and resume. Baseline companion bundles need a reviewed `bundlePins` entry or the same chain. Companion snapshots are keyed by bundle hash and verified with authenticated tree receipts before reuse.

Build `TargetPath` outputs alone receive the owner's signature. Other executables must match restored NuGet bytes, retain valid Microsoft organization signatures and terminate at a pinned Microsoft root. Unsupported signers, including possible Json.NET dependencies, stop the build for integrator review. `authenticode.json` supplies the manifest's `owner` or `microsoft` signer class; the server rejects executables without a valid class. The agent release must implement both contract amendments before activation.

## Deployment and recovery

Live compose, kernels and digests define the baseline. Retained pairs preserve their image identities. New pairs inherit only environment, networks and deployment/resource settings, using generated volumes without inherited bind mounts or extra volumes.

Recent real clients can retain a pair for 14 days, up to `maxWindow` (default 4). Exceeding the limit defers and notifies. Verification hellos are marked and excluded, as are revoked tokens and legacy `Version verification` observations. The current token store has no deletion interface for old revoked verification credentials.

Tags include a random attempt suffix. Transient pre-mutation failures persist `deferred` and reuse publication/pin checkpoints on resume. PAUSE, time reserve, available memory and backup disk checks precede mutation.

All actors must take `/var/lock/ssam-release.lock` (manual wrapper: `with-release-lock.sh`). A held lease writes a random `/var/lock/ssam-release.owner` token. Mutations check the token and occupied lock; SSH uses keepalives. Compose is compared before backup/PATCH, then read back and compared with the sent hash before restart. Lost leases are reacquired before rollback; failure to obtain a lease produces `rollback-failed` and an alert.

Rollback uses the original encrypted compose, images, kernels and per-backend budgets. After manually checking/restoring production, the owner can use `-Retry <id> -AcknowledgeRollback <id>`; Retry alone cannot bypass rollback failure. Keep snapshots referenced by live attempts plus the five newest files, and five complete remote backups.

## ODC features (no Studio sign-in per version)

The ODC kernel needs a readable `Features.plain.xml` to initialize the Studio's static feature provider, and the values of the few flags its model-layer assemblies read (six in 1.7.30: AI_NL2Agg, MultiPortfolioOrganizations, UseNewSystemTrackedClipboard, WrapEditCommandsInDelayedVerySlowOperations, FixDragAndDropMultipleElements, FixIconConversionIssues). The model itself answers from the ModelAPI provider compiled into each version and never reads the file. So no ODC version waits for a signed-in Studio.

`featuresRoot` (private, never under `C:\t`) keeps `odc-<a.b.c>/Features.plain.xml` with `features.provenance.json`, a journal (MAC-signed in automatic mode, bound to its path) with `mode`, `sha256`, the file's `Version`, its `source`, `chain` and the drift. Every use (the round, the tests, the smoke, the remote prepare and -Approve) checks the MAC and the sha256 again; a difference stops the lane with `store-mismatch` and changes nothing. A new folder appears whole (file and provenance staged, then one rename). In automatic mode a folder without provenance is never trusted (`store-mismatch`: review it, delete it by name and seed it again) and the legacy store (`bundleRoot/odc-<v>/Features.plain.xml`) is not used. The modes:

- `exact`: an export of that very version: seeded by the owner, exported from `featuresSource`, or, in manual mode only, a folder of the watcher from before provenance that holds features (recorded as `legacy`) or the legacy store (`legacy-store`). An exact file is never replaced.
- `carried`: a version without its own export gets a byte copy of the nearest exact file (the newest lower version, else the oldest higher one; never a carried file), `chain` counting the versions since that export. Keys whose kind changed in the new version are left out (`filtered`).
- `defaults`: only with `featuresDefaultsFallback: true` (default false) and no exact file anywhere: `<Features Version="<full version>"/>`, the Studio's code defaults alone. Without it the lane waits with `features-unavailable` and the seed instruction.

The drift is static, on the frozen snapshot of the new version (`pe-metadata.mjs`, no .NET run): the catalog of `ServiceStudio.Common.dll` (`FeaturesValues` *Key constants and getter types), the getters the model layer calls (ServiceStudio.BuiltInBehaviors, ServiceStudio.Framework, OutSystems.Model*, Plugins/**/ServiceStudio.Plugin.* and OutSystems.Model.Plugin.*), the new flags (they use the code defaults), unknown keys, kind conflicts and the kernel flags missing. Nothing blocks on drift: the candidate tests and the smoke run the new kernel with that file and stay the gate. PROPOSTA.md, APROVADO.md, attempt.json and release.json name the provenance (no feature values); a carried or defaults-only file gives one notice a day per version, insisting after three versions without an exact export.

`featuresSource` is optional: when it names a cache this Windows user can decrypt, its export becomes the exact file of the version it says (never of another one) and replaces a carried one at the next round. A file that exports to an invalid document stops the lane with `features-invalid`.

Seed the exact exports once, as the watcher account: `vigia.ps1 -Config <config> -SeedFeatures <Features.plain.xml>` (one file per call). It takes the watcher lock, validates the file strictly (at most 1 MiB, UTF-8 without a byte order mark like the export itself, no DOCTYPE, ENTITY or entity other than the five of XML, root `Features` with a four-part `Version`, `Feature key="GUID" kind="Boolean|Integer|String"`), stores it once as `exact` (over a carried or defaults-only file at most) and prints only the version, the feature count and the sha256.

## Validation

Run the automatic, review-safety, vault, vigia, vigia-runtime and features-carry suites; facade agent-hub, odc-bridge-version, r1-mixed-studio and hosted-studio-window suites; and remote-release.test.py. Use fake infrastructure and private temporary paths. R3 regressions run against an immutable bd9513b export via `VIGIA_REVIEW_ROOT`. Do not publish or contact production during validation.

## Round 4 operational requirements

The scheduled task uses a dedicated clone, never a worktree. Its only supported logon type is Password. Run install-task.ps1 with explicit Config and Workspace; Get-Credential requests that account's password once, passing it to Task Scheduler in memory. Interactive and S4U are refused. No password is written to a file or command log.

Configure absolute paths for node, python, dotnet, git, bash, powershell, tar, docker, sshKeygen and automaticDeployment.ssh.executable. System executables must be in Program Files or System32 and owned/writable only by the trusted OS principals; the executable and its own folder (searched first for DLLs) keep the full rule and every folder above it, up to the drive root, the ancestor rule. Private executables must be owned by the account under C:\ssam-priv. Automatic vigia.ps1 never selects node from USERPROFILE or PATH. Private path descendants and ancestor owners are checked too.

Before resuming a deferred release, observe production again. An already served pair closes the journal as idle. Otherwise recompose retained pairs and repin against the new baseline and CAS hash. By default a journal expires after three deferrals or 48 hours, becomes abandoned with its own `abandoned` notification carrying the last deferral code, and later rounds continue. `-Retry <id>` reopens an abandoned (closed) attempt; an idle closure is served and cannot be reopened. Unchanged closed inputs are not rebuilt; new inputs may run again. Configure maxDeploymentDeferrals/maxDeferredHours only after review.

Extraction is keyed by the installer SHA-256. Its authenticated provenance is checked before reuse, including publisher verification again. keepArtifacts defaults to two unreferenced artifacts per managed group (extractions, bridges, agent sources, snapshots and installersDir installers). Never removed: what unfinished journals reference; the journals of the pairs the live baseline serves (recorded as live-pairs.json each time it is read; before the first read every `live` journal counts); every bundle receipt in bundleRoot with the extraction and installer it cites; the snapshot of each stored bundle; the installer of each extraction kept. Removing a retired bundle from the store frees its extraction, snapshot and installer at the next round. Check free disk before download/extraction. Window size and estimated remote memory are checked before tests or image/bridge compilation.

Certificate paths use the signed countersignature timestamp (classic or RFC3161), explicit online revocation policy and environmental deferral when revocation service is unavailable. The agent must adopt the same timestamp semantics; this repository change does not update it.

Every lock owner records a random token and PID. Both the watcher and manual wrapper use flock with no fork; remote fencing verifies that the live PID owns that inode in /proc/locks. Install the revised manual wrapper before any release.

A deployment records deploySent before requesting restart. A failure before that point restores compose without restarting the existing containers. After reacquiring the lease, rollback accepts only the watcher's compose or the captured baseline; a third writer causes rollback-failed and an alert. Post-PATCH verification compares canonical JSON, tolerating whitespace and object-key ordering only.

Provenance sidecars and snapshot receipts use the journal MAC key. Automatic journal reads without that key are refused. build.sh receives VCS_REF and TAG from the verified runtime and never invokes Git in automatic mode.
