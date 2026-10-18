// odc_external_library: an ODC External Library from its spec, in one call per change (contract INTEGRACOES-GITSSAM,
// lane extlib). build (no tenant): the ODC kernel generates the net10.0 project with the pinned
// OutSystems.ExternalLibraries.SDK, runs dotnet publish and writes the deterministic zip. deploy: the same build, then
// the tenant lifecycle of portal/runtime/external-library.mjs (credential planes and Portal metadata first, reads,
// receipt, upload, generation followed here, publish through the Portal session, release tag, readback) and one answer
// with the library, revision, tag, runtime, the consumers left outdated and the continuation of the reference job.
// status (reads) and discard (deletes an open job; destructive). No username or password ever: the ODC Studio session
// first, then the vault, then the private prompt. Every refusal comes before any change, with every problem at once.
import { DESTRUCTIVE_SUFFIX, ODC_EXECUTION_UUID, withSignal, wordsGiven } from './destructive-operations.mjs';
import { OWNED_CLEANUP } from '../portal/runtime/owned-cleanup-approval.mjs';
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import { anvilRoot, odcRoot } from './workspace.mjs';
import { recordPublished, recordPublicationEnded, publicationOpen } from './producer-signatures.mjs';
import { execFile } from 'node:child_process';
import { namesWhole } from './studio-create-app.mjs';
import { portalTransportDirectory } from './portal-request-file.mjs';
import {authorizationContext as readApproval} from './authorization-context.mjs';
import {externalLibrarySelection} from './external-library-selection.mjs';

