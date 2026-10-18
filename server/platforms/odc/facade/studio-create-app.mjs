// studio_create_app: a new ODC app or library, created the way the ODC Studio's "Create app" creates it, in one call.
// The model is built headless by the ODC kernel (anvil-odc create-app, OdcAppFactory): an app is a clone of the
// tenant's template OML with the app name, color, description and icon, its theme renamed and colored by the Studio's
// own ChangeESpacePrimaryColor; a library is ESpace.Create with the "Users" provider, as the Studio's NewLibrary. The
// tenant side runs through the bridge in the signed-in ODC Studio: templates and template-download (reads), create-app
// (the "create" gates plus the app name), open from the organization and, only with publish:true, publish --wait (C25:
// the answer comes right after opening by default). One authorization covers creating and, when asked, publishing; the
// words must name the app. Only their sha256 reaches
// <kernel>/.local/lane-odc/journal/studio_create_app.jsonl, reserved before the first tenant write and closed with the
// outcome. A lost answer after the upload started is `uncertain` and never repeated here: the continuation is a read.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { authorizationContext } from './authorization-context.mjs';
import { anvilRoot, odcRoot } from './workspace.mjs';
import { createAnvilRunner } from './anvil-cli.mjs';
import { shapePublishLog } from './studio-publish-log.mjs';
import { usesWorkspace, workspacePath } from './executor.mjs';
import { runOdcOnWorker } from './anvil-worker.mjs';
import { hashedWords, withoutWordEchoes, wordsGiven } from './destructive-operations.mjs';

export const CREATE_APP_KINDS = ['reactive', 'mobile', 'library', 'mobile-library', 'agentic'];
export const CREATE_APP_ACTIONS = ['templates', 'create'];
// The tenant's system templates the Studio's wizard asks for (template GUIDs as asset keys; OdcAppFactory.Templates).
export const APP_TEMPLATES = {
  agent: { kind: 'agentic', key: 'KOkXSZ_Lu0Cj3P6eusyLLw', asset: 'template_Agent' },
  web: { kind: 'reactive', key: 'Wrm0V2ZyskqM7KobRok75w', asset: 'Template Web App' },
  'mobile-ui': { kind: 'mobile', key: 'Y53h6e8fQ0CFeiQPTNo+Pw', asset: 'Template_MobileApp' },
  'outsystems-ui': { kind: 'mobile', key: 'S_crbOhHc0Wu_Ub6zzRNug', asset: 'Template Phone App' },
};
const DEFAULT_TEMPLATE = { reactive: 'web', mobile: 'mobile-ui', agentic: 'agent' };
const isLibrary = kind => kind === 'library' || kind === 'mobile-library';
const FIELDS = {
  templates: { required: [], optional: ['kind', 'tenant', 'pid'] },
  create: { required: ['kind', 'name', 'authorize'], optional: ['module', 'description', 'color', 'icon', 'template', 'templateKey', 'publish', 'tenant', 'pid', 'authorizationContext'] },
};
const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TIMEOUTS = { kernel: 600000 };

