# ODC3 generic bridge

One resident bridge per ODC Studio session, parameterized by manifest files and by `..\..\snapshots\modules.json`.
It replaces the per-delivery Bridge/Client project pairs. It never initializes the ModelAPI runtime inside the
Studio, never edits the open model directly, never synthesizes operating-system input, and appends one line per
command to `..\..\journal\operations.jsonl`.

Current version: the `AssemblyName` of Bridge.csproj (**v35** on 2026-10-04). v23 was proven live on 2026-09-16 in the
personal test environment: open from organization,
snapshot, candidate preview, native merge with strict equivalence, publication followed to its end in one command,
dialog inspection and dismissal with a watchdog for informational dialogs, duplicate-copy close, discard close,
native asset and consumer listing, module creation through the native CreateAsset, the producer -> consumer gate
exercised with a real library + app pair, and native dependency refresh that closes that loop.
See `..\..\lab\REPORT.md` for measurements and `..\..\README.md` for the runbook.

Start every session with `attach`, `status`, then `assets`: the catalog `..\..\snapshots\modules.json` is rewritten from
the server listing, so no command and no LLM ever reasons from an inventory a previous session assumed.

## Build

If Windows blocks the client with `0x800711C7` (Smart App Control), use the
[signed-runtime workflow](../../../../docs/CONEXAO-ODC-ASSINADA.md). It prepares an isolated
copy for trusted code signing, verifies it and explicitly selects it for the existing attach
command. It does not change the Studio installation or Windows security policy.

```powershell
dotnet build .\studio\bridge\Bridge.csproj -c Release --nologo
dotnet build .\studio\bridge\client\Client.csproj -c Release --nologo
dotnet test .\studio\bridge\tests\Bridge.Tests.csproj --nologo
```

Outputs: `studio\bridge\bin\Release\net8.0\ODC3.Bridge.<version>.dll` and `studio\bridge\client\bin\Release\net10.0\ODC3.Bridge.Client.dll`.
A loaded DLL is never replaced: to ship a change, bump `Version` in StartupHook.cs and Program.cs and the
`AssemblyName` in Bridge.csproj, then attach the new DLL. Each version keeps its own in-memory state, so the
"merged in this session" and "busy" facts do not carry over between versions; the journal does.

## Commands

