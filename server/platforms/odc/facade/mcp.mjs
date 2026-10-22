import { serverInstructions } from './server-instructions.mjs';
// SSAM Hybrid-ODC MCP server: the Studio lane (studio_*) and the Portal lane (odc_*) on one stdio server.
// Every studio_* tool relays one bridge or builder command and returns its JSON; the bridge keeps its gates
// and its journal, so the tools cannot bypass them. Mutations need the user's words in the arguments.
import { DESTRUCTIVE_SUFFIX, argsWithoutWords, bridgeArgsWithoutWords, bridgeLineWords, taskStepOfCall, withoutWords, wordsGiven, wordsRequired } from './destructive-operations.mjs';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { appUrlGuide } from './app-urls.mjs';
import { ANSWER_BUDGETS, EXPANSION_DEFAULT_BYTES } from './context-budget.mjs';
import { registerStudioReferenceProducers } from './studio-reference-producers.mjs';
import path from 'node:path';
import { appUrl, attach, builder, builderArgs, createAccess, credentialStatus, dataPath, deliver, doctor, inspect, portal, portalBridge, prepareManifest, readJson, root, studio, studioData, studioPids, studioStatus, headlessDebug, tenantOf, tenants } from './lib.mjs';
import { publishWithGrant, studioPublishLog } from './studio-publish-log.mjs';
import { reconcileMerge } from './merge-reconcile.mjs';
import { registerAccessTools } from './odc-access.mjs';
import { registerDebugTools } from './debug.mjs';
import { registerQueryTestTools } from './query-test.mjs';
import { moduleMap, ROLES, VIEWS } from './module-map.mjs';
import { readCatalog, resolveOpenTarget } from './studio-open.mjs';
import { registerStudioCreateApp } from './studio-create-app.mjs';
import { hostedContext, runWithExecutor, seamFields } from './executor.mjs';
import { codeFromText, isCode } from './refusal-codes.mjs';
import { phasedDeliver, phasedDeliveryDeps } from './odc-build-phase.mjs';
import { referenceSnapshot, contentProofKernel } from './kernel-delivery.mjs';
import { PHASES_META } from './studio-write-lock.mjs';
import { runDataLoad, odcDataChannel } from './data-load.mjs';
import { withInlineDataReservation } from './data-load-lock.mjs';
import { registerSsamTask } from './ssam-task.mjs';
import { managedRelayContext } from './relay-lifecycle.mjs';

const result = (value, error = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(error ? { isError: true } : {}) });
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const mutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
// I7: a call honours the client's cancellation (ctx.mcpReq.signal, which the relay of ssam.mjs forwards): it answers at
// once, CANCELLED with outcome "uncertain", instead of holding the client until the bridge ends. The native command it
// started is never cancelled; studio_status shows it, and its receipt says how it ended.
// CX15 r2 (C2/T5): the cancelled call of a destructive execution (it carries a confirmationToken) names the record of its
// operation, which says item by item what was sent before the cancellation reached the execution.
export const cancelledAnswer = (args = {}) => {
  const task = taskStepOfCall(args);
  // Junction CX12 x CX15 (M6 adjustment 5): a cancellation that reaches the handler stops it before its next send; a call the
  // unified server kept running past its 25 s wait is stopped by ssam_task {id, stop:true} (the operationId or previewId).
  return task ? { ok: false, code: 'CANCELLED', outcome: 'uncertain', continuation: task,
    stop: { tool: 'ssam_task', arguments: { id: task.arguments.id, stop: true }, why: 'stops the execution if it still runs on the server (kept past its 25 s wait); then read its record' },
    error: `The call was cancelled; the execution stops before its next send once the cancellation reaches it; if it still runs on the server (kept past its 25 s wait), ssam_task {id:"${task.arguments.id}", stop:true} stops it. Its record says what was sent: read ssam_task {id:"${task.arguments.id}"} before telling the owner anything. Never repeat it.` }
    : { ok: false, code: 'CANCELLED', outcome: 'uncertain',
      error: 'The call was cancelled; the Studio command it started may still run: studio_status shows it and its receipt says how it ended. Never repeat a write blindly.' };
};
export const wrap = (fn, {drain} = {}) => async (args, ctx) => {
  const signal = ctx?.mcpReq?.signal;
  try {
    // The unified server owns the caller's deadline and keeps the actual work alive.
    // Its stop signal is exposed to the handler, but this wrapper must await the
    // handler's real final answer instead of racing it against an SDK cancellation.
    if (managedRelayContext(ctx)) {
      const value = await fn(args, ctx);
      return result(value, value && value.ok === false);
    }
    if (signal?.aborted) return result(cancelledAnswer(args), true);
    const work = Promise.resolve().then(() => fn(args, ctx));
    let value;
    if (signal && !drain?.(args)) {
      let onAbort;
      const aborted = new Promise(resolve => { onAbort = () => resolve(cancelledAnswer(args)); signal.addEventListener('abort', onAbort, { once: true }); });
      work.catch(() => {}); // a late failure after the cancellation has nobody to answer
      try { value = await Promise.race([work, aborted]); } finally { signal.removeEventListener('abort', onAbort); }
    } else value = await work;
    return result(value, value && value.ok === false);
  }
  // A seam refusal of the hosted executor (AGENT_NOT_CONNECTED, O11_NOT_CONNECTED, ...) keeps its code and continuation;
  // else a thrown error keeps its own code (odc-pipe.mjs PipeError: BRIDGE_NOT_ATTACHED, BRIDGE_BUSY), else the code of
  // its text (refusal-codes.mjs, the table the ssam shaper and the friction store use).
  catch (error) {
    const seam = seamFields(error);
    if (seam.code) return result({ ok: false, ...seam, error: error.message }, true);
    const code = isCode(error?.code) ? error.code : codeFromText(error?.message);
    return result({ ok: false, error: error.message, ...(code ? { code } : {}) }, true);
  }
};
// The stages of a delivery as MCP progress notifications when the request asks for them (a progressToken): the relay of
// ssam.mjs resets its timeout on each one, so a long merge or publication is never cut by a client timeout.
export function progressNotifier(ctx, { tool = 'studio_deliver' } = {}) {
  const token = ctx?.mcpReq?._meta?.progressToken;
  if (token == null || typeof ctx?.mcpReq?.notify !== 'function') return undefined;
  let count = 0;
  return stage => {
    const batch = stage && typeof stage === 'object' && Number.isFinite(stage.done) && Number.isFinite(stage.total);
    const params = { progressToken: token, progress: batch ? stage.done : ++count,
      message: tool + ': ' + (batch ? `${stage.done}/${stage.total} batches completed` : stage), ...(batch ? { total: stage.total } : {}) };
    Promise.resolve().then(() => ctx.mcpReq.notify({ method: 'notifications/progress', params })).catch(() => {});
  };
}
const pidSchema = z.number().int().positive().optional().describe('ODC Studio process id; detected when there is exactly one.');
const manifestSchema = z.string().min(1).describe('Absolute path of a manifest.json written by studio_build, studio_manifest or studio_deliver.');

