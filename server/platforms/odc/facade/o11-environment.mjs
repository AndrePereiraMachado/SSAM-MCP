// o11_environment: the O11 environment verbs of the Anvil CLI (kernel/src/Anvil.Cli/Program.cs) as one MCP tool.
// Without --credentials every server call runs through the Service Studio already logged in on the lane (SSO
// included), over the bridge's environment_session lease; this tool never passes --credentials, and the reads open a
// read-only lease (--read-only), so a read can never submit a write. `host` only picks among the environments that
// Studio is already logged in to (EnvironmentSessionHandler.Connect); it never logs in anywhere.
// Writes need the user's own words (authorize): only their sha256 reaches <lane.local>/journal/o11_environment.jsonl,
// reserved before the CLI runs and closed with the outcome. The envelope's `ok` is true for most verbs whatever
// happened (update-app answers data.ok=false, create-module/set-user-provider a publish outcome), so ok is decided from
// each verb's own data. A write whose answer is lost (CLI timeout, a bridge transport error after the request) is
// `uncertain` and never repeated here: the continuation is a read (inventory). delete-app is not a CLI verb here: it is
// the Service Center delete engine (one call, answered by state; its own receipts).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { createAnvilRunner } from './anvil-cli.mjs';
import { assertSelectedO11 } from './studio-connect.mjs';

export const ENVIRONMENT_READS = ['inventory', 'download', 'download-app', 'templates', 'references', 'referenceable'];
export const ENVIRONMENT_WRITES = ['create-app', 'add-modules', 'create-module', 'update-app', 'refresh-refs', 'set-user-provider', 'delete-app'];
const ACTIONS = [...ENVIRONMENT_READS, ...ENVIRONMENT_WRITES];
const MODULE_KINDS = ['Reactive', 'Service', 'Library', 'Traditional', 'Mobile'];   // ModuleSpec / AppFactory.ParseKind
// blank (A16): only Service and Library modules may be created blank. A blank UI module has no theme, no layouts and no
// LayoutBlank/Content placeholder (session of 06/10: three DELIVERY_FAILED of LayoutBlank, then delete and recreate).
export const BLANK_UI_KINDS = ['Reactive', 'Traditional', 'Mobile'];
// Per action: required and optional fields (Program.cs options). Writes also take `authorize`; reads never do.
const FIELDS = {
  inventory: { required: [], optional: ['host', 'filter'] },
  download: { required: ['module'], optional: ['version', 'host', 'out'] },
  'download-app': { required: ['apps'], optional: ['host', 'out'] },
  templates: { required: [], optional: ['host'] },
  referenceable: { required: [], optional: ['host', 'filter'] },
  references: { required: ['oml'], optional: [] },
  'create-app': { required: ['name', 'modules'], optional: ['kind', 'templateKey', 'template', 'color', 'blank', 'host'] },
  'add-modules': { required: ['app', 'modules'], optional: ['templateKey', 'blank', 'host'] },
  'create-module': { required: ['app', 'name'], optional: ['replace', 'templateKey', 'description', 'noPublish', 'host'] },
  'update-app': { required: ['name'], optional: ['color', 'description', 'host'] },
  'refresh-refs': { required: ['module'], optional: ['all', 'publish', 'host'] },
  'set-user-provider': { required: ['module'], optional: ['providerName', 'providerKey', 'host'] },
  'delete-app': { required: ['app'], optional: ['host'] },
};
const LIST_CAP = 100;
const TIMEOUTS = { read: 600000, 'download-app': 1800000, write: 1800000 };
// Bridge transport failures (BridgeClient: IOException "execution outcome may be unknown", socket and read timeouts).
const LOST_ANSWER = /outcome may be unknown|\b(?:IOException|SocketException|TimeoutException)\b|timed out/i;

const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const isWrite = action => ENVIRONMENT_WRITES.includes(action);
// Kernel records serialize PascalCase and anonymous objects camelCase; read either.
const get = (obj, name) => {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.hasOwn(obj, name)) return obj[name];
  const key = Object.keys(obj).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : obj[key];
};
const firstLine = text => String(text ?? '').split(/\r?\n/)[0].slice(0, 500);
const capped = (list, cap = LIST_CAP) => (list.length > cap ? { items: list.slice(0, cap), more: list.length - cap } : { items: list });
const publishOk = publish => get(publish, 'Started') === true && get(publish, 'Completed') === true && get(publish, 'HasErrors') !== true;
const publishErrors = publish => (get(publish, 'Messages') ?? []).filter(m => /error/i.test(String(get(m, 'Type') ?? '')))
  .slice(0, 5).map(m => firstLine(get(m, 'Message')));
