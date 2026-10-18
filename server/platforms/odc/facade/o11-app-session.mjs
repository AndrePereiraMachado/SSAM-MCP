// The O11 controlled app session in the facade's own process: a port of kernel/scripts/ssam_app.py, which ran as a
// separate Python MCP server behind the stdio proxy of ssam.mjs. Four tools (context, propose, continue, status) with
// the Python names, descriptions, input schemas and annotations, plus runHook(): the same file's trusted Codex hook
// (UserPromptSubmit capture, PreToolUse guard) with the same JSON outputs and exit codes.
//
// Every tool call first spends the one-use permit the PreToolUse hook issued for that exact call (`app-session
// --action authorize`, AppSessions.ConsumePermit), then runs its action on the host (`dotnet anvil.dll app-session
// --action <a>` with the JSON on stdin, AppSessions.cs). Nothing here decides policy: the host does.
//
// propose asks the user to accept a changed contract by elicitation. The proxy could not relay that across protocol
// eras (ssam.mjs); in this process the handler returns inputRequired(), which the SDK serves on both: on 2026-07-28
// the client fulfils it and retries the call, on 2025 connections the SDK shim sends elicitation/create and re-enters
// the handler. The re-entry carries requestState: an unguessable one-use id of the review kept here (task, contract
// hash, the exact arguments, 15 min; a newer review of the same task replaces it). It never spends a second permit
// and never proposes again; only the stored contract hash can be accepted, and only when the user's answer is accept
// with accepted === true. Unlike the single-threaded Python loop, other calls are not held while a review waits: each
// still needs its own hook permit, and the host's lease and proposal/source hashes keep the task consistent.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CLIENT_CAPABILITIES_META_KEY, fromJsonSchema, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import { createAnvilRunner } from './anvil-cli.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { bridgeTarget, o11Bridge } from './o11-bridge.mjs';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { RESULT } from './result-values.mjs';

// The Codex MCP server name of the app profile (configure_app_profile.py). The host's guard (AppSessions.Guard) and
// permits (ConsumePermit) are keyed by these exact tool names; serving the tools under another server name changes them.
export const APP_TOOL_PREFIX = 'mcp__ssam_hybrid__';
export const APP_TOOLS = {
  context: 'Read the host-captured request, accepted module contract and supported schema for this task.',
  propose: 'Record the complete initial module contract from the user request. Later requirement changes need user acceptance; this does not deliver or publish.',
  continue: 'Advance or resume the accepted task. Hybrid chooses snapshot, compilation, merge or reconciliation and preserves its original requirements.',
  status: "Read the original task's delivery facts and content proof. This does not create or merge anything.",
};
export const ACCEPTANCE_UNSUPPORTED = 'Client does not support user contract acceptance; controlled delivery remains blocked';
export const REVIEW_SCHEMA = { type: 'object', properties: {
  accepted: { type: 'boolean', title: 'The contract matches my request', default: false } }, required: ['accepted'] };
const HOST_TIMEOUT_MS = 30000;   // ssam_app.py host(): subprocess timeout=30
const LANE_PROBE_MS = 3000;      // ssam_app.py lanes(): AnvilBridge(timeout=3)
const REVIEW_TTL_MS = 900000;    // above the SDK shim's 600 s per-round timeout (inputRequired.roundTimeoutMs)
const REVIEW_KEY = 'acceptance';