// CX15 r4 (W-2, the family): a bridge line typed through studio_command never carries the owner's words either. The words
// of --authorize (the bridge reads every token after it up to the next --option, DataCommands.cs Words) go as one
// 'sha256:<hex>' token, --authorize=<words> too, and the answer drops what the bridge repeats. CX15 r5 (N-2): the helper
// lives in destructive-operations.mjs (bridgeArgsWithoutWords: also the authorize command), shared with lib.mjs.
export { argsWithoutWords };
async function passthroughWithoutWords(command, args, pid, call) {
  const line = String(command).split(' ');
  // CX15 r6 (M-1): words of the line that are missing, a marker, a <template> or a sha256 of the server: WORDS_REQUIRED, the
  // bridge never called (the authorize command, --authorize, --authorize=).
  const words = bridgeLineWords([...line, ...args]);
  if (words.some(w => !wordsGiven(w))) return wordsRequired([{ path: 'command/args', value: words.find(w => !wordsGiven(w)) }], { tool: 'studio_command' });
  if (line[0] === 'authorize') return withoutWords(await call(bridgeArgsWithoutWords([...line, ...args].filter(a => a !== '')), pid));
  // The words may sit in the command text itself ("data-insert M E --authorize ...") or inside one argument that holds
  // several tokens (CX15 r6: bridgeLineWords and bridgeArgsWithoutWords read them token by token, as the pipe joins them).
  if (!words.length) return call([command, ...args], pid);
  const [first, ...rest] = bridgeArgsWithoutWords([...line, ...args].filter(a => a !== ''));
  return withoutWords(await call([first, ...rest], pid));
}