```text
dotnet ODC3.Bridge.Client.dll <pid> attach <path>\ODC3.Bridge.<version>.dll
dotnet ODC3.Bridge.Client.dll <pid> status                                   -> full state
dotnet ODC3.Bridge.Client.dll <pid> status brief                             -> bridge, busy, catalog, dialogs with choices, modules
dotnet ODC3.Bridge.Client.dll <pid> status <field.path>                      -> one field, e.g. modules.0.dependencies, catalog.modules
dotnet ODC3.Bridge.Client.dll <pid> wait idle|no-dialogs|published <M>|open <M> [timeoutSeconds]  -> one blocking call instead of a status loop
dotnet ODC3.Bridge.Client.dll <pid> authorize <manifest.json> publish|create <the user's words>  -> records the authorization with a timestamp
dotnet ODC3.Bridge.Client.dll <pid> assets [tenant-host] [--no-catalog]  -> native AssetManagementService.GetAssetInfos; writes ..\snapshots\assets-<host>.json and rewrites the tenant's section of modules.json
dotnet ODC3.Bridge.Client.dll <pid> consumers <Module|key>               -> native GetConsumers: published consumers of a module, with "open" flags
dotnet ODC3.Bridge.Client.dll <pid> open <Module|key>                    -> native "open from organization" (keeps publish linkage)
dotnet ODC3.Bridge.Client.dll <pid> open <Module> <local.oml>            -> opens a local file (no publish linkage: Publish shows Compare and Merge)
dotnet ODC3.Bridge.Client.dll <pid> open <Module> --download-file        -> downloads the published revision and opens it as a file
dotnet ODC3.Bridge.Client.dll <pid> close <Module> [--duplicates] [--discard]
dotnet ODC3.Bridge.Client.dll <pid> snapshot <Module>                    -> ..\snapshots\<Module>-<sha256>.oml (+ .json with capturedAt and dependency revisions)
dotnet ODC3.Bridge.Client.dll <pid> latest <Module|key>                  -> ..\snapshots\<Module>-revision-<n>[-<sha12>].oml
dotnet ODC3.Bridge.Client.dll <pid> module-info <Module>
dotnet ODC3.Bridge.Client.dll <pid> refresh-references <Module>                     -> the Studio's "Check for dependency updates"; its closing dialog is closed by the bridge
dotnet ODC3.Bridge.Client.dll <pid> refresh-references <Module> --producer <Library> -> update that library reference to its latest published revision (Library Updates path)
dotnet ODC3.Bridge.Client.dll <pid> check-base <manifest.json>
dotnet ODC3.Bridge.Client.dll <pid> preview <manifest.json>
dotnet ODC3.Bridge.Client.dll <pid> merge <manifest.json>
dotnet ODC3.Bridge.Client.dll <pid> create <manifest.json>               -> new asset from a whole-module candidate (ODC3.Builder new <feature> <dir>); requires manifest.createAuthorization; uploads revision 1, does not deploy
dotnet ODC3.Bridge.Client.dll <pid> templates [--kind reactive|mobile|all] [--tenant <host>]  -> the tenant's application templates (TemplatesService.ListApplicationTemplates, the wizard's keys per kind)
dotnet ODC3.Bridge.Client.dll <pid> template-download <key> [--tenant <host>]  -> latest template OML (GetESpaceForApplicationTemplate) into snapshots\templates\<key>-r<rev>-<sha12>.oml; never overwritten; also pluginsDirectory (the Studio's model plugin cache) and modelPlugins (the template's required plugins, each fetched into that cache through the session when missing)
dotnet ODC3.Bridge.Client.dll <pid> template-download <key> --have <rev>-<sha12>  -> capability template-download:have: when <rev> is still the latest revision (GetAssetInfo) and the bridge kept that file with that sha256 prefix, cached:true from it, no download; else the download above
dotnet ODC3.Bridge.Client.dll <pid> create-app <manifest.json>           -> app built by anvil-odc create-app: manifest.appName in the candidate and free in the live listing, then the create gates and CreateAsset
dotnet ODC3.Bridge.Client.dll <pid> publish <manifest.json>              -> dispatch only; requires manifest.publishAuthorization and a successful receipt.json (merged or created)
dotnet ODC3.Bridge.Client.dll <pid> publish <manifest.json> --wait [min] -> dispatch, follow the server process, close the notice, download the revision, compare with the open module: publish-receipt.json
dotnet ODC3.Bridge.Client.dll <pid> publish-status <manifest.json>
dotnet ODC3.Bridge.Client.dll <pid> dismiss-dialog <caption>|<action or button>
dotnet ODC3.Bridge.Client.dll <pid> data <Module> <Entity> [--limit N] [--offset N] [--fields A,B] [--out name.json]   -> records from the development database (IDataService.GetRecords, the "View data" call); own or referenced entity of an open module
dotnet ODC3.Bridge.Client.dll <pid> data-insert <Module> <Entity> --records-file <journal\data\requests\x.json> --authorize <words>  -> InsertRecords; report per record in ..\..\journal\data
dotnet ODC3.Bridge.Client.dll <pid> data-update <Module> <Entity> --records-file <...> --authorize <words>      -> UpdateRecords (records carry the identifier)
dotnet ODC3.Bridge.Client.dll <pid> data-delete <Module> <Entity> --ids <id,id> --authorize <words>            -> DeleteRecords
dotnet ODC3.Bridge.Client.dll <pid> portal-call <request.json> [--tenant <host>]          -> one public ODC API call with the Studio session of the tenant (v32)
dotnet ODC3.Bridge.Client.dll <pid> portal-session status|open|close [--tenant <host>]   -> the Portal window of the tenant inside the Studio (v32)
dotnet ODC3.Bridge.Client.dll <pid> portal-session fetch <request.json> [--tenant <host>] -> one internal Portal route run by the page of that window (v32)
dotnet ODC3.Bridge.Client.dll <pid> portal-upload <request.json> --tenant <host>          -> an External Library package to the tenant's generation API with the Studio session (capability portal-upload)
dotnet ODC3.Bridge.Client.dll <pid> auth-status [--tenant <host>]                         -> Studio sessions per tenant, no secret (v32)
dotnet ODC3.Bridge.Client.dll <pid> stop
```