const validationSample = validation => (get(validation, 'Sample') ?? []).slice(0, 5).map(firstLine);

const refusal = (code, error, continuation, extra = {}) => ({ ok: false, code, error, ...extra, continuation });
const inventoryRead = (host, why) => ({ tool: 'o11_environment', arguments: { action: 'inventory', ...(host ? { host } : {}) }, why });
const withoutKeys = (input, keys) => Object.fromEntries(Object.entries(input).filter(([k]) => !keys.includes(k)));

// ---- validation: unknown fields per action, required fields, the words, and values that could act as flags --------
export function validateEnvironmentInput(input) {
  const { action } = input;
  const spec = FIELDS[action];
  if (!spec) return refusal('UNKNOWN_ACTION', 'Unknown action ' + action, { tool: 'o11_environment', arguments: { action: 'inventory' }, why: 'actions: ' + ACTIONS.join(', ') });
  const allowed = new Set(['action', ...spec.required, ...spec.optional, ...(isWrite(action) ? ['authorize'] : [])]);
  const unknown = Object.keys(input).filter(k => input[k] !== undefined && !allowed.has(k));
  if (unknown.length) return refusal('UNKNOWN_FIELD', `${action} does not take: ${unknown.join(', ')}`,
    { tool: 'o11_environment', arguments: withoutKeys(input, unknown), why: `fields of ${action}: ${[...allowed].filter(k => k !== 'action').join(', ') || '(none)'}` },
    unknown.includes('authorize') ? { note: 'reads take no authorization words' } : {});
  const missing = spec.required.filter(k => input[k] === undefined || (Array.isArray(input[k]) && input[k].length === 0));
  if (missing.length) return refusal('MISSING_FIELD', `${action} needs: ${missing.join(', ')}`,
    { tool: 'o11_environment', arguments: { ...input, ...Object.fromEntries(missing.map(k => [k, '<' + k + '>'])) }, why: 'fill the missing fields' });
  // The CLI reads options by position (Opt) and switches by presence (Array.IndexOf): a value equal to a flag such as
  // --publish, --replace or --confirm would switch it on. No value may start with "--".
  const strings = Object.entries(input).flatMap(([k, v]) => (k === 'authorize' || k === 'action' ? [] : typeof v === 'string' ? [[k, v]]
    : Array.isArray(v) ? v.flatMap(item => (typeof item === 'string' ? [[k, item]] : Object.entries(item ?? {}).filter(([, s]) => typeof s === 'string').map(([, s]) => [k, s]))) : []));
  const flagLike = strings.find(([, v]) => v.trim().startsWith('--') || !v.trim());
  if (flagLike) return refusal('BAD_VALUE', `${flagLike[0]}: empty values and values starting with "--" are refused`,
    { tool: 'o11_environment', arguments: withoutKeys(input, [flagLike[0]]), why: 'give the plain name' });
  for (const key of ['oml', 'out']) if (input[key] !== undefined && !path.isAbsolute(input[key]))
    return refusal('PATH_NOT_ABSOLUTE', `${key} must be an absolute path`, { tool: 'o11_environment', arguments: withoutKeys(input, [key]), why: 'absolute path' });
  if (action === 'references' && !fs.existsSync(input.oml))
    return refusal('FILE_NOT_FOUND', 'oml not found: ' + input.oml, { tool: 'o11_environment', arguments: { action: 'download', module: '<module>' }, why: 'download the module first' });
  if (input.apps?.some(a => a.includes(',')))
    return refusal('BAD_VALUE', 'apps: an application name with a comma cannot be passed to --app', { tool: 'o11_environment', arguments: { action: 'inventory' }, why: 'use the application key' });
  if (action === 'create-module' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.name))
    return refusal('BAD_VALUE', 'name: module names are letters, digits and _ (not starting with a digit)', { tool: 'o11_environment', arguments: withoutKeys(input, ['name']), why: 'valid module name' });
  if (action === 'update-app' && input.color === undefined && input.description === undefined)
    return refusal('NOTHING_TO_CHANGE', 'update-app needs color or description', { tool: 'o11_environment', arguments: { ...input, color: '<#RRGGBB>' }, why: 'say what changes' });
  // A16: blank is for Service and Library modules only (AppFactory refuses the same in the kernel).
  if ((action === 'create-app' || action === 'add-modules') && input.blank === true) {
    const ui = (input.modules ?? []).filter(m => BLANK_UI_KINDS.includes(m?.kind));
    if (ui.length) return refusal('BLANK_UI_MODULE',
      `blank creates only Service and Library modules; ${ui.map(m => `${m.name} (${m.kind})`).join(', ')} would be created without theme, layouts, LayoutBlank and its Content placeholder`,
      { tool: 'o11_environment', arguments: withoutKeys(input, ['blank']), why: 'omit blank: UI modules come from the application template' },
      { fix: 'omit blank', modules: ui.map(m => m.name) });
  }
  if (isWrite(action)) {
    if (typeof input.authorize !== 'string' || !input.authorize.trim())
      return refusal('WORDS_REQUIRED', `${action} changes the environment and needs the user's own words (authorize)`,
        { tool: 'o11_environment', arguments: { ...input, authorize: "<the user's literal words>" }, why: 'ask the user; never write the words yourself' });
    // delete-app: the words are checked by the Service Center delete engine, against the app and every consumer.
  }
  return null;
}