const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const firstLine = text => String(text ?? '').split(/\r?\n/)[0].slice(0, 500);
// CX15 r5 (N-1): a continuation rebuilt from the input (self({...input})) never gives the owner's words back.
const refusal = (code, error, continuation, extra = {}) => ({ ok: false, code, error, ...extra, continuation: withoutWordEchoes(continuation) });
const withoutKeys = (input, keys) => Object.fromEntries(Object.entries(input).filter(([k]) => !keys.includes(k)));
// The words name the app as whole words, case-insensitive: "ZZ Criar Web2" does not name "ZZ Criar Web".
export const namesWhole = (words, name) => new RegExp('(?<![\\p{L}\\p{N}_])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '(?![\\p{L}\\p{N}_])', 'iu').test(words);
// The module name the kernel derives from the app name (OdcAppFactory.ModuleNameFor).
export const moduleNameFor = name => String(name).replace(/[^A-Za-z0-9_]/g, '');
const assetsRead = (tenant, why) => ({ tool: 'studio_assets', arguments: tenant ? { tenant } : {}, why });

// ---- validation: per action, before anything is read or written --------------------------------------------------
export function validateCreateAppInput(input) {
  const action = input.action ?? 'create';
  const spec = FIELDS[action];
  const self = args => ({ tool: 'studio_create_app', arguments: args, why: 'fields of ' + action + ': ' + [...spec.required, ...spec.optional].join(', ') });
  if (!spec) return refusal('UNKNOWN_ACTION', 'Unknown action ' + action, { tool: 'studio_create_app', arguments: { action: 'templates' }, why: 'actions: ' + CREATE_APP_ACTIONS.join(', ') });
  const allowed = new Set(['action', ...spec.required, ...spec.optional]);
  const unknown = Object.keys(input).filter(k => input[k] !== undefined && !allowed.has(k));
  if (unknown.length) return refusal('UNKNOWN_FIELD', `${action} does not take: ${unknown.join(', ')}`, self(withoutKeys(input, unknown)),
    unknown.includes('authorize') ? { note: 'templates is a read and takes no authorization words' } : {});
  if (action === 'templates') {
    if (input.kind && isLibrary(input.kind)) return refusal('NO_TEMPLATE', 'a ' + input.kind + ' has no template: the ODC Studio creates libraries without one',
      { tool: 'studio_create_app', arguments: { action: 'create', kind: input.kind, name: '<App>', authorize: "<the user's words naming the app>" }, why: 'create the library directly' });
    return null;
  }
  const missing = spec.required.filter(k => input[k] === undefined || (typeof input[k] === 'string' && !input[k].trim()));
  // CX15 r7 (M-3): words that are a marker, a <template> or a sha256 of the server are no words (before the approval and the
  // naming rule: a template that names the app never creates it).
  if (missing.includes('authorize') || !wordsGiven(input.authorize)) return refusal('WORDS_REQUIRED', 'create changes the tenant and needs the user\'s own words (authorize)',
    { tool: 'studio_create_app', arguments: { ...input, authorize: "<the user's literal words, naming the app>" }, why: 'ask the user; never write the words yourself' });
  if (missing.length) return refusal('MISSING_FIELD', `create needs: ${missing.join(', ')}`, self({ ...input, ...Object.fromEntries(missing.map(k => [k, '<' + k + '>'])) }));
  if (!CREATE_APP_KINDS.includes(input.kind)) return refusal('BAD_VALUE', 'kind is one of ' + CREATE_APP_KINDS.join(', '), self({ ...input, kind: 'reactive' }));
  if (input.name !== input.name.trim() || input.name.length > 50 || /[\u0000-\u001f]/.test(input.name))
    return refusal('BAD_VALUE', 'name: at most 50 characters, no leading or trailing spaces', self({ ...input, name: input.name.trim().slice(0, 50) }));
  const module = input.module ?? moduleNameFor(input.name);
  if (!MODULE_NAME.test(module)) return refusal('BAD_VALUE', `module: "${module}" is not a module name (letters, digits and _, not starting with a digit)`,
    self({ ...input, module: '<ModuleName>' }));
  if (input.color !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(input.color)) return refusal('BAD_VALUE', 'color must be #RRGGBB', self(withoutKeys(input, ['color'])));
  if (input.icon !== undefined && (!path.isAbsolute(input.icon) || !/\.png$/i.test(input.icon)))
    return refusal('BAD_VALUE', 'icon must be the absolute path of a PNG', self(withoutKeys(input, ['icon'])));
  if (input.icon !== undefined && !fs.existsSync(input.icon)) return refusal('FILE_NOT_FOUND', 'icon not found: ' + input.icon, self(withoutKeys(input, ['icon'])));
  if (isLibrary(input.kind) && (input.template !== undefined || input.templateKey !== undefined))
    return refusal('NO_TEMPLATE', 'a ' + input.kind + ' has no template: the ODC Studio creates libraries with ESpace.Create, never from a template', self(withoutKeys(input, ['template', 'templateKey'])));
  if (input.template !== undefined && input.templateKey !== undefined) return refusal('BAD_VALUE', 'template and templateKey exclude each other', self(withoutKeys(input, ['template'])));
  if (input.template !== undefined && APP_TEMPLATES[input.template]?.kind !== input.kind)
    return refusal('BAD_VALUE', `template "${input.template}" is not a ${input.kind} template; ${input.kind} takes ${Object.entries(APP_TEMPLATES).filter(([, t]) => t.kind === input.kind).map(([k]) => k).join(', ')}`,
      self(withoutKeys(input, ['template'])));
  let approval = null;
  try {
    approval = authorizationContext(input.authorizationContext, input.authorize, { lane: 'odc', host: input.tenant, operation: 'create-app', targets: [input.name, module] });
    if (approval && input.publish) authorizationContext(input.authorizationContext, input.authorize, { lane: 'odc', host: input.tenant, operation: 'publish', targets: [input.name, module] });
  } catch (error) { return refusal(error.code, error.message); }
  if (!approval && !namesWhole(input.authorize, input.name)) return refusal('WORDS_MUST_NAME_APP', `the user's words must name the app "${input.name}"`,
    { tool: 'studio_create_app', arguments: { ...input, authorize: `<the user's words naming ${input.name}>` }, why: 'creating needs words that name what is created' });
  return null;
}

// The kernel argv, in a fixed order (Program.cs CreateApp reads options by name). pluginsDir: the Studio's model plugin
// cache, as template-download reports it, where the kernel reads the template's model plugins (MobileUI) first.
export function kernelArguments(input, { out, templateOml, templateKey, tenant, author, pluginsDir }) {
  const args = ['create-app', '--kind', input.kind, '--name', input.name, '--out', out];
  const opt = (name, value) => { if (value !== undefined && value !== null) args.push(name, String(value)); };
  opt('--module', input.module); opt('--template-oml', templateOml); opt('--template-key', templateKey); opt('--color', input.color);
  opt('--description', input.description); opt('--icon', input.icon); opt('--tenant', tenant); opt('--author', author); opt('--plugins-dir', pluginsDir);
  return args;
}

// A model plugin the template requires (MobileUI) is missing from the Studio's cache: the Studio puts it there when it
// opens an app built on it. A read, never a repeat of the creation.
const pluginsContinuation = tenant => assetsRead(tenant, 'the ODC Studio downloads a model plugin into its cache when it opens an app that uses it: '
  + 'open any Mobile UI app of the tenant in the ODC Studio (studio_open, or ask the user), then call studio_create_app again; nothing was created');

// C25: the templates this facade already holds, <odcRoot>/.local/templates/<key>-r<revision>-<sha12>.oml (the bridge's
// naming). The newest revision of a key whose bytes still hash to the name, or null.
const templateStem = key => String(key).replace(/\//g, '_').replace(/\+/g, '-') + '-r';
export function cachedTemplate(dir, key) {
  let names; try { names = fs.readdirSync(dir); } catch { return null; }
  const stem = templateStem(key);
  const found = names.filter(n => n.startsWith(stem)).map(n => ({ n, m: /^(\d+)-([0-9A-Fa-f]{12})\.oml$/.exec(n.slice(stem.length)) })).filter(x => x.m)
    .map(({ n, m }) => ({ file: path.join(dir, n), revision: m[1], sha12: m[2] })).sort((a, b) => Number(b.revision) - Number(a.revision));
  for (const entry of found) {
    try { if (createHash('sha256').update(fs.readFileSync(entry.file)).digest('hex').toUpperCase().startsWith(entry.sha12.toUpperCase())) return entry; } catch { /* next */ }
  }
  return null;
}
// After a download: the template is kept under the name the bridge gave it (revision and the first 12 hex of its sha256).
export function keepTemplate(dir, key, { path: file, revision, sha256 }) {
  try {
    if (!file || revision == null || !/^[0-9A-Fa-f]{12}/.test(String(sha256 ?? ''))) return null;
    const target = path.join(dir, templateStem(key) + revision + '-' + String(sha256).slice(0, 12).toUpperCase() + '.oml');
    if (!fs.existsSync(target)) { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(file, target + '.tmp'); fs.renameSync(target + '.tmp', target); }
    return target;
  } catch { return null; }
}
// B2 (C02, C25): the model step on the lane's resident ODC worker (DLLs bound, JIT warm) when it serves the request under its
// --author (capability apply:developer-id: the same CLI makes create-app run under its author); else the cold runner.
export function odcWorkerFirst(cold, worker) {
  return async (args, options = {}) => {
    const w = await runOdcOnWorker(args, { ...(worker !== undefined ? { worker } : {}), needs: ['apply:developer-id'] });
    if (w.used && w.unknown) return { ok: false, exitCode: 1, envelope: null, stderr: [w.error ?? 'no answer'], unknown: true, via: 'worker' };
    if (w.used) return { ok: w.envelope?.ok === true, exitCode: w.envelope?.ok === true ? 0 : 1, envelope: w.envelope, stderr: w.warning ? [w.warning] : [], via: 'worker' };
    const r = await cold(args, options);
    return w.note ? { ...r, workerNote: w.note } : r;
  };
}

function uniqueFolder(base, stamp) {
  let dir = path.join(base, stamp);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(base, stamp + '-' + n);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// One bridge call: {value} | {failed, sent, error}. A refusal before the pipe carried the request is never uncertain.
async function call(studio, args, pid) {
  try {
    const value = await studio(args, pid);
    return { value };
  } catch (error) {
    return { failed: true, sent: error?.sent !== false && error?.code !== 'BRIDGE_NOT_ATTACHED' && !/not running|pass the pid/i.test(error?.message ?? ''), error: firstLine(error?.message) };
  }
}
const connect = why => ({ tool: 'ssam_connect', arguments: { lane: 'odc' }, why });

export function createStudioCreateApp(deps = {}) {
  const root = deps.root ?? anvilRoot;
  const local = path.join(root, '.local', 'lane-odc');
  const cli = deps.cli ?? path.join(local, 'cli', 'anvil-odc.dll');
  // Hosted (executor.mjs), the evidence and the journal are the customer's: <ws>/odc/lab/create-app and <ws>/odc/journal.
  const hosted = usesWorkspace(root, anvilRoot);
  const evidenceRoot = hosted ? workspacePath('odc', 'lab', 'create-app') : path.join(local, 'create-app');
  const runAnvil = deps.runAnvil ?? odcWorkerFirst(createAnvilRunner({ root, env: deps.env ?? process.env }), deps.worker);
  // C25: the system templates by revision and sha, one cache of this server for every customer (a code-side folder: a
  // template is the platform's, the same bytes for every tenant at the same revision and sha).
  const templateCache = deps.templateCache ?? path.join(odcRoot, '.local', 'templates');
  const now = deps.now ?? (() => new Date());
  const uuid = deps.uuid ?? randomUUID;
  const studio = deps.studio ?? (async (args, pid) => (await import('./lib.mjs')).studio(args, pid));
  const tenants = deps.tenants ?? (async () => (await import('./lib.mjs')).tenants());
  const appUrl = deps.appUrl ?? (async input => (await import('./lib.mjs')).appUrl(input));
  const journalFile = hosted ? workspacePath('odc', 'journal', 'studio_create_app.jsonl') : path.join(local, 'journal', 'studio_create_app.jsonl');
  const journal = entry => {
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    fs.appendFileSync(journalFile, JSON.stringify({ at: now().toISOString(), tool: 'studio_create_app', ...entry }) + '\n');
  };

  async function templates(input) {
    const args = ['templates', '--kind', input.kind ?? 'all', ...(input.tenant ? ['--tenant', input.tenant] : [])];
    const r = await call(studio, args, input.pid);
    if (r.failed) return refusal('BRIDGE_FAILED', r.error, connect('connect the ODC Studio signed in to the tenant, then list again'));
    if (r.value?.ok === false) return refusal('BRIDGE_REFUSED', firstLine(r.value.error), { tool: 'studio_doctor', arguments: {}, why: 'check the Studio, its session and the bridge version' });
    const list = (r.value.templates ?? []).map(t => ({ key: t.key, label: t.label, kind: t.applicationKind, asset: t.asset?.name, revision: t.asset?.revision,
      template: Object.entries(APP_TEMPLATES).find(([, x]) => x.key === t.key)?.[0] }));
    return { ok: true, tenant: r.value.tenant, kind: input.kind ?? 'all', templates: list,
      next: { tool: 'studio_create_app', arguments: { action: 'create', kind: input.kind ?? 'reactive', name: '<App>', templateKey: '<key>', authorize: "<the user's words naming the app>" } } };
  }

  // The signed-in session that receives the app: the tenant asked for, or the only one. Corporate tenants need the
  // tenant named in the call and in the words.
  async function session(input) {
    const r = await call(studio, ['auth-status', ...(input.tenant ? ['--tenant', input.tenant] : [])], input.pid);
    if (r.failed) return { refused: refusal('BRIDGE_FAILED', r.error, connect('connect the ODC Studio signed in to the tenant; nothing was created')) };
    const sessions = (r.value?.sessions ?? []).filter(s => s.loggedIn !== false && s.host);
    if (input.tenant && !sessions.some(s => s.host === input.tenant))
      return { refused: refusal('STUDIO_NOT_SIGNED_IN', `the ODC Studio has no session on ${input.tenant}`, { tool: 'hybrid_tenants', arguments: {}, why: 'ask the user to sign in to that tenant in the ODC Studio' }) };
    if (!input.tenant && sessions.length !== 1)
      return { refused: refusal(sessions.length ? 'TENANT_AMBIGUOUS' : 'STUDIO_NOT_SIGNED_IN', sessions.length ? 'the ODC Studio holds several sessions: ' + sessions.map(s => s.host).join(', ') + '; pass tenant' : 'the ODC Studio is not signed in to any tenant',
        { tool: 'hybrid_tenants', arguments: {}, why: sessions.length ? 'choose the tenant with the user' : 'ask the user to sign in in the ODC Studio' }) };
    const chosen = sessions.find(s => s.host === (input.tenant ?? sessions[0].host));
    let klass = null;
    try { klass = (await tenants())?.tenants?.[chosen.host]?.class ?? null; } catch { klass = null; }
    if (klass === 'corporate' && (!input.tenant || (!input.authorizationContext && !namesWhole(input.authorize, chosen.host))))
      return { refused: refusal('CORPORATE_TENANT', `${chosen.host} is a corporate tenant: pass tenant explicitly and words that name it`,
        { tool: 'studio_create_app', arguments: { ...input, tenant: chosen.host, authorize: `<the user's words naming ${input.name} and ${chosen.host}>` }, why: 'a corporate tenant is never the default target' }) };
    return { host: chosen.host, user: chosen.user ?? null, class: klass };
  }

  async function create(input) {
    const kind = input.kind;
    const module = input.module ?? moduleNameFor(input.name);
    const s = await session(input);
    if (s.refused) return s.refused;
    if (!fs.existsSync(cli)) return refusal('CLI_NOT_BUILT', 'The ODC lane CLI is not built: ' + cli, { tool: 'ssam_doctor', arguments: { lane: 'odc' }, why: 'the doctor reports the CLI build of each lane' });
    const stamp = now().toISOString().replace(/[-:.]/g, '');
    const evidence = uniqueFolder(evidenceRoot, stamp);
    const steps = [];
    const summary = extra => ({ app: input.name, module, kind, tenant: s.host, evidence, steps, ...extra });

    // 1. The template (apps only), downloaded through the session: what the Studio clones. The bridge also names the
    // Studio's model plugin cache and the template's required model plugins, fetched into it when missing (older
    // bridges name neither: the kernel then reads its default cache folder).
    // Hosted, that cache is a folder of the customer's machine: the server's kernel never reads a folder the agent named
    // (a model plugin is code the kernel loads); it reads the server's own plugin cache, as without --plugins-dir.
    let template = null; let pluginsDirectory; let kernelPlugins;
    if (!isLibrary(kind)) {
      const key = input.templateKey ?? APP_TEMPLATES[input.template ?? DEFAULT_TEMPLATE[kind]].key;
      // C25: a template this facade already holds goes as --have <revision>-<sha12> to a bridge with template-download:have;
      // the same revision answers cached:true without bytes and the kernel clones the cached file.
      const held = cachedTemplate(templateCache, key);
      let have = [];
      if (held) {
        const status = await call(studio, ['status', 'brief'], input.pid);
        if (Array.isArray(status.value?.capabilities) && status.value.capabilities.includes('template-download:have')) have = ['--have', held.revision + '-' + held.sha12];
      }
      const r = await call(studio, ['template-download', key, '--tenant', s.host, ...have], input.pid);
      if (r.failed || r.value?.ok === false)
        return refusal('TEMPLATE_DOWNLOAD_FAILED', r.error ?? firstLine(r.value?.error), { tool: 'studio_create_app', arguments: { action: 'templates', kind, tenant: s.host }, why: 'list the templates the tenant offers; nothing was created' }, summary({ failedStep: 'template-download' }));
      const plugins = Array.isArray(r.value.modelPlugins) ? r.value.modelPlugins : null;
      const fromCache = r.value.cached === true && held && String(r.value.revision) === held.revision;
      const file = fromCache ? held.file : keepTemplate(templateCache, key, r.value) ?? r.value.path;
      template = { key, name: r.value.name, revision: r.value.revision, sha256: r.value.sha256, path: file, ...(fromCache ? { cached: true } : {}),
        ...(plugins ? { modelPlugins: plugins.map(p => ({ name: p.name, version: p.version, cached: p.cached === true, ...(p.fetched ? { fetched: true } : {}), ...(p.error ? { error: firstLine(p.error) } : {}) })) } : {}) };
      pluginsDirectory = r.value.pluginsDirectory ?? undefined;
      kernelPlugins = hosted ? undefined : pluginsDirectory;
      steps.push('template-download');
      const missing = (plugins ?? []).filter(p => p.cached !== true);
      if (missing.length)
        return refusal('MODEL_PLUGIN_MISSING', `the template ${r.value.name} requires the model plugin(s) ${missing.map(p => p.name + ' ' + p.version).join(', ')}, which the ODC Studio could not put in its plugin cache (${pluginsDirectory})`
          + (missing.some(p => p.error) ? ': ' + firstLine(missing.find(p => p.error).error) : ''), pluginsContinuation(s.host),
          summary({ outcome: 'failed', failedStep: 'model-plugins', template, pluginsDirectory }));
    }

    // 2. The model, headless, as the Studio builds it (nothing reaches the tenant here).
    const argv = kernelArguments({ ...input, module }, { out: evidence, templateOml: template?.path, templateKey: template?.key, tenant: s.host, author: s.user, pluginsDir: kernelPlugins });
    const run = await runAnvil(argv, { timeoutMs: deps.timeoutMs ?? TIMEOUTS.kernel, cwd: root, cli });
    const built = run.envelope?.data;
    if (!run.envelope || run.envelope.ok === false || !built?.ok) {
      const error = firstLine(run.envelope?.error ?? (run.stderr ?? []).at(-1) ?? 'the ODC kernel gave no answer');
      const failed = summary({ outcome: 'failed', failedStep: 'model', template });
      if (/^OdcModelPluginMissingException\b/.test(error)) return refusal('MODEL_PLUGIN_MISSING', error, pluginsContinuation(s.host), failed);
      // An answer of the kernel is deterministic: the same template and arguments get the same refusal, so it is not repeated.
      if (run.envelope) return refusal('MODEL_REFUSED', `${template ? 'the template was downloaded, but ' : ''}the headless model step refused it; nothing was sent to the tenant: ${error}`,
        { tool: 'ssam_friction', arguments: { view: 'issues' }, why: 'the model step answers the same refusal to the same call: do not repeat it; tell the user this error and the evidence folder' },
        { ...failed, repeat: false });
      return refusal('MODEL_REFUSED', `the headless model step gave no answer; nothing was sent to the tenant: ${error}`,
        { tool: 'ssam_doctor', arguments: { lane: 'odc' }, why: 'the ODC kernel did not answer: check the ODC lane, then repeat' }, failed);
    }
    steps.push('model');
    const manifestPath = built.manifest;
    // 3. The user's words, once, for creating and (when asked) publishing: the Studio's "Create app" publishes revision 1.
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const approval = authorizationContext(input.authorizationContext, input.authorize, { lane: 'odc', host: s.host, operation: 'create-app', targets: [input.name, module] });
    if (approval) fs.writeFileSync(path.join(evidence, 'authorization-context.json'), JSON.stringify(approval, null, 2));
    // CX15 r5 (N-2): both fields keep sha256:<hex> of the words, never the words (the bridge only requires a nonempty text).
    const recorded = `${hashedWords(input.authorize.trim())} [recorded ${now().toISOString()} by studio_create_app]`;
    manifest.createAuthorization = recorded;
    if (input.publish === true) manifest.publishAuthorization = recorded;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const operationId = uuid();
    const record = { action: 'create', target: input.name, module, kind, tenant: s.host, operationId, wordsSha256: sha256(input.authorize), evidence, ...(approval ? { authorizationContext: approval } : {}) };
    journal({ ...record, phase: 'reserved' });
    const finish = value => { journal({ ...record, phase: 'result', outcome: value.ok ? 'ok' : value.outcome ?? 'failed', ...(value.code ? { code: value.code } : {}) });
      // Hosted (servidor/fase4): the delivery processes are warmed again for the first delivery to the new app.
      if (value.ok) import('./lib.mjs').then(lib => lib.warmSoon()).catch(() => {});
      try { fs.writeFileSync(path.join(evidence, 'studio_create_app-receipt.json'), JSON.stringify({ ...value, wordsSha256: record.wordsSha256 }, null, 2)); } catch { /* the answer stands */ }
      return value; };

    // 4. The upload (revision 1). An answer lost after the request is uncertain: read, never repeat.
    const created = await call(studio, ['create-app', manifestPath], input.pid);
    if (created.failed && !created.sent) return finish(refusal('BRIDGE_FAILED', created.error, connect('nothing was sent; connect the ODC Studio and repeat'), summary({ outcome: 'failed' })));
    if (created.failed || created.value?.outcome === 'uncertain')
      return finish(refusal('UNCERTAIN', `the creation of ${input.name} was sent but its answer was lost; it may exist. Not repeated.`,
        assetsRead(s.host, `list the tenant to see whether ${input.name} exists; never repeat before that`), summary({ outcome: 'uncertain', manifest: manifestPath })));
    if (created.value?.ok !== true)
      return finish(refusal('CREATE_REFUSED', firstLine(created.value?.error), assetsRead(s.host, 'read the tenant before any new attempt'), summary({ outcome: 'failed', manifest: manifestPath })));
    steps.push('create');
    const asset = { key: created.value.assetKey, name: created.value.assetName ?? created.value.appName, type: created.value.assetType, revision: created.value.revision };
    const counts = built.content ?? {};

    // 5. Open from the organization (the upload linkage Publish needs), as the Studio opens the new app.
    const opened = await call(studio, ['open', built.moduleKey], input.pid);
    if (opened.failed || opened.value?.ok !== true)
      return finish(refusal('OPEN_FAILED', opened.error ?? firstLine(opened.value?.error), { tool: 'studio_open', arguments: { module: built.moduleKey }, why: `${input.name} was created; open it, then studio_publish {manifest}` },
        summary({ outcome: 'failed', created: true, asset, manifest: manifestPath })));
    steps.push('open');
    // The bridge checks the author against the open module's developer; the Studio's own value wins over the session user.
    if (opened.value.developerId && opened.value.developerId !== manifest.author) {
      manifest.author = opened.value.developerId;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
    const base = { ok: true, app: input.name, module, moduleKey: built.moduleKey, kind, tenant: s.host, asset, template, theme: built.theme ?? null,
      content: counts, settings: built.settings, evidence, manifest: manifestPath, steps, ...(built.notes ? { notes: built.notes } : {}) };
    if (input.publish !== true)
      // C25: publish only when asked; the answer comes right after opening. A write is never a `next`: publishing later
      // needs the user's words again.
      return finish({ ...base, publish: { requested: false }, published: false, toPublish: [{ tool: 'studio_authorize', arguments: { manifest: manifestPath, kind: 'publish', text: "<the user's words>" } },
        { tool: 'studio_publish', arguments: { manifest: manifestPath, wait: true } }] });

    // 6. Publish revision 1 and compare the published revision with the open module (one receipt).
    const published = await call(studio, ['publish', manifestPath, '--wait', '15'], input.pid);
    const publishRead = { tool: 'studio_command', arguments: { command: 'publish-status', args: [manifestPath] }, why: 'read the publication state; never republish before that' };
    if ((published.failed && published.sent) || published.value?.outcome === 'uncertain')
      return finish(refusal('PUBLISH_UNCERTAIN', `${input.name} was created and opened; its publication was sent but the answer was lost. Not repeated.`, publishRead,
        summary({ outcome: 'uncertain', created: true, asset, manifest: manifestPath })));
    if (published.failed || published.value?.ok !== true) {
      // The bridge answers a publication that ended without success with its log: every message and what to fix.
      const log = published.value?.publishLog ? shapePublishLog(published.value.publishLog) : null;
      return finish(refusal('PUBLISH_FAILED', published.error ?? firstLine(published.value?.error), log?.continuation ?? publishRead,
        { ...summary({ outcome: 'failed', created: true, asset, manifest: manifestPath }), ...(log?.lastPublish ? { publishLog: log.lastPublish } : {}) }));
    }
    steps.push('publish');
    let appLinks = null;
    if (!isLibrary(kind) && kind !== 'agentic') { try { appLinks = await appUrl({ app: module, host: s.host }); } catch (error) { appLinks = { error: firstLine(error.message) }; } }
    return finish({ ...base, published: true, publishedRevision: published.value.published?.revision ?? null, ...(appLinks ? { appLinks } : {}),
      next: { tool: 'ssam_map', arguments: { lane: 'odc', target: module }, why: 'read the new app before changing it' } });
  }

  return async function createApp(input) {
    const refused = validateCreateAppInput(input);
    if (refused) return refused;
    return (input.action ?? 'create') === 'templates' ? templates(input) : create(input);
  };
}

export function registerStudioCreateApp(server, deps = {}) {
  const createApp = createStudioCreateApp(deps);
  const text = description => z.string().min(1).describe(description);
  server.registerTool('studio_create_app', {
    title: 'Create an ODC app or library as the ODC Studio does',
    description: 'A new Reactive app, Mobile app, Library, Mobile Library or Agentic app in the tenant the ODC Studio is signed in to, built the way the Studio\'s '
      + '"Create app" builds it: an app is a clone of the tenant\'s template (MainFlow, layouts, theme, login, OutSystems UI) with the app name, '
      + 'color, description and icon; a library is a new library module. Then uploaded and opened in the Studio; the answer comes right '
      + 'after opening. publish:true also publishes revision 1: pass it only when the user asked to publish. action templates (read) lists the tenant\'s application templates. create needs kind, name (the app name, spaces allowed; '
      + 'the module name drops them unless module is given) and authorize = the user\'s literal words naming the app (one authorization covers '
      + 'creating and, with publish:true, publishing; only their sha256 is journaled). template: web (reactive), mobile-ui (mobile default) or outsystems-ui; '
      + 'agent (agentic app with native V1/V2 scaffolds; agents and AI model dependencies are configured with studio_deliver). '
      + 'templateKey for a custom template of the organization. tenant only picks among the Studio\'s signed-in sessions; a corporate tenant must '
      + 'be named in the call and in the words. An uncertain outcome is never repeated: read studio_assets first. Deleting an app stays with the '
      + 'user in the ODC Portal.',
    inputSchema: z.object({
      action: z.enum(CREATE_APP_ACTIONS).default('create'),
      kind: z.enum(CREATE_APP_KINDS).describe('reactive | mobile | library | mobile-library | agentic').optional(),
      name: text('create: the app name, as in the Studio dialog (spaces allowed)').optional(),
      module: z.string().regex(MODULE_NAME).describe('create: module name (default: the name without spaces and symbols)').optional(),
      description: text('create: app description').optional(),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).describe('create: primary color #RRGGBB (default #2E86C1)').optional(),
      icon: text('create: absolute path of a PNG icon').optional(),
      template: z.enum(Object.keys(APP_TEMPLATES)).describe('create: system template (web | mobile-ui | outsystems-ui | agent)').optional(),
      templateKey: text('create: asset key of an application template (see action templates)').optional(),
      publish: z.boolean().describe('create: also publish revision 1 after opening (default false: only when the user asked to publish)').optional(),
      tenant: text('Tenant host among the Studio\'s signed-in sessions').optional(),
      authorize: z.string().describe('create: the user\'s literal words naming the app; only their sha256 is kept').optional(),
      authorizationContext: z.string().describe('Optional absolute path to a scoped ssam-authorization-context/1 record of the verified human approval of the concrete proposal; authorize remains the exact human words. Requires explicit tenant.').optional(),
      pid: z.number().int().positive().describe('ODC Studio process id; detected when there is exactly one.').optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async input => {
    try { return reply(await createApp(input)); }
    catch (error) { return reply({ ok: false, error: firstLine(error.message) }); }
  });
}
