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

1. **Lock and log.** One round at a time (`vigia.lock` in outDir). The lock names the launcher and the round process it
   started by pid AND start time: a reused pid is not a holder, and a round process left running after the task's 8 h
   limit keeps the lock. A lock held for more than `busyNoticeHours` (10) gives a notice once a day. Every round appends to
   `runs/<local date>/<local time>.log`.
2. **Self-update.** The watcher worktree (a dedicated worktree on an integration branch, never `main` nor `vigia/*`)
   fast-forwards from the local `main`. Anything but a fast-forward stops the round with a notice. The round then runs in a
   child process from the code just fetched; a child that does not even load leaves its output in the log and a notice. A
   round stops itself at `roundHours` (7, under the task's 8 h): it stops its commands and records its attempt as deferred.
3. **Detect** (`detect-studios.ps1`): ProductVersion of `ServiceStudio.Framework.dll`, the .NET of each installed Studio
   (`tfm` of its `runtimeconfig.json`) and what an installed Studio folder misses (its executable, its `runtimeconfig.json`),
   plus downloaded O11 installers in `installersDir` (read, never run).
4. **Decide.** The base window is `versions.json` of the worktree plus approved proposals `main` does not carry yet. The newest
   installed version of each lane that is newer than the whole window is a candidate; ODC and O11 new at the same time go
   into ONE pair (one image, one approval). Nothing new: the round ends in seconds and writes only its log. A pending
   proposal is never rebuilt; its notice repeats at most once a day. A failure is not retried with the same inputs (the
   worktree commit and the Studio builds) and at most every `retryHours` after they change; `-Retry` forces it. A lane that
   failed its tests is set aside and the other lane goes on alone. An environment problem defers the round and the next
   round retries; when it concerns one lane only (its Studio incomplete, its runtime rule or agent pack missing, its baseline
   or tests not running, its bundle or features), that lane holds the pair for `laneWaitHours` (24) and then the other lane
   goes on alone (in the same round), while the whole pair is checked again every `retryHours`.
   Each pair has its folder `outDir/<pair>/`: `attempt.json` (state), `AGUARDANDO.md` (deferred), `FALHAS.md` (failed, with
   the failure names), `PROPOSTA.md` (proposed), `APROVADO.md` (approved) and the evidence.
5. **Preflight**: the worktree clean (untracked files too: build.sh sends the tree to Docker) and free disk (`minFreeGb`).
6. **Lane checks**, all at once and before Docker: an incomplete installed Studio (no executable or no `runtimeconfig.json`)
   waits (`studio-incomplete`), never as an unknown runtime; for each new Studio the watcher asks MSBuild which target
   framework the workspace's build rule takes for that Studio folder (`dotnet msbuild -getProperty:TargetFramework`) and
   compares it with the Studio's own runtime. It never picks a framework: a workspace without the rule
   (`runtime-unsupported`) or an MSBuild that cannot be asked (`runtime-unknown`) waits. A Studio on a .NET no agent pack
   covers waits (`agent-pack-missing`). Then Docker Desktop (started and awaited) and the buildx builder.
7. **Bundle store** (`bundleRoot/<lane>-<version>/`): `<lane>-studio-<full>.tar.gz` with its `.sha256` (and optional
   `bundlePins`) and a frozen copy `snapshot/files` (exactly the bundle's files, plus the Studio's `runtimeconfig.json` in a
   copy the watcher froze itself). A new build is bundled by `studio-bundle.ps1`; a bundle of that build already there is
   used as it is, and one that does not check out is never bundled over (`store-mismatch`, the lane waits for a review).
   Existing folders are never renamed or overwritten. The companion lane and the baseline come from the store by the
   window's versions; no configuration edit is needed after an approval.
8. **Features** of each ODC version (the tenant's feature flags) live only in the private `featuresRoot`
   (`<featuresRoot>/odc-<version>/Features.plain.xml`, outside `C:/t`), exported from this machine's ODC Studio cache only
   when its `<Features Version>` is that version (else `features-stale`: open the new ODC Studio once, signed in).
9. **Tests**: the explicit filtered kernel classes (`filters`, default ScreenHtmlDataTable/ScreenVisual of each lane), one
   dotnet process at a time on the machine (the watcher waits for another session's build or test; the prototype's
   `anvil.dll serve` and idle build servers do not count), baseline = the current default pair's frozen copies, candidate =
   the new pair's frozen copies, ODC features protected for this Windows user (`features-protect.ps1`). Failures are
   compared by full name. A baseline that does not run, a package restore without network or a timeout is the machine
   (deferred); a candidate that does not build or passes nothing is the version (failed).
10. **Image and smoke**: `build.sh` with both bundles, tag `prod-<yyyymmdd>-<commit>-o<o11>-odc<odc>` (a registry or network
    failure or a timeout defers; the client-name guard or a build error fails); the smoke runs the image without network:
    pair check, health, warm (indexes, builder, worker), the agent pack of the pair (`agentPack`, built for
    `agentPack.runtime`, with `agentPackByRuntime.net<N>` for a Studio on .NET N), `tools/list` against
    `../coolify/listing-budget.json` (all tools and the core). The watcher does not run `builder-image.test.mjs` nor the
    whole-window rehearsal of the manual recipe; `PROPOSTA.md` says so.
11. **Proposal**: a commit on `vigia/<pair>` made in a temporary worktree (the watcher worktree never leaves its branch),
    from HEAD or from the newest approved pin `main` lacks: `versions.json` rotated (the new pair without a digest, nothing is
    published yet) and the compose regenerated and tested; `PROPOSTA.md` and the evidence in `outDir/<pair>/`; a Windows
    notification that stays in the notification center.

## Approval (`-Approve`)

Refuses a pair `main` already serves. Checks that the proposal branch is unchanged and that the local image is the tested
digest, publishes the tag with `publish.sh --private-repo-ready` (never `--latest`; an earlier publication of the same digest
is accepted), refuses to pin a registry digest that is not the tested one, then commits on the proposal branch the pin (the
published digest in `versions.json`) with the compose regenerated by `gen-compose.mjs` and `gen-compose.test.mjs` +
`initial-window.test.mjs` green. Each step is recorded: an approval stopped half-way resumes without publishing or pinning
twice. It writes `compose.coolify.literal.yml` (the domains of `domains` in the Traefik rules, ready to paste),
`compose.rollback.literal.yml` (the previous window), `deploy-<commit>.tar.gz` (the deploy folder of the pin commit) and
`APROVADO.md`, and prints what is left to the owner in the order of COOLIFY.md sections 5 and 7: maintenance notice, VPS
backup, the deploy folder and the new pair's kernel and features to the VPS, the new compose in Coolify with its containers
prepared stopped (`ssamctl.sh status` lists the new pair), `ssamctl.sh kernel write` / `features put` with the new lane's
selector (then delete the features copy), Redeploy and the checks (status, health, kernel and warm events, routing,
`SESSION_REROUTED`), and the way back. From then on the watcher plans from the approved window even before the branch
reaches `main`. `-Retry` also takes an unpublished proposal (its local image was pruned).

## Configuration (`C:/t/vigia/config.json`)

`workspace`, `updateFrom` (default `main`), `tempRoot` and `featuresRoot` (private, outside `C:/t`; features default to
`<tempRoot>/features`), `outDir`, `bundleRoot`, `bundlePins`, `studios`, `featuresSource`, `installersDir`, `image`,
`builder`, `dockerContext` (only `desktop-linux`), `domains`, `agentPack`, `agentPackByRuntime`, `filters`, `notify`,
`node`, `minFreeGb` (25), `retryHours` (12), `laneWaitHours` (24), `roundHours` (7), `busyNoticeHours` (10),
`dotnetWaitMinutes` (180), `dockerWaitMinutes` (8), `testTimeoutMinutes` (90), `buildTimeoutMinutes` (120),
`versionStateFile` (optional local copy of the server's `studio-versions.json`).

Never run the full Anvil.Tests suite. Temporary smoke credentials stay in memory or the smoke's `segredo` folder, removed in
`finally`; commands never contain them.