`<pid>` is the ODCStudio.exe process id; the client refuses any other executable. Argument words are joined
with spaces, so `dismiss-dialog Compare and Merge|Close` works as written.

## Portal lane (v32)

`PortalCore.cs` holds the rules and uses no Studio type (tests: `dotnet test studio\bridge\tests\Bridge.Tests.csproj`);
`PortalCommands.cs` binds them to the Studio. The request and answer shapes are those of
`_notes\scp\CONTRATO.md` (`{ ok:true, source, host, user, elapsedMs, ... }` or `{ ok:false, code, message }`).

- Request files are read only from `..\..\journal\portal\requests` and deleted once read. A secret never travels in
  them: a write names it in `secretRefs` (below).
- `portal-call` sends with `IServerCommunicationsProvider.AuthenticatedHttpClient` of the session whose
  `LoginInfo.HostInfo.Hostname` is the tenant: the Studio's handler adds the Bearer and renews it inside the process;
  the bridge never reads a token. That handler puts the Bearer on any URI, so the URI is built here as
  `https://<session host><basePath><path>?<query>` with `basePath` in the 14 public API families of the catalog, no
  climbing or encoded separators, and checked again after normalization. The answer is discarded unless its final URI
  (after redirects) is on the same host. The client is the Studio's and is never disposed. A client stamped
  (`X-OSTenant`) for another tenant than the session's belongs to an earlier login and is not used.
- Writes: any non-GET except the six catalog search POSTs, and anything the facade marks `write:true`. They need
  `--tenant`, `write:true`, `operationUuid` and `authorizeSha256`; `tenants.json` `readOnly` refuses them and any host but
  the `default` tenant needs `confirmTenant` naming it. `..\..\journal\portal\writes\<operationUuid>.json` is created
  exclusively before the send (hashes, never the body or the words) and a second send of the same UUID is refused
  (`retry_refused`). No retry: a failure after the send, a timeout, a 5xx or a redirect to another host answers
  `UNCERTAIN`, to be reconciled by a read. The Studio's own handler repeats a request once after a 401 with a renewed
  token; the gateway processed nothing in that case. A failed renewal answers `STUDIO_NOT_SIGNED_IN`.
- Every answer is redacted (`errors.mjs` rules plus camelCase `*Token` keys such as the private gateway's `authToken`);
  only `content-type`, `location` and `x-request-id` headers come back; answers over 4 MB go, redacted, to
  `..\..\journal\portal\downloads`.
- `portal-session open` shows an unowned window (the dialog watchdog never touches it) on `https://<host>/` with the
  Studio's own browser control, only once the Studio has started its browser engine. The user signs in there (SSO
  works); popups open in the same window. `status` reports `signedIn` when the page is on the tenant's origin outside
  `/authentication` and holds a CSRF token (a fetch is the proof). `fetch` runs one route in the page: `POST
  /<module>/screenservices/<module>/...` or the module's own `GET` metadata and scripts, with the page's cookies and
  CSRF token, which never leave the page; known read routes go freely, any other only as an authorized write; the
  `authentication`, `identity` and `api` modules and routes that decrypt secrets are refused. `close` closes the window
  and deletes the tenant host's cookies from the Studio's browser engine. The engine's cache is the Studio's:
  `cachePersistent` says whether it lives on disk.
- `secretRefs` (writes only, `portal-session fetch` and `portal-call`): `[{pointer, target, field:'password'|'username'}]`
  in the request file, up to 32, each pointer once. The facade leaves `""` at each JSON pointer (RFC 6901) of the body;
  the bridge reads the generic credential `target` of the user's Windows vault inside the Studio process
  (`PortalVault.cs`, `CredRead`, one read per entry even when a body takes the same password several times) and puts
  its user name or password there, in a copy of the body, right before the reservation and the send. `target` must be
  `SSAM/ODC3/<session host>/<kind>/<name>` (`DB/<connection>` for an external database), never the lane's sign-in
  entries `APIClient` and `Portal`; a screenservice pointer starts in `/inputParameters/`, `/screenData/variables/` or
  `/clientVariables/`. The value never reaches a file, an answer or the journal: the reservation hashes the body as the
  facade wrote it and records only `{pointer, target, field}`; each value placed, raw and in its JSON-escaped, HTML and
  URL forms, is masked (`[REDACTED]`) in the answer, the downloaded body and the messages (long values anywhere, short
  ones as whole words). Refusals, nothing
  reserved or sent: `secret_ref_invalid` (`BAD_REQUEST`) and `secret_ref_target` (`NOT_ALLOWED`) before the vault is
  touched; `secret_ref_missing` (entry absent or without that field) and `secret_ref_vault` (vault unreadable)
  (`BAD_REQUEST`) after the read. The same `operationUuid` goes once the entry exists.