// ---- argv: exactly what Program.cs reads, in a fixed order; never --credentials ----------------------------------
const opt = (args, name, value) => { if (value !== undefined) args.push(name, String(value)); return args; };
const on = (args, name, value) => { if (value === true) args.push(name); return args; };
const specs = modules => modules.map(m => m.name + ':' + m.kind).join(',');

// K1-c (atritos 3): download takes the lane's published-OML cache (<lane.local>/environment/published/<moduleKey>/<versionId>.oml):
// the CLI resolves the version first (the requested one, else the published one) and downloads a version only once; the
// file always lands in the call's own folder, copied from the cache.
export const publishedCache = local => path.join(local, 'environment', 'published');
export function environmentArguments(input, { out, work, cache } = {}) {
  const i = input; const host = args => opt(args, '--host', i.host);
  switch (i.action) {
    case 'inventory': return [...host(['inventory', '--out', out]), '--read-only'];
    case 'download': return [...host(opt(opt(['download', '--module', i.module, '--out', out], '--version', i.version), '--cache', cache)), '--read-only'];
    case 'download-app': return [...host(['download-app', '--app', i.apps.join(','), '--out', out]), '--read-only'];
    case 'templates': return [...host(['templates']), '--read-only'];
    case 'referenceable': return [...host(['referenceable']), '--read-only'];
    case 'references': return ['references', '--oml', i.oml, '--work', work];
    case 'create-app': {
      const args = ['create-app', '--name', i.name, '--modules', specs(i.modules), '--out', out];
      opt(args, '--kind', i.kind); opt(args, '--template-key', i.templateKey); opt(args, '--template', i.template);
      opt(args, '--color', i.color); on(args, '--blank', i.blank); return host(args);
    }
    case 'add-modules': return host(on(opt(['add-modules', '--app', i.app, '--modules', specs(i.modules), '--out', out], '--template-key', i.templateKey), '--blank', i.blank));
    case 'create-module': {
      const args = on(['create-module', '--app', i.app, '--name', i.name, '--out', out], '--replace', i.replace);
      opt(args, '--template-key', i.templateKey); opt(args, '--description', i.description); on(args, '--no-publish', i.noPublish);
      return host(args);
    }
    case 'update-app': return host(opt(opt(['update-app', '--name', i.name], '--color', i.color), '--description', i.description));
    case 'refresh-refs': return host(on(on(['refresh-refs', '--module', i.module, '--out', out], '--all', i.all), '--publish', i.publish));
    case 'set-user-provider': return host(opt(opt(['set-user-provider', '--module', i.module, '--out', out], '--provider-name', i.providerName), '--provider-key', i.providerKey));
    // delete-app never reaches the CLI (its delete-app --confirm is a lab tool): it is the Service Center delete engine.
    default: throw new Error('Unknown action ' + i.action);
  }
}

const target = i => ({ 'create-app': i.name, 'add-modules': i.app, 'create-module': i.app + '/' + i.name, 'update-app': i.name,
  'refresh-refs': i.module, 'set-user-provider': i.module, 'delete-app': i.app })[i.action];
const needsFolder = action => !['templates', 'update-app', 'delete-app'].includes(action);

