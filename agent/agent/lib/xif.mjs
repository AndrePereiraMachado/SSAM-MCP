// o11.xif (F4 of PLANO-11H): the two Integration Studio stages of o11_extension (model and final) on this machine, with
// the Integration Studio installed here, for a hosted SSAM server (hosted/xif-stage.mjs of the server line). The server
// checks the spec, merges and compiles the code and publishes; only the stages that need Integration Studio run here.
//   - The engine is the pack's own Anvil.Xif.Engine.exe (net472, x86; no OutSystems binary in the pack). The server never
//     sends code, a script, an executable or a path of this machine: one JSON request, every file an agent: path under
//     agent:o11/xif/<operationId>/ (the server put them there by sha256), the XIF written to agent:o11/xif/<id>/out/.
//   - Integration Studio is found by the rule the agent uses for the Studios (studios.mjs locateInstalled): the uninstall
//     key "OutSystems Integration Studio 11" (HKLM then HKCU, 64-bit then 32-bit view), its InstallLocation or the
//     "Integration Studio" folder in it, then Program Files; a folder counts when it has OutSystems.IntegrationStudio.Core.dll.
//     Never a fixed path or version. None: XIF_ENGINE_UNAVAILABLE, nothing runs.
//   - The engine runs with a private TEMP under the operation folder, no network and no login, at most 10 minutes; its
//     answer goes back with the agent folder and the user profile masked. A XIF that names this machine's user profile is
//     refused (the audit the kernel makes locally, which the server cannot make for this machine).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AgentError, refuse } from './errors.mjs';

export const XIF_KIND = 'o11.xif';
export const ENGINE_EXE = 'Anvil.Xif.Engine.exe';
// pack.json xifEngine {path, sha256}; without it, xif-engine/Anvil.Xif.Engine.exe of the runtime.
export const ENGINE_DEFAULT = 'xif-engine/' + ENGINE_EXE;
export const ENGINE_TIMEOUT_MS = 10 * 60000;
export const INTEGRATION_STUDIO = Object.freeze({ marker: 'OutSystems.IntegrationStudio.Core.dll', uninstall: 'OutSystems Integration Studio 11',
  folders: Object.freeze(['', 'Integration Studio']), programFiles: Object.freeze(['OutSystems', 'Integration Studio']) });
const KEYS = Object.freeze({ model: ['command', 'operationId', 'output', 'spec', 'references', 'base'], final: ['command', 'operationId', 'output', 'model', 'dll', 'name', 'sources'] });
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const OPERATION = /^[0-9a-f]{8,16}$/;
const invalid = message => refuse('PARAMS_INVALID', message);
const unavailable = message => new AgentError('XIF_ENGINE_UNAVAILABLE', message, { executed: false });

// The Integration Studio folder of this machine, or null. query(key, value, view) reads the registry (studios.mjs regQuery).
export async function locateIntegrationStudio({ env = process.env, exists = fs.existsSync, query } = {}) {
  const valid = dir => (dir && exists(path.join(dir, INTEGRATION_STUDIO.marker)) ? dir : null);
  if (typeof query === 'function') for (const hive of ['HKLM', 'HKCU']) for (const view of [64, 32]) {
    const location = await query(`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${INTEGRATION_STUDIO.uninstall}`, 'InstallLocation', view);
    if (!location || !String(location).trim()) continue;
    for (const folder of INTEGRATION_STUDIO.folders) { const dir = valid(path.join(String(location).trim(), folder)); if (dir) return dir; }
  }
  for (const programs of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean)) {
    const dir = valid(path.join(programs, ...INTEGRATION_STUDIO.programFiles));
    if (dir) return dir;
  }
  return null;
}

// The pack's engine: {path} when this installation carries it (and its sha256 matches pack.json), else null.
export function resolveXifEngine({ runtimeRoot, pack = {}, platform = process.platform, exists = fs.existsSync, read = fs.readFileSync } = {}) {
  if (platform !== 'win32' || !runtimeRoot) return null;
  const relative = typeof pack?.xifEngine?.path === 'string' ? pack.xifEngine.path : ENGINE_DEFAULT;
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) return null;
  const file = path.join(runtimeRoot, ...relative.split(/[\\/]/));
  if (!exists(file)) return null;
  if (typeof pack?.xifEngine?.sha256 === 'string') {
    try { if (createHash('sha256').update(read(file)).digest('hex') !== pack.xifEngine.sha256.toLowerCase()) return null; } catch { return null; }
  }
  return { path: file };
}

