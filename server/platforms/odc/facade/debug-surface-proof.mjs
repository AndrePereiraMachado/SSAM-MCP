// Tracked live proof driver (R17): one declarative script over either public surface, `ssam mcp`
// (MCP stdio, ssam_debug_server|client) or `ssam debug <runtime> --stdio --lane <lane>` (JSON lines).
// It binds the observed stop tokens, never evaluates or replays, and audits requests by hash only.
import { wordsGiven } from './destructive-operations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCRIPT_SCHEMA = 'ssam-debug-surface-proof-script/1';
export const AUDIT_SCHEMA = 'ssam-debug-surface-proof-audit/1';
const fail = code => { throw new Error('debug_surface_proof_' + code); };
const invalid = reason => fail('script_invalid:' + reason);
const TERMINAL = ['completed', 'failed', 'uncertain'], ENDED = [...TERMINAL, 'owner-unavailable'];
const TOOL = { server: 'ssam_debug_server', client: 'ssam_debug_client' };
const STEP = { server: { into: 'step-into', over: 'step-over', out: 'step-out' }, client: { into: 'stepInto', over: 'stepOver', out: 'stepOut' } };
const OPS = {
  server: ['scope', 'read', 'private-read', 'read-many', 'refresh', 'expand', 'frame', 'read-frame', 'read-scope', 'private-compare',
    'step-into', 'step-over', 'step-out', 'continue', 'step', 'stop'],
  client: ['scope', 'read', 'private-read', 'read-many', 'refresh', 'expand', 'children', 'slice', 'frame', 'read-scope', 'private-compare',
    'stepInto', 'stepOver', 'stepOut', 'continue', 'step', 'stop'] };
const CONSUMING = new Set(['step', 'step-into', 'step-over', 'step-out', 'stepInto', 'stepOver', 'stepOut', 'continue', 'stop']);
const SINGLE_REF = new Set(['read', 'private-read', 'refresh', 'expand', 'children', 'slice']);
const PROBES = new Set(['scope', 'read-many', 'read', 'frame']);
// Bound from observations only; a script never supplies them.
const BOUND = new Set(['op', 'sessionId', 'threadId', 'eventId', 'generation', 'stop', 'reference', 'references', 'ref', 'refs',
  'handles', 'anchor', 'afterRevision', 'run', 'scopes', 'frame']);
const EVALUATOR = /^(expressions?|evaluat\w*|code|script|source)$/i;
const SECRET = /^(words|authori[sz]e|authorization|password|passphrase|secret|clientSecret|apiKey|token|accessToken|refreshToken|credentials?)$/i;
// External-mutation hooks call public tools only; writes need an explicit authorization token in the script.
const READ_TOOLS = new Set(['o11_service_center_read', 'odc_read', 'odc_portal_read']);
// odc_deploy (ApplyConfigs between held scenarios) is admitted only at the 'held' hook point.
const WRITE_TOOLS = new Set(['o11_service_center_write', 'odc_configurations', 'odc_write', 'odc_portal_write', 'odc_deploy']);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const LABEL = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const selfPath = fileURLToPath(import.meta.url);
export const publicCode = v => typeof v === 'string' && v.length <= 200 && /^debug_[a-z0-9_:.@-]+$/i.test(v) ? v : null;

// Key-order independent JSON, so the same request hashes alike on both surfaces and across runs.
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(v => v === undefined || typeof v === 'function' ? 'null' : canonicalJson(v)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined && typeof value[k] !== 'function').sort()
    .map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const canonicalSha256 = value => sha256(canonicalJson(value));
const fileSha = file => { try { return sha256(fs.readFileSync(file)); } catch { return null; } };
export function redactSecrets(value, field) {
  if (Array.isArray(value)) return value.map(v => redactSecrets(v));
  if (!plain(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, (SECRET.test(k) || k === field) && typeof v === 'string' ? { redactedSha256: sha256(v) } : redactSecrets(v)]));
}

function commands(list, runtime, labels, where) {
  if (!Array.isArray(list) || !list.length || list.length > 60) invalid(where);
  let consumed = null, scoped = false;
  const out = list.map(raw => {
    if (!plain(raw) || Object.keys(raw).some(k => !['op', 'kind', 'frame', 'select', 'args', 'as', 'handlesFrom', 'anchor', 'probe', 'bindStop'].includes(k)))
      invalid(where + ':field');
    const c = structuredClone(raw);
    if (!OPS[runtime].includes(c.op)) invalid(where + ':op');
    if (c.probe !== undefined) { if (c.probe !== 'stale' || !consumed || consumed === 'stop' || !PROBES.has(c.op)) invalid(where + ':probe'); }
    else if (consumed) invalid(where + ':after_consuming');
    else if (CONSUMING.has(c.op)) consumed = c.op;
    if ((c.op === 'step') !== (c.kind !== undefined) || c.kind !== undefined && !STEP[runtime][c.kind]) invalid(where + ':step');
    if (c.op === 'frame') { if (!(c.frame === 'top' || runtime === 'server' && c.frame === 'caller' || int(c.frame, 0, 100))) invalid(where + ':frame'); }
    else if (c.frame !== undefined) invalid(where + ':frame');
    const refs = SINGLE_REF.has(c.op) || c.op === 'read-many' || c.probe !== undefined && c.op === 'read';
    if (c.select !== undefined) {
      const { names, max } = plain(c.select) ? c.select : {};
      if (!refs || !plain(c.select) || Object.keys(c.select).some(k => !['names', 'max'].includes(k)) || max !== undefined && !int(max, 1, 500) ||
          names !== undefined && (!Array.isArray(names) || !names.length || names.length > 500 || names.some(n => typeof n !== 'string' || !n) ||
            new Set(names).size !== names.length)) invalid(where + ':select');
    }
    if (refs && !scoped) invalid(where + ':scope_required');
    if (c.op === 'scope' && c.probe === undefined) scoped = true;
    if (c.args !== undefined && (!plain(c.args) || Object.keys(c.args).some(k => BOUND.has(k) || EVALUATOR.test(k) || SECRET.test(k)))) invalid(where + ':args');
    if (c.as !== undefined && (c.op !== 'private-read' || c.probe !== undefined || typeof c.as !== 'string' || !LABEL.test(c.as))) invalid(where + ':as');
    if (c.op === 'private-compare') {
      if (c.probe !== undefined || !Array.isArray(c.handlesFrom) || !c.handlesFrom.length || c.handlesFrom.length > 8 ||
          c.handlesFrom.some(l => !labels.has(l)) || c.anchor !== undefined && c.anchor !== 'app-user' ||
          c.bindStop !== undefined && typeof c.bindStop !== 'boolean') invalid(where + ':handles');
    } else if (c.handlesFrom !== undefined || c.anchor !== undefined || c.bindStop !== undefined) invalid(where + ':handles');
    return Object.freeze(c);
  });
  if (!consumed) invalid(where + ':no_consuming_command');
  return Object.freeze(out);
}