// ssam_app.py schemas(), key for key.
export function appSessionSchemas() {
  return Object.entries(APP_TOOLS).map(([name, description]) => {
    const properties = { task_id: { type: 'string', description: 'Task id supplied by the trusted UserPromptSubmit hook.' } };
    const required = ['task_id'];
    if (name === 'propose') {
      properties.csharpSource = { oneOf: [{ type: 'string' }, { type: 'object', properties: { files: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['files'], additionalProperties: false }], description: 'Authored C# source text or files, compiled semantically into the same native module contract. Data declarations and typed static server/service methods use ordinary C# expressions, calls and structured control flow. Public methods require authentication; Authorize declares roles. Unsupported constructs report source diagnostics. IDataSession translates typed CRUD and basic LINQ queries. Paging, joins/projections, mutable reference effects, async and general .NET APIs remain incomplete. No jobs, graphs or native bindings are supplied by the author.' };
      Object.assign(properties, { module: { type: 'string' }, lane: { type: 'string', enum: ['ss4', 'ss5'] },
        environment: { type: 'string' }, uiSource: { oneOf: [{ type: 'string' }, { type: 'object', properties: { entry: { type: 'string' }, files: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['entry', 'files'], additionalProperties: false }], description: 'HTML/CSS/JS source, or a bundle of authored files with an entry path. Relative component imports are resolved and frozen by the Hybrid; no binding manifest.' }, data: { type: 'object' }, logic: { type: 'object' }, roles: { type: 'array', items: { type: 'object' } }, exceptions: { type: 'array', items: { type: 'object' } }, expectedMessages: { type: 'array', items: { type: 'object' } } });
      required.push('module', 'lane', 'environment');
    }
    return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
      annotations: { readOnlyHint: name === 'context' || name === 'status', destructiveHint: false, openWorldHint: false } };
  });
}
const SCHEMAS = appSessionSchemas();

// ssam_app.py contract_review(): the full declaration, never a count or a success label.
export function contractReview(proposal) {
  return 'SSAM Hybrid — check this change of the module contract already fixed. '
    + 'The acceptance fixes this content, module, environment and lane; later technical corrections do not change these requirements. '
    + 'This contract covers the data and the declared flow of the actions; on its own it does not prove the whole business intent.\n\n' + JSON.stringify(proposal, null, 2);
}

// json.dumps() with Python's defaults (", " / ": ", ensure_ascii): the host's stdin and the hook's stdout, byte for byte.
const pyString = text => JSON.stringify(text).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
export function pyJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(pyJson).join(', ') + ']';
  if (typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => pyString(k) + ': ' + pyJson(v)).join(', ') + '}';
  return typeof value === 'string' ? pyString(value) : JSON.stringify(value);
}

class AppSessionError extends Error {
  constructor(message, code, continuation) { super(message); this.code = code; if (continuation) this.continuation = continuation; }
}

// ssam_app.py host(): the launch workspace is trusted metadata, never model input, so a forged one is dropped first.
export function appHost({ runAnvil, cli, workspace } = {}) {
  return async function host(action, payload) {
    const input = { ...payload };
    delete input.trustedWorkspace;
    if (workspace != null) input.trustedWorkspace = String(workspace);
    const run = await runAnvil(['app-session', '--action', action], { input: pyJson(input), timeoutMs: HOST_TIMEOUT_MS, ...(cli ? { cli } : {}) });
    const envelope = run?.envelope;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
      throw new AppSessionError('Hybrid host did not return valid JSON; the controlled app session is unavailable', 'HOST_UNAVAILABLE');
    if (!envelope.ok) throw new AppSessionError(envelope.error || 'Hybrid host refused the request', 'HOST_REFUSED');
    return envelope.data;
  };
}