// The engine request of one stage, every agent: path confined to this operation's folder: {request, output, folder}.
// Pure (tests and the native core answer the same table, tests/fixtures/xif-table.mjs).
export function prepareXifRequest(params, { ws }) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('params must be an object');
  const command = params.command;
  if (!Object.hasOwn(KEYS, command)) throw invalid('command must be model or final');
  for (const key of Object.keys(params)) if (!KEYS[command].includes(key)) throw invalid('unknown field ' + key.slice(0, 40));
  if (typeof params.operationId !== 'string' || !OPERATION.test(params.operationId)) throw invalid('operationId must be 8 to 16 hex digits');
  const prefix = 'agent:o11/xif/' + params.operationId + '/';
  const file = (value, field, role = 'read') => {
    if (typeof value !== 'string' || !value.toLowerCase().startsWith(prefix)) throw refuse('PATH_FORBIDDEN', field + ' must be a file of this operation (' + prefix + '...)');
    return ws.resolve(value, role);
  };
  const name = command === 'model' ? params.spec?.name : params.name;
  if (typeof name !== 'string' || !NAME.test(name)) throw invalid('the extension name is not valid');
  if (params.output !== prefix + 'out/' + name + '.xif') throw refuse('PATH_FORBIDDEN', 'output must be ' + prefix + 'out/<name>.xif');
  const output = file(params.output, 'output', 'write');
  const folder = ws.resolve(prefix.slice(0, -1), 'write');
  const request = { command, work: path.join(folder, 'work'), output };
  if (command === 'model') {
    const spec = params.spec;
    if (typeof spec !== 'object' || Array.isArray(spec)) throw invalid('spec must be an object');
    if (spec.references !== undefined || spec.sources !== undefined) throw invalid('spec carries no references or sources in this stage');
    const sent = { ...spec };
    if (spec.resources !== undefined) {
      if (!Array.isArray(spec.resources)) throw invalid('spec.resources must be a list');
      sent.resources = spec.resources.map((r, i) => {
        if (!r || typeof r !== 'object' || Array.isArray(r)) throw invalid('spec.resources[' + i + '] must be an object');
        return r.file === undefined ? r : { ...r, file: file(r.file, 'spec.resources[' + i + '].file') };
      });
    }
    request.spec = sent;
    if (params.references !== undefined && !Array.isArray(params.references)) throw invalid('references must be a list');
    request.references = (params.references ?? []).map((r, i) => file(r, 'references[' + i + ']'));
    if (params.base !== undefined && params.base !== null) request.base = file(params.base, 'base');
  } else {
    request.name = name;
    request.model = file(params.model, 'model');
    request.dll = file(params.dll, 'dll');
    if (!Array.isArray(params.sources)) throw invalid('sources must be a list');
    request.sources = params.sources.map((s, i) => {
      if (!s || typeof s !== 'object' || typeof s.path !== 'string' || !s.path || s.path.length > 260 || /[\x00-\x1f:*?"<>|]/.test(s.path) || /^[\\/]/.test(s.path)
        || s.path.split(/[\\/]/).some(x => x === '' || x === '.' || x === '..')) throw invalid('sources[' + i + '].path must be a relative path inside the extension');
      return { path: s.path, file: file(s.file, 'sources[' + i + '].file') };
    });
  }
  return { request, output, folder };
}

// The engine process: one JSON request on stdin, the last JSON line of stdout.
function spawnEngine(exe, input, { env, cwd, timeoutMs }) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', done = false;
    const child = spawn(exe, [], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill(); } catch { /* gone */ } resolve({ timedOut: true, stdout, stderr }); } }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < 64 * 1024 * 1024) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { if (stderr.length < 65536) stderr += chunk.toString('utf8'); });
    child.on('error', error => { if (!done) { done = true; clearTimeout(timer); resolve({ error, stdout, stderr }); } });
    child.on('close', code => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const CODE = /^[A-Z][A-Z0-9_]{1,60}$/;
// The engine's refusal, with this machine's folders masked.
function masked(value, masks) {
  if (typeof value === 'string') { let text = value; for (const [from, to] of masks) if (from) text = text.split(from).join(to); return text.slice(0, 2000); }
  if (Array.isArray(value)) return value.slice(0, 100).map(item => masked(item, masks));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, masked(v, masks)]));
  return value;
}
function refusalOf(answer, masks) {
  const code = CODE.test(answer?.code ?? '') ? answer.code : 'XIF_ENGINE_FAILED';
  const problems = Array.isArray(answer?.problems) ? answer.problems.filter(p => p && typeof p === 'object').slice(0, 50)
    .map(p => ({ code: CODE.test(p.code ?? '') ? p.code : code, ...(typeof p.path === 'string' ? { path: p.path } : {}), message: String(p.message ?? ''), ...(typeof p.fix === 'string' ? { fix: p.fix } : {}) })) : [];
  return masked({ ok: false, code, error: String(answer?.error ?? code), problems: problems.length ? problems : [{ code, message: String(answer?.error ?? code) }] }, masks);
}