function hook(h, max) {
  if (!plain(h) || Object.keys(h).some(k => !['at', 'occurrence', 'tool', 'arguments', 'authorization', 'authorizationField'].includes(k))) invalid('hook');
  const stopAt = typeof h.at === 'string' ? /^stop:([1-9][0-9]{0,2})$/.exec(h.at) : null;
  if (!['before-start', 'after-start', 'held', 'after-terminal', 'cleanup'].includes(h.at) && !(stopAt && Number(stopAt[1]) <= max)) invalid('hook_at');
  if (h.occurrence !== undefined && (h.at !== 'held' || !int(h.occurrence, 1, 100))) invalid('hook_occurrence');
  if (typeof h.tool !== 'string' || !READ_TOOLS.has(h.tool) && !WRITE_TOOLS.has(h.tool)) invalid('hook_tool');
  if (h.tool === 'odc_deploy' && h.at !== 'held') invalid('hook_at');
  if (!plain(h.arguments) || Object.keys(h.arguments).some(k => SECRET.test(k) || k === h.authorizationField)) invalid('hook_arguments');
  if (WRITE_TOOLS.has(h.tool) ? !wordsGiven(h.authorization) || h.authorization.length > 2000 ||
      typeof h.authorizationField !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(h.authorizationField)
    : h.authorization !== undefined || h.authorizationField !== undefined) invalid('hook_authorization');
  return Object.freeze({ at: h.at, occurrence: h.at === 'held' ? h.occurrence ?? 1 : null, tool: h.tool, arguments: structuredClone(h.arguments),
    authorization: h.authorization ?? null, authorizationField: h.authorizationField ?? null });
}

export function parseSurfaceProofScript(raw) {
  let s = raw;
  if (typeof raw === 'string') { try { s = JSON.parse(raw.replace(/^﻿/, '')); } catch { invalid('json'); } }
  if (!plain(s) || s.schema !== SCRIPT_SCHEMA) invalid('schema');
  if (Object.keys(s).some(k => !['schema', 'name', 'runtime', 'lane', 'start', 'expectedStops', 'perStop', 'atStop', 'onRunning', 'onHeld',
    'hooks', 'statusWaitMs', 'deadlineMs', 'replyTimeoutMs', 'cleanupMs'].includes(k))) invalid('unknown_field');
  if (s.name !== undefined && (typeof s.name !== 'string' || s.name.length > 200)) invalid('name');
  const runtime = s.runtime;
  if (!Object.hasOwn(TOOL, runtime ?? '')) invalid('runtime');
  if (!['o11', 'odc'].includes(s.lane)) invalid('lane');
  if (!plain(s.start) || !plain(s.start.run) || Object.keys(s.start).some(k => ['op', 'sessionId'].includes(k) || EVALUATOR.test(k))) invalid('start');
  // Both surfaces must receive the same run: the CLI forces --lane, MCP sends run.lane as given.
  if (s.start.run.lane !== s.lane) invalid('lane_mismatch');
  const range = s.expectedStops;
  if (!plain(range) || Object.keys(range).some(k => !['min', 'max'].includes(k)) || !int(range.min, 0, 500) || !int(range.max, range.min, 500)) invalid('expected_stops');
  const labels = new Set();
  for (const list of [s.perStop, ...(plain(s.atStop) ? Object.values(s.atStop) : [])])
    if (Array.isArray(list)) for (const c of list) if (plain(c) && c.op === 'private-read' && typeof c.as === 'string') labels.add(c.as);
  const perStop = commands(s.perStop, runtime, labels, 'per_stop'), atStop = {};
  if (s.atStop !== undefined) {
    if (!plain(s.atStop)) invalid('at_stop');
    for (const [k, list] of Object.entries(s.atStop)) {
      if (!/^[1-9][0-9]{0,2}$/.test(k) || Number(k) > range.max) invalid('at_stop');
      atStop[k] = commands(list, runtime, labels, 'at_stop_' + k);
    }
  }
  const single = (list, op, where, extra = []) => {
    if (list === undefined) return null;
    if (!Array.isArray(list) || list.length !== 1 || !plain(list[0]) || list[0].op !== op || Object.keys(list[0]).some(k => !['op', ...extra].includes(k))) invalid(where);
    return Object.freeze({ ...list[0] });
  };
  const pause = single(s.onRunning, 'pause', 'on_running', ['afterStops']);
  if (pause?.afterStops !== undefined && !int(pause.afterStops, 0, 500)) invalid('on_running');
  const resume = single(s.onHeld, 'resume', 'on_held');
  if (s.hooks !== undefined && (!Array.isArray(s.hooks) || s.hooks.length > 20)) invalid('hooks');
  const ms = (v, min, max, fallback, where) => { if (v === undefined) return fallback; if (!int(v, min, max)) invalid(where); return v; };
  return Object.freeze({ schema: SCRIPT_SCHEMA, name: s.name ?? null, runtime, lane: s.lane, start: structuredClone(s.start),
    expectedStops: Object.freeze({ min: range.min, max: range.max }), perStop, atStop: Object.freeze(atStop), pause, resume,
    hooks: Object.freeze((s.hooks ?? []).map(h => hook(h, range.max))),
    statusWaitMs: ms(s.statusWaitMs, 0, 10000, 10000, 'status_wait'), deadlineMs: ms(s.deadlineMs, 1000, 3600000, 900000, 'deadline'),
    replyTimeoutMs: ms(s.replyTimeoutMs, 10, 600000, 180000, 'reply_timeout'), cleanupMs: ms(s.cleanupMs, 10, 600000, 180000, 'cleanup') });
}