export const EXTERNAL_LIBRARY_ACTIONS = ['build', 'deploy', 'status', 'discard'];
const FIELDS = {
  build: ['spec', 'specFile'],
  deploy: ['spec', 'specFile', 'releaseTag', 'releaseNotes', 'tenant', 'auth', 'pid', 'authorize', 'operationUuid', 'confirmTenant', 'authorizationContext', 'originOperationUuid', 'expectedRevision'],
  status: ['library', 'spec', 'specFile', 'tenant', 'auth', 'pid'],
  discard: ['library', 'jobKey', 'tenant', 'auth', 'pid', 'authorize', 'operationUuid', 'confirmTenant', 'authorizationContext', 'originOperationUuid', 'confirmationToken', 'ownerRequest'],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refusal = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

// ---- the spec rules of ExternalLibrarySpec.cs (kernel), mirrored so a bad spec is refused without starting a process.
// kernel/tests/fixtures/external-library/spec-invalid.json and spec-invalid.expected.json keep both in agreement.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOTTED = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const EXACT_VERSION = /^\d+(\.\d+){1,3}(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
export const SDK_PACKAGE = 'OutSystems.ExternalLibraries.SDK';
export const PRIMITIVES = Object.freeze({ Text: 'Text', Integer: 'Integer', LongInteger: 'LongInteger', 'Long Integer': 'LongInteger', Decimal: 'Decimal', Boolean: 'Boolean',
  Date: 'Date', DateTime: 'DateTime', 'Date Time': 'DateTime', Time: 'Time', Currency: 'Currency', Email: 'Email', PhoneNumber: 'PhoneNumber', 'Phone Number': 'PhoneNumber',
  BinaryData: 'BinaryData', 'Binary Data': 'BinaryData' });
const KEYWORDS = new Set(['abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do',
  'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal',
  'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte',
  'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort',
  'using', 'virtual', 'void', 'volatile', 'while']);
const ROOT = ['name', 'description', 'namespace', 'structures', 'actions', 'packages', 'usings'];
const O11_ONLY = ['sources', 'references', 'resources', 'remove', 'isFunction'];
const STRUCTURE = ['name', 'description', 'attributes'];
const ATTRIBUTE = ['name', 'type', 'mandatory', 'length', 'decimals', 'default', 'description'];
const ACTION = ['name', 'description', 'inputs', 'outputs', 'body'];
const INPUT = ['name', 'type', 'mandatory', 'default', 'description'];
const OUTPUT = ['name', 'type', 'description'];
const PACKAGE = ['name', 'version'];
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (o, k) => (isObject(o) && typeof o[k] === 'string' ? o[k] : null);
const ieq = (a, b) => a.toLowerCase() === b.toLowerCase();

export function validateExternalLibrarySpec(spec) {
  const problems = [];
  const add = (code, path, message, fix) => problems.push({ code, path, message, fix });
  if (!isObject(spec)) { add('SPEC_NOT_OBJECT', '', 'The spec must be a JSON object.', 'Pass {name, actions:[...]}.'); return problems; }
  const unknown = (o, path, known) => { for (const key of Object.keys(o)) if (!known.includes(key))
    add('FIELD_UNKNOWN', path + '/' + key, O11_ONLY.includes(key) ? key + ' exists only in O11 extensions (o11_extension).' : 'Unknown field ' + key + '.', 'Remove ' + key + '; the fields here are: ' + known.join(', ') + '.'); };
  const identifier = (name, path, what) => {
    if (!IDENTIFIER.test(name)) add('IDENTIFIER_INVALID', path, 'The ' + what + ' \'' + name + '\' is not an identifier (letters, digits and _, not starting with a digit).', 'Rename it to ' + suggest(name) + '.');
    else if (KEYWORDS.has(name)) add('IDENTIFIER_INVALID', path, 'The ' + what + ' \'' + name + '\' is a C# keyword.', 'Rename it, e.g. ' + name[0].toUpperCase() + name.slice(1) + 'Value.');
  };
  const listOf = (o, key, path) => { const v = o[key]; if (v === undefined || v === null) return []; if (Array.isArray(v)) return v; add('LIST_EXPECTED', path, key + ' must be a list.', 'Write ' + key + ' as [ ... ].'); return []; };
  const member = (o, path, what, seen) => {
    const name = text(o, 'name');
    if (!name || !name.trim()) { add('NAME_REQUIRED', path + '/name', 'The ' + what + ' needs a name.', 'Set name to an identifier.'); return; }
    identifier(name, path + '/name', what + ' name');
    if (seen.has(name.toLowerCase())) add('DUPLICATE_NAME', path + '/name', 'The ' + what + ' name ' + name + ' is used twice here (names ignore case; inputs and outputs share them).', 'Rename one of them.');
    else seen.add(name.toLowerCase());
  };
  const typeRule = (type, path, declared) => {
    if (typeof type !== 'string' || !type.trim()) { add('TYPE_REQUIRED', path, 'The type is missing.', 'Set type, e.g. Text, Integer or a declared structure.'); return; }
    const t = type.trim();
    const item = t.endsWith(' List') ? t.slice(0, -5).trim() : t;
    if (item.endsWith(' List')) { add('TYPE_UNKNOWN', path, 'Type ' + t + ' is a list of lists, which an External Library cannot declare.', 'Use a structure that holds the inner list.'); return; }
    if (Object.hasOwn(PRIMITIVES, item) || declared.has(item)) return;
    if (item === 'Object') { add('TYPE_NOT_SUPPORTED', path, 'Object exists only in O11 extensions.', 'Use Text, Binary Data or a structure.'); return; }
    const primitive = Object.keys(PRIMITIVES).find(p => ieq(p.replace(/ /g, ''), item.replace(/ /g, '')));
    if (primitive) { add('TYPE_UNKNOWN', path, 'Type ' + item + ' is not an OutSystems type name.', 'Use ' + PRIMITIVES[primitive] + '.'); return; }
    const structure = [...declared].find(s => ieq(s, item));
    if (structure) { add('STRUCTURE_UNDECLARED', path, 'No structure named ' + item + ' is declared (names are case-sensitive here).', 'Use ' + structure + '.'); return; }
    if (IDENTIFIER.test(item)) { add('STRUCTURE_UNDECLARED', path, item + ' is neither an OutSystems type nor a structure declared in structures.', 'Declare structure ' + item + ' in structures, or use one of: ' + [...new Set(Object.values(PRIMITIVES))].join(', ') + '.'); return; }
    add('TYPE_UNKNOWN', path, 'Type ' + t + ' is not an OutSystems type: use the OutSystems names, not C# types.', 'Use Text, Integer, Long Integer, Decimal, Boolean, Date, Date Time, Time, Currency, Email, Phone Number, Binary Data, a structure or "<T> List".');
  };

  unknown(spec, '', ROOT);
  const name = text(spec, 'name');
  if (!name || !name.trim()) add('NAME_REQUIRED', '/name', 'The library needs a name.', 'Set name to an identifier, e.g. "SSAMTextTools".');
  else identifier(name, '/name', 'library name');
  if (spec.namespace !== undefined && spec.namespace !== null && (typeof spec.namespace !== 'string' || !DOTTED.test(spec.namespace) || spec.namespace.split('.').some(s => KEYWORDS.has(s))))
    add('NAMESPACE_INVALID', '/namespace', 'namespace must be dotted identifiers, e.g. Company.Tools.', 'Remove namespace (it defaults to the library name) or use identifiers separated by dots.');

  const structures = listOf(spec, 'structures', '/structures');
  const declared = new Set(structures.filter(s => isObject(s) && typeof s.name === 'string' && IDENTIFIER.test(s.name)).map(s => s.name));
  const structureNames = new Set();
  structures.forEach((s, i) => {
    const path = '/structures/' + i;
    if (!isObject(s)) { add('STRUCTURE_INVALID', path, 'Each structure is an object {name, attributes}.', 'Write {name, attributes:[{name, type}]}.'); return; }
    unknown(s, path, STRUCTURE);
    const sn = text(s, 'name');
    if (!sn || !sn.trim()) add('NAME_REQUIRED', path + '/name', 'The structure needs a name.', 'Set name to an identifier.');
    else {
      identifier(sn, path + '/name', 'structure name');
      if (structureNames.has(sn.toLowerCase())) add('DUPLICATE_NAME', path + '/name', 'Structure ' + sn + ' is declared twice (names ignore case).', 'Rename or remove one of them.');
      else structureNames.add(sn.toLowerCase());
      if (Object.keys(PRIMITIVES).some(p => ieq(p, sn))) add('STRUCTURE_NAME_RESERVED', path + '/name', 'Structure ' + sn + ' has the name of a primitive type.', 'Rename the structure.');
      if (name && (ieq(sn, name) || ieq(sn, 'I' + name))) add('STRUCTURE_NAME_RESERVED', path + '/name', 'Structure ' + sn + ' has the name of the library class or of its interface.', 'Rename the structure.');
    }
    const attributes = listOf(s, 'attributes', path + '/attributes');
    if (!attributes.length) add('ATTRIBUTES_REQUIRED', path + '/attributes', 'Structure ' + (sn ?? '') + ' has no attributes.', 'Add at least one attribute {name, type}.');
    const seen = new Set();
    attributes.forEach((a, j) => {
      const ap = path + '/attributes/' + j;
      if (!isObject(a)) { add('ATTRIBUTE_INVALID', ap, 'Each attribute is an object {name, type}.', 'Write {name, type}.'); return; }
      unknown(a, ap, ATTRIBUTE);
      member(a, ap, 'attribute', seen);
      typeRule(a.type, ap + '/type', declared);
      for (const key of ['length', 'decimals'])
        if (a[key] !== undefined && a[key] !== null && !(Number.isInteger(a[key]) && a[key] >= 0)) add('NUMBER_INVALID', ap + '/' + key, key + ' must be a non-negative integer.', 'Use an integer such as 50, or remove it.');
      if (a.mandatory !== undefined && a.mandatory !== null && typeof a.mandatory !== 'boolean') add('FLAG_INVALID', ap + '/mandatory', 'mandatory must be true or false.', 'Use true or false.');
    });
  });

  const actions = listOf(spec, 'actions', '/actions');
  if ((Array.isArray(spec.actions) && !actions.length) || spec.actions === undefined || spec.actions === null)
    add('ACTIONS_REQUIRED', '/actions', 'The library needs at least one action.', 'Add actions:[{name, inputs, outputs, body}].');
  const actionNames = new Set();
  actions.forEach((a, i) => {
    const path = '/actions/' + i;
    if (!isObject(a)) { add('ACTION_INVALID', path, 'Each action is an object {name, inputs, outputs, body}.', 'Write {name, body}.'); return; }
    unknown(a, path, ACTION);
    const an = text(a, 'name');
    if (!an || !an.trim()) add('NAME_REQUIRED', path + '/name', 'The action needs a name.', 'Set name to an identifier.');
    else {
      identifier(an, path + '/name', 'action name');
      if (actionNames.has(an.toLowerCase())) add('DUPLICATE_NAME', path + '/name', 'Action ' + an + ' is declared twice (names ignore case).', 'Rename or remove one of them.');
      else actionNames.add(an.toLowerCase());
      if (name && ieq(an, name)) add('ACTION_NAME_IS_LIBRARY', path + '/name', 'Action ' + an + ' has the name of the library class (C# refuses a member named like its type).', 'Rename the action.');
    }
    const seen = new Set();
    for (const [key, fields] of [['inputs', INPUT], ['outputs', OUTPUT]])
      listOf(a, key, path + '/' + key).forEach((p, j) => {
        const pp = path + '/' + key + '/' + j;
        if (!isObject(p)) { add('PARAMETER_INVALID', pp, 'Each parameter is an object {name, type}.', 'Write {name, type}.'); return; }
        unknown(p, pp, fields);
        member(p, pp, 'parameter', seen);
        typeRule(p.type, pp + '/type', declared);
      });
    if (typeof a.body !== 'string' || !a.body.trim())
      add('BODY_REQUIRED', path + '/body', 'Action ' + (an ?? '') + ' has no body.', 'Write the C# statements of the action in body, using the declared parameter names (e.g. "Result = new string(Text.Reverse().ToArray());").');
  });

  const packageNames = new Set();
  listOf(spec, 'packages', '/packages').forEach((p, i) => {
    const path = '/packages/' + i;
    if (!isObject(p)) { add('PACKAGE_INVALID', path, 'Each package is an object {name, version}.', 'Write {name, version:"1.2.3"}.'); return; }
    unknown(p, path, PACKAGE);
    const pn = text(p, 'name');
    if (!pn || !pn.trim() || !PACKAGE_ID.test(pn)) add('PACKAGE_NAME_INVALID', path + '/name', 'The package needs its NuGet id.', 'Set name to the NuGet package id.');
    else {
      if (ieq(pn, SDK_PACKAGE)) add('SDK_PACKAGE_PINNED', path + '/name', SDK_PACKAGE + ' is pinned by SSAM.', 'Remove it from packages.');
      if (packageNames.has(pn.toLowerCase())) add('DUPLICATE_NAME', path + '/name', 'Package ' + pn + ' is listed twice.', 'Keep one entry.');
      else packageNames.add(pn.toLowerCase());
    }
    const version = text(p, 'version');
    if (!version || !version.trim()) add('PACKAGE_VERSION_REQUIRED', path + '/version', 'Package ' + (pn ?? '') + ' has no version: the build pins every package to an exact version.', 'Set version to the exact NuGet version, e.g. "13.0.3".');
    else if (!EXACT_VERSION.test(version)) add('PACKAGE_VERSION_INEXACT', path + '/version', 'Version ' + version + ' of ' + (pn ?? '') + ' is not one exact version (ranges and wildcards change the build).', 'Set the exact NuGet version, e.g. "13.0.3".');
  });
  listOf(spec, 'usings', '/usings').forEach((u, i) => {
    if (typeof u !== 'string' || !DOTTED.test(u.trim())) add('USING_INVALID', '/usings/' + i, 'Each using is a namespace name, e.g. System.Text.', 'Write the namespace without the using keyword.');
  });
  return problems;
}
function suggest(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9_]/g, '');
  if (!cleaned) return 'a name such as Value';
  return /^[0-9]/.test(cleaned) ? '_' + cleaned : cleaned;
}