- `auth-status` lists, per session: host, signed in, user, tenant id, the expiry instant of the access token (never the
  token), permissions, and whether a Portal window is open. It is answered while another command is busy. Its
  `capabilities` list `portal-call:secretRefs` and `portal-session:secretRefs` from the build that places vault values
  (the first v32 refused `secretRefs` with `secret_refs_unsupported`), and `portal-upload` and
  `reference-snapshot:external-library` from the build of the External Library lane (below).
- `portal-upload` (rules in `PortalUpload.cs`, no Studio type; tests `PortalUploadTests`): one External Library package
  to `/api/external-libraries/v1` as ONE write. The request file `{file, sha256, fileName, operationUuid,
  authorizeSha256, confirmTenant}` names a package under `..\..\journal\portal\uploads` (anywhere else, a size above
  90 MB or another sha256 is refused before any request). Then: `GET /uploads` with the session's client (the presigned
  `uploadUrl` and `downloadUrl`); the reservation `journal\portal\writes\<operationUuid>.json` (one UUID is one send,
  `retry_refused` after); the `PUT` of the zip to `uploadUrl` with a NEW `HttpClient` without credentials, cookies or
  redirects (the session's handler would put the user's Bearer on any URI, so it never sees this request): https only,
  default port, no user info, `application/zip`, 600 s; a redirect or a non-2xx is `UPLOAD_REJECTED` and nothing is
  generated; then `POST /generation-operations {fileName, highCodeBinaryUri: downloadUrl}` with the session's client.
  The answer is `{operationKey, bytes, sha256, fileName}`: neither URL reaches the answer, the reservation or the
  journal. A lost answer to the POST is `UNCERTAIN`, reconciled by reading the generation jobs by file name. The
  watchdog leaves it alone (no Studio dialog) and its timeout is 13 minutes.
- `reference-snapshot` exports an External Library producer like a library (its public actions and structures,
  `ModuleType` ExternalLibrary); a bridge before `reference-snapshot:external-library` refused it with the sentence the
  facade turns into `BRIDGE_UPGRADE_REQUIRED`.

## What status tells you

