// o11.xif on a hosted server (F4 of PLANO-11H): the two Integration Studio stages of o11_extension (model and final,
// kernel XifBuild through XifEngineClient.Default) run on the user's machine, with the user's own Integration Studio,
// through the SSAM agent. The kernel sends the engine request to the customer's O11 relay (method xif_engine,
// o11-relay.mjs); this module turns it into the request of the kind:
//   - every file the engine reads (the current extension, the author DLLs, the files of spec.resources, the model XIF, the
//     merged sources and the compiled DLL) goes to the agent by sha256 under agent:o11/xif/<id>/in/, keeping its file
//     name (the engine names the XIF resources by it); a file outside this account's workspace is PATH_OUTSIDE_WORKSPACE
//     and nothing is sent;
//   - the work folder is the agent's own (agent:o11/xif/<id>/), the XIF it writes is agent:o11/xif/<id>/out/<name>.xif;
//   - no path of this server reaches the agent: the spec goes without its references and source files (the model stage
//     reads neither), and only the agent paths above are named;
//   - the XIF comes back by file.get, checked against the sha256 the agent reported, and is copied to the output the
//     kernel asked for. The engine's answer keeps its shape: {ok, xif, sha256, studio:{version, lastUpgradeVersion},
//     reports} or {ok:false, code, error, problems}.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MirrorError, agentSegments, sha256File } from './mirror.mjs';