// ---- answers: short (paths, names, keys); ok from each verb's data -------------------------------------------------
function shapeRead(i, data, { out }) {
  switch (i.action) {
    case 'inventory': {
      const match = item => !i.filter || String(get(item, 'Name') ?? '').toLowerCase().includes(i.filter.toLowerCase());
      const apps = (get(data, 'applications') ?? []).filter(match).map(a => ({ name: get(a, 'Name'), key: get(a, 'Key') }));
      const modules = get(data, 'modules') ?? [];
      const listed = capped(apps);
      return { ok: true, host: get(data, 'host'), file: path.join(out, 'inventory.json'), applications: (get(data, 'applications') ?? []).length,
        modules: modules.length, apps: listed.items, ...(listed.more ? { moreApps: listed.more } : {}),
        ...(i.filter ? { matchingModules: capped(modules.filter(match).map(m => ({ name: get(m, 'Name'), key: get(m, 'Key'), app: get(m, 'ApplicationName') }))).items } : {}) };
    }
    case 'download': {
      const status = String(get(data, 'Status') ?? '');
      return status === 'ok' ? { ok: true, file: get(data, 'FilePath'), module: get(data, 'Name'), key: get(data, 'Key'), versionId: get(data, 'VersionId'),
        cached: get(data, 'Cached') === true }
        : refusal('DOWNLOAD_FAILED', firstLine(status) || 'download failed', inventoryRead(i.host, 'check the module name and its published versions'), { module: get(data, 'Name') ?? i.module });
    }
    case 'download-app': {
      const results = get(data, 'results') ?? [];
      const status = r => String(get(r, 'Status') ?? '');
      const files = results.filter(r => status(r) === 'ok').map(r => get(r, 'FilePath'));
      const skipped = results.filter(r => status(r).startsWith('skipped')).map(r => get(r, 'Name'));
      const failed = results.filter(r => status(r) !== 'ok' && !status(r).startsWith('skipped')).map(r => ({ module: get(r, 'Name'), status: firstLine(status(r)) }));
      const value = { folder: out, files, ...(skipped.length ? { skipped } : {}), ...(failed.length ? { failed } : {}) };
      return failed.length || !files.length ? refusal('DOWNLOAD_FAILED', failed.length ? `${failed.length} module(s) not downloaded` : 'no module downloaded',
        inventoryRead(i.host, 'check the application names'), value) : { ok: true, ...value };
    }
    case 'templates':
      return { ok: true, templates: (Array.isArray(data) ? data : []).map(t => ({ key: get(t, 'Key'), label: get(t, 'Label'), kind: get(t, 'ApplicationKind') })) };
    case 'referenceable': {
      const all = Array.isArray(data) ? data : [];
      const file = path.join(out, 'referenceable.json');
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
      const match = r => !i.filter || String(get(r, 'Name') ?? '').toLowerCase().includes(i.filter.toLowerCase());
      const listed = capped(all.filter(match).map(r => ({ name: get(r, 'Name'), key: get(r, 'Key'), kind: get(r, 'Kind') })));
      return { ok: true, count: all.length, file, producers: listed.items, ...(listed.more ? { more: listed.more } : {}) };
    }
    case 'references':
      return { ok: true, references: (Array.isArray(data) ? data : []).map(r => ({ name: get(r, 'Name'), key: get(r, 'Key'), kind: get(r, 'Kind'), elements: get(r, 'Elements') })) };
    default: throw new Error('Unknown read ' + i.action);
  }
}

// The publication of refresh-refs {publish:true} (Astra item 3, 2026-10-05: o11_studio publish-log kept showing the
// previous publication after refresh-refs answered published:true). Channel: the CLI downloads the published module,
// refreshes its references headless and publishes it through the environment session (ReferenceRefresher.RefreshModule ->
// Publisher.Publish, Start1CP + CheckPublish, commit "SSHeadless: refresh references"); the Service Studio's 1-Click
// Publish tab, the only source of o11_studio publish-log, never sees it, and the copy open in the Studio stays on the
// version it was opened at. The answer carries what correlates it: the server's VersionId (the module version in Service
// Center), the time the CLI returned and the operationId of this tool's journal line.
export const REFRESH_COMMIT = 'SSHeadless: refresh references';
function refreshPublication(i, data, { operationId, at }) {
  const publish = get(data, 'Publish');
  const moduleKey = get(data, 'ModuleKey');
  return { channel: 'environment-session', version: get(publish, 'VersionId') ?? null, espaceId: get(publish, 'ESpaceId') ?? null,
    at: at ?? null, operationId: operationId ?? null, comment: REFRESH_COMMIT, durationMs: get(publish, 'TotalMs') ?? null,
    note: 'published by the server through the environment session, not by the Service Studio tab: o11_studio publish-log does not show it, and the module open in the Studio stays on the version it was opened at (open it again before changing it there)',
    versions: { tool: 'o11_service_center_read', arguments: { action: 'versions', ...(moduleKey ? { moduleKey } : { module: get(data, 'ModuleName') ?? i.module }), ...(i.host ? { host: i.host } : {}) },
      why: 'the module versions in Service Center: this publication is the version above, with its comment' } };
}

// A16 receipt: per module, the template it came from (its key, or "blank") and whether the saved module has LayoutBlank and
// its Content placeholder (AppFactory: ModuleCreationOutcome.Template, LayoutBlank, Content). Absent when the CLI predates it.
function moduleTemplates(modules) {
  const rows = modules.filter(m => get(m, 'Template') !== undefined && get(m, 'Template') !== null)
    .map(m => ({ module: get(m, 'Name'), template: get(m, 'Template'), layoutBlank: get(m, 'LayoutBlank') === true, content: get(m, 'Content') === true }));
  return rows.length ? { templates: rows } : {};
}