// --workspace of ssam_app.py main(): an absolute existing directory, resolved through links.
export function trustedWorkspace(value) {
  const text = String(value ?? '');
  if (!pyAbsolute(text)) return { ok: false, error: '--workspace must be an absolute existing directory' };
  let real;
  try { real = fs.realpathSync.native(text); } catch { return { ok: false, error: '--workspace must be an absolute existing directory' }; }
  if (!fs.statSync(real).isDirectory()) return { ok: false, error: '--workspace must be an existing directory' };
  return { ok: true, path: real };
}
// pathlib's is_absolute(): on Windows a drive with a root, or a UNC share; "\x" and "C:x" are not absolute.
const pyAbsolute = text => process.platform === 'win32' ? /^([a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(text) : path.isAbsolute(text);
const within = (child, root) => { const rel = path.relative(root, child); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
const pyType = value => value === null ? 'NoneType' : Array.isArray(value) ? 'list' : typeof value === 'boolean' ? 'bool'
  : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : typeof value === 'object' ? 'dict' : typeof value;

// ssam_app.py Server.lanes(): which lane's Studio is ready for a controlled delivery. Both lanes at once, 3 s each.
export async function laneReadiness({ bridgeFor }) {
  return Promise.all(['ss4', 'ss5'].map(async name => {
    try {
      const bridge = bridgeFor(name);
      const ok = method => bridge.ok(method, {}, { timeoutMs: LANE_PROBE_MS });
      const manifest = await ok('bridge_manifest');
      const entry = { lane: name, ready: (manifest?.protocolVersion ?? 0) >= 2 };
      if (!entry.ready) return { ...entry, reason: 'Bridge update required before controlled app delivery' };
      const inventory = await ok('list_open_modules');
      const environments = inventory?.environments ?? [];
      Object.assign(entry, { environments, activeModule: null });
      if ((inventory?.modules ?? []).some(module => module?.hasESpace)) {
        const active = await ok('get_active_module');
        Object.assign(entry, { environment: active?.environment, activeModule: active?.name });
      } else if (environments.length === 1) entry.environment = environments[0];
      if (!environments.length) Object.assign(entry, { ready: false, reason: 'Connect the Studio to the requested environment first' });
      return entry;
    } catch (error) { return { lane: name, ready: false, reason: error.message }; }
  }));
}
// The lane table port (ssam_app.py fixed 4516/4536; AppSessions prepares deliveries for the same ports) and the
// trusted-controller key of the lane's connection record or authority folder.
const defaultBridgeFor = ({ root, env }) => lane => o11Bridge({ ...bridgeTarget({ lane, root, env }), port: o11LaneOf(lane, { root, env }).bridge });

// Elicitation form support declared by the client: per request on 2026-07-28 (envelope), at initialize on 2025.
export function clientAcceptsForm(server, ctx) {
  const envelope = ctx?.mcpReq?.envelope;
  const capabilities = envelope ? envelope[CLIENT_CAPABILITIES_META_KEY] : server?.server?.getClientCapabilities?.();
  const elicitation = capabilities?.elicitation;
  return !!elicitation && typeof elicitation === 'object' && (Object.keys(elicitation).length === 0 || elicitation.form != null);
}

const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  : JSON.stringify(value);
const nonEmpty = value => (Array.isArray(value) ? value.length > 0 : value != null && value !== '' && !(typeof value === 'object' && !Object.keys(value).length));
const compact = object => Object.fromEntries(Object.entries(object).filter(([, v]) => nonEmpty(v)));

// The user's rule for continue: delivered without error answers only "entregue"; verifier errors (TrueChange after
// the merge, the validation contract before it, the content proof, the CLI itself) come back alone and nothing is
// delivered. Any other state (e.g. a write to reconcile) is the host's status, as ssam_app.py returned it.
export function deliveryAnswer(status, transportError) {
  const result = status?.result ?? null;
  if (result?.delivered === true && !result.error && !transportError) return { delivered: true };
  const d = result?.diagnostics ?? {};
  const newErrors = Number(d.newErrors) > 0 ? d.newErrors : undefined;
  const contract = d.messageContract ? compact({ unexpected: d.messageContract.unexpected, missingExpected: d.messageContract.missingExpected, ambiguous: d.messageContract.ambiguous }) : null;
  if (!(result?.error || transportError || d.preparation || newErrors || nonEmpty(contract))) return status;
  return { ok: false, code: 'DELIVERY_ERRORS', errors: compact({ error: result?.error, transportError, newErrors, messageContract: contract,
    preparation: d.preparation, preMergeDifferences: d.preMergeDifferences, proofDifferences: result?.dataProof?.differences, failures: result?.failures }) };
}

// The four tools without MCP: call(name, arguments, ctx) as ssam_app.py Server.call(). deps: runAnvil (host runner),
// createRunner (lane runner factory, createAnvilRunner), bridgeFor(lane), cli, workspace, lane, root, env, now,
// reviewTtlMs, gate (async check before any permit is spent), acceptsForm(ctx).
export function createAppSession(deps = {}) {
  const root = deps.root ?? anvilRoot;
  const env = deps.env ?? process.env;
  const createRunner = deps.createRunner ?? createAnvilRunner;
  const runAnvil = deps.runAnvil ?? createRunner({ lane: deps.lane ?? o11Lane.lane, root, env });
  let workspace = null;
  if (deps.workspace != null) {
    const checked = trustedWorkspace(deps.workspace);
    if (!checked.ok) throw new Error(checked.error);
    workspace = checked.path;
  }
  const host = appHost({ runAnvil, cli: deps.cli, workspace });
  const bridgeFor = deps.bridgeFor ?? defaultBridgeFor({ root, env });
  const now = deps.now ?? Date.now;
  const ttl = deps.reviewTtlMs ?? REVIEW_TTL_MS;
  const acceptsForm = deps.acceptsForm ?? (() => false);
  const reviews = new Map();
  const lanes = () => laneReadiness({ bridgeFor });

  function check(name, args) {
    const schema = SCHEMAS.find(s => s.name === name)?.inputSchema;
    if (!schema) throw new AppSessionError('Unknown app tool', 'UNKNOWN_APP_TOOL');
    const keys = Object.keys(args ?? {});
    if (keys.some(k => !Object.hasOwn(schema.properties, k)) || schema.required.some(k => !keys.includes(k)))
      throw new AppSessionError('Only the declared app tool arguments are accepted', 'UNDECLARED_ARGUMENTS');
  }

  async function propose(args, ctx) {
    const state = typeof ctx?.mcpReq?.requestState === 'function' ? ctx.mcpReq.requestState() : undefined;
    if (typeof state === 'string') return answerReview(state, args, ctx);
    await host('authorize', { tool: 'propose', arguments: args });
    const { task_id: taskId, ...proposal } = args;
    const result = await host('propose', { task_id: taskId, proposal });
    if (result?.accepted) return result;
    for (const key of ['proposal', 'contractHash']) if (result?.[key] == null) throw new AppSessionError("'" + key + "'", 'HOST_REPLY_INCOMPLETE');
    if (!acceptsForm(ctx)) throw new AppSessionError(ACCEPTANCE_UNSUPPORTED, 'CONTRACT_ACCEPTANCE_UNSUPPORTED');
    for (const [id, review] of reviews) if (now() - review.at > ttl || review.taskId === taskId) reviews.delete(id);
    const id = randomBytes(16).toString('hex');
    reviews.set(id, { taskId, contractHash: result.contractHash, key: canonical(args), at: now() });
    return inputRequired({ requestState: id, inputRequests: {
      [REVIEW_KEY]: inputRequired.elicit({ message: contractReview(result.proposal), requestedSchema: REVIEW_SCHEMA }) } });
  }

  async function answerReview(id, args, ctx) {
    const review = reviews.get(id);
    reviews.delete(id);
    if (!review || now() - review.at > ttl || review.key !== canonical(args))
      throw new AppSessionError('The contract review expired or does not match this call; nothing was accepted', 'CONTRACT_REVIEW_EXPIRED',
        { tool: 'propose', arguments: { task_id: args.task_id }, why: 'Propose the same contract again to ask the user again' });
    const answer = inputResponse(ctx?.mcpReq?.inputResponses, REVIEW_KEY);
    if (answer.kind !== 'elicit' || answer.action !== 'accept' || answer.content?.accepted !== true)
      return { accepted: false, state: 'awaiting-user-acceptance', taskId: review.taskId };
    return host('accept', { task_id: review.taskId, contract_hash: review.contractHash });
  }

  async function advance(taskId) {
    const prepared = await host('prepare', { task_id: taskId });
    for (const key of ['lane', 'deliveryTaskId', 'work'])
      if (typeof prepared?.[key] !== 'string' || !prepared[key]) throw new AppSessionError("'" + key + "'", 'HOST_REPLY_INCOMPLETE');
    // The prepared lane's environment for this one run (ssam_app.py set ANVIL_LANE and ANVIL_STUDIO_DIR process-wide).
    const lane = o11LaneOf(prepared.lane, { root, env });
    const runDeliver = createRunner({ lane: lane.name, root, env: { ...env, ANVIL_LANE: lane.name, ANVIL_STUDIO_DIR: lane.studioDir } });
    const run = await runDeliver(['deliver', '--resume', prepared.deliveryTaskId, '--work', prepared.work]);
    const status = await host('status', { task_id: taskId });
    const envelope = run?.envelope;
    let transportError;
    if (!envelope?.ok && !status?.result?.error)
      transportError = envelope?.error || envelope?.data?.error || (envelope ? undefined
        : run?.timedOut ? 'Anvil CLI timed out' : run?.stderr?.at(-1) || 'Anvil CLI returned no envelope (exit ' + run?.exitCode + ')');
    return deliveryAnswer(status, transportError);
  }

  async function call(name, args = {}, ctx) {
    check(name, args);
    const resuming = name === 'propose' && typeof ctx?.mcpReq?.requestState === 'function' && typeof ctx.mcpReq.requestState() === 'string';
    if (!resuming) await deps.gate?.();
    if (name === 'propose') return propose(args, ctx);
    await host('authorize', { tool: name, arguments: args });
    const taskId = args.task_id;
    if (name === 'status') return host('status', { task_id: taskId });
    if (name === 'context') {
      const probes = lanes(); // read-only bridge probes, overlapped with the host call
      const result = await host('context', { task_id: taskId });
      return { ...result, lanes: await probes };
    }
    return advance(taskId);
  }

  return { call, host, lanes, reviews, workspace };
}

const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value?.ok === false ? { isError: true } : {}) });