const within = (promise, ms) => {
  let timer;
  return Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]).finally(() => clearTimeout(timer));
};
export function mcpReplyValue(reply) {
  if (plain(reply?.structuredContent)) return reply.structuredContent;
  const text = Array.isArray(reply?.content) ? reply.content.find(c => c?.type === 'text')?.text : undefined;
  try {
    const parsed = JSON.parse(text);
    // ssam.mjs relays a non-debug_ throw as raw text; only its hash is kept (the CLI maps it to invalid_request).
    if (plain(parsed)) return parsed.ok === false && typeof parsed.error === 'string' && !publicCode(parsed.error)
      ? { ...parsed, error: 'debug_surface_proof_mcp_nonpublic_error', errorSha256: sha256(parsed.error) } : parsed;
  } catch { /* not a JSON tool result */ }
  // The SDK validates the tool schema before the handler and answers text; the CLI answers a public code instead.
  const sdk = typeof text === 'string' && text.startsWith('Input validation error:');
  return { ok: false, error: sdk ? 'debug_surface_proof_mcp_input_validation' : 'debug_surface_proof_mcp_unparsed_reply',
    textSha256: typeof text === 'string' ? sha256(text) : null };
}

// `ssam mcp` through the MCP SDK client. Closing it ends the server process, so it never cancels for us.
export function createMcpSurface({ root, entry, runtime, env, deps = {} }) {
  let client;
  const surface = { transport: 'mcp-stdio', lost: false,
    async open() {
      try {
        const Client = deps.Client ?? (await import('@modelcontextprotocol/client')).Client;
        const Transport = deps.StdioClientTransport ?? (await import('@modelcontextprotocol/client/stdio')).StdioClientTransport;
        client = new Client({ name: 'ssam-debug-surface-proof', version: '1' });
        await client.connect(new Transport({ command: process.execPath, args: [entry, 'mcp', '--profile', 'all'], cwd: root, env, stderr: 'ignore' }));
      } catch { surface.lost = true; fail('surface_unavailable'); }
    },
    request: (request, timeoutMs) => surface.tool(TOOL[runtime], request, timeoutMs),
    async tool(name, args, timeoutMs) {
      try { return { status: 'replied', result: mcpReplyValue(await client.callTool({ name, arguments: args }, { timeout: timeoutMs })) }; }
      catch (error) {
        // A JSON-RPC error is an answer; local SDK errors (timeout, closed, send failure) leave the outcome unknown.
        if (typeof error?.code === 'number') return { status: 'replied', result: { ok: false, error: 'debug_surface_proof_mcp_protocol_error', protocolCode: error.code } };
        return { status: 'lost', reason: error?.code === 'REQUEST_TIMEOUT' ? 'reply-timeout' : error?.code === 'SEND_FAILED' ? 'send-failed' : 'channel-closed' };
      }
    },
    async close() {
      try { await client?.close(); } catch { /* the process is gone either way */ }
      return { releasedBy: 'transport-close', ownerClosingSupported: false, exitObserved: null };
    } };
  return surface;
}

