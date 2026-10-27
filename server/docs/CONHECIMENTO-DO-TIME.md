# Team knowledge

Working rules and platform lessons learned in the real use of SSAM Hybrid. They apply to any agent (Claude, Codex or
another) and to anyone on the team. Read them before generating or changing O11 or ODC modules.

## 1. How to work

### Traditional official components from the first delivery

UI task packets (a UI text route, a first direct match that is UI, or a screen request) expose `uiCatalog` in the room
they have left. Data/logic/operation packets keep their budget for the requested code; the same explicit lookup is always available.
Use `ssam_discover {lane, expand:"osui:<appType>"}`: o11-traditional includes OutSystemsUIWeb AND RichWidgets;
o11-reactive/o11-mobile use the compatible OutSystemsUI catalog, and odc-reactive/odc-mobile use the ODC revision.
Expand a component for its inputs, placeholders and native instance recipe; `osui:o11-traditional/actions:Feedback_Message`
returns the action contract (not the similarly named block). Catalog/fixture presence is not browser or task-behavior proof.
For any language, interpret the user's meaning, negations and context before choosing components. Keyword results are
suggestions, never a capability gate. With `traditionalTask`, provide `resolution:[{pattern,evidence}]`, where evidence
is an exact excerpt of the original request. This records the agent's interpretation; it is not an automatic language
detector. A request without keyword matches returns the resolution route, not a denial of support.

Task-level authoring: use the Traditional packet's `taskPlan` for the requested behaviors, not a generic gallery.
`ssam_reference` kind `recipe`, query `{traditionalTask: "the user's UI request"}` returns contracts and integration steps.
Its `bind` form builds native component ops from resolved parameters; `implement` compiles pagination, success-feedback,
informational modal, tabs or accordion behavior from resolved bindings. Read `plan.compile` for the contract and limits.
Tabs/accordion currently accept expression content; they do not compile arbitrary nested forms or their save flows. Other patterns remain
guided authoring; never call their presence in the catalog proof of a working task. Merge all screen/action/data changes
in the same module delivery and keep planned, generated, native-verified, published and browser-tested status separate.

Reuse the module's official layout/theme and its placeholders; do not build a second shell or menu inside MainContent.
Read the installed OutSystemsUIWeb/RichWidgets contract before composing UI. Prefer compatible official components
for dialogs, feedback, paging and sorting. A custom overlay is not the default substitute for a missing recipe.
Never offer Reactive OutSystemsUI/IPopup examples for a WebResponsive module.

For an explicitly requested RichWidgets.Popup_Editor: use a named Navigate link, LinkOrButtonWidgetId=Link.Id,
a separate screen with OutSystemsUIWeb.LayoutPopup, Popup_Editor_Notify followed by Popup_Editor_Close on success,
and OnNotify in the parent to fetch changed data and Ajax Refresh. Refresh the trigger and popup instance together.
Native action references are IReference:Producer/IServerActionSignature:Action; Method/Validation belong to OnClick.
Check the installed component's deprecation/device restrictions: Popup_Editor 5404 is deprecated and unsupported on
mobile, so choose the supported responsive Modal for new responsive UI unless compatibility is explicitly required.
For requested browser acceptance, include first load and post-Ajax controls, close/cancel, validation, data refresh,
desktop/narrow layout and actual served CSS. Publication alone does not establish usable UI.

### Traditional Web interaction methods

Traditional HTML supports creation plus keyed reading/editing: `ssam_map {lane:"o11",target,view:"html",screen}`
returns the native source with `k` and `basedOn`. Submit complete changed elements through the `html` op in one
`o11_deliver` job; retain the children that must survive. Block inputs are `:Input`, typed handlers are `@Event`,
legacy handlers use `onnotify`, and calls carry named argument expressions. Keep the returned native event properties
(`os-onclick.Method`, `os-onclick.Validation`), data bindings and guards. Unknown `os-opaque` kinds retain their subtree.
The HTML editor is not an unrestricted HTML/JavaScript importer.