function shapeWrite(i, data, { out, operationId, at }) {
  const failed = (code, error, extra = {}) => refusal(code, error, inventoryRead(i.host, 'read the environment before any new attempt; partial changes are possible'), { outcome: 'failed', ...extra });
  const moduleFailures = modules => modules.filter(m => get(m, 'Succeeded') !== true).map(m => ({ name: get(m, 'Name'),
    error: firstLine(get(m, 'Error')) || undefined, validation: get(m, 'IsValid') === false ? validationSample(get(m, 'Validation')) : undefined,
    publishErrors: get(m, 'Publish') ? publishErrors(get(m, 'Publish')) : undefined }));
  switch (i.action) {
    case 'create-app': {
      const modules = get(data, 'Modules') ?? [];
      const templates = moduleTemplates(modules);
      if (get(data, 'Succeeded') === true)
        return { ok: true, app: get(data, 'ApplicationName'), key: get(data, 'ApplicationKey'), modules: modules.map(m => ({ name: get(m, 'Name'), key: get(m, 'Key') })), ...templates };
      return failed('CREATE_APP_FAILED', get(data, 'ApplicationOk') === false ? firstLine(get(data, 'ApplicationMessage')) || 'application not saved' : 'module creation failed',
        { app: get(data, 'ApplicationName') ?? i.name, key: get(data, 'ApplicationKey'), modules: moduleFailures(modules), ...templates });
    }
    case 'add-modules': {
      const modules = get(data, 'modules') ?? [];
      const templates = moduleTemplates(modules);
      if (get(data, 'succeeded') === true)
        return { ok: true, app: get(get(data, 'application'), 'Name') ?? i.app, modules: modules.map(m => ({ name: get(m, 'Name'), key: get(m, 'Key'), ...(get(m, 'Skipped') ? { existed: true } : {}) })), ...templates };
      return failed('ADD_MODULES_FAILED', 'module creation failed', { app: i.app, modules: moduleFailures(modules), ...templates });
    }
    case 'create-module': {
      const valid = get(data, 'IsValid') === true;
      const published = valid && !i.noPublish && publishOk(get(data, 'Publish'));
      if (valid && (i.noPublish || published))
        return { ok: true, module: get(data, 'ModuleName'), key: get(data, 'ModuleKey'), ...(i.noPublish ? { file: get(data, 'OmlPath') } : {}) };
      return failed('CREATE_MODULE_FAILED', valid ? 'publish failed' : 'the new module is not valid; nothing was published',
        { module: get(data, 'ModuleName') ?? i.name, ...(valid ? { publishErrors: publishErrors(get(data, 'Publish')) } : { validation: validationSample(get(data, 'Validation')) }) });
    }
    case 'update-app':
      return get(data, 'ok') === true ? { ok: true, result: 'feito' } : failed('UPDATE_APP_FAILED', firstLine(get(data, 'message')) || 'application not updated', { app: i.name });
    case 'refresh-refs': {
      const applied = get(data, 'RefreshApplied') === true;
      const before = get(data, 'Before') ?? [];
      const refreshed = applied ? before.filter(b => get(b, 'InCatalog') === true && (i.all === true || get(b, 'Stale') === true)).map(b => get(b, 'Name')) : [];
      const stillStale = (get(data, 'After') ?? []).filter(a => get(a, 'Stale') === true).map(a => get(a, 'Name'));
      if (!applied) return { ok: true, result: 'nada a atualizar' };
      const after = get(data, 'ValidationAfter');
      const validation = after ? { total: get(after, 'Total') ?? 0, byType: get(after, 'ByType') ?? {}, sample: (get(after, 'Sample') ?? []).slice(0, 5).map(firstLine) } : undefined;
      if (i.publish === true && !publishOk(get(data, 'Publish')))
        return failed('REFRESH_PUBLISH_FAILED', 'references refreshed but the publish failed', { module: get(data, 'ModuleName') ?? i.module, publishErrors: publishErrors(get(data, 'Publish')), file: get(data, 'SavedOmlPath'),
          ...(operationId ? { operationId } : {}) });
      return { ok: true, module: get(data, 'ModuleName'), refreshed, ...(stillStale.length ? { stillStale } : {}), ...(validation ? { validation } : {}),
        ...(i.publish === true ? { published: true, publication: refreshPublication(i, data, { operationId, at }) } : { file: get(data, 'SavedOmlPath') }) };
    }
    case 'set-user-provider': {
      const valid = get(data, 'IsValid') === true;
      if (valid && publishOk(get(data, 'Publish'))) return { ok: true, result: 'feito' };
      return failed('SET_USER_PROVIDER_FAILED', valid ? 'publish failed' : 'the changed module is not valid',
        { module: get(data, 'ModuleName') ?? i.module, ...(valid ? { publishErrors: publishErrors(get(data, 'Publish')) } : { validation: validationSample(get(data, 'Validation')) }) });
    }
    default: throw new Error('Unknown write ' + i.action);
  }
}