// MCP registration. deps as createAppSession, plus descriptionPrefix (e.g. '[o11] ' in the ssam server) and surface
// (I10 of the 2026-10-06 package, A22): 'ssam_hybrid' (default) is the controlled app profile, whose client hook authorizes
// these four tools; 'ssam' is the general server, where they answer only with that hook, so they are listed only when
// SSAM_APP_HOOK_TOOLS=1 (a Codex session got "The trusted client hook did not authorize this exact tool call").
export const APP_SESSION_TOOLS = Object.freeze(SCHEMAS.map(s => s.name));
export function appSessionToolsServed({ surface = 'ssam_hybrid', env = process.env } = {}) {
  return surface !== 'ssam' || env?.SSAM_APP_HOOK_TOOLS === '1';
}
export function registerO11AppSession(server, deps = {}) {
  const session = createAppSession({ acceptsForm: ctx => clientAcceptsForm(server, ctx), ...deps });
  if (!appSessionToolsServed({ surface: deps.surface ?? 'ssam_hybrid', env: deps.env ?? process.env })) return session;
  for (const { name, description, inputSchema, annotations } of SCHEMAS) {
    server.registerTool(name, { description: (deps.descriptionPrefix ?? '') + description, inputSchema: fromJsonSchema(inputSchema), annotations, ...(name === 'propose' ? { _meta: { canRequestInput: true } } : {}) },
      async (args, ctx) => {
        try {
          const value = await session.call(name, args ?? {}, ctx);
          if (value?.resultType === 'input_required') return value;
          if (name === 'continue' && value?.delivered === true && Object.keys(value).length === 1)
            return { content: [{ type: 'text', text: RESULT.delivered }], structuredContent: { delivered: true } };
          return reply(value);
        } catch (error) {
          return reply({ ok: false, code: error instanceof AppSessionError ? error.code : 'APP_SESSION_ERROR', error: error.message,
            ...(error.continuation ? { continuation: error.continuation } : {}) });
        }
      });
  }
  return session;
}

