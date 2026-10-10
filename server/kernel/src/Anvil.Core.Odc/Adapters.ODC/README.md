# Adapters.ODC (WS1: headless)

The ODC platform adapter of the Anvil kernel. `Anvil.Core.Odc.csproj` compiles the same kernel sources as
`Anvil.Core` (linked, never copied) against the installed ODC Studio (`C:\Program Files\OutSystems\ODC Studio\ODC Studio`,
override with `ANVIL_ODC_STUDIO_DIR`) and adds this folder. `StudioAdapter.Runtime` discovers `OdcRuntime` as the only
`IStudioRuntime` of that build. No OutSystems binary is copied or committed.

## What is covered (proved by `tests/Anvil.Tests.Odc`)

| Contract member | ODC implementation | Proof |
|---|---|---|
| `Bind` / `Ensure` | `StudioAssembliesOdc.Bind` (resolver by name over the install dir, loads the NRWidgets plugin), `Loader.SetConfiguration` (in-memory storage, developer id `ANVIL_DEVELOPER_ID`), `OdcFeatures.Initialize` (feature provider from the local `Features.xml` cache), `OdcModelPlugins.Register` (`ModelServices.ResolveModelPlugin` answered from the ODC Studio's plugin cache `<dir>\<AssemblyName>-<Version>.xif`: first the folders a caller named (create-app `--plugins-dir`, the Studio's own `PluginsDirectory` from the bridge), then `ANVIL_ODC_PLUGINS_DIR` or `%LocalAppData%\OutSystems\ODC Studio\Plugins`: MobileUI for the Mobile templates and the apps cloned from them; also linked into ODC3.Builder) | `TheRuntimeIsTheOdcAdapter`, `TheTenantsRealTemplatesBecomeApps`, `AMissingModelPluginIsRefusedInOneLineNamingItAndTheFolders`, `TheBuildersReaderResolvesModelPluginsLikeTheKernel` |
| `Load` / `Save` / `Release` | `Loader.ModelServicesInstance.LoadESpace(..., enableTransactions, trackChanges, CreatedByTool.AgentExperience, agentName "Anvil")` (a required model plugin that cannot be loaded is `OdcModelPluginMissingException`, one line), `IESpace.Save()`, `Dispose` | `TheFixtureLoadsSavesAndReloads` (59 281 objects, same count after the round trip) |
| `Mutate` | `TransactionsManager.ExecuteTransaction` (one native transaction per job) | every job |
| `VerifyDefinitions` | `VerifyResources.Extract` over `OutSystems.Model.dll` (ODC declares `ServiceStudio.Verify.VerifyMessageId` there, not in `ServiceStudio.Framework.dll`) | `TheVerifyCatalogComesFromTheInstalledOdcStudio` |
| `ImportsChild` / `MoveObject` | `OutSystems.Model.Clone.ObjectCloner.CloneAllowed` (the cloner lives in `OutSystems.Model.dll` here, `ServiceStudio.Clone` in SS11) and `Loader.ModelServicesInstance.MoveObject` (the `move` verb with `into`) | `tests/jobs-odc/refactor-reparent.json`, `tests/jobs-odc-negative/move-into-*.json` |
| Blank module of another kind (`anvil-odc create-blank`) | `OdcBlankModule.Create`: `IModelServices.CreateESpace(kind, targetPlatform: Neo)`, key from kind and name, optional offline connections (`CreateAIModelConnection`/`CreateMCPConnection`/`CreateKnowledgeBase` + `IESpace.AddDependency`), saved and reloaded by `Load`. The InsuranceApp app (CrossDevice) refuses workflows, agents and the Mobile-only elements; `tests/fixtures/odc/blank-{mobile,workflow,agent,agent-definition}.oml` are this command's output | `OdcBlankModuleTests`, jobs `mobile-sync-events`, `workflow-nodes`, `agent-calls`, `agent-definition-tools` |
| New app or library as the Studio creates it (`anvil-odc create-app`, MCP `studio_create_app`) | `OdcAppFactory.Create`: apps are `ESpace.Clone` of the tenant template OML (new key, AppName, PrimaryColor, Description, no image, forcePlatformVersionV12); the template is never loaded, since the tenant's templates are system modules the Model API refuses (`Constants.ReadonlyESpaces`): its identity and kind come from the OML header, its content and warning baseline from a plain clone verified inside a transaction; then `ApplicationCommands.ChangeESpacePrimaryColor(isESpaceCreation: true)` over a `MockAggregatorPresenter`; libraries are `ESpace.Create(ReactiveLibrary or MobileLibrary, V12)` with the "Users" provider. Zero validation errors or nothing is written; writes the OML, `create-app-receipt.json` and a creation `manifest.json` for the bridge | `OdcAppFactoryTests` |
| External Library from a spec (`anvil-odc external-library build|contents|diff`, MCP `odc_external_library`) | `ExternalLibraries/`: `ExternalLibrarySpec` (every problem at once, `EXTERNAL_LIBRARY_SPEC_INVALID`), `ExternalLibraryProject` (net10.0, `OutSystems.ExternalLibraries.SDK` pinned, `PathMap`: the same spec gives the same bytes), `ExternalLibraryBuild` (`dotnet publish -r linux-x64` behind `IProcessRunner`; C# errors mapped to the action and the line of its body, `DOTNET_SDK_MISSING`, `NUGET_RESTORE_FAILED`), `ExternalLibraryPackage` (deterministic zip; one `.deps.json`, .NET 10, 90 MB: `PACKAGE_NOT_NET10`, `PACKAGE_TOO_LARGE`), `ExternalLibraryContents` (plan, generation contents, Added/Removed/Updated). No Studio type: it runs without the Studio bound | `OdcExternalLibraryTests` |
| External Library producer of a reference | `NativeReferenceSnapshot` accepts the unattested version 2 envelope whose `ModuleKind` is `ExternalLibrary` (compared by name; actions and structures only); `OdcReferenceImporter` imports it with ModuleKind/ModuleType ExternalLibrary | `OdcExternalLibraryTests` (envelope); the import is a live proof |
| Jobs | `tests/jobs-odc/data-entity.json` (spec: static entity + entity with FK and defaults), `logic-action.json` (logic: get/assign/if), `screen-basic.json` (screen on `LayoutTopMenu` with container, expression, input bound to a local variable, button bound to a screen action) over `tests/fixtures/odc/insurance-reactive-r8.oml` | `JobAppliesAndVerifies` x3: `isValid`, no unexpected message, data contract accepted |

Run: `dotnet test tests/Anvil.Tests.Odc -c Release`. Needs the ODC Studio installed and opened once (the feature cache);
without it the tests return without asserting, like `JobTests` without the Service Studio. Results land in
`.local/lane-odc/test-work/<job>.result.json` and `<job>.oml`.

## What is not covered here

- `ImportReference` imports only a public signature captured from a consumer session (`OdcReferenceImporter`, version 2
  envelope of a module, library or External Library; `OdcDependencyTests`): no producer .oml is imported offline.
  References are refreshed live by the bridge (`odc studio refresh-references <Consumer> --producer <Producer>`).
- Merge, snapshot, publish: bridge session (WS2). The kernel's headless 3-way merge (`MergeProbe`,
  `ReferenceSignatureMerge`) and the O11 C# extension delivery are excluded from this build (see the csproj).
- `FunctionCatalog.Visibility`: ODC keeps three visibility flags as predicates over the module; evaluated without a
  module, a predicate that needs one counts as visible.

## Platform differences met by the kernel (all handled in the kernel, none by `#if`)

See `docs/tasks/2026-09-17-ws1-diferencas.md` for the list with the errors as they appeared.
