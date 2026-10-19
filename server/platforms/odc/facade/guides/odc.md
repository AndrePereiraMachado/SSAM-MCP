# SSAM: the ODC lane (ODC Studio and the ODC APIs)

Every step is an MCP call. A refusal carries `continuation: {tool, arguments, why}`; follow it. `ssam://guide/refusals` lists every code.

## Connect

1. The person opens the ODC Studio normally and signs in to the tenant.
2. `ssam_connect {lane:"odc", dryRun:true}`: the static compatibility check only; nothing is sent to the Studio.
3. `ssam_connect {lane:"odc"}` (or `studio_attach {}`, the same path): attaches the bridge in memory, beside any other version.
4. `studio_status {}` and `studio_doctor {}`: bridge, open modules, dialogs, catalog age, Portal access per tenant.

With several ODC Studios open, pass `pid`. Never ask the person to close or restart the Studio to connect.

## Read

- `studio_assets {}`: the tenant's assets, the same service as the Studio's Open dialog. Call it before any claim about what exists.
- `ssam_map {lane:"odc", target}`: every element of the capture with its `@key`; then `studio_inspect {target, path:"@<key>", expectedSourceSha256}` for one element.
- `ssam_code {lane:"odc", action, part}`: the module as code, one word to read and write: part `ddl` (data as SQL DDL), `logic` (actions as pseudocode), `html` (screens). `grammar` gives the syntax and a from-scratch example (an empty module starts there), `read` the part with its keys, `check` validates against a capture without Studio, `write` delivers it through `studio_deliver`; `files` sends several code files in the same check or write.
- `studio_open {module}` opens a module from the organization (the upload link Publish needs); `studio_close {module}` closes unmodified copies.
- `studio_snapshot {module}`, `studio_latest {module}`, `studio_consumers {module}`, `studio_reference_producers {module}` (the producers the open consumer can reference, read only), `studio_reference_snapshot {module, producer, output}`.
- `ssam_app_url {app, screen}`: the home and screen URLs of an app; it opens nothing.
- `studio_data {module, entity}`: development database records; writes are `studio_data_insert`, `studio_data_update`, `studio_data_delete` with the user's words. File loads use `files:[absolute paths]` (JSON, JSONL, CSV) and REQUIRE `keys` (unique, non-null natural keys), with `columns`, `references` and `dryRun` (per row: insert, update current -> new, unchanged). Equal rows skip and missing rows insert (an update with `insertMissing:false` refuses absent keys); a key that exists with other values is an overwrite: the call stops before any write with `updatePreview` and writes only with `confirmUpdates {previewSha256, authorize}` carrying the owner's next message, which states that row count. One refusal before any write; the same `operationId` resumes by re-reading the keys (the load's words come from its plan). `close {preview:true}`, then `close {previewSha256, authorize}` with the owner's words stating the rows left unwritten.

## Change and deliver

To change only a few lines of a read action, use `ssam_code {lane:"odc", action:"write", module, part:"logic", element:"X", basedOn:"<textSha>", edits:[{replace:"@n4", with:"..."}]}`. Take `basedOn` from the action read; edits address that read and keep its other lines. Use `also:[{part:"logic", element, basedOn, edits}]` for more actions in the same delivery.

For 6 or more elements, call `ssam_code {lane:"odc", action:"plan", module, items:[{kind, name, intent, signature}]}`: write its shared data first, launch its batch prompts in parallel, then send its `final` write.

With subagents, each writes its part to its own UTF-8 file: `.flow` may hold several actions, each with its `///` description and header at column 0, with a blank line between; data goes in `.ddl`, screens in `.html`, and JSON ops in `.json`. Before answering only the absolute path, each runs `ssam_code {lane:"odc", action:"check", module, files:["C:\\...\\shared.ddl", "C:\\...\\shared.json", "C:\\...\\parte-1.flow"]}` until ok; checks use the newest capture, never contact the Studio and are safe in parallel. If this part calls an action from another part, include that file in the check too. The main agent sends ONE `ssam_code {lane, action:"write", module, files:["C:\\...\\parte-1.flow", ...]}`, never copying their text into the call. SSAM splits the actions and names every problem by file (`files/<i>`) in one refusal.

1. `ssam_discover {intent, lane:"odc"}` and `ssam_reference {lane:"odc", kind, query}`: operations, contracts, proven examples. The team rules before generating or changing modules: `ssam_reference {lane:"odc", kind:"rules", query:"all"}` (the 35 rules: `query:"padroes"`).
2. `studio_deliver {feature, module, job, owners, changes}`, directly: a fresh capture of the module as it is now in the Studio, build, the candidate checked against that capture and the native merge, in one call that refuses before any change with the fix and every problem at once (`problems`; `NO_CHANGE`: the module already has it). The merge proves the base and the preview conditions itself, so a delivery runs no separate check-base or preview. An identical delivery (same job and files it names, same capture, same kernel and builder) reuses the kernel build (`cache.hit`). `module` may be the app name the person sees ("QuizLive Web" reaches QuizLiveWeb). Never repeat an uncertain merge: its answer lists each divergence (`divergences`: element, property, local, candidate). Defaults the Studio drops on elements a merge creates are merged in a second native merge of the same call; outcome `incomplete` (gate `known_losses`: merged, everything else proven equal) names each one still lost in `missing` with its `repair` job, and each property the Studio rewrote in `normalized`; the continuation delivers the repair (`repairJob`) as a new job.
3. Deliver and publish in one call: `studio_deliver {..., publish:true, authorize:"<the user's words naming the app>"}`. After a clean merge it records the words and publishes with wait: `result:"delivered and published"`, `publish {outcome, version}`, `lastPublication`. Without `authorize`, the standing grant of the app is used (`authorization {source:"standing-grant", grantId}`); without either, the call is refused before anything is built (`PUBLISH_AUTHORIZATION_REQUIRED`). A merge that is not clean skips the publication (`publish.outcome:"skipped"`). A publication that fails answers `ok:false, result:"delivered", code:"PUBLISH_FAILED"|"PUBLISH_UNCERTAIN"` with the `studio_publish` continuation: publish again, never deliver again.
4. Only when the person asks: `ssam_job {lane:"odc", job}` proves a job on a fixture; `until:"preview"` reviews without merging; step by step: `studio_manifest`, `studio_check_base {manifest}`, `studio_preview {manifest}`, `studio_merge {manifest}`.
5. Publish separately: `studio_publish {module, authorize:"<the user's words>"}` (or a standing grant of the app). It publishes the module's last clean SSAM merge in this Studio and tenant, found from the delivery evidence (`resolvedFrom`); no manifest to look for. It refuses before anything, with the next call, a last merge that is not clean (`LAST_DELIVERY_NOT_CLEAN`), already published (`ALREADY_PUBLISHED`), made in another Studio process (`DELIVERY_IN_OTHER_STUDIO`), no SSAM merge at all (`NO_DELIVERY_TO_PUBLISH`), or an open module that changed since (`MODULE_CHANGED_SINCE_DELIVERY`). The answer of a delivery that did not publish keeps its `manifest` and names this call in `continuation`. `studio_publish {manifest}` still publishes a given manifest (`studio_authorize {manifest, kind:"publish", text}` records the words first). A new app or library: `studio_create_app {kind, name, authorize}` (the words name the app; created as the Studio does, opened and published). `studio_create {manifest}` only uploads a ready whole-module candidate.
6. `studio_refresh_references {module, producer}` updates a dependency; the next `studio_deliver` captures the module again by itself.

When you fall back to native verbs because the compact form does not cover the case, record it with `ssam_friction {view:"report", kind:"gap"}`.

Jobs: write them with Write (UTF-8) to a file and pass the path; never a heredoc.

7. `studio_build {feature, base, sha, output}` runs one builder feature of the release on a hash-checked base; `studio_command {command, args}` reaches a bridge command without its own tool (module-info, publish-status, stop).

What the ODC Studio rewrites on merge is refused before the build with the fix: a structure made public in an app (`ODC_STRUCTURE_PUBLIC_IN_APP`: flat outputs, a public entity, or a library) and a Refresh Data `MaxRecords` other than its aggregate's (`ODC_REFRESH_MAXRECORDS`: omit it; set Max. Records on the aggregate).

While a merge or a publication runs, `studio_status {}` answers at once from that delivery's evidence (`fromEvidence:true`, `busy {command, since}`, stage, `merge-started.json`); the call that started it answers when it ends.

## HTML prototype → native screens

A prototype folder (index.html, app.js, styles.css, mock data, icons, images), or the .zip it came in, becomes native screens in ONE call through the ssam server (it takes the job inline), with no reading and no conversion by the model:

`studio_deliver {feature:"Prototype <Prefix>", module:"<open module>", job:{ops:[{op:"prototype", data:{source:"<prototype folder or its .zip, absolute path>"}}]}, owners:["<Prefix>"], changes:["Prototype <Prefix> imported as native screens"], publish:true, authorize:"<the owner's words>"}`

- `feature`, `owners` and `changes` may be left out: the ssam server fills them from the prototype's prefix (its `<title>` up to the first separator, in PascalCase).
- Give a .zip as it is (SSAM extracts it safely once; never unzip it with a shell). Do not read `app.js`, `model.js`, `styles.css`, the `.jsx` or the HTML, and never split the views into several calls: SSAM renders the prototype headless and builds one screen per view in a flow of its own, a shell block, native popups, entities with the mock data, aggregates and server actions, with the prototype CSS verbatim in a theme of its own; `main`, `data` and `picture` (not HTML Element tags on ODC) are substituted. A name already taken by an element the import does not own becomes `<Prefix><Name>` (`renamedFrom`), never a refusal.
- A prototype with several versions (`v1`/`v2`/`v3` `.jsx`, a design canvas): SSAM builds the one the HTML opens and lists the others in `prototype.source.unreferenced`; another version only when the person asks for it (`data.mapping.version:"<file of the folder>"`).
- Several `.html` pages at the root and no `index.html` (the app and a style guide): the refusal names in its patch the page that runs the app, already captured with it (`verified`); send the `correctedJob` (the capture is reused), or give `data.entry` in the first call. Reference images (`screens/*.png`) are never part of the app.
- The owner's words in `authorize` cover the import, the publication and the demo data: after a clean publication the mock rows go into the empty regular entities the import created (`studio_data_insert`). `data.seed:false` leaves the data out.
- A refusal of the prototype (`PROTOTYPE_*`) comes ONCE, before the Studio is touched, with every problem, the ready `patch` over `/ops/<i>/data` and `correctedJob`: send the patch as it is (`patch` + `basedOn`). `data.mapping` only when a refusal asks for it. A build problem on a generated item rebuilds once without it (`prototype.degraded`); a second failure is `VALIDATION_REFUSED` with `ssamDefect:true` and the `mapping.ignore` patch.
- Screens on real data: `data.bind {producer:"<Module>"}` in the same call; `PROTOTYPE_BINDING_REQUIRED` proposes every source (Data Action), list, text and event (`call` / `navigate`) over the producer's published actions, each built offline before it is offered; apply the whole `patch`, write or `null` the unresolved items. Bound collections get no entity and no seed. (The ODC producer is referenced as its public signature: the kernel's binding is shared; the live ODC proof is pending.)
- The answer carries the receipt in `prototype` (screens with `url`, popups, blocks, data, events, fidelity per state, Verify warnings, seed, timings). Give the person the screen links.
- A rehearsal without merge only when the person asks: `until:"preview"` (ODC has no `until:"apply"`).