export const XIF_KIND = 'o11.xif';
export const XIF_COMMANDS = Object.freeze(['model', 'final']);
// The engine's own limit (XifEngineClient.Timeout, 10 min) and a margin for the files.
export const XIF_TIMEOUT_MS = 12 * 60000;
export const XIF_UPDATE_REQUIRED = 'XIF_AGENT_UPDATE_REQUIRED';
export const XIF_UPDATE_TEXT = 'The SSAM agent of this account does not build .NET extensions yet: building an extension (XIF) needs the SSAM Agent app '
  + 'version that runs Integration Studio on the user\'s machine (kind o11.xif). Nothing was built or sent. Install the current SSAM Agent app, then call again.';
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const invalid = message => new MirrorError('PARAMS_INVALID', message);
const absolute = (value, field) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw invalid(field + ' must be an absolute file of the workspace');
  return value;
};
// One safe file name for the agent (agent:<rel> rules), else refused before anything is sent.
// F4 review A2: the last segment by either separator, whatever the system (path.basename of Linux keeps "Source\NET\X.cs").
export function fileName(abs, field) {
  const name = String(abs).split(/[\\/]/).pop();
  const parsed = agentSegments('agent:o11/' + name);
  if (parsed.error || parsed.segments.length !== 2) throw new MirrorError('PATH_NOT_STAGEABLE', field + ' has a file name the agent cannot take: ' + JSON.stringify(name.slice(0, 120)));
  return name;
}
// A path inside the XIF (Source\NET\Helpers.cs): relative, no drive, no dot segment.
function xifPath(value, field) {
  if (typeof value !== 'string' || !value || value.length > 260 || /[\x00-\x1f:*?"<>|]/.test(value) || /^[\\/]/.test(value)
    || value.split(/[\\/]/).some(s => s === '' || s === '.' || s === '..')) throw invalid(field + ' must be a relative path inside the extension');
  return value;
}

// The kind's request and what to do with its answer: {params, puts: [{source, target}], after(value)}.
export async function stageXif(request, mirror, { newId = randomUUID } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalid('the engine request must be an object');
  const command = request.command;
  if (!XIF_COMMANDS.includes(command)) throw invalid('command must be model or final');
  const output = absolute(request.output, 'output');
  // B4 (F4 review): the kernel's output is a file of this account's workspace too.
  if (!mirror.classify(output).visible) throw new MirrorError('PATH_OUTSIDE_WORKSPACE', 'output is not a file of this account\'s workspace');
  const id = String(newId()).replace(/[^0-9a-f]/gi, '').slice(0, 16).toLowerCase();
  if (id.length < 8) throw invalid('no operation id');
  const base = 'agent:o11/xif/' + id;
  const puts = [];
  let count = 0;
  const input = async (abs, field) => {
    absolute(abs, field);
    const plan = await mirror.inputPlan(abs, 'o11', { to: base + '/in/' + (count++) + '/' + fileName(abs, field) });
    puts.push(...plan.puts);
    return plan.target;
  };
  const params = { command };
  let name;
  if (command === 'model') {
    const spec = request.spec;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw invalid('spec must be an object');
    name = spec.name;
    // The model stage reads neither the references of the spec nor its sources: they stay here, with their server paths.
    const { references: _references, sources: _sources, resources, ...rest } = spec;
    const sent = { ...rest };
    if (Array.isArray(resources)) {
      sent.resources = [];
      for (const [i, r] of resources.entries()) {
        if (!r || typeof r !== 'object') throw invalid('spec.resources[' + i + '] must be an object');
        const { file, ...kept } = r;
        sent.resources.push(typeof file === 'string' && file ? { ...kept, file: await input(file, 'spec.resources[' + i + '].file') } : kept);
      }
    }
    params.spec = sent;
    params.references = [];
    for (const [i, file] of (Array.isArray(request.references) ? request.references : []).entries()) params.references.push(await input(file, 'references[' + i + ']'));
    if (request.base !== undefined && request.base !== null) params.base = await input(request.base, 'base');
  } else {
    name = request.name;
    params.name = name;
    params.model = await input(request.model, 'model');
    params.dll = await input(request.dll, 'dll');
    params.sources = [];
    for (const [i, s] of (Array.isArray(request.sources) ? request.sources : []).entries()) {
      if (!s || typeof s !== 'object') throw invalid('sources[' + i + '] must be an object');
      params.sources.push({ path: xifPath(s.path, 'sources[' + i + '].path'), file: await input(s.file, 'sources[' + i + '].file') });
    }
  }
  if (typeof name !== 'string' || !NAME.test(name)) throw invalid('the extension name is not valid');
  params.output = base + '/out/' + name + '.xif';
  params.operationId = id;

  return {
    params, puts,
    // The kind's answer: a refusal passes with its code and problems only; a XIF comes back and is checked.
    async after(value) {
      if (!value || typeof value !== 'object') throw new MirrorError('AGENT_PROTOCOL_VIOLATION', 'o11.xif answered no object', { sent: true });
      if (value.ok !== true) return refusalOf(value);
      if (value.xif !== params.output) throw new MirrorError('AGENT_PROTOCOL_VIOLATION', 'o11.xif answered another XIF than the one it was asked for', { sent: true });
      const sha256 = typeof value.sha256 === 'string' ? value.sha256.toLowerCase() : null;
      if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw new MirrorError('AGENT_PROTOCOL_VIOLATION', 'o11.xif answered no sha256', { sent: true });
      const pulled = await mirror.pull(value.xif);
      if (await sha256File(pulled.path) !== sha256) throw new MirrorError('AGENT_PROTOCOL_VIOLATION', 'the XIF that came back is not the one the agent reported', { sent: true });
      fs.mkdirSync(path.dirname(output), { recursive: true });
      if (path.resolve(pulled.path) !== path.resolve(output)) fs.copyFileSync(pulled.path, output, fs.constants.COPYFILE_EXCL);
      const studio = value.studio && typeof value.studio === 'object'
        ? { version: typeof value.studio.version === 'string' ? value.studio.version : null, lastUpgradeVersion: typeof value.studio.lastUpgradeVersion === 'string' ? value.studio.lastUpgradeVersion : null }
        : null;
      return { ok: true, xif: output, sha256, studio, reports: Array.isArray(value.reports) ? value.reports.slice(0, 200) : [], agent: true };
    },
  };
}

const CODE = /^[A-Z][A-Z0-9_]{1,60}$/;
const text = (value, limit = 600) => String(value ?? '').slice(0, limit);
// The engine's refusal as the kernel reads it (XifEngineClient.Answered): code, error, problems; nothing else of the agent.
export function refusalOf(value) {
  const code = CODE.test(value?.code ?? '') ? value.code : 'XIF_ENGINE_FAILED';
  const problems = (Array.isArray(value?.problems) ? value.problems : []).slice(0, 50).filter(p => p && typeof p === 'object')
    .map(p => ({ code: CODE.test(p.code ?? '') ? p.code : code, ...(typeof p.path === 'string' ? { path: text(p.path, 200) } : {}), message: text(p.message), ...(typeof p.fix === 'string' ? { fix: text(p.fix) } : {}) }));
  return { ok: false, code, error: text(value?.error ?? code), problems: problems.length ? problems : [{ code, message: text(value?.error ?? code) }] };
}

// An error of the hop itself (the agent unreachable, the kind missing, a file refused) as an engine refusal: nothing of a
// stage reaches the environment, so the kernel answers it and the call can be repeated.
export function hopRefusal(error) {
  const code = CODE.test(error?.code ?? '') ? error.code : 'XIF_ENGINE_UNAVAILABLE';
  const message = code === XIF_UPDATE_REQUIRED ? XIF_UPDATE_TEXT
    : 'The Integration Studio stage did not finish on the user\'s machine (' + code + ': ' + text(error?.message, 300) + '). Nothing was sent to the environment.';
  return { ok: false, code, error: message, problems: [{ code, message, fix: code === XIF_UPDATE_REQUIRED ? 'Install the current SSAM Agent app, then call again.' : 'Repeat the call; the stage works only on local files.' }] };
}