// ---- the tool
export const externalLibraryKernel = ({ root = anvilRoot, env = process.env, execFileFn = execFile } = {}) => {
  return async args => {
    const selection = externalLibrarySelection(root, env);
    if (selection.error) return { stderr: [selection.error] };
    const cli = selection.cli;
    if (!path.isAbsolute(cli)) return { stderr: ['SSAM_ODC_EXTERNAL_LIBRARY_CLI must be an absolute path.'] };
    if (!fs.existsSync(cli)) return { missing: cli };
    return new Promise(resolve => execFileFn('dotnet', [cli, ...args], {
      cwd: root, env: { ...env, ANVIL_LANE: 'odc' }, windowsHide: true,
      timeout: 20 * 60000, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8',
    }, (error, stdout, stderr) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout ?? '').trim()); } catch { /* reported as KERNEL_NO_ANSWER */ }
      resolve({ ok: !error && envelope?.ok === true, envelope,
        stderr: String(stderr ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-10),
        ...(error?.killed ? { timedOut: true } : {}) });
    }));
  };
};
const portalModule = file => import(new URL('../portal/runtime/' + file, import.meta.url).href);

export function createExternalLibraryTool(deps = {}) {
  const now = deps.now ?? (() => new Date());
  const evidenceRoot = deps.evidenceRoot ?? path.join(anvilRoot, '.local', 'lane-odc', 'external-library');
  const kernel = deps.kernel ?? externalLibraryKernel(deps);
  const grantsOf = async () => (deps.grants !== undefined ? deps.grants : await import('./standing-grants.mjs').catch(() => null));
  let access = deps.access ?? null;
  const accessOf = async () => access ??= await (await import('./lib.mjs')).createAccess();

  // The deployer's own writes (upload, publish, the job DELETE of discard) go through the unguarded access: the guard of
  // a destructive call is at the entry of this tool (discard below), never inside the internal steps (CX15).
  async function deployer() {
    const { unguarded } = await portalModule('destructive-preview.mjs');
    const a = unguarded(await accessOf());
    const { ExternalLibraryDeployer } = deps.portalRuntime?.deployer ?? await portalModule('external-library.mjs');
    const uploads = deps.portalRuntime?.uploads ?? await portalModule('external-library-upload.mjs');
    const uploaders = deps.uploaders ?? {
      studio: () => uploads.bridgeUploader({ studio: a.studio, requestFile: json => a.requestFile(json),
        stage: async (file, name) => uploads.stageUpload(await portalTransportDirectory(args => a.studio.call(args), 'uploads'))(file, name) }),
      vault: async host => { try { return uploads.vaultUploader({ bridge: await a.vault.bridge(host) }); } catch { return null; } },
    };
    return new ExternalLibraryDeployer({ access: a, uploaders, sleep: deps.sleep, waits: deps.waits });
  }

  function readSpec(input) {
    if (input.spec !== undefined && input.specFile !== undefined) return { refused: refusal('SPEC_REQUIRED', 'Pass spec or specFile, not both.', { problems: [{ code: 'SPEC_REQUIRED', path: '', message: 'spec and specFile exclude each other.', fix: 'Keep one of them.' }] }) };
    if (input.specFile !== undefined) {
      if (typeof input.specFile !== 'string' || !path.isAbsolute(input.specFile) || !/\.json$/i.test(input.specFile))
        return { refused: refusal('SPEC_REQUIRED', 'specFile is the absolute path of a JSON file.', { problems: [{ code: 'SPEC_FILE_INVALID', path: '/specFile', message: 'specFile must be an absolute .json path.', fix: 'Pass the absolute path, or the spec itself in spec.' }] }) };
      try { return { spec: JSON.parse(fs.readFileSync(input.specFile, 'utf8').replace(/^﻿/, '')) }; }
      catch (error) { return { refused: refusal('SPEC_REQUIRED', 'specFile could not be read as JSON: ' + error.message, { problems: [{ code: 'SPEC_FILE_INVALID', path: '/specFile', message: error.message, fix: 'Write a JSON object {name, actions}.' }] }) }; }
    }
    if (input.spec === undefined) return { refused: refusal('SPEC_REQUIRED', 'Pass the library spec (spec, or specFile).', { problems: [{ code: 'SPEC_REQUIRED', path: '/spec', message: 'No spec.', fix: 'Pass spec {name, actions:[{name, inputs, outputs, body}]}.' }] }) };
    return { spec: input.spec };
  }

  // The words for a deploy: the user's, naming the library, or a standing publish grant of the library.
  async function wordsFor(input, name) {
    // CX15 r7 (M-3): words that are a marker, a <template> or a sha256 of the server are no words, before the approval, the
    // naming rule and the grant (never a grant instead).
    if (typeof input.authorize === 'string' && input.authorize.trim() && !wordsGiven(input.authorize))
      return { problem: { code: 'WORDS_REQUIRED', path: '/authorize', message: 'authorize holds a text of the server (a marker, a <template> or a sha256), never the owner\'s words. Nothing was sent.', fix: 'Ask the owner and pass his literal words, naming ' + (name ?? 'the library') + '.' } };
    if(input.authorizationContext) {
      try {
        const host=await (await accessOf()).pickTenant(input.tenant);
        const context=readApproval(input.authorizationContext,input.authorize,{lane:'odc',host,operation:'external-library:deploy',targets:[name]});
        if(!context)throw Object.assign(new Error('Missing approval.'),{code:'AUTHORIZATION_CONTEXT_INVALID'});
        return {words:input.authorize,userWords:true,authorization:{source:'proposal-context',context}};
      } catch(error) {return {problem:{code:error.code??'AUTHORIZATION_CONTEXT_INVALID',path:'/authorizationContext',message:error.message,fix:'Use the unchanged human-approved proposal for this exact library.'}};}
    }
    if (typeof input.authorize === 'string' && input.authorize.trim()) {
      if (typeof name === 'string' && namesWhole(input.authorize, name)) return { words: input.authorize.trim(), userWords: true, authorization: { source: 'words' } };
      return { problem: { code: 'WORDS_MUST_NAME_LIBRARY', path: '/authorize', message: 'The words do not name the library ' + (name ?? '') + ' as a whole word.', fix: 'Repeat with the user\'s own words that name ' + (name ?? 'the library') + ' (quoted, not a paraphrase).', ssamRule: true } };
    }
    if (typeof name === 'string' && name) {
      let grant = null;
      try { grant = await (await grantsOf())?.findGrant?.({ lane: 'odc', app: name, module: name, verb: 'publish' }); } catch { grant = null; }
      if (grant && wordsGiven(grant.words)) return { words: grant.words, userWords: false, authorization: { source: 'standing-grant', grantId: grant.grantId } };
    }
    return { problem: { code: 'WORDS_MUST_NAME_LIBRARY', path: '/authorize', message: 'A deploy changes the tenant and needs the user\'s own words naming ' + (name ?? 'the library') + ', or a standing publish grant of it.', fix: 'Repeat with authorize: the user\'s words that name ' + (name ?? 'the library') + '; or ask for a standing grant (ssam_grant).', ssamRule: true } };
  }

  async function build(spec) {
    const stamp = now().toISOString().replace(/[-:.]/g, '');
    const dir = uniqueDir(path.join(evidenceRoot, spec.name + '-' + stamp));
    const specFile = path.join(dir, 'spec.json');
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
    const run = await kernel(['external-library', 'build', '--spec', specFile, '--out', path.join(dir, 'build')]);
    if (run?.missing) return refusal('CLI_NOT_BUILT', 'The ODC lane CLI is not built: ' + run.missing, { continuation: { tool: 'ssam_doctor', arguments: { lane: 'odc' }, why: 'the integrator or the user builds the ODC CLI' } });
    const data = run?.envelope?.data;
    if (!data) return refusal('KERNEL_NO_ANSWER', 'The ODC kernel gave no answer to external-library build' + ((run?.stderr ?? []).length ? ': ' + run.stderr.at(-1) : '') + '.', { evidence: dir });
    if (data.ok === false) return { ok: false, code: data.code, error: data.error, problems: data.problems ?? [], evidence: dir, ...(data.log ? { log: data.log } : {}) };
    if (run.ok !== true || run.envelope.ok !== true || data.ok !== true)
      return refusal('KERNEL_BUILD_FAILED', 'The ODC build did not finish successfully.', { evidence: dir, timedOut: run.timedOut === true });
    return { ok: true, evidence: dir, data };
  }

  return async function externalLibrary(input = {}) {
    const action = input.action;
    if (!EXTERNAL_LIBRARY_ACTIONS.includes(action)) return refusal('UNKNOWN_ACTION', 'action is build, deploy, status or discard.');
    const extra = Object.keys(input).filter(k => k !== 'action' && input[k] !== undefined && !FIELDS[action].includes(k));
    if (extra.length) return refusal('UNKNOWN_FIELD', action + ' does not take: ' + extra.join(', '), { problems: extra.map(k => ({ code: 'FIELD_UNKNOWN', path: '/' + k, message: action + ' does not take ' + k + '.', fix: 'The fields of ' + action + ' are: ' + FIELDS[action].join(', ') + '.' })) });

    if (action === 'status') {
      let library = input.library;
      if (!library && (input.spec !== undefined || input.specFile !== undefined)) { const read = readSpec(input); if (read.refused) return read.refused; library = read.spec?.name; }
      if (typeof library !== 'string' || !library) return refusal('LIBRARY_REQUIRED', 'status needs library (the library name) or its spec.');
      return (await deployer()).status({ tenant: input.tenant, auth: input.auth, library });
    }
    // discard deletes an open job: two calls (CX15). Without confirmationToken it previews the job (identity read now,
    // backup plan, token); with it, the token, the owner's reply after the preview (naming the library, with the count)
    // and the operationId of the preview as operationUuid, then the deployer's discard as before.
    if (action === 'discard') {
      if (!input.jobKey && !input.library && !input.confirmationToken)
        return refusal('INPUT_INVALID', 'discard needs jobKey or library.', { problems: [{ code: 'INPUT_INVALID', path: '/jobKey', message: 'discard needs jobKey or library.', fix: 'Pass the jobKey the refusal named.' }] });
      const { destructiveGuard, DESTRUCTIVE_GUARD, unguarded } = await portalModule('destructive-preview.mjs');
      const a = await accessOf();
      const guard = a?.[DESTRUCTIVE_GUARD] ?? destructiveGuard(unguarded(a), deps.destructive ?? {});
      return guard.discard(input, async args => (await deployer()).discard({ tenant: args.tenant, auth: args.auth, jobKey: args.jobKey, library: args.library, authorize: args.authorize,
        operationUuid: args.operationUuid, confirmTenant: args.confirmTenant, authorizationContext: args.authorizationContext, originOperationUuid: args.originOperationUuid }));
    }

    // build and deploy: the spec first, then (deploy) the words and the tenant guard, all before anything runs.
    const read = readSpec(input);
    if (read.refused) return read.refused;
    const spec = read.spec;
    const problems = validateExternalLibrarySpec(spec);
    let authorization = null;
    if (action === 'deploy') {
      const words = await wordsFor(input, text(spec, 'name'));
      if (words.problem) problems.push(words.problem); else authorization = words;
      if (!UUID.test(String(input.operationUuid ?? ''))) problems.push({ code: 'INPUT_INVALID', path: '/operationUuid', message: 'operationUuid must be a new UUID; repeating it continues the same deploy and never resends.', fix: 'Pass a new UUID.' });
    }
    if (problems.length) {
      const codes = [...new Set(problems.map(p => p.code === 'WORDS_MUST_NAME_LIBRARY' || p.code === 'INPUT_INVALID' ? p.code : 'EXTERNAL_LIBRARY_SPEC_INVALID'))];
      return refusal(codes.length === 1 ? codes[0] : 'DEPLOY_REFUSED', problems.length + ' problem(s); nothing was built or sent.', { problems });
    }
    let tenantHost = null;
    if (action === 'deploy') {
      const a = await accessOf();
      try {
        const host = tenantHost = await a.pickTenant(input.tenant);
        const { guardTenant } = deps.portalRuntime?.access ?? await portalModule('access.mjs');
        guardTenant(a.tenantInfo(host), authorization.words, input.confirmTenant,authorization.authorization?.context);
      } catch (error) {
        return refusal(error.code ?? 'INPUT_INVALID', error.message, { sent: false, problems: [{ code: error.code ?? 'INPUT_INVALID', path: '/tenant', message: error.message,
          fix: error.code === 'CORPORATE_TENANT_GUARD' ? 'Repeat with confirmTenant (the tenant host) and the user\'s words that also name the tenant.' : 'Choose a tenant the user may change.' }] });
      }
    }
    const built = await build(spec);
    if (!built.ok) return built;
    const data = built.data;
    if (action === 'build')
      return { ok: true, action: 'build', library: data.name, package: data.package, contents: data.contents, sdk: data.sdk, targetFramework: data.targetFramework, runtime: data.runtime, evidence: built.evidence,
        next: { tool: 'odc_external_library', arguments: { action: 'deploy', specFile: path.join(built.evidence, 'spec.json'), authorize: '<the user\'s words naming ' + data.name + '>', operationUuid: '<new uuid>' }, why: 'deploys the complete spec preserved by this build to the authorized tenant in one call' } };

    const plan = { name: data.name, package: { path: data.package.path, fileName: data.package.fileName, sha256: data.package.sha256, bytes: data.package.bytes }, contents: data.contents };
    // F5 (producer-signatures.mjs): the library is a producer of the apps that reference it; no reference snapshot of it
    // acquired before the end of this deploy is reused. Only a released library ends it; anything else (uncertain, awaiting
    // words, a job left on the tenant) leaves it running for the ledger.
    // The ODC lane's producer cache (kernel-delivery.mjs signatureCache: <ODC root>/.local/producer-cache).
    const signatureCache = deps.signatureCache !== undefined ? deps.signatureCache : path.join(odcRoot, '.local', 'producer-cache');
    const publication = signatureCache ? recordPublished(signatureCache, { environment: tenantHost || '*', module: data.name, source: 'odc_external_library deploy', id: input.operationUuid }) : false;
    const result = await (await deployer()).deploy(plan, { tenant: input.tenant, auth: input.auth ?? 'auto', words: authorization.words, userWords: authorization.userWords,
      operationUuid: input.operationUuid, confirmTenant: input.confirmTenant, releaseTag: input.releaseTag, releaseNotes: input.releaseNotes, authorization: authorization.authorization,
      authorizationContext:input.authorizationContext,originOperationUuid:input.originOperationUuid,expectedRevision:input.expectedRevision });
    // A repeated call that only read its confirmed receipt published nothing now: it ends too.
    if (publication && result?.ok === true && (result.state === 'released' || (result.existingReceipt === true && !publicationOpen(result)))) recordPublicationEnded(publication);
    return finish(result, { input, spec, evidence: built.evidence });
  };

  // The one answer of a deploy: consumers left outdated with their steps, the reference job as the continuation, and
  // the same call as the continuation of an uncertain one (the words are quoted again by the model, never echoed).
  function finish(result, { input, spec, evidence }) {
    const answer = { ...result, action: 'deploy', evidence };
    if (result.ok && result.state === 'released') {
      answer.consumers = (result.consumers ?? []).map(c => ({ ...c, steps: [
        { tool: 'studio_refresh_references', arguments: { module: c.name, producer: spec.name }, why: c.name + ' still runs the previous revision of ' + spec.name + ': refresh its reference in the ODC Studio.' },
        { tool: 'studio_publish', arguments: { manifest: '<the manifest of ' + c.name + ' after the refresh>' }, why: 'publish ' + c.name + ' with the new revision (with the user\'s words, or studio_deliver publish:true).' }] }));
      const job = path.join(evidence, 'reference-' + spec.name + '.json');
      try { fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'reference', producer: spec.name, elements: result.references ?? [] }] }, null, 2)); } catch { /* the answer stands */ }
      answer.referenceJob = job;
      answer.continuation = { tool: 'studio_deliver', arguments: { feature: 'reference-' + spec.name, module: '<ConsumerApp>', job, owners: ['<ConsumerApp>'], changes: ['Reference ' + spec.name] },
        why: 'References the library\'s actions and structures from an app through the existing reference job (the producer is captured from the consumer session).' };
    } else if (result.state === 'uncertain' || result.code === 'CONSUMERS_WOULD_BREAK' && result.state === 'awaiting-words') {
      const { authorize, ...rest } = input;
      answer.continuation ??= { tool: 'odc_external_library', arguments: { ...rest, authorize: result.state === 'awaiting-words' ? '<the user\'s words naming ' + spec.name + ' and ' + (result.consumers ?? []).join(', ') + '>' : '<the user\'s same words>' },
        why: result.state === 'awaiting-words' ? 'The same call with words that also name each consumer publishes the ready job; nothing is uploaded again.' : 'The same call (same operationUuid) reads the exact state of the uncertain step and continues; nothing is resent.' };
    }
    return answer;
  }
}
function uniqueDir(base) {
  for (let i = 0; ; i++) {
    const dir = i ? base + '-' + i : base;
    try { fs.mkdirSync(dir, { recursive: false }); return dir; }
    catch (error) { if (error.code === 'ENOENT') { fs.mkdirSync(path.dirname(dir), { recursive: true }); i--; continue; } if (error.code !== 'EEXIST') throw error; }
  }
}