function interpret(i, run, context) {
  const envelope = run.envelope;
  if (isWrite(i.action)) {
    const lost = run.timedOut || !envelope || (envelope.ok === false && envelope.data === undefined && LOST_ANSWER.test(String(envelope.error ?? '')));
    if (lost) return { ok: false, code: 'UNCERTAIN', outcome: 'uncertain',
      error: `${i.action} was sent but its answer was lost; it may have been applied. Not repeated.`,
      continuation: inventoryRead(i.host, 'read the environment to see whether it was applied; never repeat before that') };
  }
  if (!envelope) return refusal(run.timedOut ? 'TIMEOUT' : 'CLI_FAILED', firstLine((run.stderr ?? []).at(-1) ?? 'the CLI gave no answer'),
    { tool: 'o11_environment', arguments: withoutKeys(i, ['authorize']), why: 'a read can be repeated' });
  // The kernel's own refusal before any change (AppFactory.RefuseBlankUi): the same answer as the check above.
  if (envelope.ok === false && envelope.code === 'BLANK_UI_MODULE')
    return refusal('BLANK_UI_MODULE', firstLine(envelope.error), { tool: 'o11_environment', arguments: withoutKeys(i, ['blank']), why: 'omit blank: UI modules come from the application template' },
      { fix: 'omit blank', outcome: 'refused' });
  if (envelope.ok === false && envelope.data === undefined)
    return refusal('CLI_REFUSED', firstLine(envelope.error), isWrite(i.action)
      ? inventoryRead(i.host, 'read the environment before any new attempt') : { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'check the O11 lane and its Studio' },
      isWrite(i.action) ? { outcome: 'failed' } : {});
  return isWrite(i.action) ? shapeWrite(i, envelope.data, context) : shapeRead(i, envelope.data, context);
}