## Dialogs

`studio_wait {condition:"no-dialogs"}` waits; informational dialogs are closed by the bridge. A dialog with a choice: `studio_dismiss_dialog {caption, action}` only when the person has decided.

## Portal and public APIs

- `hybrid_tenants {}` and `odc_auth_status {tenant}`: which session answers each tenant.
- Authentication order per call: the ODC Studio session, then the credential stored in the Windows vault, then a private prompt the tool opens itself. Credentials never pass through the chat.
- Catalog: `odc_status`, `odc_portal_capabilities`, `odc_describe_capability`, `odc_list_apis`, `odc_search_operations`, `odc_describe_operation`.
- Calls: `odc_read {tenant, operationId}`, `odc_write {tenant, operationId, authorize, operationUuid}` (a DELETE or Undeploy takes two calls: below), `odc_deploy`, `odc_operation_status`, `odc_configurations`, `odc_asset_delete`, `odc_external_db_connection`.
- `odc_external_library {action:"build"|"deploy"|"status", spec, authorize, operationUuid}`: deploy generates, builds, uploads, publishes and tags an External Library in one call; references go through the existing reference job. Its `discard` (an open job) previews first and executes with `confirmationToken`.
- `odc_asset_delete {tenant, assetKey}`: the preview (identity, consumers, backup plan, `confirmationToken`); then the same call with `confirmationToken` and the owner's words naming the asset and every consumer, with the count.
- Every destructive call (odc_asset_delete, odc_write/odc_deploy DELETE or Undeploy, the destructive odc_portal_write routes, odc_a2a_connection_delete, odc_external_db_connection delete/remove-entities, odc_external_library discard, studio_data_delete) takes two calls (CX15): without `confirmationToken` it only shows the list; show the owner that EXACT list and ask; the owner's reply, verbatim, states the number of items and names the targets; `operationUuid` of the execution is the preview's `operationId` (never a new one, never omitted). The words are the owner's next message after the list, copied whole: never write, complete, translate or reuse words yourself (not the request, not a template, not a reply to another list); without such a message, ask the owner and stop. studio_command never runs data-delete, portal-call, portal-private-call or portal-api-client-fixture-cleanup. Interrupted, CANCELLED, SC_LOCAL_FAILURE or another local failure, 'rejected' or no answer: read ssam_task {id:<operationId from the preview>} before telling the owner anything; never say nothing happened without it.
- Job ops `rest` and `rest-expose` (and `rest` with `openapi`) through studio_deliver.
- Internal Portal: `odc_portal_login {tenant}` (the person signs in once in the Portal window inside the ODC Studio), `odc_portal_read`, `odc_portal_write`, `odc_portal_routes {tenant, module}`.
- Every write needs the user's words and a new `operationUuid`. An uncertain write is never repeated: `odc_receipt {operationUuid}` reconciles it with a read.
- Secret values are never arguments: secret settings go as `vaultSettings`, database accounts as vault entries. A missing one: `ssam_credentials {action:"prompt", kind:"odc-setting", host}`, `{kind:"odc-db"}`, `{kind:"odc-api-client"}` or `{kind:"odc-portal"}`.