// `ssam debug <runtime> --stdio --lane <lane>`: ids per request, owner-closing events kept, stdin EOF on close.
export function createCliSurface({ root, entry, runtime, lane, env, deps = {} }) {
  let child, next = 0, exit = null, linesClosed = Promise.resolve();
  const pending = new Map();
  const surface = { transport: 'cli-json-lines', lost: false, closed: false, events: [], lateReplies: 0, invalidLines: 0,
    async open() {
      try {
        child = (deps.spawn ?? spawnProcess)(process.execPath, [entry, 'debug', runtime, '--stdio', '--lane', lane],
          { cwd: root, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      } catch { child = null; surface.lost = true; fail('surface_unavailable'); } // never started: nothing to close
      child.stdin.on('error', () => {}); // a broken pipe surfaces as a lost reply below
      const gone = () => {
        surface.closed = true;
        for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ status: 'lost', reason: 'channel-closed' }); }
        pending.clear();
      };
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      linesClosed = new Promise(resolve => lines.once('close', resolve));
      lines.on('line', line => {
        let row;
        try { row = JSON.parse(line); } catch { surface.invalidLines++; return; }
        if (row?.id === null && typeof row.event === 'string') { surface.events.push(row); return; }
        const p = pending.get(row?.id);
        if (!p) { surface.lateReplies++; return; } // a reply after its deadline is counted, never used
        pending.delete(row.id); clearTimeout(p.timer);
        p.resolve({ status: 'replied', result: plain(row.result) ? row.result : { ok: false, error: 'debug_surface_proof_cli_invalid_reply' } });
      });
      lines.on('close', gone); child.on('error', gone);
      child.once('close', (code, signal) => { exit = { code, signal }; gone(); });
    },
    request(request, timeoutMs) {
      if (surface.closed) return { status: 'not-sent', reason: 'channel-closed' };
      const id = 'r' + (++next);
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ status: 'lost', reason: 'reply-timeout' }); }, timeoutMs);
        pending.set(id, { resolve, timer });
        try { child.stdin.write(JSON.stringify({ id, request }) + '\n'); }
        catch { pending.delete(id); clearTimeout(timer); resolve({ status: 'lost', reason: 'send-failed' }); }
      });
    },
    tool() { fail('cli_has_no_tools'); },
    async close(waitMs) {
      if (!child) return null;
      try { child.stdin.end(); } catch { /* already closed */ }
      // EOF is the owner's cancellation: it stops owned sessions and reports owner-closing. Never killed here.
      await within(Promise.all([exit ? null : new Promise(resolve => child.once('close', resolve)), linesClosed]), waitMs);
      const exitObserved = exit !== null;
      if (!exitObserved) { child.unref?.(); try { child.stdout?.destroy(); } catch { /* detached */ } }
      return { releasedBy: 'stdin-eof', ownerClosingSupported: true, exitObserved, ...(exit ? { exit } : {}) };
    } };
  return surface;
}

// The runner sets credentialsReleased only when it leased an app-user descriptor (debug-o11-native-run.mjs);
// explicitly anonymous endpoints and native-background runs take none, which their own needs record.
const NO_LEASE = new Set(['anonymous', 'native-background']);
function credentialOutcome(rr, requested) {
  if (typeof rr?.credentialsReleased === 'boolean')
    return { value: rr.credentialsReleased, outcome: rr.credentialsReleased ? 'released' : 'not-released', source: 'runResult.credentialsReleased' };
  const needs = plain(rr?.needs) ? rr.needs : null, results = Array.isArray(rr?.results) ? rr.results : [];
  if (needs && NO_LEASE.has(needs.contextMode) && needs.loginWindow === false && (requested === undefined || requested === needs.contextMode) &&
      rr.appUserAuthenticated === undefined && rr.appUser === undefined &&
      results.every(r => r?.authentication === undefined || r.authentication?.credentialsFromPrivateDialog === false))
    return { value: null, outcome: 'not-applicable', source: 'runResult.needs.contextMode', contextMode: needs.contextMode };
  return { value: null, outcome: 'unknown', source: null };
}

// Evidence flags read from the coordinator's terminal snapshot; each names its source or stays null.
export function surfaceFlags(snapshot, { contextMode } = {}) {
  const rr = plain(snapshot?.runResult) ? snapshot.runResult : null, results = Array.isArray(rr?.results) ? rr.results : [];
  const bool = v => typeof v === 'boolean' ? v : null;
  // kind says what was observed: the native debugger's stop, or only the exit of the worker hosting the client inspector.
  const nativeStop = typeof rr?.serverTrace?.stopped === 'boolean' ? { value: rr.serverTrace.stopped, kind: 'debugger-stopped', source: 'runResult.serverTrace.stopped' }
    : typeof rr?.cleanup?.debuggerStopped === 'boolean' ? { value: rr.cleanup.debuggerStopped, kind: 'debugger-stopped', source: 'runResult.cleanup.debuggerStopped' }
    : typeof rr?.worker?.workerExited === 'boolean' ? { value: rr.worker.workerExited, kind: 'inspector-host-exited', source: 'runResult.worker.workerExited' }
    : { value: null, kind: null, source: null };
  // Client stop acknowledgement (debug-client-session.mjs), kept apart from the runner's completion.
  const se = plain(snapshot?.stopEvidence) ? snapshot.stopEvidence : null, pic = se?.privateInspectionCleanup;
  const stopCommand = se ? { source: 'stopEvidence', workerTerminationRequested: bool(se.workerTerminationRequested),
    executionOutcome: typeof se.executionOutcome === 'string' ? se.executionOutcome : null,
    privateInspectionCleanup: typeof pic?.completed === 'boolean' && Number.isSafeInteger(pic.pending) ? { completed: pic.completed, pending: pic.pending } : null } : null;
  return { response: { answered: rr ? rr.state === 'answered' || results.length > 0 && results.every(r => r?.uncertain !== true) && !rr.notSent?.length : null,
      results: results.length, uncertainResults: results.filter(r => r?.uncertain === true).length },
    nativeStop, stopCommand, credentials: credentialOutcome(rr, contextMode), mutexReleased: typeof rr?.lockRetained === 'boolean' ? !rr.lockRetained : null,
    runUncertain: bool(rr?.uncertain), cleanupCompleted: bool(rr?.cleanup?.completed) };
}

class LostReply extends Error {}

