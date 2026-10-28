# Local Studio version watcher

Runs on the owner's Windows machine (Docker Desktop, the installed ODC Studio and Service Studio), every 6 hours from a
scheduled task, in its own Git worktree. It notices a new Studio version, bundles and tests it, builds and smoke-tests a
local image, and leaves a proposal that the owner approves with one command. It never publishes on its own, never touches
the VPS, Coolify or GitHub, never pushes and never moves `latest`.

## Commands

```powershell
# what a round would do; writes nothing
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/Users/andre/SSAM-MCP-wt/vigia-run/server/deploy/vigia/vigia.ps1 -Config C:/t/vigia/config.json -DryRun
# one round (what the scheduled task runs)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/Users/andre/SSAM-MCP-wt/vigia-run/server/deploy/vigia/vigia.ps1 -Config C:/t/vigia/config.json
# the owner's commands on a proposal (<id> is the pair, o11-11.55.94-odc-1.7.30, or one lane of it, odc-1.7.30)
... vigia.ps1 -Config C:/t/vigia/config.json -Approve <id>
... vigia.ps1 -Config C:/t/vigia/config.json -Reject <id> -Reason "<why>"
... vigia.ps1 -Config C:/t/vigia/config.json -Retry <id>
# the scheduled task, once main carries this watcher: fast-forwards the watcher worktree from main, then registers
# (-Show prints it without registering anything; -Uninstall removes it)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/Users/andre/SSAM-MCP/server/deploy/vigia/install-task.ps1
```

## A round

1. **Lock and log.** One round at a time (`vigia.lock` in outDir; a lock whose process is gone or older than a day is stale).
   Every round appends to `runs/<local date>/<time>Z.log`.
2. **Self-update.** The watcher worktree (a dedicated worktree on an integration branch, never `main` nor `vigia/*`)
   fast-forwards from the local `main`. Anything but a fast-forward stops the round with a notice. The round then runs in a
   child process from the code just fetched.
3. **Detect** (`detect-studios.ps1`): ProductVersion of `ServiceStudio.Framework.dll` and the .NET of each installed Studio
   (`tfm` of its `runtimeconfig.json`), plus downloaded O11 installers in `installersDir` (read, never run).
4. **Decide.** The base window is `versions.json` of the worktree plus approved proposals `main` does not carry yet. The newest
   installed version of each lane that is newer than the whole window is a candidate; ODC and O11 new at the same time go
   into ONE pair (one image, one approval). Nothing new: the round ends in seconds and writes only its log. A pending
   proposal is never rebuilt; its notice repeats at most once a day. A failure is not retried with the same inputs (the
   worktree commit and the Studio builds) and at most every `retryHours` after they change; `-Retry` forces it. When one lane
   of a pair failed its tests, the next round tries the other lane alone. An environment problem (Docker, disk, another
   dotnet build, the runtime rule missing, a gap in the bundle store) defers the round and the next round retries.
5. **Preflight**: free disk (`minFreeGb`), Docker Desktop (started and awaited when it is not answering), the buildx builder.
6. **Runtime**: for each new Studio, the watcher asks MSBuild which target framework the workspace's build rule takes for that
   Studio folder (`dotnet msbuild -getProperty:TargetFramework`) and compares it with the Studio's own runtime. It never picks a
   framework itself; a workspace without the rule waits (`runtime-unsupported`), it never turns into test failures.
7. **Bundle store** (`bundleRoot/<lane>-<version>/`): `<lane>-studio-<full>.tar.gz` with its `.sha256` (and optional
   `bundlePins`), a frozen copy `snapshot/files` (exactly the bundle's files, plus the Studio's `runtimeconfig.json`), and for
   ODC the version's `Features.plain.xml`. A new version is bundled by `studio-bundle.ps1` (an existing bundle of that build is
   reused); the companion lane and the baseline come from the store by the window's versions. No configuration edit is
   needed after an approval. Existing folders are never renamed or overwritten.
8. **Tests**: the explicit filtered kernel classes (`filters`, default ScreenHtmlDataTable/ScreenVisual of each lane), one
   dotnet process at a time on the machine (the watcher waits for another session's build or test; the prototype's
   `anvil.dll serve` does not count), baseline = the current default pair's frozen copies, candidate = the new pair's frozen
   copies, ODC features protected for this Windows user (`features-protect.ps1`). Failures are compared by full name; a
   suite that passed nothing cannot approve.
9. **Image and smoke**: `build.sh` with both bundles, tag `prod-<yyyymmdd>-<commit>-o<o11>-odc<odc>`; the smoke runs it
   without network: pair check, health, warm (indexes, builder, worker), the agent pack of the pair (`agentPack`, built
   for `agentPack.runtime`, with `agentPackByRuntime.net<N>` for a Studio on .NET N; a pair on a runtime no pack covers
   waits, `agent-pack-missing`, before any test), `tools/list` against `../coolify/listing-budget.json`.
10. **Proposal**: a commit on `vigia/<pair>` made in a temporary worktree (the watcher worktree never leaves its branch):
    `versions.json` rotated (the new pair without a digest, nothing is published yet) and the compose regenerated and tested;
    `PROPOSTA.md` and the evidence in `outDir/<pair>/`; a Windows notification that stays in the notification center.

## Approval (`-Approve`)

Checks that the proposal branch is unchanged and that the local image is the tested digest, publishes the tag with
`publish.sh --private-repo-ready` (never `--latest`; an earlier publication of the same digest is accepted), refuses to pin a
registry digest that is not the tested one, then commits on the proposal branch the pin (the published digest in
`versions.json`) with the compose regenerated by `gen-compose.mjs` and `gen-compose.test.mjs` + `initial-window.test.mjs`
green. It writes `compose.coolify.literal.yml` (the domains of `domains` in the Traefik rules, ready to paste),
`compose.rollback.literal.yml` (the previous window) and `APROVADO.md`, and prints what is left to the owner: the VPS backup,
kernel and features of a new pair (`ssamctl.sh kernel write` / `features put`), paste the compose in Coolify and Redeploy, and
the way back. From then on the watcher plans from the approved window even before the branch reaches `main`.

## Configuration (`C:/t/vigia/config.json`)

`workspace`, `updateFrom` (default `main`), `tempRoot` (private, outside `C:/t`), `outDir`, `bundleRoot`, `bundlePins`,
`studios`, `featuresSource`, `installersDir`, `image`, `builder`, `dockerContext` (only `desktop-linux`), `domains`,
`agentPack`, `agentPackByRuntime`, `filters`, `notify`, `node`, `minFreeGb` (25), `retryHours` (12), `dotnetWaitMinutes`
(180), `dockerWaitMinutes` (8), `testTimeoutMinutes` (90), `buildTimeoutMinutes` (120), `versionStateFile` (optional local
copy of the server's `studio-versions.json`).

Never run the full Anvil.Tests suite. Temporary smoke credentials stay in memory or the smoke's `segredo` folder, removed in
`finally`; commands never contain them.