## Debugger

`ssam_debug {lane:"odc", ...}`: headless server debugger with the tenant's private API Client.

## Refusals of this lane

| code | next call |
|---|---|
| `STUDIO_NOT_CONNECTED`, `ODC_STUDIO_NOT_RUNNING` | the person opens the ODC Studio, then `ssam_connect {lane:"odc"}` or `studio_attach {}` |
| `STUDIO_NOT_SIGNED_IN` | the person signs in in the ODC Studio; `hybrid_tenants {}` shows it |
| `STUDIO_BUSY` | `studio_wait {condition:"idle"}`, then repeat |
| `STUDIO_REQUIRED` | `ssam_connect {lane:"odc"}`: the secret is read only inside the ODC Studio |
| `PORTAL_AUTH_REQUIRED`, `WEB_SIGN_IN_REQUIRED` | `odc_portal_login {tenant}` |
| `ODC_API_CLIENT_MISSING` | `ssam_credentials {action:"prompt", kind:"odc-api-client", host}` |
| `SECRET_IN_ARGUMENTS` | `ssam_credentials {action:"prompt", kind, host}`, then pass only the entry name |
| `FEATURE_NOT_IN_RELEASE` | `ssam_discover {intent, lane:"odc"}` for the job operation |
| `MODULE_NOT_OPEN` | `studio_open {module}`, then the same call again; `openModules` lists what is open |
| `MODULE_AMBIGUOUS` | the same call with one of `candidates`, the exact module name |
| `NO_CHANGE` | none: the module, as it is now, already has what the job asks for |
| `ODC_STRUCTURE_PUBLIC_IN_APP`, `ODC_REFRESH_MAXRECORDS`, `PREFLIGHT_REFUSED` | fix the job as each item of `problems` says (`fix`, `patch`, `patchByName`): the same `studio_deliver` with `patch` + `basedOn` (`nextBasedOn`), or only the changed actions in `job` + `basedOn`; never the whole job |
| `PUBLISH_AUTHORIZATION_REQUIRED` | the same `studio_deliver` with `authorize` (the user's words naming the app) |
| `PUBLISH_FAILED`, `PUBLISH_UNCERTAIN` | the `studio_publish` continuation after the fix the publish log names; never a new delivery |
| `MERGE_UNCERTAIN` | none: read `divergences`, the receipts and the journal; never repeat the merge |
| `MERGE_CONFLICT` | a new `studio_deliver` built on the module as it is now |
| `AUTHOR_MISMATCH` (gate `authorship`) | the person signs in to the tenant of the snapshot as the account it names, then the same call |
| `INCOMPATIBLE_STUDIO` | `ssam_doctor {lane:"odc", checks:["compat"]}` |
| `COMPONENT_MISSING`, `ODC_BRIDGE_CLIENT_MISSING` | `ssam_doctor {lane:"odc"}`; reinstall or update, nothing is built here |