// access: an OdcAccess (portal\runtime\access.mjs); tests pass one built on fakes of the bridge, vault and prompt.
// Built inside a hosted call (executor.mjs), the server keeps that context: every handler registered below, its own and
// those of registerAccessTools, registerOdcTools, registerStudioCreateApp and registerDebugTools, runs inside it, so a
// call that arrives without it still reaches the customer's agent and workspace. Hosted there is no owner tenant, no
// vault and no API Client: the Portal catalog tools describe only, and tenant calls go through the customer's Studio.
// deps (tests, CX15): studio and studioData (fakes of the bridge, used by studio_data_delete and studio_command only) and
// destructive {now, root, uuid} (the clock, root and ids of the previews).
// a7 (review C:\t\revisoes\vps-a7 M1/B2, the family): the data roots a handler hands to the delivery code are the ODC data
// root of the call (lib.mjs dataPath: the lane root locally, the customer's <ws>/odc hosted), never the code root, which
// every customer of a hosted server shares: the producer cache (records and .avsig of studio_reference_snapshot, the
// publication ledger of studio_publish), the capture folder, the lab with the delivery evidence, and where relative
// evidence paths resolve. Read at call time, inside the call's context.
const odcDataRoots = () => ({ cache: dataPath('.local', 'producer-cache'), captureDir: dataPath('snapshots'), lab: dataPath('lab'), root: dataPath() });
export async function createFacadeServer({ env = process.env, access, deps = {} } = {}) {
  const context = hostedContext();
  const server = new McpServer({ name: 'ssam-hybrid-odc', version: '0.2.0' }, {
    instructions: serverInstructions({ profile: 'odc-facade' }),
  });
  if (context) {
    const register = server.registerTool.bind(server);
    server.registerTool = (name, ...rest) => {
      const handler = rest.at(-1);
      return typeof handler === 'function' ? register(name, ...rest.slice(0, -1), (...args) => runWithExecutor(context, () => handler(...args))) : register(name, ...rest);
    };
  }

  registerDebugTools(server, headlessDebug, wrap);
  registerQueryTestTools(server);
  // CX15 r3 (CT-9, the family): the ODC facade alone (.\odc mcp) serves ssam_task too, read-only (no delivery close): its
  // destructive tools (studio_data_delete, studio_command, odc_*) send the model there after an interruption, CANCELLED or a
  // local failure. The ssam server serves its own on every server and does not relay this one.
  registerSsamTask(server, { destructiveRoot: deps.destructive?.root, ...(deps.task ?? {}) });
  registerStudioReferenceProducers(server, { studio, wrap, readOnly, pidSchema });
  // Contextual discovery: intent -> capabilities with exact operations, extracted contracts, proofs, limits and
  // (optionally) the reusable elements of a capture. Read-only; the index is built from the lane sources and reused by hash.
  server.registerTool('ssam_discover', {
    title: 'The single entry: the tool, verb and arguments, or the capabilities and contracts, for any SSAM request',
    description: 'Start EVERY SSAM request here, model change or not. For an operation (open or close a module, connect, publish, deploy, create an app or module, data, Service Center, Portal, debugger, long tasks, evidence...) the answer\'s `tools` gives the exact MCP tool, its verb (command/action/op/operation/kind) and an arguments template, preconditions and the next call; a tool of the other lane says so (otherLane), and an operation no tool performs comes back as a gap. catalog:true lists every tool of the lane by group (`toolGroups`); an empty intent answers only with the exact shape of the call, under 1 KB. A model change gets its capabilities in `matches`, in Portuguese or English (e.g. "form with searchable dropdown, load data and save"): why each matched, the exact operation, the kernel contract slice the dispatcher enforces, proof jobs with their level, the dependency closure (mandatory, or conditional with `unless`), decisions, limits with their origin and what the lane lacks; a request with both parts gets both. An intent that builds screens also gets `outsystemsUi` (the OutSystems UI patterns of the lane; expand osui:<Category>|osui:<Pattern> for inputs, events and placeholders). A screen, data or logic change also gets `textRoute`: the read (ssam_map view html, ddl or flow) and the ready delivery call of its text form, with the owner\'s rules. Prefer this to reading kernel source code or docs: it answers from them, sized. app (a capture .oml, or an open module, snapshotted first) adds the existing elements and the signatures of what the intent names, bound to sourceSha256. packet:true is the work packet an agent or subagent starts its task from (ssam-packet/1): the elements of app the intent names, the matched contracts, a proven example, the team rules that apply and the next step, in a fixed order within the answer ceiling, cuts named; same input, same bytes. For a data, logic or screen change the packet\'s `text` is enough to write it in one round: the read (or why none is needed), the exact delivery call with the text forms (ssam-ddl/1, ssam-flow/1, ssam-html/1), their grammar, contract and one proven example, and the owner\'s rules; a need the platform lacks (pdf, excel, email, files, images...) brings `environment`, the installed extensions and Forge components with their actions and signatures (also a direct O11 intent: "what do I have in the environment to generate a PDF"). Work from it without reading docs or the module again. Provenance per item: A native API, B kernel accepts, C proven by suite, D present in the capture. Read-only: nothing here executes or delivers.',
    inputSchema: z.object({ intent: z.string().max(500).default(''), lane: z.enum(['odc', 'o11']).default('odc'), app: z.string().min(1).optional().describe('Capture .oml path or open module name for application context'),
      packet: z.boolean().default(false).describe('The work packet of the intent (with app: the module elements it names), deterministic and within the answer ceiling'),
      expand: z.string().max(1000).optional().describe('Batch continuation without intent: "<id>:contract+example+evidence+bindings,<id>:example,contract:<pointer>,element:<Kind:Name>,osui:<Category|Pattern|appType>" (element needs app; osui = OutSystems UI patterns of the lane with inputs, events, placeholders and the instance op); returns exactly the parts named, within budgetBytes'),
      detail: z.string().min(1).optional().describe('One capability in full (same as expand "<id>:contract+example+evidence+bindings")'), type: z.string().min(1).optional().describe('Native interface name for Model API metadata (same as expand "native:<Interface>")'),
      limit: z.number().int().min(1).max(30).default(8), budgetBytes: z.number().int().min(4096).max(1048576).optional().describe(`UTF-8 byte budget: ${ANSWER_BUDGETS.discoverFirst} for the first answer, ${EXPANSION_DEFAULT_BYTES} for explicit expansions. Reduced sections in size.truncated carry the exact call that returns them`),
      rebuild: z.boolean().default(false).describe('Rebuild the index even if its identity is unchanged'),
      catalog: z.boolean().optional().describe('Without intent: every capability and every tool of the lane by group') }).strict(),
    annotations: readOnly,
  // The answer leaves as JSON: the text route rides inside discover() as an enumerable symbol key (discovery.mjs
  // TEXT_ROUTE_SECTION), which the MCP result schema refuses ("expected string, received symbol") when no tool route took it out.
  }, wrap(async input => { const { laneInspect, laneMap } = await import('./discovery.mjs'); const { discoverAll } = await import('./tool-routing.mjs'); return JSON.parse(JSON.stringify(await discoverAll({ ...input, inspect: laneInspect(input.lane ?? 'odc', inspect), map: laneMap(input.lane ?? 'odc') }))); }));
  // The module map: every element of a capture from its module index (module-map.mjs), both lanes. Read-only; a miss
  // asks the lane's resident reader to build the index once per capture hash. Views search and uses read the rich index
  // (module-rich.mjs), built only when one of them asks for it.
  const sha256Pin = z.string().regex(/^[a-fA-F0-9]{64}$/);
  server.registerTool('ssam_map', {
    title: 'Map every element of an application capture',
    description: 'The first read of an application, both lanes. To read AND write the module as code (data as SQL DDL, logic as pseudocode, screens as HTML) with one word for both, use ssam_code {action, part}: views ddl, flow (also "logic") and html below are its reads under their old names. view "digest": the whole module as compact text (entities, structures, actions in pseudocode, screens with widgets and events, integrations, coverage), built once per capture sha256 and paged within budgetBytes: page 1 is the overview (entities, structures and the index of every action with its signature, calls and callers; contents gives the page of every part); continuations.next is the next page of the same capture. Read it once and work in context; inspect only to go deeper into an @key. view "ddl": the module data as text with an @key on every element (entities and static entities with records as SQL DDL, structures as type X = {…}, site properties/settings, client variables and timers as one line; whole descriptions, os:<Property> for any other property), paged by whole blocks; element reads one by name or @key. view "flow" {element: @key, Flow/Screen/Action or the action name}: one action as ssam-flow/1 text, whole (every node, parameter and local with its @id, full descriptions, comments, scripts and SQL with parameter types), with fixedPoint (the text parses back to this exact action) and textSha; a list of elements reads several actions whole in one answer; without element, the list of the actions; page continues a long action. To change actions, send their edited texts in a job: {"op":"logic","data":{"flow":[{"text","basedOn":textSha}]}} (send each action WHOLE as read with the change: a line keeps the element of its @id, a line without @id is new, a line left out is deleted; the kernel writes only what changed). view "map" (default): every element of the module index of the capture (one per capture sha256, kept across sessions) with key, kind, name, role, parentKey, readable path, childrenTotal and dataType, sorted by key, filtered (kind matches any interface the element implements) and paged within budgetBytes. A plain map leaves out detail rows (expression, reference, other) and anonymous structures/list types; kind, role or includeDetail lists them. continuations.inspect is the exact studio_inspect (ODC) or o11_inspect (O11) call for a subtree, properties or usages by @key with expectedSourceSha256; continuations.next is the next page. '
      + 'Cross-cutting questions in ONE call, over one capture or a list of them (the modules of one app), from the rich index (every value, expression text, call argument and reference; built on the first such call per capture, which says how long it took): view "search" {text, regex?, property?, kind?, role?}: every element whose expressions, values, arguments or name contain the text (where a site property, a variable or a literal appears, all aggregates filtering on Order, every SQL using a table), with @key, module, path, property and the passage; view "uses" {element: @key, Module.Element, Flow/Screen/Action, Kind:Name or name}: who uses an element, inside and across the given modules (consumer signatures resolve to the producer by its key), with the property that uses it: impact of a change, callers of a public action. Use these instead of inspecting element by element. '
      + 'view "html" {screen}: one screen or block as ssam-html/1, its source as HTML: every element with k (keysFile maps it to the ObjectKey), expressions as text ({{ }}, if, list, bind, :Input), both branches of every If (<div else>), events as on<event>="Destination(Param = expression)", block handlers as @Event, every other authored property as os-<Property>; tables and Traditional widgets are os-opaque; without screen, the list of screens and blocks. Paged in whole lines within budgetBytes.',
    inputSchema: z.object({ lane: z.enum(['odc', 'o11']).default('odc'),
      target: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(16)]).describe('Capture .oml path, or a module open in the Studio of the lane (snapshotted first); views search and uses also take a list of them (the modules of one app)'),
      view: z.enum(VIEWS).default('map').describe('map: the elements with their @keys; digest: the whole module as text, in pages; ddl: the module data as DDL with @keys, in pages; flow (or logic, the same view): one action as text, whole (element), or the list of the actions; search: text in expressions, values, arguments and names; uses: who uses an element, across the given modules; html: one screen or block as ssam-html/1'),
      screen: z.string().min(1).optional().describe('view html: the screen or block (name, Kind:Name or @key); without it, the list of screens and blocks'),
      keys: z.boolean().default(false).describe('view html: also return the k -> ObjectKey table inline (it is always stored in keysFile)'),
      text: z.string().min(1).max(500).optional().describe('view search: the text to find (substring, case-insensitive)'),
      regex: z.boolean().default(false).describe('view search: text is a regular expression (JavaScript syntax, case-insensitive)'),
      property: z.string().min(1).optional().describe('view search: only this property (Condition, Value, Statement, Name...); arg:<Parameter> or arg for call arguments'),
      element: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(50)]).optional().describe('view uses: the element: @key, Module.Element (producer.element), a name path such as MainFlow/Home/Search, Kind:Name or a name; view ddl: an entity, structure, variable or timer by name or @key; view flow: the action (@key, Flow/Screen/Action or its name), or a list of actions read whole in one answer'),
      page: z.number().int().min(1).optional().describe('views digest and ddl: the page to read (digest: 1 = overview); contents on page 1 lists every part; view flow: the page of a long action; view html: the page of the screen (whole lines within budgetBytes)'),
      kind: z.string().min(1).optional().describe('Interface name without the leading I, e.g. MobileScreen, ServerAction; view map also takes a list (A|B or A,B); * for any'),
      name: z.string().min(1).optional().describe('Exact name or label, case-insensitive'), prefix: z.string().min(1).optional().describe('Name prefix, case-insensitive'),
      role: z.enum(ROLES).optional(),
      parent: z.string().min(1).optional().describe('@key of an element of the same capture: list its direct children'), key: z.string().min(1).optional().describe('@key: one element'),
      offset: z.number().int().min(0).default(0), max: z.number().int().min(1).max(500).default(100),
      budgetBytes: z.number().int().min(2000).max(1048576).default(60000).describe('UTF-8 byte budget of the answer; fewer entries are returned and nextOffset continues'),
      includeDetail: z.boolean().default(false).describe('Also list expression/reference/other rows and anonymous structures/list types'),
      expectedSourceSha256: z.union([sha256Pin, z.array(sha256Pin).min(1).max(16)]).optional().describe('Refuse if the capture bytes differ from this hash (a list: one per target)'), pid: pidSchema }).strict(),
    annotations: readOnly,
  }, wrap(input => moduleMap(input)));
  server.registerTool('ssam_app_url', { title: 'App home and screen URLs', description: appUrlGuide + ' ODC: pass app and optionally screen. environment is the runtime origin, e.g. https://www.personal-aiupndln.outsystems.dev; tenant selects an exactly configured stage. Without either, uses the module\'s connected Studio environment. Does not open a browser, publish or check existence.',
    inputSchema: z.object({ app: z.string().min(1), screen: z.string().min(1).optional(), environment: z.string().min(1).optional(),
      tenant: z.string().min(1).optional(), stage: z.string().min(1).default('Development'), pid: pidSchema }).strict(),
    annotations: readOnly }, wrap(({ tenant, ...input }) => appUrl({ ...input, host: tenant })));
  server.registerTool('studio_doctor', { title: 'State of everything before working', description: 'dotnet, bridge build and attachment, ODC Studio process, asset catalog age, Portal credential per tenant (live: one read per configured tenant), journal. No mutation.', inputSchema: z.object({ live: z.boolean().default(false) }).strict(), annotations: readOnly }, wrap(({ live }) => doctor({ live })));
  server.registerTool('studio_attach', { title: 'Attach the newest bridge to ODC Studio', description: 'Loads the newest built bridge extension into the user\'s own running ODC Studio through the official .NET diagnostics startup hook (Microsoft.Diagnostics.NETCore.Client), like an IDE plugin. A loaded DLL is never replaced; each version has its own pipe.', inputSchema: z.object({ pid: pidSchema }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, wrap(({ pid }) => attach(pid)));
  server.registerTool('studio_status', { title: 'Bridge and Studio status', description: 'brief: bridge version, busy command, catalog, dialogs with choices, modal windows, open modules, each with lastPublish (state, errors, warnings and first error of its last publication, whoever started it; studio_command publish-log has every message). full: everything. field: one dotted path such as modules.0.dependencies. While the bridge runs a long command (a merge, a publication) the answer comes at once from the evidence of that delivery (fromEvidence:true, busy {command, since}, its stage and the result once written); the call that started the command answers when it ends.', inputSchema: z.object({ view: z.string().default('brief').describe('brief | full | <dotted field path>'), pid: pidSchema }).strict(), annotations: readOnly }, wrap(({ view, pid }) => studioStatus({ view, pid })));
  server.registerTool('studio_wait', { title: 'Wait for a Studio state', description: 'One blocking call instead of polling: idle, no-dialogs, published <module>, open <module>. Informational dialogs are closed meanwhile; dialogs with a choice are reported. module may be the app name the person sees (resolved to its asset key, as studio_open does).', inputSchema: z.object({ condition: z.enum(['idle', 'no-dialogs', 'published', 'open']), module: z.string().optional(), timeoutSeconds: z.number().int().positive().max(1800).default(600), pid: pidSchema }).strict(), annotations: readOnly }, wrap(async ({ condition, module, timeoutSeconds, pid }) => {
    // The bridge splits the wait argument at spaces: an app name with a space waits by its asset key (the module key).
    const target = module ? resolveOpenTarget(module, readCatalog()) : null;
    if (target && !target.ok) return target;
    return studio(['wait', condition, ...(target ? [target.target] : []), String(timeoutSeconds)], pid);
  }));
  server.registerTool('studio_assets', { title: 'List tenant assets natively and refresh the catalog', description: 'The same service the Studio Open dialog uses. Rewrites snapshots/modules.json for the signed-in tenant. Run before any claim about what exists.', inputSchema: z.object({ tenant: z.string().optional().describe('Tenant host when the Studio holds several sessions.'), pid: pidSchema }).strict(), annotations: readOnly }, wrap(({ tenant, pid }) => studio(['assets', ...(tenant ? [tenant] : [])], pid)));
  server.registerTool('studio_consumers', { title: 'Published consumers of a module', description: 'Native GetConsumers with an open flag per consumer.', inputSchema: z.object({ module: z.string().min(1), pid: pidSchema }).strict(), annotations: readOnly }, wrap(({ module, pid }) => studio(['consumers', module], pid)));
  const entitySchema = { module: z.string().min(1).describe('An open module, or the app name the person sees; the entity may be its own or one of its references.'), entity: z.string().min(1), pid: pidSchema };
  const dataCall = deps.studioData ?? (callArgs => studioData(callArgs, { studio: deps.studio ?? studio })); // CX15 deps.studio reaches the data writes
  // a9 (the a7 family of odcDataRoots): the plan, journal, reservations and locks of a file load are the ODC data root of the
  // call (lib.mjs dataPath: the lane root locally, the customer's <ws>/odc hosted, as ssam.mjs waits for them), never the code
  // root every customer of a hosted server shares. Read at call time, inside the call's context.
  const loadsRoot = () => dataPath('journal', 'data', 'loads');
  const loadFields = {
    // CX13 review 6 (listing budget): the load validates its options itself (one refusal with everything, before any write; delimiter,
    // files, columns and references only after the schema and the files are read),
    // so they are listed with their cheapest schema.
    close: z.unknown().optional(), // {preview:true}, then {previewSha256, authorize}: stated in the tool text
    confirmUpdates: z.object({previewSha256:z.string().optional(),authorize:z.string().optional()}).optional().describe("Overwrites of existing rows: the updatePreview sha256 and the owner's next message after that preview, verbatim, stating its number of rows."),
    records: z.array(z.record(z.string(), z.unknown())).optional(), files: z.array(z.string()).optional(),
    columns: z.unknown().optional(), references: z.unknown().optional(), // objects; the load refuses any other value
    keys: z.union([z.string(), z.array(z.string())]).optional(), batchSize: z.number().optional(), delimiter: z.string().optional(),
    dryRun: z.boolean().optional(), deadlineMs: z.number().optional(), operationId: z.string().optional(), authorize: z.string().optional(),
  };
  const dataWrite = operation => async (args, ctx) => {
    if (args.files !== undefined || args.close !== undefined) return runDataLoad({ ...args, lane: 'odc', operation }, odcDataChannel({ studioData: dataCall, module: args.module, entity: args.entity, pid: args.pid, authorize: args.authorize }), {
      journalRoot: deps.dataRoot ?? loadsRoot(), now: deps.now, progress: progressNotifier(ctx, { tool: `studio_data_${operation}` }),
      signal: ctx?.mcpReq?.signal, destructive: deps.destructive, // the CX15 store of previews and words seen (review 6)
      continuation: { tool: `studio_data_${operation}`, arguments: args },
    });
    const problems = [];
    if (!Array.isArray(args.records) || !args.records.length) problems.push({ code: 'INPUT_INVALID', reason: 'exactly one of records or files must be a nonempty list', at: 'records' });
    for (const key of [...Object.keys(loadFields).filter(key => !['records', 'files', 'authorize'].includes(key)), 'insertMissing']) {
      if (args[key] !== undefined) problems.push({ code: 'INPUT_INVALID', reason: `${key} requires files`, at: key });
    }
    // CX15 r6 (M-1): the inline words are the owner's (wordsGiven: never missing, a marker, a <template> or a sha256), or
    // WORDS_REQUIRED; with other input problems, one refusal names them all.
    const noWords = wordsGiven(args.authorize) ? null : wordsRequired([{ path: 'authorize', value: args.authorize }], { tool: `studio_data_${operation}` });
    if (problems.length) return { ok: false, code: 'INPUT_INVALID', error: `${problems.length + (noWords ? 1 : 0)} input problems before any write`, problemCount: problems.length + (noWords ? 1 : 0), problems: [...problems, ...(noWords?.problems ?? [])], written: 0 };
    if (noWords) return noWords;
    const { module, entity, records, authorize, pid } = args;
    // Review 6: no identity read before an inline write unless a file load of the lane is open (withInlineDataReservation).
    const identities=async()=>{try{return[await odcDataChannel({studioData:dataCall,module,entity,pid,authorize}).identity()];}catch(error){throw Object.assign(error,{code:error.code??'DATA_TARGET_IDENTITY_REQUIRED',identityFailure:true});}};
    return withInlineDataReservation({lane:'odc'},identities,{journalRoot:deps.dataRoot ?? loadsRoot()},()=>dataCall({op:operation,module,entity,records,authorize,pid}))
      .catch(error=>{if(error?.identityFailure)return{ok:false,code:error.code,error:error.message,written:0,outcome:'not-sent'};throw error;});
  };
  server.registerTool('studio_data', { title: 'Read records of an entity (development database)', description: 'The Studio\'s own data service, the calls behind View data / Edit data, for an entity of the open module or of one of its references. Nothing in the model changes. Values come back as text; the identifier is the first column.', inputSchema: z.object({ ...entitySchema, limit: z.number().int().positive().max(5000).default(100), offset: z.number().int().nonnegative().default(0), fields: z.array(z.string()).optional().describe('Attribute names; default all but the identifier.') }).strict(), annotations: readOnly }, wrap(({ module, entity, limit, offset, fields, pid }) => studioData({ op: 'read', module, entity, limit, offset, fields, pid })));
  server.registerTool('studio_data_insert', { title: 'Insert records into an entity (development database)', description: 'InsertRecords of the Studio data service. records: objects of Attribute: value; auto-number identifiers are assigned by the server and returned as recordId. Needs the user\'s own authorization words; request and per-record report are kept under journal/data. Corporate tenants only on explicit instruction. files:[abs paths] (JSON/JSONL/CSV) need natural keys: equal rows skip, missing rows insert; changed rows stop before writing (updatePreview) until confirmUpdates. Same operationId resumes by reading keys. close:{preview:true}, then close:{previewSha256,authorize} with the owner reply.', inputSchema: z.object({ ...entitySchema, ...loadFields }).strict(), annotations: mutating }, wrap(dataWrite('insert'), { drain: args => args.files !== undefined || args.close !== undefined }));
  server.registerTool('studio_data_update', { title: 'Update records of an entity (development database)', description: 'UpdateRecords of the Studio data service. Each record carries the identifier plus the attributes to change. Needs the user\'s own authorization words. files:[abs paths] (JSON/JSONL/CSV) need natural keys: equal rows skip, missing rows insert; changed rows stop before writing (updatePreview) until confirmUpdates. Same operationId resumes by reading keys. close:{preview:true}, then close:{previewSha256,authorize} with the owner reply.', inputSchema: z.object({ ...entitySchema, ...loadFields, insertMissing: z.boolean().optional() }).strict(), annotations: mutating }, wrap(dataWrite('update'), { drain: args => args.files !== undefined || args.close !== undefined }));
  server.registerTool('studio_data_delete', { title: 'Delete records of an entity (development database)', description: 'DeleteRecords of the Studio data service by identifier. ' + DESTRUCTIVE_SUFFIX + ' The preview, {module, entity, ids}, lists the records found (read in pages; a missing id is absent, never deleted; the rows are the backup). The execution, {module, entity, confirmationToken, authorize} without ids: the owner\'s reply also names the entity.', inputSchema: z.object({ ...entitySchema, ids: z.array(z.union([z.string(), z.number()])).min(1).optional(), authorize: z.string().min(1).optional(), confirmationToken: z.string().min(1).optional(), ownerRequest: z.string().min(1).optional() }).strict(), annotations: mutating }, wrap(async (args, ctx) => (await import('./data-delete-gate.mjs')).studioDataDelete(args, { studioData: deps.studioData ?? studioData, ...deps.destructive, signal: ctx?.mcpReq?.signal ?? null })));
  server.registerTool('studio_open', { title: 'Open a module from the organization', description: 'Native open that keeps the upload linkage Publish needs. A module opened from a local file cannot be published.', inputSchema: z.object({ module: z.string().min(1), localOml: z.string().optional().describe('Open this local .oml instead (merge experiments only, never to publish).'), pid: pidSchema }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, wrap(async ({ module, localOml, pid }) => {
    const open = resolveOpenTarget(module, readCatalog());
    if (!open.ok) return open;
    const value = await studio(['open', open.target, ...(localOml ? [localOml] : [])], pid);
    return open.resolvedFrom && value && typeof value === 'object' ? { ...value, requested: open.resolvedFrom, moduleKey: value.moduleKey ?? open.target } : value;
  }));
  server.registerTool('studio_close', { title: 'Close open copies of a module', description: 'Unmodified copies close through the native CloseModule; duplicates keeps the first copy; discard closes a modified copy without saving after snapshotting it.', inputSchema: z.object({ module: z.string().min(1), duplicates: z.boolean().default(false), discard: z.boolean().default(false), pid: pidSchema }).strict(), annotations: mutating }, wrap(({ module, duplicates, discard, pid }) => studio(['close', module, ...(duplicates ? ['--duplicates'] : []), ...(discard ? ['--discard'] : [])], pid)));
  server.registerTool('studio_snapshot', { title: 'Capture the open module as a hash-named base', description: 'Writes snapshots/<Module>-<sha256>.oml plus capture metadata. Every builder run starts from a snapshot taken after the last merge or refresh.', inputSchema: z.object({ module: z.string().min(1), pid: pidSchema }).strict(), annotations: readOnly }, wrap(({ module, pid }) => studio(['snapshot', module], pid)));
  server.registerTool('studio_reference_snapshot', { title: 'Discover and capture public producer dependencies', description: 'Lists the public blocks, structures, actions and entities of a module/library available to the consumer session, including system libraries. Writes a new .avsig file without editing the open module. For acquisition and delivery, use reference ops with the producer name in studio_deliver; it captures named producers automatically. Refresh only updates existing references.', inputSchema: z.object({ module: z.string().min(1), producer: z.string().min(1), output: z.string().min(1), pid: pidSchema }).strict(), annotations: readOnly }, wrap(({ module, producer, output, pid }) => referenceSnapshot({ module, producer, output, pid }, { studio, ...odcDataRoots(), otherPids: () => studioPids(), catalog: readCatalog,
    ...(deps.producerModel ? { producerModel: deps.producerModel } : {}) })));
  server.registerTool('studio_latest', { title: 'Download the latest published revision', description: 'Through the authenticated native DownloadService into snapshots/<Module>-revision-<n>.oml.', inputSchema: z.object({ module: z.string().min(1), pid: pidSchema }).strict(), annotations: readOnly }, wrap(({ module, pid }) => studio(['latest', module], pid)));
  server.registerTool('studio_refresh_references', { title: 'Refresh dependencies natively', description: 'Without producer: the Studio\'s own "Check for dependency updates". With producer: update that library reference to its latest published revision. Proves that only references changed. Take a new snapshot afterwards.', inputSchema: z.object({ module: z.string().min(1), producer: z.string().optional(), pid: pidSchema }).strict(), annotations: mutating }, wrap(({ module, producer, pid }) => studio(['refresh-references', module, ...(producer ? ['--producer', producer] : [])], pid)));
  server.registerTool('studio_dismiss_dialog', { title: 'Close a Studio dialog through its own action', description: 'Presenter dialogs by caption and footer action; owned windows by title and button. Use only for dialogs with a choice the user has decided; informational ones are closed by the bridge.', inputSchema: z.object({ caption: z.string(), action: z.string().min(1), pid: pidSchema }).strict(), annotations: mutating }, wrap(({ caption, action, pid }) => studio(['dismiss-dialog', caption + '|' + action], pid)));
  server.registerTool('studio_build', { title: 'Build a candidate with the headless builder', description: 'Runs one feature from studio/builder/features on a hash-checked base (or creates a module with newModule) and writes manifest.json, the candidate .oml and the builder receipt into a new output directory. producer is the path of a producer .oml for features that add a dependency.', inputSchema: z.object({ feature: z.string().min(1), base: z.string().optional(), sha: z.string().optional(), output: z.string().min(1), module: z.string().optional(), producer: z.string().optional(), newModule: z.boolean().default(false), smoke: z.boolean().default(false) }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, wrap(args => builder(builderArgs(args))));
  server.registerTool('studio_inspect', { title: 'Read the structure of a module', description: 'Read-only, headless; the resident capture is reused while its SHA-256 is unchanged. Start with ssam_map for every element and its @key; use this tool for what the map does not carry. With path: the element subtree with properties as text (e.g. "MobileScreen:Backoffice" with depth 4, or "ServerAction:GetQuotes"); without path: the legacy module map (names per section). Large answers give summary/navigation and the complete JSON in out. target is an open module name (snapshotted first) or a .oml path.', inputSchema: z.object({ target: z.string().min(1), path: z.string().optional().describe('Kind:Name/Kind:Name or @key from the same snapshot; resolve again after save/reload'), select: z.array(z.string().min(1)).min(1).max(32).optional().describe('Read several paths relative to path in one verified snapshot load'), cold: z.boolean().default(false).describe('Reload the source instead of reusing the resident capture'), expectedSourceSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe('Refuse if the source bytes differ from this capture hash'), kind: z.string().optional(), name: z.string().optional().describe('Exact name or label, case-insensitive'), text: z.string().optional().describe('Search full text before clipping'), offset: z.number().int().min(0).default(0), properties: z.string().optional().describe('Comma-separated property projection'), usages: z.boolean().default(false).describe('Incoming native references to the target and its children'), scope: z.enum(['direct', 'subtree']).optional().describe('Usage scope, default subtree'), includeInternal: z.boolean().default(false).describe('Include usages inside the selected target subtree'), depth: z.number().int().min(0).max(12).default(3), max: z.number().int().min(1).max(500).default(60), all: z.boolean().default(false).describe('Include audit properties'), full: z.boolean().default(false).describe('Do not clip property text or collections'), budget: z.number().int().min(2000).max(200000).default(60000).describe('Character budget of the inline answer; above it the full JSON goes to out'), pid: pidSchema }).strict(), annotations: readOnly }, wrap(args => inspect(args)));
  server.registerTool('studio_check_base', { title: 'Check that the open module still equals the captured base', description: 'Native MatchTree plus the producer -> consumer gate. base_drift means: new snapshot, new build.', inputSchema: z.object({ manifest: manifestSchema, pid: pidSchema }).strict(), annotations: readOnly }, wrap(({ manifest, pid }) => studio(['check-base', manifest], pid)));
  server.registerTool('studio_preview', { title: 'Preview the native merge', description: 'Candidate validation delta and native MatchTree conflicts, without merging.', inputSchema: z.object({ manifest: manifestSchema, pid: pidSchema }).strict(), annotations: readOnly }, wrap(({ manifest, pid }) => studio(['preview', manifest], pid)));
  server.registerTool('studio_merge', { title: 'Merge the candidate natively', description: 'One CompareAndMerge per evidence directory, verified for strict equivalence (tolerant only to reference refreshes and empty grid metadata in owners). Never repeat after an uncertain outcome.', inputSchema: z.object({ manifest: manifestSchema, pid: pidSchema }).strict(), annotations: mutating }, wrap(({ manifest, pid }) => studio(['merge', manifest], pid)));
  server.registerTool('studio_authorize', { title: 'Record the user\'s authorization in the manifest', description: 'Writes publishAuthorization or createAuthorization with a timestamp. text must be the user\'s own words, quoted, not a paraphrase by the model.', inputSchema: z.object({ manifest: manifestSchema, kind: z.enum(['publish', 'create']), text: z.string().min(8), pid: pidSchema }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, wrap(async ({ manifest, kind, text, pid }) => (wordsGiven(text) // CX15 r7 (M-3): the text is the owner's words, never a server text
    ? withoutWords(await (deps.studio ?? studio)(bridgeArgsWithoutWords(['authorize', manifest, kind, text]), pid)) : wordsRequired([{ path: 'text', value: text }], { tool: 'studio_authorize' }))));
  server.registerTool('studio_publish', { title: 'Publish through the native Publish command', description: 'module: the open module (or app name); publishes its last SSAM merge in this ODC Studio and tenant (answer resolvedFrom). Refused before anything, with the next call, when that merge was not clean (LAST_DELIVERY_NOT_CLEAN), is already published (ALREADY_PUBLISHED), was made in another Studio process (DELIVERY_IN_OTHER_STUDIO), no delivery merged it (NO_DELIVERY_TO_PUBLISH), or the open module changed since (MODULE_CHANGED_SINCE_DELIVERY). An unproven merge is first reconciled by content proof, never merged again (reconcile:true: only that). manifest instead of module: a manifest of studio_build, studio_manifest, studio_deliver or studio_create. Requires a successful merge or creation receipt and the authorization: the user\'s own words in authorize (recorded in the manifest first), else the words recorded by studio_authorize, else the standing grant of the app (authorization {source:"standing-grant", grantId} in the answer). With wait: follows the publication to its end, downloads the revision and compares it with the open module (one receipt, lastPublication). A publication that ends without success is refused with code PUBLISH_FAILED, publishLog (every message of the cloud build/publish: type, text, element, stage) and a continuation that says what to fix; never republish unchanged. studio_deliver {publish:true} publishes in the same call as the merge.', inputSchema: z.object({ manifest: manifestSchema.optional(), module: z.string().min(1).optional().describe('The open module or app name (no manifest needed).'), authorize: z.string().min(8).optional().describe('The user\'s own words for this publication, quoted, never a paraphrase; recorded in the manifest before publishing.'), wait: z.boolean().default(true), minutes: z.number().int().positive().max(30).default(10), pid: pidSchema, reconcile: z.boolean().optional() }).strict(), annotations: mutating }, wrap(({ manifest, module, authorize, wait, minutes, pid, reconcile }) => publishWithGrant({ manifest, module, authorize, wait, minutes, pid, reconcile }, { studio: deps.studio ?? studio, readManifest: file => readJson(path.resolve(dataPath(), file)), lab: dataPath('lab'), root: dataPath(), catalog: readCatalog,
    reconcile: deps.reconcile !== undefined ? deps.reconcile : (input, more = {}) => reconcileMerge(input, { studio: deps.studio ?? studio, prove: contentProofKernel, ...more }) })));
  server.registerTool('studio_create', { title: 'Upload a ready whole-module candidate as a new asset', description: 'Low level: uploads a whole-module candidate already built (lab features, test producers). To create an app or library as the Studio does, use studio_create_app. Native CreateAsset with the recorded createAuthorization; refuses an existing name in the live tenant listing. Uploads revision 1 without deploying: open it and publish with its own authorization.', inputSchema: z.object({ manifest: manifestSchema, pid: pidSchema }).strict(), annotations: mutating }, wrap(({ manifest, pid }) => studio(['create', manifest], pid)));
  // A new app or library as the Studio's "Create app" builds it: headless model (template clone / library), then the
  // bridge's create-app, open and publish (studio-create-app.mjs).
  registerStudioCreateApp(server);
  server.registerTool('studio_command', { title: 'Any other bridge command', description: 'Passthrough for commands without a dedicated tool (module-info, publish-status, publish-log, stop). It never runs data-delete, portal-call, portal-private-call or portal-api-client-fixture-cleanup (DESTRUCTIVE_NEEDS_DEDICATED_TOOL: their dedicated tools preview and confirm with confirmationToken; after an interruption read ssam_task); a line that starts with a non-ASCII whitespace, a control or a format character is never sent (BRIDGE_LINE_UNSAFE_START). Arguments are joined with spaces as the bridge expects. publish-log [<Module>] reads the last publication of an open module in this ODC Studio, whoever started it (the person or studio_publish): state, time, revision and every message of the cloud build/publish with type, text, element (name, and key when the open model has it) and stage (upload, compilation, deploy), plus a continuation that says what to fix; read-only, answered even while another command runs.', inputSchema: z.object({ command: z.string().min(1), args: z.array(z.string()).default([]), pid: pidSchema }).strict(), annotations: mutating }, wrap(async ({ command, args, pid }) => (await import('./data-delete-gate.mjs')).bridgeCommandRefusal(command, args) ?? (command === 'publish-log' ? studioPublishLog(args, pid, { studio: deps.studio ?? studio }) : passthroughWithoutWords(command, args, pid, deps.studio ?? studio))));

  server.registerTool('studio_manifest', {
    title: 'Prepare an existing kernel candidate for native delivery',
    description: 'Headless: verifies snapshot metadata/hash, base/candidate identity and validation delta; copies the candidate into a fresh directory and writes the standard manifest. Requires base.oml.json from studio_snapshot. No Studio mutation. Then use studio_check_base, studio_preview and studio_merge.',
    inputSchema: z.object({ base: z.string().min(1), candidate: z.string().min(1), output: z.string().min(1), feature: z.string().min(1),
      owners: z.array(z.string().min(1)).min(1), changes: z.array(z.string().min(1)).min(1) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, wrap(prepareManifest));
  server.registerTool('studio_deliver', {
    title: 'Deliver a C# feature or an ODC kernel job',
    description: 'The one call that changes an open ODC module: deliver directly, with no separate proof (ssam_job), preview or merge step. In order: a fresh capture of the module as it is now in the Studio (Studio edits included), the kernel build (an identical delivery reuses it), the candidate checked against that capture (no new errors or warnings; NO_CHANGE when it changes nothing) and the native merge with its equivalence verification. It stops on the first refusal, before any change, with the fix and every problem at once (e.g. ODC_STRUCTURE_PUBLIC_IN_APP, PREFLIGHT_REFUSED): a refused job comes back ONCE with every problem of every phase over the capture (the job alone, the base, the apply, the Verify of the candidate), problems[] with phase, op, pointer, code, message, fix and the patch of each certain fix (identical ones grouped with their pointers) and verifyRan; correct all of them in one call with patch (the patches returned plus your fixes; a path may name elements: actions/<Action>/steps/<as>/...) and basedOn {job, sha256}, or with only the changed or new actions as a partial job plus basedOn; never rewrite the whole job. module: the open module, or the app name the person sees ("QuizLive Web" reaches QuizLiveWeb); otherwise the answer lists openModules. With job: module, owners and changes are required. Producers named by reference ops are captured from the consumer session automatically, system libraries included. until=build|check-base|preview stops before the merge, only when the person asks to review first. publish:true publishes in the same call after a clean merge, with the words of authorize or the standing grant of the app ("delivered and published", publish {outcome, version, messages}); a merge that is not clean skips it; a failed publication answers code PUBLISH_FAILED with the studio_publish continuation, never a new delivery. An uncertain merge lists each divergence and is never retried: read receipts and journal.',
    inputSchema: z.object({ feature: z.string().min(1), module: z.string().min(1).optional(), job: z.string().min(1).optional().describe('Absolute path or relative to the SSAM-Hybrid-ODC root.'),
      owners: z.array(z.string().min(1)).min(1).optional(), changes: z.array(z.string().min(1)).min(1).optional(),
      autoPatch: z.boolean().optional(), output: z.string().min(1).optional(), until: z.enum(['snapshot', 'build', 'check-base', 'preview', 'merge']).default('merge'),
      publish: z.boolean().optional().describe('Alone: true also publishes after a clean merge (merged and strictlyEqual); any other merge outcome skips it (publish.outcome "skipped"). Requires until "merge".'),
      authorize: z.string().min(8).optional().describe('Alone: the user\'s own words for publish:true, quoted, naming the app; without them the standing grant of the app is used, else the delivery is refused before anything is built.'),
      producers: z.record(z.string(), z.string().min(1)).optional().describe('Producer bindings, as o11_deliver: {Name: absolute path of a capture .avsig (studio_reference_snapshot) or producer .oml, or "published"}; (System) and System are one producer. Without it, each producer is captured from the consumer session.'),
      producer: z.string().optional(), tenant: z.string().optional(), pid: pidSchema }).strict(), annotations: mutating,
    // The ssam server builds this delivery without the Studio lock: its Studio commands take the lock (odc-build-phase.mjs).
    _meta: { [PHASES_META]: true },
  // Lane wp (atritos 3): the build runs in the build pool without the Studio lock; the merge takes the Studio (odc-build-phase.mjs).
  }, wrap((args, ctx) => phasedDeliver(args, { onStage: progressNotifier(ctx), ...phasedDeliveryDeps({ root, studio, prepareManifest, env }) }, { deliver })));

  // Portal lane. Catalog, status and discovery come from the existing registration; odc_read/odc_write and the
  // internal Portal are the tenant-aware tools of odc-access.mjs (tenant and auth per call, Studio session first).
  // Hosted: no owner tenant and no vault; the catalog bridge has no origin and no credential.
  const m = await portal();
  let host = null, bridge, credentialAvailable = false;
  if (context) bridge = new m.OdcBridge({ config: m.readConfig({}) });
  else {
    const selected = tenantOf(env.SSAM_HYBRID_ODC_TENANT);
    host = selected.host;
    try { ({ bridge, credentialAvailable } = await portalBridge(host, selected.tenant, { requireCredential: false })); }
    catch { bridge = new m.OdcBridge({ config: m.readConfig({ ODC_PORTAL_ORIGIN: selected.tenant.portalOrigin }) }); }
  }
  // tenantAccess: the internal routes of the capability inventory run through the tools of odc-access.mjs below.
  m.registerOdcTools(server, bridge, { capabilities: new m.PortalCapabilities({ catalog: bridge.catalog, backends: new Map(), tenantAccess: true }), execute: false });
  const odcAccess = access ?? await createAccess({ env });
  // CX15 (W5): the destructive odc_* tools take two calls; the guard is at their entry, never inside OdcAccess. Hosted,
  // the gate refuses every delete before (hosted/destructive.mjs), and the previews' store is the customer's
  // (destructive-operations.mjs destructiveRoot, resolved per workspace by the served mode).
  const { guardedAccess } = await import('../portal/runtime/destructive-preview.mjs');
  const destructiveAccess = guardedAccess(odcAccess, deps.destructive ?? {});
  registerAccessTools(server, destructiveAccess, wrap);
  (await import('./odc-external-library.mjs')).registerExternalLibrary(server, { access: destructiveAccess, wrap });
  // Hosted: the customer's <ws>/odc/tenants.json (tenants() follows the context) and the sessions of their Studio; the
  // vault columns are not read.
  server.registerTool('hybrid_tenants', { title: 'Known tenants and their readiness', description: 'Tenants from tenants.json and the hosts the ODC Studio is signed in to: class (personal | corporate | client), the Studio session per tenant (user, token validity date; no token), the API Client stored in the vault (yes/no) and the Studio author expected per tenant. odc_* tools take tenant per call; the default is the only Studio session, else ' + (host ?? 'the tenant passed in the call') + '.', inputSchema: z.object({}).strict(), annotations: readOnly }, wrap(async () => {
    const all = tenants();
    const studioState = await odcAccess.studioState();
    const session = key => studioState.sessions.find(s => s.host === key && s.loggedIn) ?? null;
    const hosts = [...new Set([...Object.keys(all.tenants), ...studioState.sessions.map(s => s.host)])];
    const entries = await Promise.all(hosts.map(async key => { const value = all.tenants[key] ?? { portalOrigin: 'https://' + key, class: 'unknown' };
      const studioSession = session(key);
      return { host: key, ...value, studioSession: studioSession ? { user: studioSession.user, tokenValidUntil: studioSession.tokenValidUntil } : null,
        ...(context ? { vault: 'not used in hosted mode' } : { credentialAvailable: await credentialStatus(value) }), defaultForPortalTools: key === host }; }));
    return { ok: true, default: all.default, selected: host, ...(context ? {} : { selectedCredentialAvailable: credentialAvailable }),
      studio: { running: studioState.running, connected: studioState.connected, ...(studioState.hint ? { hint: studioState.hint } : {}) }, tenants: entries };
  }));
  return server;
}

export async function runStdio() {
  try { await (await createFacadeServer()).connect(new StdioServerTransport()); }
  catch (error) { process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runStdio();