export async function runSurfaceProof({ script: raw, transport, root, entry, outDir, transcript = true, deps = {} } = {}) {
  const script = parseSurfaceProofScript(raw);
  if (!['mcp', 'cli'].includes(transport)) fail('transport_invalid');
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('root_not_absolute');
  const entryPath = entry ?? path.join(root, 'facade', 'ssam.mjs');
  if (typeof entryPath !== 'string' || !path.isAbsolute(entryPath) || !fs.existsSync(entryPath)) fail('entry_unavailable');
  if (typeof outDir !== 'string' || !path.isAbsolute(outDir)) fail('out_not_absolute');
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  try { fs.mkdirSync(outDir); } catch (error) { fail(error?.code === 'EEXIST' ? 'out_exists' : 'out_unavailable'); } // one attempt per directory
  const now = deps.now ?? Date.now, iso = deps.isoNow ?? (() => new Date().toISOString()), env = deps.env ?? process.env;
  const { runtime, lane } = script, server = runtime === 'server', refKey = server ? ['reference', 'references'] : ['ref', 'refs'];
  const auditPath = path.join(outDir, 'audit.json'), transcriptPath = path.join(outDir, 'transcript.jsonl');
  const stateRoot = path.resolve(root, '.local', 'debugger');
  const audit = { schema: AUDIT_SCHEMA, complete: false, transport: transport === 'mcp' ? 'mcp-stdio' : 'cli-json-lines', runtime, lane,
    surface: transport === 'mcp' ? { args: ['mcp', '--profile', 'all'], tool: TOOL[runtime] } : { args: ['debug', runtime, '--stdio', '--lane', lane], tool: null },
    script: { name: script.name, sha256: canonicalSha256(redactSecrets(script)) },
    entry: { path: entryPath, sha256: fileSha(entryPath) }, driver: { path: selfPath, sha256: fileSha(selfPath) }, root,
    startedAt: iso(), finishedAt: null, sessionId: null, nativeSessionId: null, runnerOperationId: null, requests: [], sequence: null,
    stops: { expected: { ...script.expectedStops }, observed: 0, withinRange: null, exceeded: false, list: [] },
    staleRefusals: [], staleProbeMismatches: [], unexpectedStaleRefusals: 0, uncertainty: null, lateReplies: 0, invalidOutputLines: 0, hookErrors: [],
    owner: null, ownerTerminatedWithLiveSession: null, ownerClosing: [], terminal: { observed: false, state: null, source: null }, runResult: null, sessionReceipt: null,
    flags: null, surfaceCriteriaPassed: false, error: null, cleanupError: null, auditPath };
  const save = () => { fs.writeFileSync(auditPath + '.tmp', JSON.stringify(audit, null, 2)); fs.renameSync(auditPath + '.tmp', auditPath); };
  const record = row => { if (transcript) fs.appendFileSync(transcriptPath, JSON.stringify(row) + '\n'); };
  save();
  let debug, tools, session = null, initial = null, last = null, final = null, source = null;
  let stopRequested = false, stopSent = false, pauseSent = false;
  const labels = new Map(), hooksDone = new Set(), seen = new Set();
  // Observed fields become `$name` in the template: the transport-independent shape of the request.
  const bind = (fields, bound) => {
    const entries = Object.entries(bound).filter(([, v]) => v !== undefined);
    return [{ ...fields, ...Object.fromEntries(entries) },
      { ...fields, ...Object.fromEntries(entries.map(([k, v]) => [k, '$' + k + (Array.isArray(v) ? '[' + v.length + ']' : '')])) }];
  };

  async function exchange(channel, phase, op, request, template, timeoutMs, extra = {}) {
    const surface = channel === 'tools' ? tools : debug, redacted = redactSecrets(request, extra.field);
    if (surface.lost) fail('channel_lost');
    const row = { seq: audit.requests.length + 1, phase, channel, op, requestSha256: canonicalSha256(redacted),
      templateSha256: canonicalSha256(redactSecrets(template, extra.field)), ...extra.row };
    audit.requests.push(row); record({ seq: row.seq, kind: 'request', channel, request: redacted });
    const reply = channel === 'tools' ? await surface.tool(op, request, timeoutMs) : await surface.request(request, timeoutMs);
    if (reply.status !== 'replied') {
      // Never resent: the outcome is unknown and the channel is not used again.
      row.outcome = reply.status === 'not-sent' ? 'not-sent' : 'lost'; row.lostReason = reply.reason; surface.lost = true;
      if (row.outcome === 'lost') audit.uncertainty ??= { seq: row.seq, phase, channel, op, requestSha256: row.requestSha256, reason: reply.reason };
      record({ seq: row.seq, kind: row.outcome, reason: reply.reason }); save();
      if (row.outcome === 'not-sent') fail('channel_closed');
      throw new LostReply();
    }
    const result = reply.result;
    Object.assign(row, { outcome: 'replied', responseSha256: canonicalSha256(result), ok: result.ok === true });
    const code = publicCode(result.error);
    if (code) row.error = code; else if (result.error !== undefined) row.errorNonPublic = true;
    if (Array.isArray(result.values)) row.values = result.values.length;
    if (Array.isArray(result.variables)) row.variables = result.variables.length;
    record({ seq: row.seq, kind: 'response', result }); save();
    return result;
  }
  const send = (phase, [request, template], timeoutMs = script.replyTimeoutMs) =>
    exchange('debug', phase, request.op, request, template, timeoutMs);

  async function hooksAt(at, occurrence = null, tolerant = false) {
    for (const h of script.hooks) {
      if (h.at !== at || h.occurrence !== occurrence || hooksDone.has(h)) continue;
      hooksDone.add(h);
      try {
        if (!tools) { tools = createMcpSurface({ root, entry: entryPath, runtime, env, deps }); await tools.open(); }
        const args = h.authorization ? { ...h.arguments, [h.authorizationField]: h.authorization } : { ...h.arguments };
        const result = await exchange('tools', 'hook', h.tool, args, args, script.replyTimeoutMs,
          { field: h.authorizationField, row: { at: h.at, ...(h.authorization ? { authorizationSha256: sha256(h.authorization) } : {}) } });
        if (result.ok !== true) fail('hook_refused');
      } catch (error) {
        if (!tolerant) throw error;
        audit.hookErrors.push({ at, tool: h.tool, error: error instanceof LostReply ? 'debug_surface_proof_reply_lost' : publicCode(error?.message) ?? 'debug_surface_proof_hook_failed' });
      }
    }
  }

  async function stopAt(stop) {
    const index = ++audit.stops.observed;
    if (index > script.expectedStops.max) { audit.stops.exceeded = true; fail('stop_range_exceeded'); }
    const token = server ? { sessionId: session, threadId: stop.threadId, eventId: stop.eventId, generation: stop.generation }
      : { sessionId: session, stop: stop.stop, generation: stop.generation };
    const entry = { index, ...Object.fromEntries(Object.entries(token).filter(([k]) => k !== 'sessionId')), commands: 0, skipped: [] };
    audit.stops.list.push(entry); save();
    await hooksAt('stop:' + index);
    let scope = null, consumed = null;
    const refsOf = select => {
      const vars = Array.isArray(scope?.variables) ? scope.variables : [];
      const picked = vars.filter(v => !select?.names || select.names.includes(v?.name)).map(v => v?.[refKey[0]]).filter(r => typeof r === 'string');
      return [...new Set(picked)].slice(0, select?.max ?? 500);
    };
    const frameOf = value => {
      const frame = server ? (Array.isArray(stop.stack) ? stop.stack : []).at(value === 'caller' ? -2 : -1)?.frame : stop.frame;
      if (!Number.isInteger(frame)) fail('frame_unresolved');
      return frame;
    };
    const framed = (c, bound) => Number.isInteger(c.frame) ? [{ frame: c.frame }, bound] : [{}, { ...bound, frame: frameOf(c.frame) }];
    for (const c of script.atStop[index] ?? script.perStop) {
      const op = c.op === 'step' ? STEP[runtime][c.kind] : c.op, args = c.args ?? {};
      const issue = async (fields, bound) => {
        const result = await send('script', bind({ op, ...args, ...fields }, bound)); entry.commands++;
        if (result.ok !== true) { if (/_stale_stop$/.test(result.error ?? '')) audit.unexpectedStaleRefusals++; fail('command_refused'); }
        if (!CONSUMING.has(op) && Number.isInteger(result.generation)) token.generation = result.generation;
        return result;
      };
      if (c.probe === 'stale') {
        // A consumed token must be refused; the probe is a new read with the old token, never a replay.
        let fields = {}, bound = { ...consumed };
        if (op === 'frame') [fields, bound] = framed(c, bound);
        if (op === 'read-many') bound[refKey[1]] = refsOf(c.select);
        if (op === 'read') bound[refKey[0]] = refsOf(c.select)[0];
        if (op === 'read-many' && !bound[refKey[1]].length || op === 'read' && !bound[refKey[0]]) { entry.skipped.push(op + ':probe'); continue; }
        const result = await send('script', bind({ op, ...args, ...fields }, bound)); entry.commands++;
        if (result.ok === true) fail('stale_reference_accepted');
        const error = publicCode(result.error) ?? null, expected = 'debug_' + runtime + '_session_stale_stop';
        if (error !== expected) { audit.staleProbeMismatches.push({ stop: index, op, error, expected }); fail('stale_probe_refusal_mismatch'); }
        audit.staleRefusals.push({ stop: index, op, error });
      } else if (op === 'stop') {
        stopSent = stopRequested = true; entry.commands++;
        last = await send('script', bind({ op }, { sessionId: session }));
        if (last.ok !== true) fail('stop_refused');
        return;
      } else if (CONSUMING.has(op)) { consumed = { ...token }; await issue({}, token); }
      else if (op === 'frame') await issue(...framed(c, token));
      else if (op === 'scope') scope = await issue({}, token);
      else if (op === 'read-many') {
        const refs = refsOf(c.select);
        if (refs.length) await issue({}, { ...token, [refKey[1]]: refs }); else entry.skipped.push(op);
      } else if (SINGLE_REF.has(op)) {
        const refs = refsOf(c.select);
        if (!refs.length) entry.skipped.push(op);
        for (const ref of refs) {
          const result = await issue({}, { ...token, [refKey[0]]: ref });
          if (c.as) {
            // The opaque compare handle (debug-private-compare.mjs), never the DPAPI descriptor reference or a value.
            const handle = result.privateCompareHandle;
            if (typeof handle !== 'string' || !/^pc_[0-9a-f]{32}$/.test(handle)) fail('private_handle_unavailable');
            labels.set(c.as, [...(labels.get(c.as) ?? []), handle]);
          }
        }
      } else if (op === 'private-compare') {
        const handles = [...new Set(c.handlesFrom.flatMap(l => labels.get(l) ?? []))];
        if (handles.length + (c.anchor ? 1 : 0) < 2 || handles.length > 8) fail('private_handles_unavailable');
        await issue(c.anchor ? { anchor: c.anchor } : {}, { ...(c.bindStop ? token : { sessionId: session }), handles });
      } else await issue({}, token); // read-scope, read-frame
    }
  }

  async function observe(phase, state, until) {
    let held = false, episodes = 0;
    for (;;) {
      if (now() > until) fail(phase === 'cleanup' ? 'cleanup_expired' : 'deadline_expired');
      state = last = await send(phase, bind({ op: 'status', waitMs: script.statusWaitMs },
        { sessionId: session, afterRevision: Number.isInteger(state?.revision) ? state.revision : undefined }), script.statusWaitMs + script.replyTimeoutMs);
      if (state.ok !== true) fail('status_refused');
      if (ENDED.includes(state.state)) { final = state; source = 'status'; return; }
      if (phase === 'cleanup' || stopRequested) continue;
      if (state.state === 'held') {
        if (!held) {
          held = true; episodes++;
          await hooksAt('held', episodes);
          if (script.resume && (await send('script', bind({ op: 'resume' }, { sessionId: session, afterRevision: state.revision })))?.ok !== true) fail('command_refused');
        }
        continue;
      }
      held = false;
      if (state.state === 'running' && script.pause && !pauseSent && audit.stops.observed >= (script.pause.afterStops ?? 0)) {
        // One request only: a pending or uncertain pause is never resent.
        pauseSent = true;
        if ((await send('script', bind({ op: 'pause' }, { sessionId: session, afterRevision: state.revision })))?.ok !== true) fail('command_refused');
      }
      const stops = server ? (Array.isArray(state.pauses) ? state.pauses : []) : state.state === 'paused' && plain(state.pause) ? [state.pause] : [];
      for (const stop of stops) {
        const key = server ? stop.threadId + ':' + stop.eventId : String(stop.stop);
        if (seen.has(key)) continue;
        seen.add(key); await stopAt(stop);
        if (stopRequested) break;
      }
    }
  }

  function receipt(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
    const inside = (base, target) => { const rel = path.relative(base, target); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
    if (!inside(stateRoot, path.resolve(file))) return { path: file, sha256: null, refused: 'outside-debugger-root' };
    try {
      const real = fs.realpathSync(file);
      if (!inside(fs.realpathSync(stateRoot), real)) return { path: file, sha256: null, refused: 'outside-debugger-root' };
      return { path: file, sha256: sha256(fs.readFileSync(real)) };
    } catch { return { path: file, sha256: null, missing: true }; }
  }

  try {
    debug = transport === 'mcp' ? createMcpSurface({ root, entry: entryPath, runtime, env, deps })
      : createCliSurface({ root, entry: entryPath, runtime, lane, env, deps });
    if (transport === 'mcp') tools = debug;
    await debug.open();
    await hooksAt('before-start');
    const started = await send('script', bind({ op: 'start', ...structuredClone(script.start) }, {}));
    if (started.ok !== true || typeof started.sessionId !== 'string') fail('start_refused');
    session = audit.sessionId = started.sessionId; initial = last = started;
    await hooksAt('after-start');
    await observe('script', started, now() + script.deadlineMs);
    await hooksAt('after-terminal');
  } catch (error) {
    if (!(error instanceof LostReply)) audit.error ??= publicCode(error?.message) ?? 'debug_surface_proof_failed';
  } finally {
    // Script failure on a healthy channel: one stop, then the runner's own terminal receipt.
    if (session && !final && debug && !debug.lost) {
      try {
        if (!stopSent) { stopSent = true; last = await send('cleanup', bind({ op: 'stop' }, { sessionId: session })); }
        await observe('cleanup', last, now() + script.cleanupMs);
      } catch (error) { if (!(error instanceof LostReply)) audit.cleanupError = publicCode(error?.message) ?? 'debug_surface_proof_cleanup_failed'; }
    }
    await hooksAt('cleanup', null, true);
    // Live at close: a known session without a terminal state; unknown when the start reply was lost.
    const liveAtClose = session ? !final : audit.requests.some(r => r.op === 'start' && r.outcome === 'lost') ? null : false;
    audit.owner = debug ? await debug.close(script.cleanupMs) : null;
    if (tools && tools !== debug) await tools.close();
    for (const event of debug?.events ?? []) if (event.event === 'owner-closing') audit.ownerClosing.push({ sessionId: event.sessionId ?? null,
      terminalObserved: event.terminalObserved === true, state: event.result?.state ?? null, resultSha256: canonicalSha256(event.result ?? null) });
    // A lost start reply leaves the id unknown; the CLI owner only owns sessions started on this stdin.
    const closings = (debug?.events ?? []).filter(e => e.event === 'owner-closing');
    if (!session && closings.length === 1 && typeof closings[0].sessionId === 'string') { session = audit.sessionId = closings[0].sessionId; audit.sessionIdSource = 'owner-closing'; }
    const closing = closings.find(e => e.sessionId === session && e.terminalObserved === true && TERMINAL.includes(e.result?.state));
    if (!final && closing) { final = closing.result; source = 'owner-closing'; record({ kind: 'owner-closing', result: closing.result }); }
    // `ssam mcp` close handlers do not stop debug sessions: closing it kills a live session's owner with no stop, leaving
    // the native debugger, app-user lease and run mutex to expiry/reconcile. The CLI owner stops its sessions on EOF.
    if (audit.owner) Object.assign(audit.owner, { liveSessionAtClose: liveAtClose, sessionStopOnClose: audit.owner.ownerClosingSupported ? 'owner-stop-on-eof' : 'none' });
    audit.ownerTerminatedWithLiveSession = closing ? false : liveAtClose;
    audit.lateReplies = debug?.lateReplies ?? 0; audit.invalidOutputLines = debug?.invalidLines ?? 0;
    audit.terminal = { observed: TERMINAL.includes(final?.state), state: final?.state ?? null, source: final ? source : null };
    const rr = plain(final?.runResult) ? final.runResult : null;
    audit.runnerOperationId = typeof rr?.operationId === 'string' ? rr.operationId : null;
    audit.nativeSessionId = [final?.nativeSessionId, rr?.serverTrace?.sessionId].find(v => typeof v === 'string') ?? null;
    audit.runResult = rr ? { ok: rr.ok === true, uncertain: rr.uncertain === true, state: typeof rr.state === 'string' ? rr.state : null, receipt: receipt(rr.receiptPath) } : null;
    audit.sessionReceipt = receipt(final?.receiptPath ?? initial?.receiptPath);
    audit.flags = surfaceFlags(final, { contextMode: script.start.run.contextMode });
    const { min, max } = script.expectedStops, observed = audit.stops.observed;
    audit.stops.withinRange = audit.terminal.observed && !audit.stops.exceeded && observed >= min && observed <= max;
    if (audit.terminal.observed && !audit.error && !audit.uncertainty && observed < min) audit.error = 'debug_surface_proof_stop_range_unmet';
    const rows = key => audit.requests.map(r => [r.phase, r.channel, r.op, r[key] ?? null]);
    audit.sequence = { requests: audit.requests.length, requestsSha256: canonicalSha256(rows('requestSha256')),
      templatesSha256: canonicalSha256(rows('templateSha256')), responsesSha256: canonicalSha256(rows('responseSha256')) };
    const f = audit.flags;
    audit.surfaceCriteriaPassed = audit.terminal.state === 'completed' && audit.runResult?.ok === true && audit.runResult.uncertain === false &&
      typeof audit.runResult.receipt?.sha256 === 'string' && f.response.answered === true && f.nativeStop.value === true &&
      f.stopCommand?.privateInspectionCleanup?.completed !== false &&
      ['released', 'not-applicable'].includes(f.credentials.outcome) && f.mutexReleased === true && audit.ownerTerminatedWithLiveSession === false && audit.stops.withinRange === true && !audit.uncertainty && !audit.error &&
      !audit.cleanupError && audit.unexpectedStaleRefusals === 0 && !audit.hookErrors.length;
    audit.finishedAt = iso(); audit.complete = true; save();
  }
  return audit;
}

// Req 17 parity of two audits of one script: request shapes and refusal codes, status polls excluded
// (their count depends on timing). sameRefusalClasses maps the known MCP/CLI invalid-request split.
const REFUSAL_CLASS = { debug_inspection_cli_invalid_request: 'invalid-request', debug_surface_proof_mcp_input_validation: 'invalid-request',
  debug_surface_proof_mcp_nonpublic_error: 'invalid-request' };
export function surfaceParity(a, b) {
  const commands = audit => (audit?.requests ?? []).filter(r => r.op !== 'status');
  const same = view => canonicalJson(view(a)) === canonicalJson(view(b));
  const codes = audit => commands(audit).map(r => r.error ?? null);
  const verdict = { transports: [a?.transport ?? null, b?.transport ?? null], bothSurfaces: new Set([a?.transport, b?.transport]).size === 2,
    sameScript: !!a?.script?.sha256 && a.script.sha256 === b?.script?.sha256,
    sameRequestShapes: same(audit => commands(audit).map(r => [r.phase, r.channel, r.op, r.templateSha256])),
    sameErrorCodes: same(codes), sameRefusalClasses: same(audit => codes(audit).map(code => REFUSAL_CLASS[code] ?? code)),
    sameStops: a?.stops?.observed === b?.stops?.observed, bothPassed: a?.surfaceCriteriaPassed === true && b?.surfaceCriteriaPassed === true };
  verdict.parity = verdict.bothSurfaces && verdict.sameScript && verdict.sameRequestShapes && verdict.sameErrorCodes && verdict.sameStops;
  return verdict;
}

export function surfaceProofSummary(audit) {
  return { ok: audit.surfaceCriteriaPassed, transport: audit.transport, runtime: audit.runtime, lane: audit.lane, sessionId: audit.sessionId,
    state: audit.terminal.state, stops: audit.stops.observed, uncertain: !!audit.uncertainty, error: audit.error,
    auditPath: audit.auditPath, auditSha256: fileSha(audit.auditPath) };
}

export function parseSurfaceProofCli(argv) {
  const names = { '--script': 'script', '--transport': 'transport', '--root': 'root', '--out': 'outDir', '--entry': 'entry' }, options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = names[argv[i]];
    if (!name || options[name] !== undefined || typeof argv[i + 1] !== 'string') fail('cli_usage');
    options[name] = argv[i + 1];
  }
  if (!options.script || !path.isAbsolute(options.script) || !options.transport || !options.root || !options.outDir) fail('cli_usage');
  return options;
}

// node debug-surface-proof.mjs --script <abs.json> --transport mcp|cli --root <active folder> --out <new abs dir> [--entry <abs>]
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { script, ...options } = parseSurfaceProofCli(process.argv.slice(2));
    const audit = await runSurfaceProof({ ...options, script: fs.readFileSync(script, 'utf8') });
    process.stdout.write(JSON.stringify(surfaceProofSummary(audit)) + '\n');
    if (!audit.surfaceCriteriaPassed) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: publicCode(error?.message) ?? 'debug_surface_proof_failed' }) + '\n');
    process.exitCode = 1;
  }
}