// ssam_app.py hook(): eventJson is the hook's stdin; the answer is what the hook prints and its exit code.
export async function runHook(eventJson, { cli, workspace, runAnvil } = {}) {
  let root = null;
  if (workspace != null) {
    const checked = trustedWorkspace(workspace);
    if (!checked.ok) return { stdout: '', stderr: checked.error + '\n', exitCode: 2 };
    root = checked.path;
  }
  const host = appHost({ runAnvil: runAnvil ?? createAnvilRunner(), cli, workspace: root });
  const toolName = event => (typeof event?.tool_name === 'string' ? event.tool_name : '');
  const need = (object, key) => { if (object == null || !Object.hasOwn(object, key)) throw new Error("'" + key + "'"); return object[key]; };
  const printed = value => ({ stdout: pyJson(value) + '\n', stderr: '', exitCode: 0 });
  const silent = { stdout: '', stderr: '', exitCode: 0 };
  let event = {};
  let outside = false;
  try {
    const parsed = typeof eventJson === 'string' || Buffer.isBuffer(eventJson) ? JSON.parse(String(eventJson)) : eventJson;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Unsupported SSAM hook event');
    event = parsed;
    const kind = event.hook_event_name;
    if (root != null) {
      const cwd = Object.hasOwn(event, 'cwd') ? event.cwd : '';
      if (typeof cwd !== 'string') throw new TypeError("argument should be a str or an os.PathLike object where __fspath__ returns a str, not '" + pyType(cwd) + "'");
      try { outside = !pyAbsolute(cwd) || !within(fs.realpathSync.native(cwd), root); } catch { outside = true; }
      // Only scope metadata reaches the host when this hook survived a project change.
      if (outside) event = Object.fromEntries(['hook_event_name', 'session_id', 'turn_id', 'cwd', 'tool_name'].filter(k => Object.hasOwn(event, k)).map(k => [k, event[k]]));
    }
    if (kind === 'UserPromptSubmit') {
      const captured = await host('capture', event);
      if (outside || captured?.captured === false) return silent;
      return printed({ hookSpecificOutput: { hookEventName: kind, additionalContext: 'Controlled SSAM Hybrid app task: ' + need(captured, 'taskId')
        + '. Use only the ssam_hybrid tools with this task_id. The host retains the user request; unsupported scope is a blocker, not permission for maintenance.' } });
    }
    if (kind === 'PreToolUse') {
      const decision = await host('guard', event);
      if (root != null && decision?.inScope === false && !toolName(event).startsWith(APP_TOOL_PREFIX)) return silent;
      return printed({ hookSpecificOutput: { hookEventName: kind, permissionDecision: need(decision, 'allowed') && !outside ? 'allow' : 'deny',
        permissionDecisionReason: decision.reason || 'Exact Hybrid task call authorized' } });
    }
    throw new Error('Unsupported SSAM hook event');
  } catch (error) {
    if (outside && (event.hook_event_name === 'UserPromptSubmit' || !toolName(event).startsWith(APP_TOOL_PREFIX))) return silent;
    if (event.hook_event_name === 'PreToolUse')
      return printed({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Controlled app policy unavailable: ' + error.message } });
    return { stdout: '', stderr: 'SSAM could not capture the original user request: ' + error.message + '\n', exitCode: 2 };
  }
}