function uniqueFolder(base, stamp) {
  let dir = path.join(base, stamp);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(base, stamp + '-' + n);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const timeStamp = date => date.toISOString().replace(/[-:.]/g, '');

// I7 (contract PACOTE-ATRITOS-2): the published OML of one module, the same CLI call and answer as o11_environment
// {action:"download"} (environmentArguments, shapeRead), in the same folder <lane.local>/environment/download/<time>
// (JobSources accepts it as a producer). For callers that read a module without opening it in the Studio (ssam_map of
// Users, OutSystemsUI, System or a closed module). Never writes the Studio and never takes the Studio write lock.
export async function downloadModule({ module, host, version } = {},
  { root = anvilRoot, lane = o11Lane.lane, env = process.env, runAnvil, assertSelected, now } = {}) {
  const input = { action: 'download', module, ...(version !== undefined ? { version } : {}), ...(host !== undefined ? { host } : {}) };
  if (typeof module !== 'string' || !module.trim())
    return refusal('MISSING_FIELD', 'download needs: module', { tool: 'o11_environment', arguments: { action: 'download', module: '<module>' }, why: 'name the module' });
  if (version !== undefined && !(Number.isInteger(version) && version > 0))
    return refusal('BAD_VALUE', 'version: the server versionId is a positive integer', { tool: 'o11_environment', arguments: withoutKeys(input, ['version']), why: 'the published version' });
  const refused = validateEnvironmentInput(input);
  if (refused) return refused;
  const laneInfo = o11LaneOf(lane, { root, env });
  if (!fs.existsSync(laneInfo.cli)) return refusal('CLI_NOT_BUILT', 'The O11 Anvil CLI is not built for this lane', { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'the doctor reports the CLI build of each lane' });
  try { await (assertSelected ?? assertSelectedO11)(); }
  catch { return refusal('STUDIO_NOT_SELECTED', 'The selected Service Studio is not connected (or was restarted); nothing was sent', { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'see which Studio is open and connected on the O11 lane' }); }
  const folder = uniqueFolder(path.join(laneInfo.local, 'environment', 'download'), timeStamp((now ?? (() => new Date()))()));
  const run = await (runAnvil ?? createAnvilRunner({ lane, root, env }))(environmentArguments(input, { out: folder, cache: publishedCache(laneInfo.local) }),
    { timeoutMs: TIMEOUTS.read, cwd: root });
  const value = interpret(input, run, { out: folder });
  return value.ok ? { ...value, folder } : value;
}

export function registerO11Environment(server, deps = {}) {
  const root = deps.root ?? anvilRoot;
  const laneName = deps.lane ?? o11Lane.lane;
  const env = deps.env ?? process.env;
  const runAnvil = deps.runAnvil ?? createAnvilRunner({ lane: laneName, root, env });
  const assertSelected = deps.assertSelected ?? assertSelectedO11;
  const now = deps.now ?? (() => new Date());
  const uuid = deps.uuid ?? randomUUID;
  const lane = () => o11LaneOf(laneName, { root, env });
  const journalFile = () => path.join(lane().local, 'journal', 'o11_environment.jsonl');
  const journal = entry => {
    fs.mkdirSync(path.dirname(journalFile()), { recursive: true });
    fs.appendFileSync(journalFile(), JSON.stringify({ at: now().toISOString(), tool: 'o11_environment', ...entry }) + '\n');
  };
  // delete-app is a thin route to the Service Center delete engine (service-center/delete.mjs), the same call as
  // o11_service_center_write delete: the server's simulation and the consumers first, the words naming the app and
  // every consumer, one DeleteApplication and the wait until it is gone. deps.serviceCenter(argv) and deps.studioHosts()
  // replace the engine and the Studio's signed-in hosts in tests.
  const serviceCenter = deps.serviceCenter ?? (async argv => (await import('./service-center/index.mjs')).runServiceCenter(argv, deps.serviceCenterDeps ?? {}));
  const studioHosts = deps.studioHosts ?? (async () => {
    const { locateStudioBridge } = await import('./service-center/bridge.mjs');
    const bridge = await locateStudioBridge({ root, env });
    return bridge && await bridge.supports() ? bridge.signedInHosts() : [];
  });
  async function deleteApp(input) {
    let host = input.host;
    if (!host) {
      let hosts = [];
      try { hosts = await studioHosts(); } catch { hosts = []; }
      if (hosts.length !== 1)
        return refusal('HOST_REQUIRED', hosts.length ? `the Studio is logged in to ${hosts.length} environments; delete-app needs host` : 'delete-app needs host (no environment of the connected Studio was found)',
          { tool: 'o11_environment', arguments: { action: 'delete-app', app: input.app, host: hosts.length ? '<one of signedInHosts>' : '<env-host>', authorize: "<the user's words naming the app>" }, why: 'say which environment' },
          hosts.length ? { signedInHosts: hosts } : {});
      host = hosts[0];
    }
    const value = await serviceCenter(['delete', '--host=' + host, '--target=application:' + input.app, '--words=' + input.authorize]);
    const { auth, ...answer } = value ?? {};
    if (answer.ok) return { ...answer, result: 'feito' };
    // The next call is this same tool: the engine's repeat names the words it needs (and the operationId of an uncertain one).
    const repeat = answer.repeat;
    return { ...answer, ok: false, ...(repeat ? { continuation: { tool: 'o11_environment', arguments: { action: 'delete-app', app: input.app, host,
      authorize: repeat.words }, why: answer.state === 'uncertain' ? 'the same call reads the state and never sends blind' : 'fix every item of problems, then the same call' } } : {}) };
  }

  async function environment(input) {
    const refused = validateEnvironmentInput(input);
    if (refused) return refused;
    if (input.action === 'delete-app') return deleteApp(input);
    const cli = lane().cli;
    if (!fs.existsSync(cli)) return refusal('CLI_NOT_BUILT', 'The O11 Anvil CLI is not built for this lane', { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'the doctor reports the CLI build of each lane' });
    if (input.action !== 'references') {
      try { await assertSelected(); }
      catch { return refusal('STUDIO_NOT_SELECTED', 'The selected Service Studio is not connected (or was restarted); nothing was sent', { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'see which Studio is open and connected on the O11 lane' }); }
    }
    const stamp = now().toISOString().replace(/[-:.]/g, '');
    let folder = null;
    if (input.out) fs.mkdirSync(folder = input.out, { recursive: true });
    else if (needsFolder(input.action)) folder = uniqueFolder(path.join(lane().local, 'environment', input.action), stamp);
    const context = { out: folder, work: folder && path.join(folder, 'work'), ...(input.action === 'download' ? { cache: publishedCache(lane().local) } : {}) };
    const argv = environmentArguments(input, context);
    const timeoutMs = deps.timeoutMs ?? (isWrite(input.action) ? TIMEOUTS.write : TIMEOUTS[input.action] ?? TIMEOUTS.read);
    if (!isWrite(input.action)) return interpret(input, await runAnvil(argv, { timeoutMs, cwd: root }), context);

    const operationId = uuid();
    const record = { action: input.action, target: target(input), operationId, wordsSha256: sha256(input.authorize) };
    journal({ ...record, phase: 'reserved' });
    let value;
    try { const run = await runAnvil(argv, { timeoutMs, cwd: root }); value = interpret(input, run, { ...context, operationId, at: now().toISOString() }); }
    catch (error) { value = { ok: false, code: 'UNCERTAIN', outcome: 'uncertain', error: firstLine(error.message), continuation: inventoryRead(input.host, 'read the environment to see whether it was applied; never repeat before that') }; }
    // A publication of the call keeps its server version on the journal line of the same operationId.
    journal({ ...record, phase: 'result', outcome: value.ok ? 'ok' : value.outcome ?? 'failed', ...(value.code ? { code: value.code } : {}),
      ...(value.publication?.version != null ? { publishedVersion: value.publication.version, publishedAt: value.publication.at } : {}) });
    return value;
  }

  const text = description => z.string().min(1).describe(description);
  const moduleSpec = z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).describe('Module name'), kind: z.enum(MODULE_KINDS) }).strict();
  server.registerTool('o11_environment', {
    title: 'O11 environment: inventory, downloads, applications and modules',
    description: 'The O11 environment through the Service Studio already logged in on the O11 lane (SSO included); never a credential. '
      + 'Reads (no words): inventory {filter?} (applications and modules; full list in inventory.json), download {module, version?} '
      + '(OML of the published version, or versionId; each version is downloaded once, cached:true reuses it), download-app {apps}, templates, referenceable {filter?} (producers), '
      + 'references {oml} (offline: what an OML consumes). Writes need authorize = the user\'s literal words (only their sha256 is '
      + 'journaled): create-app {name, modules:[{name, kind}], kind?, templateKey?, template?, color?, blank?} (blank: Service/Library only; '
      + 'the answer lists templates [{module, template, layoutBlank, content}]), add-modules '
      + '{app, modules, templateKey?, blank?}, create-module {app, name, replace?, templateKey?, description?, noPublish?}, '
      + 'update-app {name, color?, description?}, refresh-refs {module, all?, publish?} (validation after the refresh; publish goes '
      + 'through the environment session, not the Studio tab: publication {version, at, operationId} is a Service Center module '
      + 'version, never in o11_studio publish-log), set-user-provider {module, providerName?, '
      + 'providerKey?}, delete-app {app} (the Service Center delete in one call: the server\'s simulation and the consumers first; the '
      + 'words name the application and every consumer outside it; DELETE_REFUSED lists every problem). host picks among the '
      + 'environments the Studio is logged in to. Files go to <lane>/environment/<action>/<time> unless out is given. An uncertain '
      + 'write is never repeated: read inventory first.',
    inputSchema: z.object({
      action: z.enum(ACTIONS),
      module: text('Module name or key (download, refresh-refs, set-user-provider)').optional(),
      version: z.number().int().positive().describe('download: server versionId of that module (default: the published one)').optional(),
      apps: z.array(z.string().min(1)).min(1).describe('download-app: application names or keys').optional(),
      name: text('create-app/update-app: application name; create-module: module name').optional(),
      modules: z.array(moduleSpec).min(1).describe('create-app/add-modules: the modules to create').optional(),
      kind: z.enum(MODULE_KINDS).describe('create-app: application kind (default Reactive)').optional(),
      templateKey: text('Application template key (see templates)').optional(),
      template: text('create-app: preferred template label').optional(),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).describe('Primary color #RRGGBB').optional(),
      blank: z.boolean().describe('Blank Service/Library modules; UI modules always come from the application template (BLANK_UI_MODULE)').optional(),
      app: text('Application name or key (add-modules, create-module, delete-app)').optional(),
      replace: z.boolean().describe('create-module: replace the existing module with that name').optional(),
      description: text('create-module/update-app: description').optional(),
      noPublish: z.boolean().describe('create-module: save the OML only, do not publish').optional(),
      all: z.boolean().describe('refresh-refs: every reference, not only the stale ones').optional(),
      publish: z.boolean().describe('refresh-refs: publish the refreshed module').optional(),
      providerName: text('set-user-provider: user provider module name (default Users)').optional(),
      providerKey: text('set-user-provider: user provider module key').optional(),
      oml: text('references: absolute path of an OML').optional(),
      host: text('Environment host; only selects among the environments the Studio is logged in to').optional(),
      out: text('download/download-app: absolute output folder').optional(),
      filter: text('inventory/referenceable: substring of the names to list').optional(),
      authorize: z.string().describe('Writes: the user\'s literal words; only their sha256 is kept').optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async input => {
    try { return reply(await environment(input)); }
    catch (error) { return reply({ ok: false, error: firstLine(error.message) }); }
  });
}