Use Navigate for a screen/URL and Ajax Submit for same-screen interactions (tabs, modal open/close, filters and
pagination). Ajax does not rerun the screen Preparation: fetch changed data, update bound state, then Ajax Refresh
the affected persistent container around the conditional content. Refreshing markup is not refreshing data.
Use validation=None for navigation controls; keep server authorization and business validation on writes.
Keep native upload/download on Submit. The Model API exposes Method on ILinkWidget/OnClick; a document button
with explicit method becomes a styled native link. Preserve event arguments, guards, ordering and captions on edits.
Test methods separately after publication; a clean publish is not evidence that an Ajax interaction ran in a browser.

- **Validation only when asked.** Behavior tests, reviews and checks in the browser run only when the person asks for
  them. Do not add validation rounds on your own.
- **An error goes back to the model.** When a delivery tool returns verifier errors (TrueChange), it delivers nothing.
  The model fixes the request and calls again.
- **Without errors, the answer is "delivered".** Do not describe what changed or where: the person checks it on the
  platform and, if needed, uses the Studio's Compare.
- **Build on the latest published version.** Other people publish too. Before building a change, download the current
  published version of the module and use it as the base.
- **In a usage task, do not touch the product.** To create an ODC app or library, use `studio_create_app {kind, name,
  authorize}` (it clones the tenant's template like the Studio and publishes). To change an app, use `ssam_discover`,
  `o11_deliver`/`studio_deliver`, `studio_merge`... Do not write C# features in the builder, do not edit the kernel nor
  the versioned configuration files. Before saying something is not possible, ask `ssam_discover`: it returns the exact
  operation. If the capability is really missing, stop and say what is missing, so it becomes product work.
- **Every request starts at `ssam_discover`.** It answers any SSAM request. For an operation (open a module, publish,
  create an app, data, Service Center, Portal, debug), it returns the tool, the verb and the arguments in `tools`. For a
  model change, it returns the contract and an example. Nothing is blocked: the other tools stay free.
- **Personal configuration stays local.** Each person's tenant, host and author go in `.ssam-local.json` (outside git),
  written by the development setup. Never commit your values in `tenants.json`.
- **No long runs.** No hours-long flows nor full suites repeated without need. Prefer the smallest test that answers the
  question and say beforehand how long it takes.

### O11 Reactive/Mobile: role checks run on the server

A native role action such as `CheckApproverRole` cannot be called directly as a node in a client/screen flow. Native
verification can accept the link, then merge clears its destination. Use a server action that checks `GetUserId()` and
returns the permission; load it through a Data Action. Keep an independent server-side permission check on every
business write. `ROLE_ACTION_REQUIRES_SERVER` refuses a direct client call before delivery. The example
`pat-role-check-screen` shows the complete composition.

### Jobs in a file (local) and inline (hosted)

- Local: a large job goes in a file written with the Write tool, in UTF-8, and the call passes the absolute path.
- Hosted: the job itself goes inline in the `job` argument, as compact JSON (no indentation), even when large. The call
  goes straight to the server (up to 16 MiB). A job in the inbox costs one more upload through the agent: 26.9 s for 60 KB
  in the production test of 2026-10-11, and 57% of the bytes were indentation spaces. Correction: `patch` + `basedOn`
  (the `nextBasedOn`).
- The agent inbox (`<agent folder>\inbox\<name>`, passed as `agent:inbox/<name>`) is for the user's files: OML, images,
  assets. A job that is already there (`agent:inbox/<name>.json`) still works.
- Never generate the JSON with a heredoc, `echo` or a script: the encoding and the quotes break.

### Subagents: discovery before the task

Only clients that defer schemas (such as Claude Code) use ToolSearch in one search before the first use
(`select:mcp__<server>__ssam_discover,mcp__<server>__ssam_map,...`). The first call of the subagent is `ssam_discover {intent, lane, app, packet:true}`: the packet brings the
elements of the module, the contract, a proven example, the rules that apply and the next step. It works from the
packet, without rereading docs or the module.

Each subagent writes its part to its own UTF-8 file and answers only the path: a `.flow` may hold several actions, each with its `///` description and its header at column 0, separated by a blank line; data in `.ddl`, screens in `.html` and JSON ops in `.json`. The main agent sends all the paths in one single call `ssam_code {lane, action:"write", module, files:["C:\\...\\part-1.flow", ...]}`, without copying or retyping the texts. SSAM splits the actions; a refusal points out every problem by file (`files/<i>`).

### Facade change: when to reconnect the MCP

The MCP server reloads by itself when the facade or the catalog change: the next call already uses the new code, and
`ssam_doctor` shows `server.reloadedAt`. Only a change in `facade/launch.mjs` or `facade/friction-*.mjs` needs the MCP
reconnected (Claude Code: `/mcp` and reconnect). A change of the kernel, the CLI or the XIF engine alone needs nothing.

### Several agents in the same Studio: one module per agent

Give each agent a module of its own. The build of each delivery runs at the same time, outside the lock; the merge waits
for its turn in the Studio. Nobody waits or repeats by hand: SSAM keeps the queue. Details in
`docs/AGENTES-EM-PARALELO.md`.

### expectedMessages: only what a refusal asked for

Declare in `expectedMessages` only the messages a refusal asked for, with the id and the element it named. Never list
messages as a precaution: an expectation nobody asked for hides a new error.

## 2. OutSystems implementation standards

- All generated code follows the 35 rules of the OutSystems standards (logic, lists, data, server, UI, names, state and
  architecture): `ssam_reference {lane:"<lane>", kind:"rules", query:"standards"}` (file
  `kernel/scripts/outsystems_padroes/RULES.md`). All of them apply to O11 and ODC, except AR1 (Architecture Canvas),
  which is O11 only.
- The automatic check of these rules is optional and runs only when someone asks for it.
- Scope rule: implement every acceptance criterion. When two requirements contradict each other directly, implement
  neither of them, record the conflict as pending and implement the rest.

## 3. Platform lessons

### Data access: one query with a join, never a query inside a loop

The owner's decision (2026-10-09), a kernel rule on both lanes. Fetch the related data at once, before the loop, and
look the row up by key inside it:

```json
{"get":"Order","as":"GetOrdersWithLines","sources":["OrderLine"],
 "joins":[{"left":"Order","right":"OrderLine","kind":"With or Without","condition":"OrderLine.OrderId = Order.Id"}],
 "where":"Order.CustomerId = CustomerId"}
```

When the aggregate cannot express the query, one single SQL, with IN or JOIN on the key of the list:

```sql
SELECT {OrderLine}.* FROM {OrderLine} WHERE {OrderLine}.[OrderId] IN (@OrderIds)   -- @OrderIds with Expand Inline
```

Inside the loop, `ListFilter(GetOrdersWithLines.List, OrderLine.OrderId = GetOrders.List.Current.Order.Id)` (or
`ListIndexOf`) instead of another aggregate.

- **QUERY_IN_LOOP (refusal)**: an Aggregate or Execute SQL in the body of a ForEach, or in an If/Assign cycle that goes
  back to an earlier node, that the job created or changed, is refused at apply, together with the other failures (one
  single refusal). The answer brings the op, the loop, the query, the fix and, when it can be derived (a ForEach over
  another aggregate of the flow with an FK between the entities), the ready ops in `suggestion`. An old loop and query,
  in a flow the job touched without changing them, become a HIGH warning (`legacy: true`), never a refusal.
- An explicit escape, only when the query really has to run per item: `"allowQueryInLoop": {"why": "<15+ characters>"}`
  on the op that creates the query. It is accepted and stays in the receipt (`QUERY_IN_LOOP_ALLOWED` in `highWarnings`),
  never silently.
- **Aggregate sort (refusal, `AGGREGATE_SORT_NOT_ATTRIBUTE`)**: the sort is ONE attribute of a source (`Source.Attribute`)
  or a column of the aggregate; descending order is `desc` (in the text) or `SortDirection` Descending. Never an
  expression: the Verify accepts it and the publication breaks in the compiler (VisitaCerta_CS, 2026-10-12). `X DESC`,
  `-X`, `IdentifierToLongInteger(X)` and `If(C, 0, 1)` are written as the attribute with the direction and listed in the
  receipt; a computed order (an If over a variable, a calculation) becomes a column `CALC SortKey=<expression>` with
  `SORT SortKey`, or a dynamic sort. A grouped aggregate (GROUP BY or AGG) only sorts by an attribute the GROUP BY reads.
  GROUP BY and AGG over an expression are refused: `CALC NameRow=<expression>` and the column by its name
  (`AGG Total=Sum(TotalRow)`). A join is Inner, Left or Full (a Right of two sources becomes a swapped Left, listed); a
  source without a join is refused. A SOAP client is only born from the native import of the WSDL (op soap through
  o11_deliver): created by verbs, it is refused with the ready call. The compile check refuses all of this before
  delivering, including what the base already had (`preexisting`, with the ops that fix it when that is certain): no
  delivery over a base that does not compile compiles.
- **AGGREGATES_MERGEABLE (HIGH warning)**: two or more aggregates in the same flow or on the same screen, over the same
  entity or entities linked by a reference attribute, used together. The warning names the aggregates, the relation
  (`Entity.Attribute -> Entity`) for semantic review; it does not emit replacement operations. A relationship alone does
  not prove equivalence of authorization, transaction locks, intervening calls/writes, dependent filters, independent
  pagination/counts or join cardinality. Preserve the queries until those semantics are proved. A03: it does not block,
  but it comes first in `warnings` and also in `highWarnings`, in the compact answer of `studio_deliver`, `o11_deliver`,
  `ssam_job` and `o11_job`. On different screens it does not count.

### Explicit exception for screen JavaScript

New JavaScript normally belongs in an isolated, named client action. An explicitly authorized exception can be
declared on a `logic`, `create`, `duplicate` or `move` op as `allowScreenJavaScript` with `module`, `screen`,
`actions` (a nonempty list of exact action names) and `why` (at least 15 characters). The loaded module and the
action's owner must match the scope. It is recorded as `FLOW_SCREEN_JAVASCRIPT_ALLOWED` in `highWarnings`.
It does not allow server JavaScript or suppress native verification. Use this for an explicit request such as
calling a screen's existing actions through `$actions` in a JavaScript click wrapper; preserve parameters and
completion/error handling. Full example: `docs/TEXTO-LOGICA.md`.

### Approved prototype: port it 1:1

When the person approved a prototype (HTML and CSS), it is ported 1:1: the op `html` with the markup of the prototype and
its `<style>` in the theme of the module. Do not replace the prototype with OutSystems UI patterns. Nothing is done
without the link of the app (`ssam_app_url`).

### CSS: a reset scoped with :where()

The CSS reset of a prototype is scoped with `:where(.<screen class>)`, which has zero specificity. Never write an element
selector (`button`, `a`, `input`) over the OutSystems UI classes: it beats the theme and breaks the widgets.

### List: partial refresh without reloading the screen

To change one row of the list without reloading the whole screen:
- the server action writes and returns, in its outputs, the new row and the summary (totals, counts);
- the client action does an `Assign` on `<List>[<index>]` with the returned row and copies the summary from the outputs
  to the screen variables;
- do not call the refresh of the aggregate nor of the Data Action of the whole list.
The contract of the `call` and `assign` steps is the one of the capability `logic.flow`:
`ssam_discover {intent:"variable assignment in a logic flow", lane}`.

### O11: republish the consumers after the producer

A consumer module keeps running the code of the producer it was published against, even without a signature change.
After publishing a producer, republish each consumer in dependency order and only then test. Without that, the new
logic looks "broken" on the screen.

Timers with the Schedule "When Published" may not run right after the publication. For initial loads (seed), prefer
running them on demand.

### ODC: what the Studio refuses and the preflight already refuses before the delivery

The kernel preflight (rule `OdcPlatformRules`, 05/10/2026) refuses in the job, with the exact fix, what the ODC Studio
refused in the QuizLive session (04/10):
- **A Service Action of the app itself** called by a flow of the app (`ODC_SERVICE_ACTION_SAME_APP`): the logic goes in a
  Server Action, and the Service Action stays only as the API other apps call. Do not generate Service Actions nor
  `Core_` actions the person did not ask for.
- **`GenerateGuid()` and the `mod` operator** do not exist in ODC (`ODC_FUNCTION_UNAVAILABLE`): derive the data code (the
  last Id) and write `x mod n` as `x - DecimalToInteger(x / n) * n`.
- **The `Count` of an aggregate is a Long Integer** (`ODC_COUNT_IS_LONG`): assigned to an Integer, use
  `LongIntegerToInteger(GetX.Count)` (the problem brings the patch) or declare the variable as Long Integer.

### O11: timer schedule as text

The `Schedule` of an O11 timer uses native times: `03:00` means every day at 03:00;
`00:05 Mon` means Monday at 00:05. For every day every five minutes,
use `{ "everyMinutes": 5 }` in the setter, which generates the 288 times from `00:00` to `23:55`.
In ssam-ddl/1, write that list of times in `schedule`. Phrases such as `Every 60 minutes`
or `Every day at 00:00` are invalid, even if the permissive setter of the Studio accepts them.
The DDL compiler and the setter refuse these phrases with `TIMER_SCHEDULE_INVALID`.
ODC uses a five-field `CronSchedule`.

### ODC (client) and O11 (server): list action lambda only with a direct attribute

In the lambda arguments of list actions, write the attributes of the element directly: the `Condition` of ListFilter,
ListIndexOf, ListAny and ListAll, and the `By` of ListSort. Examples: `IsActive`, `Amount`, `Code = "X"`.

- **ODC, client actions:** `<List>.Current.Attribute` passes the build, but the runtime never moves the Current. The
  ListSort does not sort, and the ListFilter compares every row with the same row.
- **O11, server ListSort:** the same defect. Every element gets the same key, and the unstable sort scrambles the list.
  Use the attributes of the item of the lambda; if you need a tie-breaker, build a unique fixed-width text key.
- On the server, ListFilter, ListIndexOf and ListAny with `.Current` work, on both.
- ODC has no server ListSort, only the client one.
- `CurrentRowNumber` inside the condition of a client ListFilter is not reliable.

The kernel and the Studio verifier accept both forms. Only a running test catches the error.

### O11: an entity with "Changed Attributes" does not write a stale copy

With Update Behavior = Changed Attributes, the Update writes only the attributes assigned after the read. If you read a
record, call something that changes that row in the database and then Update the copy you read to "restore" it, nothing
is written.

To restore: keep the value in a local, read the row AGAIN after the side effect, assign the kept value and then do the
Update.

### O11: never redeclare an existing public action

Redeclaring a public action that already exists (same name and signature) inside a `logic` op generates a new key for
it. The consumers bind by key, so the publication of the consumer gets stuck, and the Studio shows
"Incompatible or missing dependencies found".

- **Detect:** compare the keys of the public elements between the published version and the new OML
  (`ssam_map {lane:"o11", target:"<OML>", kind:"ServiceAction"}` on both), or run
  `o11_environment {action:"refresh-refs", module:"<consumer>"}` without publishing and see the errors (`validation`).
- **Rebind the consumer:** `reference` of the elements with a new key; `set @<call> Action
  "IServiceAction:@<key of the producer module>/<new key>"` (remaps the arguments by name); `delete` of the old
  signatures; `set Name` back to the name of the producer. Check with `o11_deliver {until:"apply"}` (validates without a
  merge) and `o11_inspect {path:"@<key>"}`.

### Direct OML merge through the bridge

When the OMLs are already ready and the person only wants them in the open modules, use the bridge directly, module by
module: `open_module`, then `snapshot_module` (records the base) and then `merge_from_oml` with `mode=auto`, the
snapshot as the base and the key of the module. It takes 2 to 11 seconds per module.

Use the full `deliver`, which rebuilds the job and validates before the merge, only when the person wants the integration
with checks. Before a direct merge, confirm that the open module is still the base of the OML: with an old base, the merge
undoes newer changes.