`sessions` (tenants the Studio is signed into), `catalogTenant`, `catalog` (tenant, module count and when `assets`
last listed it), `busy` (a command that outlived its timeout and is still running), `dialogs` (child presenters
with a caption and their footer actions), `modalWindows` (owned Avalonia windows with their visible text and
buttons), `modules` (open copies with key, modified, mergePending, developerId, dependencies, and the times of the
last merge and publication done by this bridge version). `capabilities` (also in `status brief`) lists what this build
does that older bridges do not: `merge:normalized` (gate 7, the Studio's own rewrites) and `template-download:have`.
The facade uses each behavior only when its capability is listed.

## Gates, in order, and the journal gate name when they refuse

1. Native providers intact, module identity, no pending Match, author, tenant: `provider_state`, `scope`, `pending_match`, `authorship`.
2. Base captured before a merge or publication, in this bridge session, of a producer that the module references
   (its native `Dependencies`): `base_drift`. Producers it does not reference are reported as `unreferencedProducers`
   and gate 4 decides. A time-only rule was tried first and refused a WrightFlood base whose bytes were unchanged.
3. Base and candidate hashes unchanged on disk, base younger than `maxBaseAgeMinutes`: `base_drift`.
4. Open module equals the captured base (native MatchTree): `base_drift`.
5. Candidate adds no validation errors; preview has changes and no conflicts: `candidate_validation`.
6. One merge per evidence directory: `retry_refused`.
6b. Merge order (v36, `engine/NativeMergeOrder.cs`): the Studio removes a Default Value it marks read-only (entity attribute of an identifier type, mandatory input parameter) when a merge sets the element's type. When the candidate holds such defaults on elements the merge creates or retypes, the same `merge` runs two native merges: the candidate without them (`first-pass.oml`, `merge-order.json`), then the candidate over that copy (`second-pass-match-tree.txt`). Silent otherwise: one merge, as before.
7. After merge: `NativeMergeVerification` strict equivalence tolerant only to empty grid metadata in `owners`, no new errors, no new diagnostics: `equivalence`. A difference confined to the module's references (the Studio refreshing a dependency from the server) is accepted and listed as `refreshedReferences` in the receipt; anything else keeps the refusal. Two known classes are named instead: defaults the Studio removed and delete rules it forced to Ignore. When they are the only differences the answer is `outcome: "incomplete"`, gate `known_losses` (merged, everything else proven equal; `incomplete-receipt.json`) with `missing` + `repair` (a job of `set DefaultValue` on the existing elements) and `forcedDeleteRules` + `declare`; with other differences the refusal stays uncertain and its text names them.
7a. Rewrites the Studio makes on every merge (capability `merge:normalized`, `engine/NativeMergeVerification.cs`): a block instance's name derived from its block (`CustomNameTrio`), Max. Records dropped from the refresh of a Data Action (`RefreshMaxRecordsRemoved`) and a FontAwesome icon converted to its Phosphor name and weight (`IconConversion`, excused only when both models prove that change of that widget and the Studio's own conversion table, `IconLibraryProvider` of NRWidgets, maps it). Each is an exact family of dump lines. When they and forced delete rules are the only differences, the answer is `ok:true, merged:true, equivalence:"normalized"`, with `normalized` (one note per element, at most 20: `element`, `rule`, `local`, `candidate`) and `normalizedTotal`. A strict proof answers `equivalence:"strict"`.
7b. After the merge only validation errors and security warnings (`SecurityWarnings.IsSecurity`, the kernel's list, A03) block; every other new live message goes to the receipt's `warnings`.
7c. A refusal after CompareAndMerge took the candidate (the merge ran) answers `merged:true, equal:false, equivalence:"uncertain"`, and its text says the module already has the candidate: never repeat the delivery; read the evidence.
7d. `create`: creation manifest, `createAuthorization`, candidate hash and zero validation errors, identity, the name free in the live tenant listing (never the catalog), one attempt per evidence directory. `publish` of a created module compares the open module with the candidate through the native MatchTree and tolerates only reference refreshes (`open-vs-candidate.json`).
8. A modal window or a command still running: `studio_busy`. Only `status` and `dismiss-dialog` are accepted while busy.
   The timeout error lists the open dialogs and windows with their actions, so the next step is known without a
   separate `status`.

## Watchdog

While any command other than `status` and `dismiss-dialog` runs, the bridge polls the Studio every 750 ms and
closes, through their own footer action or close button, dialogs that carry no decision: a presenter dialog whose
only enabled labeled action is Close/OK, or an owned window whose only enabled button is the close button (the
publication notice). Each closure is journaled (`..\..\journal\dialog-*.json`) and listed as `dialogsClosed` in the
response and in the journal note. Dialogs with a choice (Yes/No, Save, Compare and Merge) are never touched; they
are reported and closed only by an explicit `dismiss-dialog <caption>|<action>`.

Every refusal is written to `<evidenceDir>\last-error.json` and to the journal with `outcome` and `gate`.
A command that outlives its timeout is journaled as `uncertain`; when it finally ends, a `<command>-late` line
records the real outcome and `late-result.json` or `last-error.json` lands in the evidence directory.

## Lessons encoded in the bridge

- A module opened from a local file has no upload linkage; Publish then reports a version conflict and opens
  Compare and Merge. Open from the organization instead (the default `open`).
- The Studio's top-level presenter is not idle while any owned window (for example "Communication error") is open;
  queued actions wait forever. `status` shows the window and `dismiss-dialog` closes it through the native button.
- Two queued opens of the same module produce two open copies; `close <Module> --duplicates` keeps one.
- The same published revision downloaded twice is not byte-identical; a differing download is stored under a
  hash-suffixed name, never treated as corruption.
- Authorship after a pure deletion is proven by absence of the base elements, not by a stamped element.
- The catalog is not the environment. A session once wrote a one-module catalog and later claimed the tenant had one
  module; the native listing showed 58 assets. `assets` rewrites the catalog from the server, in about 1 s.
- Dependency names are module names without spaces (`OutSystemsUI`), while asset names may have spaces
  (`OutSystems UI`); the gate compares module names, which is what `MergedAt` and `PublishedAt` are keyed by.
- `IAggregatorPresenter.ForceClose` is an explicit interface implementation: call it through the interface. Looking it
  up by name on the concrete type finds nothing. `close <Module> --discard` closes a modified copy with no save prompt
  after snapshotting it to `..\..\snapshots\<Module>-discarded-<sha256>.oml`.
- A module created headlessly (`CreateESpace`, platform Neo) carries an O11-flavoured `(System)` reference. The Studio
  refreshes it from the tenant when the module is opened from the organization; nothing else changes. That refresh is
  the only difference `publish` tolerates for created modules.
- The Studio does **not** refresh an open consumer's dependency when its producer publishes: TestGap kept
  `ODC3_LabLib r0` after the library's revision 3 was published, unmodified and without any dialog. A consumer base
  captured before the producer's publication is therefore refused by the dependency gate, not by the MatchTree; the
  reference stays outdated until `refresh-references` runs.
- `refresh-references <Module>` runs the native module-menu command "Check for dependency updates". It refreshed a
  headless-born library reference from r0 to r3 and then showed the dialog "Refresh of library dependencies", whose
  only footer action is Close and which blocks the command until closed; the bridge closes it and journals its text.
  With nothing outdated it returns in about 7 s with no dialog.
- `refresh-references <Module> --producer <Library>` uses `RefreshSpecificReferencesByKey` with the library's latest
  revision and model digest, the same call the Library Updates panel makes. It took TestGap from r3 to r4 in 9 s and
  the referenced action signature gained the new output. The native method also re-resolves every other
  fixed-version reference of the module in the same request; their displayed revisions changed (for example
  OutSystemsUI 76 -> 2) with no difference outside references. Every run writes `..\..\journal\refresh-<Module>-<stamp>.json`
  and `.txt` (MatchTree after vs before) and requires that nothing outside references changed.
- After a refresh the module is modified in memory: capture a new snapshot before building the next candidate.
- A dependency added headlessly (`Authoring.AddDependency`, native `ESpaceServicesImplementation.AddDependency`)
  carries revision 0; the native merge keeps it as is (strict equivalence held).
- After a publication the Studio may show an untitled owned window with a single `PART_CloseButton` (the publication
  notice). It blocks `open`; `status` lists it and `dismiss-dialog |PART_CloseButton` closes it.
- Business data has no public ODC API, but the Studio's `IServerCommunicationsServicesProvider.DataService` reads and
  writes records (`GetRecords`, `InsertRecords`, `UpdateRecords`, `DeleteRecords`: the HTTP calls behind "View data"
  and "Edit data"). Keys go in database form (`ObjectKeyUtils.DatabaseValue`, module, entity, identifier and
  attribute keys), values as text; booleans come back as decimals. `DataCommands.cs` holds the data lane. The
  signature `ObjectKey` property is obsolete: `Key` is the referenced object's key.
- The client joins argument words with spaces, so JSON never travels as an argument: request files live in
  `..\..\journal\data\requests` and authorization words are gathered up to the next `--` flag.
- Static field initializers of a partial class have no defined order across files; anything derived from `Root`
  outside `StartupHook.cs` is a computed property.
- The catalog root names one tenant, but the Studio may be signed into another one only. `Top()` then uses that
  single session, and `ResolveKey(module, host)` looks the name up in the section of the session's tenant first
  (the same module name exists in several tenants). A session once spent six minutes hand-editing modules.json
  to get `open` to work, and left the catalog with the personal section missing; never edit it by hand,
  `assets <host>` rewrites a section in a second.
- The builder takes the identity of a run (tenant, module key, author) from the base itself: the snapshot's
  `.oml.json` sidecar or a candidate's manifest. The catalog and tenants.json only fill gaps.
