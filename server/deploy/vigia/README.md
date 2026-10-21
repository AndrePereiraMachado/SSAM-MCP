# Local Studio version watcher

Run on the owner's Windows machine with Docker Desktop. Use a dedicated clean Git worktree, installed Studios and frozen copies of the current default pair. Copy `config.example.json` outside Git and adjust its paths. `previousStudios` and `previousFeaturesDir` must describe the current default, not the oldest supported version. Keep each approved bundle and its SHA-256. Update the configuration after approving a new window.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File server/deploy/vigia/vigia.ps1 -Config C:/t/vigia/config.json -DryRun
powershell.exe -NoProfile -ExecutionPolicy Bypass -File server/deploy/vigia/vigia.ps1 -Config C:/t/vigia/config.json
```

The dry run only reads versions and prints a plan. It never writes state, builds or publishes. A Windows Task Scheduler task can invoke the second command every six hours with this worktree as its working directory. Do not schedule overlapping instances. No scheduled task is installed by this code.

Detection reads ProductVersion from the installed `ServiceStudio.Framework.dll`. It also inspects downloaded O11 installers in `installersDir`, without executing them. An installer that is newer than the window produces `PENDENTE.md`; provide an installed or frozen copy before proceeding. Optional `versionStateFile` reads a local copy of `studio-versions.json`. There is no SSH, VPS or Coolify access. Old client versions do not trigger new releases.

One candidate runs per invocation, ODC first. The watcher creates the bundle, verifies companion hashes and current default version, exports features, runs the explicit filtered kernel classes sequentially against the frozen default and candidate, compares failures by full name, builds locally, and checks health, pair, warm, unchanged agent acceptance and tools/list. An empty or fully skipped suite cannot approve a release. A failed command without a fresh TRX cannot reuse old results.

New failures write `FALHAS.md`. Successful checks create a `vigia/<lane>-<version>` branch with the proposed manifest and compose, and `PROPOSTA.md` with image digest, removed versions, affected customers and owner commands. Files and a Windows notification announce the result. The worktree remains on the proposal branch for review; subsequent runs stop until the owner handles it. An existing proposal is not rebuilt automatically.

Publication is deliberately an owner command in the proposal, following the owner's no-push instruction. The watcher never invokes publish.sh or deploys. It never moves latest. The agent package is unchanged; live bridge validation remains pending owner testing. Temporary credentials stay in memory or the smoke output's `segredo` directory, which is removed in `finally`; commands never contain them.

`tempRoot` must be private and outside C:/t. The default finite filters cover ScreenHtmlDataTableOdcTests and ScreenVisualOdcTests for ODC, and ScreenHtmlDataTableTests and ScreenVisualCheckTests for O11. Configure additional explicit class filters if required. Never run the full Anvil.Tests suite. Only one dotnet process may build/test at a time.