// Whether the XIF (a zlib stream of the Extension XML) names this machine's user profile: the kernel's audit
// (XifPackage Audit, "no local profile path") for the machine that built it.
export function namesProfile(bytes, profiles) {
  let text;
  try { text = zlib.inflateSync(bytes).toString('utf8'); } catch { try { text = zlib.inflateRawSync(bytes).toString('utf8'); } catch { text = bytes.toString('latin1'); } }
  const lower = text.toLowerCase();
  return profiles.filter(Boolean).some(p => lower.includes(String(p).toLowerCase()));
}

// deps: locate() -> Integration Studio folder | null, spawnEngine(exe, input, {env, cwd, timeoutMs}), env, profile.
export function createXifKind({ root, ws, engine = null, platform = process.platform, deps = {} }) {
  const env = deps.env ?? process.env;
  const profile = deps.profile ?? (env.USERPROFILE || os.homedir());
  const locate = deps.locate ?? (() => locateIntegrationStudio({ env, query: deps.query }));
  const run = deps.spawnEngine ?? spawnEngine;
  return {
    async execute(params, { deadline = null } = {}) {
      if (platform !== 'win32') throw new AgentError('XIF_PLATFORM_UNAVAILABLE', 'Integration Studio runs only on Windows; this SSAM agent does not build extensions on this system. Nothing was generated or sent.', { executed: false });
      const { request, output, folder } = prepareXifRequest(params, { ws });
      if (!engine?.path) throw unavailable('This SSAM agent package does not carry the Integration Studio engine host; install the current SSAM Agent app. Nothing was generated or sent.');
      const studio = await locate();
      if (!studio) throw unavailable('Integration Studio 11 is not installed on the machine of the SSAM agent (it comes with the OutSystems Development Environment installer); install it, then call again. Nothing was generated or sent.');
      if (fs.existsSync(output)) throw refuse('PATH_FORBIDDEN', 'the output of this operation already exists');
      const temp = path.join(request.work, 'engine-temp');
      fs.mkdirSync(temp, { recursive: true });
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const left = Number.isFinite(deadline) ? deadline - Date.now() : ENGINE_TIMEOUT_MS;
      const timeoutMs = Math.max(1000, Math.min(ENGINE_TIMEOUT_MS, left));
      const childEnv = { SystemRoot: env.SystemRoot, windir: env.windir, PATH: env.PATH, TEMP: temp, TMP: temp, LOCALAPPDATA: env.LOCALAPPDATA,
        USERPROFILE: env.USERPROFILE, ProgramFiles: env.ProgramFiles, 'ProgramFiles(x86)': env['ProgramFiles(x86)'], ANVIL_INTEGRATION_STUDIO_DIR: studio };
      for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
      const masks = [[root, '[data]'], [path.dirname(engine.path), '[runtime]'], [studio, '[Integration Studio]'], [profile, '[profile]']];
      let result;
      try { result = await run(engine.path, JSON.stringify(request), { env: childEnv, cwd: request.work, timeoutMs }); }
      finally { try { fs.rmSync(path.join(folder, 'in'), { recursive: true, force: true }); } catch { /* the next run uses a new folder */ } }
      if (result.timedOut) return refusalOf({ code: 'XIF_ENGINE_UNAVAILABLE', error: 'Integration Studio did not finish the ' + request.command + ' stage within ' + Math.round(timeoutMs / 60000) + ' minutes; nothing was sent.' }, masks);
      if (result.error) return refusalOf({ code: 'XIF_ENGINE_UNAVAILABLE', error: 'The Integration Studio engine host did not start (' + (result.error.code ?? 'error') + '); nothing was sent.' }, masks);
      const line = String(result.stdout ?? '').split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).at(-1);
      let answer = null;
      try { answer = line ? JSON.parse(line) : null; } catch { answer = null; }
      if (!answer || typeof answer !== 'object') return refusalOf({ code: 'XIF_ENGINE_UNAVAILABLE', error: 'The Integration Studio engine host answered nothing readable; nothing was sent.' }, masks);
      if (answer.ok !== true) return refusalOf(answer, masks);
      if (!fs.existsSync(output)) return refusalOf({ code: 'XIF_ENGINE_FAILED', error: 'The engine reported a XIF it did not write; nothing was sent.' }, masks);
      const bytes = fs.readFileSync(output);
      if (namesProfile(bytes, [profile])) {
        fs.rmSync(output, { force: true });
        return refusalOf({ code: 'XIF_VERIFY_FAILED', error: 'The XIF names a folder of the user profile of this machine; it was removed and nothing was sent.' }, masks);
      }
      try { fs.rmSync(request.work, { recursive: true, force: true }); } catch { /* kept */ }
      return { ok: true, xif: params.output, sha256: createHash('sha256').update(bytes).digest('hex'),
        studio: { version: typeof answer.studio?.version === 'string' ? answer.studio.version : null, lastUpgradeVersion: typeof answer.studio?.lastUpgradeVersion === 'string' ? answer.studio.lastUpgradeVersion : null },
        reports: masked(Array.isArray(answer.reports) ? answer.reports.slice(0, 200) : [], masks) };
    },
  };
}