export function registerExternalLibrary(server, deps = {}) {
  const run = createExternalLibraryTool(deps);
  const wrap = deps.wrap ?? (fn => async args => { const value = await fn(args); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value?.ok === false ? { isError: true } : {}) }; });
  const typeName = z.string().min(1).max(100);
  // Unknown fields pass the schema and come back as FIELD_UNKNOWN problems of the one refusal (validateExternalLibrarySpec).
  const parameter = z.object({ name: z.string(), type: typeName, mandatory: z.boolean().optional(), default: z.union([z.string(), z.number(), z.boolean()]).optional(), description: z.string().max(2000).optional() }).passthrough();
  const spec = z.object({ name: z.string(), description: z.string().max(2000).optional(), namespace: z.string().optional(),
    structures: z.array(z.object({ name: z.string(), description: z.string().max(2000).optional(), attributes: z.array(z.object({ name: z.string(), type: typeName, mandatory: z.boolean().optional(),
      length: z.number().int().optional(), decimals: z.number().int().optional(), default: z.union([z.string(), z.number(), z.boolean()]).optional(), description: z.string().max(2000).optional() }).passthrough()) }).passthrough()).optional(),
    actions: z.array(z.object({ name: z.string(), description: z.string().max(2000).optional(), inputs: z.array(parameter).optional(), outputs: z.array(parameter).optional(), body: z.string().optional() }).passthrough()),
    packages: z.array(z.object({ name: z.string(), version: z.string().optional() }).passthrough()).optional(), usings: z.array(z.string()).optional() }).passthrough()
    .describe('{name, description?, namespace?, structures?:[{name, attributes:[{name, type, mandatory?, length?, decimals?, default?}]}], actions:[{name, inputs?:[{name, type}], outputs?:[{name, type}], body:"<C# statements using the declared names>"}], packages?:[{name, version (exact)}], usings?:[namespace]}. Types: Text, Integer, Long Integer, Decimal, Boolean, Date, Date Time, Time, Currency, Email, Phone Number, Binary Data, a structure, "<T> List".');
  server.registerTool('odc_external_library', {
    title: 'ODC External Library: build, deploy, status, discard',
    description: 'An ODC External Library (C# actions and structures) from a spec, in one call per change. build (no tenant): the net10.0 project with the pinned OutSystems.ExternalLibraries.SDK, dotnet publish and the deterministic zip (the .NET 10 SDK and NuGet access are needed on this machine). deploy: the same build, then in the same call the upload, the generation followed to its end, the publish of the job, the release tag (next patch, or 1.0.0) and the readback of revision, tag and .NET 10 runtime; it refuses before any change with every problem at once (spec, words naming the library, tenant guard, sign-in of both the public API and the Portal planes, a job already open, consumers that would break, a tag already used). The answer lists the consumers left outdated (each must refresh its reference and be published) and the reference job continuation; references go through the existing reference job (studio_deliver). status: the library, its revisions and runtime, consumers and open jobs (reads). discard: deletes an open job, a delete (the words name the library). ' + DESTRUCTIVE_SUFFIX + ' ' + ODC_EXECUTION_UUID + ' ' + OWNED_CLEANUP + ' Credentials are never arguments: the ODC Studio session first, then the vault, then a private prompt. A lost answer is never resent: the same call with the same operationUuid reads the exact state and continues.',
    inputSchema: z.object({
      action: z.enum(EXTERNAL_LIBRARY_ACTIONS),
      spec: spec.optional(),
      specFile: z.string().min(1).optional().describe('Absolute path of a JSON file with the spec, in place of spec.'),
      releaseTag: z.string().regex(/^\d+\.\d+\.\d+$/).optional().describe('deploy: the version tag of the new revision; default the next patch of the highest tag, or 1.0.0.'),
      releaseNotes: z.string().max(2000).optional(),
      authorizationContext:z.string().min(1).optional().describe('deploy: absolute path of the human proposal approval bound to exact package hash, release and own-fixture origin.'),
      originOperationUuid:z.string().uuid().optional().describe('deploy update: confirmed receipt that created this own test library.'),
      expectedRevision:z.number().int().positive().optional().describe('deploy update: unchanged current revision of that own fixture.'),
      library: z.string().min(1).optional().describe('status and discard: the library name.'),
      jobKey: z.string().min(1).optional().describe('discard: the key of the open job (GENERATION_PENDING names it).'),
      tenant: z.string().min(1).optional().describe('Tenant host. Default: the only Studio session, else the configured default.'),
      auth: z.enum(['auto', 'studio', 'api-client']).optional().describe('Default auto: the Studio session for public APIs and authenticated headless HTTP or a compatible private profile for internal Portal. No browser or credential prompt opens. api-client: the stored API Client and compatible Portal profile.'),
      pid: z.number().int().positive().optional().describe('ODC Studio process id; detected when there is exactly one.'),
      authorize: z.string().min(8).optional().describe('deploy and discard: the user\'s own words naming the library (and each consumer a deploy would break), quoted verbatim; only their sha256 is kept. Without them a deploy uses a standing publish grant of the library.'),
      operationUuid: z.string().uuid().optional().describe('deploy and discard: a new UUID per change; repeating it never resends, it reads and continues.'),
      confirmTenant: z.string().optional().describe('Corporate or unknown tenants: the tenant host, as the user\'s explicit instruction.'),
      confirmationToken: z.string().min(1).optional().describe('discard: the token of its preview; without it discard only previews.'),
      ownerRequest: z.string().optional().describe('discard: the owner\'s request as said; only its sha256 is kept.'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, wrap((input, ctx) => withSignal(ctx?.mcpReq?.signal, () => run(input))));
}
