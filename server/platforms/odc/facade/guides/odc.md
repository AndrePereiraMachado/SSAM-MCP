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
- `studio_open {module}` opens a module from the organization (the upload link Publish needs); `studio_close {module}` closes unmodified copies.
- `studio_snapshot {module}`, `studio_latest {module}`, `studio_consumers {module}`, `studio_reference_snapshot {module, producer, output}`.
- `ssam_app_url {app, screen}`: the home and screen URLs of an app; it opens nothing.
- `studio_data {module, entity}`: development database records; writes are `studio_data_insert`, `studio_data_update`, `studio_data_delete` with the user's words.

## Change and deliver

1. `ssam_discover {intent, lane:"odc"}` and `ssam_reference {lane:"odc", kind, query}`: operations, contracts, proven examples. The team rules before generating or changing modules: `ssam_reference {lane:"odc", kind:"rules", query:"all"}` (the 35 rules: `query:"padroes"`).
2. `studio_deliver {feature, module, job, owners, changes}`, directly: a fresh capture of the module as it is now in the Studio, build, the candidate checked against that capture and the native merge, in one call that refuses before any change with the fix and every problem at once (`problems`; `NO_CHANGE`: the module already has it). The merge proves the base and the preview conditions itself, so a delivery runs no separate check-base or preview. An identical delivery (same job and files it names, same capture, same kernel and builder) reuses the kernel build (`cache.hit`). `module` may be the app name the person sees ("QuizLive Web" reaches QuizLiveWeb). Never repeat an uncertain merge: its answer lists each divergence (`divergences`: element, property, local, candidate). Defaults the Studio drops on elements a merge creates are merged in a second native merge of the same call; outcome `incomplete` (gate `known_losses`: merged, everything else proven equal) names each one still lost in `missing` with its `repair` job, and each property the Studio rewrote in `normalized`; the continuation delivers the repair (`repairJob`) as a new job.
3. Deliver and publish in one call: `studio_deliver {..., publish:true, authorize:"<the user's words naming the app>"}`. After a clean merge it records the words and publishes with wait: `result:"entregue e publicado"`, `publish {outcome, version}`, `lastPublication`. Without `authorize`, the standing grant of the app is used (`authorization {source:"standing-grant", grantId}`); without either, the call is refused before anything is built (`PUBLISH_AUTHORIZATION_REQUIRED`). A merge that is not clean skips the publication (`publish.outcome:"skipped"`). A publication that fails answers `ok:false, result:"entregue", code:"PUBLISH_FAILED"|"PUBLISH_UNCERTAIN"` with the `studio_publish` continuation: publish again, never deliver again.
4. Only when the person asks: `ssam_job {lane:"odc", job}` proves a job on a fixture; `until:"preview"` reviews without merging; step by step: `studio_manifest`, `studio_check_base {manifest}`, `studio_preview {manifest}`, `studio_merge {manifest}`.
5. Publish separately: `studio_publish {module, authorize:"<the user's words>"}` (or a standing grant of the app). It publishes the module's last clean SSAM merge in this Studio and tenant, found from the delivery evidence (`resolvedFrom`); no manifest to look for. It refuses before anything, with the next call, a last merge that is not clean (`LAST_DELIVERY_NOT_CLEAN`), already published (`ALREADY_PUBLISHED`), made in another Studio process (`DELIVERY_IN_OTHER_STUDIO`), no SSAM merge at all (`NO_DELIVERY_TO_PUBLISH`), or an open module that changed since (`MODULE_CHANGED_SINCE_DELIVERY`). The answer of a delivery that did not publish keeps its `manifest` and names this call in `continuation`. `studio_publish {manifest}` still publishes a given manifest (`studio_authorize {manifest, kind:"publish", text}` records the words first). A new app or library: `studio_create_app {kind, name, authorize}` (the words name the app; created as the Studio does, opened and published). `studio_create {manifest}` only uploads a ready whole-module candidate.
6. `studio_refresh_references {module, producer}` updates a dependency; the next `studio_deliver` captures the module again by itself.

Ao cair para verbos nativos porque a forma compacta não cobre o caso, registre com `ssam_friction {view:"report", kind:"gap"}`.

Jobs: grave com Write (UTF-8) num arquivo e passe o caminho; nunca heredoc.

7. `studio_build {feature, base, sha, output}` runs one builder feature of the release on a hash-checked base; `studio_command {command, args}` reaches a bridge command without its own tool (module-info, publish-status, stop).

What the ODC Studio rewrites on merge is refused before the build with the fix: a structure made public in an app (`ODC_STRUCTURE_PUBLIC_IN_APP`: flat outputs, a public entity, or a library) and a Refresh Data `MaxRecords` other than its aggregate's (`ODC_REFRESH_MAXRECORDS`: omit it; set Max. Records on the aggregate).

While a merge or a publication runs, `studio_status {}` answers at once from that delivery's evidence (`fromEvidence:true`, `busy {command, since}`, stage, `merge-started.json`); the call that started it answers when it ends.

## Dialogs

`studio_wait {condition:"no-dialogs"}` waits; informational dialogs are closed by the bridge. A dialog with a choice: `studio_dismiss_dialog {caption, action}` only when the person has decided.

## Portal and public APIs

- `hybrid_tenants {}` and `odc_auth_status {tenant}`: which session answers each tenant.
- Authentication order per call: the ODC Studio session, then the credential stored in the Windows vault, then a private prompt the tool opens itself. Credentials never pass through the chat.
- Catalog: `odc_status`, `odc_portal_capabilities`, `odc_describe_capability`, `odc_list_apis`, `odc_search_operations`, `odc_describe_operation`.
- Calls: `odc_read {tenant, operationId}`, `odc_write {tenant, operationId, authorize, operationUuid}`, `odc_deploy`, `odc_operation_status`, `odc_configurations`, `odc_asset_delete`, `odc_external_db_connection`.
- `odc_external_library {action:"build"|"deploy"|"status"|"discard", spec, authorize, operationUuid}`: generates, builds, uploads, publishes and tags an External Library in one call; references go through the existing reference job.
- `odc_asset_delete`: the words name the asset and every consumer.
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
| `ODC_STRUCTURE_PUBLIC_IN_APP`, `ODC_REFRESH_MAXRECORDS`, `PREFLIGHT_REFUSED` | fix the job as each item of `problems` says (`fix`, `patch`), then the same `studio_deliver` |
| `PUBLISH_AUTHORIZATION_REQUIRED` | the same `studio_deliver` with `authorize` (the user's words naming the app) |
| `PUBLISH_FAILED`, `PUBLISH_UNCERTAIN` | the `studio_publish` continuation after the fix the publish log names; never a new delivery |
| `MERGE_UNCERTAIN` | none: read `divergences`, the receipts and the journal; never repeat the merge |
| `MERGE_CONFLICT` | a new `studio_deliver` built on the module as it is now |
| `AUTHOR_MISMATCH` (gate `authorship`) | the person signs in to the tenant of the snapshot as the account it names, then the same call |
| `INCOMPATIBLE_STUDIO` | `ssam_doctor {lane:"odc", checks:["compat"]}` |
| `COMPONENT_MISSING`, `ODC_BRIDGE_CLIENT_MISSING` | `ssam_doctor {lane:"odc"}`; reinstall or update, nothing is built here |
