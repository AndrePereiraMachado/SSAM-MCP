import * as z from 'zod/v4';
import fs from 'node:fs';
import path from 'node:path';
import { DIAGNOSTICS_RULE } from './debug-guidance.mjs';
export const debugOperations = ['start', 'watch', 'status', 'stop', 'pause', 'variables', 'scope', 'read', 'private-read', 'read-many', 'expand', 'refresh', 'frame', 'continue', 'step-over', 'step-into', 'step-out', 'read-frame'];
const key = z.string().regex(/^[A-Za-z0-9_+]{22}$/);
const traceFunctionKey = z.string().regex(/^[A-Za-z0-9_+]{22}(?:\.#Preparation)?$/);
const variablePath = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.\[\]]{0,499}$/);
export const sessionIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
// Explicit selected metadata, never a caller assertion of complete scope or of
// runtime request identity. Native-run preparation supplies pinned model roots.
// O11 Traditional Preparation scopes carry the native '<key>.#Preparation' function identity (lane checked below).
export const inspectionScopeSchema = z.object({ moduleKey: key, functionKey: traceFunctionKey, nodeKey: key,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const inspectionSchema = z.object({ variables: z.array(z.object({
  moduleKey: key, functionKey: traceFunctionKey, variableKey: key, sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  nodeKey: key.optional(),
  name: z.string().min(1).max(500), category: z.enum(['input', 'output', 'local', 'return', 'session', 'site', 'setting', 'timer']),
  path: z.string().min(1).max(500),
}).strict()).max(500).default([]), scopes: z.array(inspectionScopeSchema).max(500).optional(),
  sources: z.array(z.object({ moduleKey: key, sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(20).optional() }).strict();
export const modelScopeSchema = z.object({
  source: z.object({ path: z.string().min(1).max(2000).refine(value => path.isAbsolute(value), 'Absolute capture path required'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  scopes: z.array(z.object({ functionKey: key, nodeKeys: z.array(key).min(1).max(20) }).strict()).min(1).max(20),
}).strict();
// Published identity only. The native SSO bearer is obtained privately from the selected Studio.
export const o11AuthSchema = z.object({
  applicationKey: key,
  publishedVersionId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  entry: z.object({ module: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,198}$/), moduleKey: key, applicationKey: key,
    publishedVersionId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
  publishedProof: z.object({
    path: z.string().min(1).max(2000).refine(value => path.isAbsolute(value), 'Absolute inventory proof path required'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict();
// Tracer (kernel/debug/shared TraceOptions): every pause is dumped and stepped at once; trace.jsonl holds the map.
export const traceSchema = z.object({
  mode: z.enum(['step', 'breakpoints']).default('step'), steps: z.number().int().min(1).max(2000).default(200),
  depth: z.number().int().min(0).max(4).default(2), fullValues: z.boolean().default(false),
  focusFunctionKey: traceFunctionKey.optional(), requireFunctionKey: traceFunctionKey.optional(),
  scopes: z.record(traceFunctionKey, z.array(variablePath).max(60)).default({}),
}).strict();
export const debugSchema = z.object({
  op: z.enum(debugOperations), lane: z.enum(['odc', 'o11']).optional(), sessionId: sessionIdSchema.optional(),
  tenant: z.string().max(200).optional(), module: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,198}$/).optional(),
  moduleKey: key.optional(), runtimeUrl: z.url().optional(), nodeKeys: z.array(key).min(1).max(200).optional(), trace: traceSchema.optional(),
  // Per-node breakpoint owner (native ExtendedBreakpointId owner): the session module plus at most one partner.
  nodeModuleKeys: z.record(key, key).optional(),
  credentials: z.string().max(2000).optional(), seconds: z.number().int().min(1).max(600).default(120),
  o11Auth: o11AuthSchema.optional(),
  inspection: inspectionSchema.optional(),
  modelScope: modelScopeSchema.optional(),
  pauseSeconds: z.number().int().min(1).max(30).default(5), autoContinue: z.boolean().default(true),
  paths: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.\[\]]{0,499}$/)).max(30).default([]),
  frame: z.number().int().min(0).max(100).default(0), depth: z.number().int().min(0).max(4).default(1),
  threadId: z.string().min(1).max(200).optional(), eventId: z.string().regex(/^\d+$/).optional(),
  reference: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  references: z.array(z.string().regex(/^[a-f0-9]{32}$/)).min(1).max(500).optional(),
  childPath: z.string().max(500).regex(/^(?:\.[A-Za-z_][A-Za-z0-9_]*|\[(?:0|[1-9][0-9]{0,8})\])+$/).optional(),
  offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(150).default(50),
  textOffset: z.number().int().min(0).default(0), textLimit: z.number().int().min(1).max(16384).default(4096),
  // read-frame only: node budget of the bounded one-command frame read (worker default 2000).
  maxNodes: z.number().int().min(1).max(20000).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.inspection && (v.op !== 'start' || v.autoContinue || v.trace)) ctx.addIssue({ code: 'custom', path: ['inspection'], message: 'Inspection requires start with autoContinue=false and no automatic trace' });
  if (v.modelScope) {
    if (v.op !== 'start' || v.autoContinue || v.trace || v.inspection)
      ctx.addIssue({ code: 'custom', path: ['modelScope'], message: 'Model scope requires manual start without inspection or trace' });
    const nodes = v.modelScope.scopes.flatMap(scope => scope.nodeKeys);
    if (nodes.length > 20 || new Set(nodes).size !== nodes.length || nodes.length !== v.nodeKeys?.length || nodes.some(node => !v.nodeKeys?.includes(node)))
      ctx.addIssue({ code: 'custom', path: ['modelScope'], message: 'Model scope nodes must match the unique initial breakpoints (maximum 20)' });
  }
  for (const variable of v.inspection?.variables ?? []) {
    const site = ['site', 'setting'].includes(variable.category);
    const valid = variable.category === 'return' ? variable.path === '$return' : site && v.lane === 'odc'
      ? /^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\.[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(variable.path)
      : variablePath.safeParse(variable.path).success;
    if (!valid) ctx.addIssue({ code: 'custom', path: ['inspection'], message: 'Invalid native variable address' });
  }
  if (v.trace && v.lane !== 'o11' && [v.trace.focusFunctionKey, v.trace.requireFunctionKey, ...Object.keys(v.trace.scopes)].some(key => key?.includes('.#')))
    ctx.addIssue({ code: 'custom', path: ['trace'], message: 'Native Preparation function keys apply only to O11' });
  const need = field => { if (!v[field]) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required for ${v.op}` }); };
  if (['start', 'watch'].includes(v.op)) {
    for (const field of ['lane', 'module', 'moduleKey', 'runtimeUrl', 'nodeKeys']) need(field);
    if (v.lane === 'odc') need('tenant');
    if (v.sessionId) ctx.addIssue({ code: 'custom', path: ['sessionId'], message: `${v.op} creates its own sessionId; never repeat an uncertain start` });
    if (v.nodeKeys && new Set(v.nodeKeys).size !== v.nodeKeys.length) ctx.addIssue({ code: 'custom', path: ['nodeKeys'], message: 'Duplicate breakpoints' });
    if (v.nodeKeys && v.nodeKeys.length > 20 && !v.trace && v.op !== 'watch') ctx.addIssue({ code: 'custom', path: ['nodeKeys'], message: 'More than 20 breakpoints only for a trace window' });
    if (v.op === 'watch' && !v.autoContinue) ctx.addIssue({ code: 'custom', path: ['autoContinue'], message: 'watch requires automatic tracing; use start for manual stepping' });
    if (v.runtimeUrl) { const u = new URL(v.runtimeUrl); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) ctx.addIssue({ code: 'custom', path: ['runtimeUrl'], message: 'HTTPS application URL without credentials, query or fragment required' }); }
  } else need('sessionId');
  if (v.o11Auth) {
    if (!['start', 'watch'].includes(v.op) || v.lane !== 'o11') ctx.addIssue({ code: 'custom', path: ['o11Auth'], message: 'o11Auth applies only to O11 start or watch' });
    if (v.credentials) ctx.addIssue({ code: 'custom', path: ['credentials'], message: 'Choose native SSO or legacy developer credentials' });
    if (v.runtimeUrl && v.module) {
      let url; try { url = new URL(v.runtimeUrl); } catch { }
      const entryModule = v.o11Auth.entry?.module ?? v.module;
      if (url?.port || ![ '/' + entryModule, '/' + entryModule + '/' ].includes(url?.pathname)) ctx.addIssue({ code: 'custom', path: ['runtimeUrl'], message: 'O11 native SSO requires the declared runtime entry on HTTPS port 443' });
    }
  }
  if (v.nodeModuleKeys) {
    const owners = Object.entries(v.nodeModuleKeys), keys = owners.map(([node]) => node);
    if (!['start', 'watch'].includes(v.op)) ctx.addIssue({ code: 'custom', path: ['nodeModuleKeys'], message: 'nodeModuleKeys applies only to start or watch' });
    if (keys.length !== v.nodeKeys?.length || keys.some(node => !v.nodeKeys.includes(node)))
      ctx.addIssue({ code: 'custom', path: ['nodeModuleKeys'], message: 'nodeModuleKeys must name exactly the nodeKeys' });
    if (new Set(owners.map(([, owner]) => owner).filter(owner => owner !== v.moduleKey)).size > 1)
      ctx.addIssue({ code: 'custom', path: ['nodeModuleKeys'], message: 'Breakpoint owners: the session module plus at most one partner' });
  }
  if (v.lane !== 'o11' && (v.inspection?.scopes ?? []).some(scope => scope.functionKey.includes('.#')))
    ctx.addIssue({ code: 'custom', path: ['inspection'], message: 'Native Preparation function keys apply only to O11' });
  if (v.maxNodes !== undefined && v.op !== 'read-frame') ctx.addIssue({ code: 'custom', path: ['maxNodes'], message: 'maxNodes applies only to read-frame' });
  if (v.op === 'read-frame' && v.textOffset !== 0) ctx.addIssue({ code: 'custom', path: ['textOffset'], message: 'read-frame starts every text at offset 0; offset is the root offset' });
  if (['variables', 'scope', 'read', 'private-read', 'read-many', 'expand', 'refresh', 'frame', 'continue', 'step-over', 'step-into', 'step-out', 'read-frame'].includes(v.op)) { need('threadId'); need('eventId'); }
  if (v.op === 'pause' && (v.threadId || v.eventId)) ctx.addIssue({code:'custom',message:'pause addresses the native debug session; no stopped-thread token applies'});
  if (['read', 'private-read', 'expand', 'refresh'].includes(v.op)) need('reference');
  if (v.op === 'read-many') { need('references'); if (v.references && new Set(v.references).size !== v.references.length) ctx.addIssue({ code: 'custom', path: ['references'], message: 'Duplicate references' }); }
  if (v.references && v.op !== 'read-many') ctx.addIssue({ code: 'custom', path: ['references'], message: 'references requires read-many' });
  if (v.op === 'variables' && v.paths.length === 0) ctx.addIssue({ code: 'custom', path: ['paths'], message: 'Specify local variable paths' });
});
export function parseDebugCli(args) {
  const [op, ...rest] = args; const input = { op };
  const names = { '--lane': 'lane', '--session': 'sessionId', '--tenant': 'tenant', '--module': 'module', '--module-key': 'moduleKey', '--runtime-url': 'runtimeUrl', '--node-keys': 'nodeKeys', '--credentials': 'credentials', '--o11-auth': 'o11Auth', '--seconds': 'seconds', '--pause-seconds': 'pauseSeconds', '--paths': 'paths', '--frame': 'frame', '--depth': 'depth', '--thread-id': 'threadId', '--event-id': 'eventId', '--inspection': 'inspection', '--reference': 'reference', '--references': 'references', '--child-path': 'childPath', '--offset': 'offset', '--limit': 'limit', '--text-offset': 'textOffset', '--text-limit': 'textLimit', '--max-nodes': 'maxNodes', '--node-module-keys': 'nodeModuleKeys' };
  for (let i = 0; i < rest.length; i++) {
    if (['--auto-continue', '--manual'].includes(rest[i])) {
      if ('autoContinue' in input) throw new Error('Choose either automatic capture or manual stepping');
      input.autoContinue = rest[i] === '--auto-continue'; continue;
    }
    const name = rest[i] === '--model-scope' ? 'modelScope' : names[rest[i]], value = rest[++i];
    if (!name || value == null || value.startsWith('--') || name in input) throw new Error('Invalid debugger option');
    if (name === 'o11Auth' || name === 'inspection' || name === 'modelScope') {
      try {
        const max = name === 'inspection' ? 1024 * 1024 : 16384;
        if (fs.statSync(value).size > max) throw new Error();
        const bytes = fs.readFileSync(value); if (bytes.length > max) throw new Error();
        input[name] = (name === 'inspection' ? inspectionSchema : name === 'modelScope' ? modelScopeSchema : o11AuthSchema).parse(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')));
      } catch { throw new Error(name === 'modelScope' ? 'debug_model_scope_file_invalid' : name === 'inspection' ? 'debug_inspection_file_invalid' : 'debug_o11_auth_file_invalid'); }
    } else if (name === 'nodeModuleKeys') {
      try { input[name] = JSON.parse(value); } catch { throw new Error('debug_node_module_keys_invalid'); }
    } else input[name] = ['nodeKeys', 'paths', 'references'].includes(name) ? value.split(',') : ['seconds', 'pauseSeconds', 'frame', 'depth', 'offset', 'limit', 'textOffset', 'textLimit', 'maxNodes'].includes(name) ? Number(value) : value;
  }
  return debugSchema.parse(input);
}
export function registerDebugTools(server, execute, wrap) {
  const tool = {
    title: 'Debug O11 or ODC headlessly',
    description: DIAGNOSTICS_RULE + ' Headless SERVER debugger in a separate process; with legacy authentication neither Studio must be open. O11 native SSO requires the currently connected Service Studio of this SSAM lane. Start or watch reuses an explicitly selected private app-user Vault profile for this exact app/runtime when available; otherwise it opens the private App User Sign In window with Username and masked Password. Enter app credentials only in this private window; they are bound to this app/runtime/producer/session, encrypted with Windows CurrentUser DPAPI, and erased on stop or expiry. ODC app login currently supports built-in Cognito in us-east-1. O11 captures credentials for the original Users.User_Login; connection alone does not authenticate an app request. This tool never invokes an action: running one with chosen inputs is ssam_debug_run with execution=native-entry (both lanes: the code picks the nearest public entry of the published app deterministically and publishes nothing; its REST wrapper path is legacy) or ssam_debug_invoke (an existing ODC entry). Developer/debugger authentication is separate: ODC requires tenant and private API Client; O11 native SSO uses optional o11Auth metadata {applicationKey, publishedVersionId, publishedProof:{path,sha256}} and a fresh published inventory (at most 15 minutes old) for the exact runtime host/module/application/version; CLI --o11-auth reads that metadata from a JSON file. When a linked producer executes in its consumer, o11Auth.entry declares that consumer module/moduleKey/applicationKey/publishedVersionId and the publishedProof must contain both identities. Service actions use their own runtime boundary. The SOAP endpoint belongs to the entry; breakpoint keys belong to the target. Both bindings retain their uncertainty guards. The selected Studio PID and process start are pinned internally; the bearer never appears in tool arguments, files or responses and goes only to private worker stdin. Uncertain token exchange retains its operation receipt and target lock; inspect them instead of retrying. Without o11Auth, the explicit legacy path uses a private developer credentials file or SSAM_O11_* environment and has no native SSO publication binding. Never supply secrets in tool arguments. Start and watch require lane, published producer module/moduleKey, HTTPS runtimeUrl of the entry app, and required nodeKeys (start: 1-20 without trace, 1-200 with trace; watch: 1-200). watch enables automatic trace and waits for external use of the app; it never invokes an action. Its default trace is step, 200 node visits, depth 2 and fullValues=false; MCP may supply the existing trace object. watch is implemented and validated offline; a live watch proof is still pending. Once the visit budget is reached the worker only continues requests until stop or expiry. The direct debugger CLI has no trace flag. Obtain keys by inspecting the published snapshot. start/watch returns sessionId and safe appUser status; watch status also reports automaticInvocation=false and userRequestIsolationProved=false. A private app login does not establish the identity of an externally triggered request. Action keys, ccid and debugger UserName do not prove isolation from other users; request ownership is qualified only on offline synthetic fixtures and is refused in production and on ODC. status returns stack, frame, threadId and exact string eventId. variables reads specified local paths; continue/step consume that stop even on timeout: never retry uncertain execution. autoContinue defaults to true; watch requires true, while start permits false for manual stepping. Legacy capture pauses expire after pauseSeconds (default 5). Interactive inspection uses inspection metadata with autoContinue=false and no trace; scope/read/private-read/read-many/expand/refresh/frame remain available until an explicit control or session/credential expiry. read-many evaluates 1-500 unique references together through the installed native evaluator; continuations remain per value. References expire on frame changes and control commands. pause requests native SuspendAllThreads only in a manual inspection session, without thread/event tokens. Its acknowledgment does not prove a stop; inspect subsequent status. It addresses all threads of this native debug session, not a proved app request. Pending or uncertain pauses cannot be repeated. Text reads return nextTextOffset and accept textOffset/textLimit; nativeTrimmed/fullEvaluationDetail report when native detail 2 is needed. Sessions expire after seconds (default 120, maximum 600), bounded by the app-user lease. End with stop and confirm stopped. Existing Studio breakpoints are never changed. No model edits/publication. Legacy variables uses the diagnostic filter. Interactive inspection preserves business values with native types, deferred children and continuation; credentials remain filtered. Selected metadata does not establish complete scope coverage. Connection success does not prove a breakpoint fired, request identity was applied, or a business action succeeded. Browser client-side debugging is outside this tool.',
    inputSchema: debugSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  };
  tool.description += ' For manual start, modelScope:{source:{path,sha256},scopes:[{functionKey,nodeKeys}]} replaces caller-supplied inspection variables with scope enumeration by the installed Model API. The nodes must exactly match nodeKeys (maximum 20). CLI --model-scope reads this object from JSON. Reads and verifies the exact capture bytes before any debugger authentication or session lock; mismatched client/server scopes and over-budget metadata are refused without truncation. modelScopeEvidence preserves the model evidence on start/status. This low-level option proves capture identity only: publishedBindingVerified and runtimeValuesEvaluated remain false; the native-entry runner must establish publication and live evaluation separately. Automatic scope discovery after stepping belongs to the ssam_debug_server coordinator. It accepts only runner-pinned published captures; ODC consumer/selected-producer frames have a bounded live proof, with unavailable values explicitly recorded. Additional producer acquisition and complete coverage remain pending.';
  tool.description += ' read-frame (threadId/eventId of the observed stop; offset = root offset, maxNodes default 2000, cap 20000; CLI --max-nodes) reads every Scope() root of the frame in one native EvaluateMany and then the child pages level by level, with the same stable references, redaction, revisions and stale-reference refusal as read/read-many; continuations are nextOffset (roots and containers) and pending references, and complete=true only when nothing remains; implemented, live proof pending. nodeModuleKeys (start/watch; CLI --node-module-keys JSON) declares the owner module of each breakpoint node (native ExtendedBreakpointId): the keys must equal nodeKeys and the owners are the session module plus at most one partner; the ODC runner uses it only for its library-reference consumer/library pair on one runtimeUrl. Whether the ODC runtime honours a consumer-owned breakpoint in a library-keyed session is not proved live.';
  server.registerTool('ssam_debug', tool, wrap(execute));
}
