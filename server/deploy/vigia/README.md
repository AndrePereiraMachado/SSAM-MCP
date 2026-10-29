# Automatic Studio watcher

Development checkouts support tests and `--dry-run` only. Dry runs read local metadata and official public sources; they never read the vault or contact deployment endpoints.

## Execution account and clone

Activate only an owner-reviewed release in a dedicated Windows account's own clone, named `vigia-run`, on `server/vigia-run`. `.git` must be a directory owned by that account. Shared worktrees, foreign owners, reparse points, alternate object stores, writable foreign ACL entries and executable/included Git configuration are refused. Provision restrictive ACLs before activation, including ancestors that could replace private directories.

Copy `config.example.json` to `C:\ssam-priv\vigia\config.json`. Set the exact HTTPS `trustedRemote`, agent release commit/ref, baseline bundle pins and deployment destinations. Automatic output, bundle, installer, temporary, configuration and vault paths must be private under `C:\ssam-priv\`. Never activate the development worktree.

Updates fetch main from the fixed remote and fast-forward. Watcher Git calls disable hooks, fsmonitor, external diffs, credential helpers, external/file transports and global/system configuration. When `ownerSigningPublicKey` supplies the owner's SSH signing key, fetched and executed commits must pass `git verify-commit`. No key is invented; without it, unsigned main remains a residual activation risk.

Keep the Authenticode key nonexportable in the dedicated account. Use an unpackaged PowerShell terminal for vault setup; `Windows.ApplicationModel.Package.Current` detects packaged execution. `set-secrets.ps1` provisions a new vault without replacing an existing one. `initialize-journal-key.ps1 -Vault <private path>` adds only a DPAPI-protected random HMAC key to an existing schema-2 vault, preserving the other encrypted values. These are owner actions, never development-test operations.

`attempt.json`, `release.json` and `deployment.json` use HMAC-SHA256 bound to their absolute paths. Invalid, relocated and unsigned journals stop the round; they are never silently migrated.

## Installer and bridge custody

Candidates always come from verified installers downloaded from exact allowlisted hosts. The main-reviewed `publisher-pins.json` pins the OutSystems subject and CA. There is no installed-Studio fallback. Internal unsigned files inherit installer trust; any signature present must be valid. Unpinned installers stop the lane and notify the owner.

Installer hash, signer and the extracted content tree travel with the release and `/app/studio-provenance.json`; an image label records the metadata hash. Custody is checked before bundles, tests, bridge builds, image context and resume. Baseline companion bundles need a reviewed `bundlePins` entry or the same chain. Pinned companion snapshots are extracted afresh.

Build `TargetPath` outputs alone receive the owner's signature. Other executables must match restored NuGet bytes, retain valid Microsoft organization signatures and terminate at a pinned Microsoft root. Unsupported signers, including possible Json.NET dependencies, stop the build for integrator review. `authenticode.json` supplies the manifest's `owner` or `microsoft` signer class; the server rejects executables without a valid class. The agent release must implement both contract amendments before activation.

## Deployment and recovery

Live compose, kernels and digests define the baseline. Retained pairs preserve their image identities. New pairs inherit only environment, networks and deployment/resource settings, using generated volumes without inherited bind mounts or extra volumes.

Recent real clients can retain a pair for 14 days, up to `maxWindow` (default 4). Exceeding the limit defers and notifies. Verification hellos are marked and excluded, as are revoked tokens and legacy `Version verification` observations. The current token store has no deletion interface for old revoked verification credentials.

Tags include a random attempt suffix. Transient pre-mutation failures persist `deferred` and reuse publication/pin checkpoints on resume. PAUSE, time reserve, available memory and backup disk checks precede mutation.

All actors must take `/var/lock/ssam-release.lock` (manual wrapper: `with-release-lock.sh`). A held lease writes a random `/var/lock/ssam-release.owner` token. Mutations check the token and occupied lock; SSH uses keepalives. Compose is compared before backup/PATCH, then read back and compared with the sent hash before restart. Lost leases are reacquired before rollback; failure to obtain a lease produces `rollback-failed` and an alert.

Rollback uses the original encrypted compose, images, kernels and per-backend budgets. After manually checking/restoring production, the owner can use `-Retry <id> -AcknowledgeRollback <id>`; Retry alone cannot bypass rollback failure. Keep snapshots referenced by live attempts plus the five newest files, and five complete remote backups.

## Validation

Run the automatic, review-safety, vault, vigia and vigia-runtime suites; facade agent-hub, odc-bridge-version, r1-mixed-studio and hosted-studio-window suites; and remote-release.test.py. Use fake infrastructure and private temporary paths. R3 regressions run against an immutable bd9513b export via `VIGIA_REVIEW_ROOT`. Do not publish or contact production during validation.
