// Service Center through the connected Studio's own authenticated clients (bridge sc_api; port of
// kernel/scripts/service_center/studio_api.py): the SOAP ServiceStudio.asmx (IServiceCenter), server.api/v1
// (provider.ServerApiService) and /ServiceCenter/rest (ServerCommonService). Arguments are the .NET parameter names
// without the credential, CancellationToken and out parameters; the bridge injects the Studio's user and fresh secret
// per call and calls each write once, never through the Studio's re-sending wrapper. Results are projected business
// data, redacted again here.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './bridge.mjs';
import { BridgeError, ProtocolError, Refusal, continuation } from './errors.mjs';
import { runWrite } from './client.mjs';
import { fold, sha256, utc, waitFor } from './util.mjs';

const KEY = /^[A-Za-z0-9*_+/=-]{1,100}$/;
const flag = name => '--' + name.replaceAll('_', '-');

function key(a, name) {
  const value = a[name];
  if (!value || !KEY.test(value)) throw new ProtocolError(flag(name) + ' must be the key from a Service Center listing');
  return value;
}
function text(a, name) {
  const value = a[name];
  if (!value || value.length > 200) throw new ProtocolError(flag(name) + ' is required');
  return value;
}
function number(a, name) {
  const value = a[name];
  if (!value || !/^[0-9]{1,10}$/.test(String(value))) throw new ProtocolError(flag(name) + ' must be the numeric ID returned by the operation');
  return Number(value);
}
// datetime.fromisoformat(...).astimezone(timezone.utc): a naive value is local time.
export function since(a) {
  const value = String(a.since ?? '').replace('Z', '+00:00');
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6}))?)?)?)?(?:([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/.exec(value);
  const bad = () => new ProtocolError('--since must be an ISO date/time (for example 2026-10-01T00:00:00Z)');
  if (!m || (m[8] && !m[4])) throw bad();
  const [y, mo, d, h = 0, mi = 0, s = 0] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(v => (v === undefined ? undefined : Number(v)));
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || s > 59) throw bad();
  const ms = m[8] ? Date.UTC(y, mo - 1, d, h, mi, s) - (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 3600 + Number(m[10]) * 60 + Number(m[11] ?? 0)) * 1000
    : new Date(y, mo - 1, d, h, mi, s).getTime();
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
const integer = value => { if (!/^\s*[+-]?\d+\s*$/.test(String(value))) throw new Error('invalid literal for int()'); return Number(value); };

// action -> [surface, operation, arguments from the parsed arguments]
export const READS = {
  applications: ['soap', 'ListApplications', () => ({ withIcons: false })],
  application: ['soap', 'GetApplicationDetails', a => ({ appKey: key(a, 'application_key') })],
  'application-dependencies': ['soap', 'GetApplicationDependenciesDetails', a => ({ appKey: key(a, 'application_key') })],
  modules: ['soap', 'ListEspaces', () => ({})],
  extensions: ['soap', 'ListExtensions', () => ({})],
  versions: ['soap', 'ListVersions', a => ({ eSpaceKey: key(a, 'module_key') })],
  'module-id': ['soap', 'GetESpaceId', a => ({ eSpaceKey: key(a, 'module_key') })],
  consumers: ['soap', 'GetConsumers', a => ({ producerESpaceKey: key(a, 'module_key'), referenceableElementKey: a.element_key || '' })],
  'public-elements': ['soap', 'GetPublicElements', () => ({})],
  commits: ['soap', 'ListCommits', a => ({ eSpacesStartVersion: 0, extensionsStartVersion: 0, startDate: since(a) })],
  'developer-operations': ['soap', 'GetDeveloperOperations', a => ({ startDate: since(a) })],
  license: ['soap', 'GetLicenseInformation', () => ({})],
  databases: ['server-api', 'ListDatabases', () => ({ withAppsInfo: true })],
  'application-database': ['server-api', 'GetDatabaseByApplicationKey', a => ({ applicationKey: key(a, 'application_key') })],
  'solution-components': ['soap', 'ListSolutionComponents', a => ({ solutionName: text(a, 'solution') })],
  'solution-publish-status': ['soap', 'CheckSolutionPublish', a => ({ solutionPublishId: number(a, 'publish_id'), lastSeenMessageId: integer(a.last_message_id || 0) })],
  'apply-settings-status': ['sc-rest', 'apply-settings-status', a => ({ id: number(a, 'apply_id') })],
};
// action -> the plan keys that lock its target in the journal. The three deletes run in the delete engine
// (delete.mjs, the same lock keys); they stay here so that their older receipts keep reconciling (observe).
export const WRITES = { 'module-delete': ['moduleKey'], 'extension-delete': ['moduleKey'], 'solution-publish': ['solution'],
  'apply-settings': ['applicationKey'], 'application-database-set': ['applicationKey'], 'application-delete': ['applicationKey'],
  'module-move': ['moduleKey'], 'module-add-to-application': ['moduleKey'], 'commit-message-set': ['versionId'], 'extension-publish': ['xifSha256'] };
// Destructive writes: the delete engine checks the words against every target and every consumer outside the set.
export const DESTRUCTIVE = ['module-delete', 'extension-delete', 'application-delete'];
const XIF_LIMIT = 256 * 1024 * 1024; // the bridge reads at most this much from args.file

// A projected field by any of its names, case-insensitively (the projection keeps the .NET member names).
export function field(value, ...names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const folded = new Map(Object.entries(value).map(([k, v]) => [fold(k), v]));
  for (const n of names) if (folded.has(fold(n))) return folded.get(fold(n));
  return null;
}
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function items(result) {
  const value = isObject(result) ? field(result, 'returnValue', 'items', 'value') : result;
  return Array.isArray(value) ? value : [];
}
const moduleKey = row => field(row, 'Key', 'ESpaceKey', 'ModuleKey', 'SS_Key');
const appKey = row => field(row, 'ApplicationKey', 'AppKey');
const versionOf = row => { const v = field(row, 'Version_Id', 'VersionId', 'ExtensionVersionId'); return v === null || v === undefined || v === '' ? null : v; };
const pyStr = value => (value === null || value === undefined ? 'None' : value === true ? 'True' : value === false ? 'False' : String(value));
// Error messages of an HEMessage list (Type Error), redacted.
const failed = messages => (Array.isArray(messages) ? messages.filter(m => isObject(m) && fold(pyStr(field(m, 'Type') || '')) === 'error').map(m => redact(field(m, 'Message') || '')) : []);
// The text of a SOAP message field, redacted; the server's empty HEMessage (Type Error, no text, live on 11.42 after a
// successful MoveModuleBetweenApps) is no message at all.
export function messageOf(result) {
  let value = field(result, 'message', 'msg');
  if (isObject(value)) {
    const definition = field(value, 'MessageDefinition');
    value = field(value, 'Message') || field(definition, 'Message') || field(definition, 'Detail') || field(definition, 'Id');
  }
  return value ? redact(value) : null;
}
function commitText(a) {
  const value = a.commit_message;
  if (value === null || value === undefined || value.length < 1 || value.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    throw new ProtocolError('--commit-message must be 1..2000 characters of plain text');
  return value;
}
const sha256File = file => sha256(fs.readFileSync(file));
const isPk = body => body.subarray(0, 2).equals(Buffer.from('PK'));

export class StudioApi {
  // sleep, wait: the bounded wait for the real state after a send (util.waitFor), injected by tests.
  constructor(bridge, host, { sleep = undefined, wait = undefined } = {}) {
    this.bridge = bridge; this.host = host; this.wait = { ...(wait ?? {}), ...(sleep ? { sleep } : {}) };
  }

  async call(surface, operation, args) { return (await this.bridge.api(this.host, surface, operation, args)).result ?? null; }

  async read(action, a) {
    const [surface, operation, build] = READS[action];
    const result = await this.call(surface, operation, build(a));
    return { operation, surface, result: redact(result), observedAt: utc() };
  }

  // [kind, row] of one module or extension by exact name/key across both listings (--module-kind narrows it).
  async module(a, kinds = null) {
    kinds = kinds ?? (a.module_kind ? [a.module_kind] : ['eSpace', 'Extension']);
    if (kinds.some(k => !['eSpace', 'Extension'].includes(k))) throw new ProtocolError('--module-kind is eSpace or Extension');
    if (!a.module_key && !a.module) throw new ProtocolError('Use --module <name> or --module-key <key>');
    const found = [];
    for (const kind of kinds) {
      const rows = items(await this.call('soap', kind === 'eSpace' ? 'ListEspaces' : 'ListExtensions', {}));
      found.push(...rows.filter(r => (a.module_key ? moduleKey(r) === a.module_key : field(r, 'Name') === a.module)).map(r => [kind, r]));
    }
    if (found.length !== 1) throw new ProtocolError(`Expected exactly one module or extension with that name/key; found ${found.length} (--module-kind narrows it)`);
    return found[0];
  }

  async applications() { return items(await this.call('soap', 'ListApplications', { withIcons: false })); }

  // [key, name] of one application by exact name or key, from the live listing when it is needed.
  async application(a, nameAttr = 'application', keyAttr = 'application_key') {
    const givenKey = a[keyAttr]; const givenName = a[nameAttr];
    if (givenKey) return [key(a, keyAttr), givenKey];
    if (!givenName) throw new ProtocolError(`Use ${flag(nameAttr)} <name> or ${flag(keyAttr)} <key>`);
    const matches = (await this.applications()).filter(r => field(r, 'Name') === givenName);
    if (matches.length !== 1) throw new ProtocolError(`Expected exactly one application named ${pyRepr(givenName)}; found ${matches.length}`);
    return [field(matches[0], 'Key', 'ApplicationKey'), givenName];
  }

  // ---- writes: prepare by default; send runs once inside the journal reservation
  async write(action, a, { execute, words, operationId, journal, osp = null, approve = null }) {
    if (!Object.hasOwn(API_HANDLERS, action)) throw new ProtocolError(`${action} runs in the delete engine (action delete)`);
    const [prepare, send] = API_HANDLERS[action];
    const run = (plan, state, receipt) => { receipt.plan = plan; return send.call(this, plan, state, receipt); };
    const gate = async plan => {
      // Before the reservation: a delete the server's own simulation refuses is never sent.
      if (plan.blocked) throw new ProtocolError(plan.blocked);
      if (approve) await approve(plan);
    };
    // The target lock uses the resolved key, whether the call named the target or gave its key.
    return runWrite(this.identity(action, a), () => prepare.call(this, a, osp), run, { execute, words, operationId, journal, approve: gate,
      lock: plan => ({ host: this.host, ...Object.fromEntries(WRITES[action].map(k => [k, pyStr(plan[k])])) }) });
  }

  // The journal identity is known before any network read, so a reused operationId answers from the journal.
  identity(action, a) {
    const module = a.module_key || a.module;
    const target = { 'module-delete': module, 'extension-delete': module, 'solution-publish': a.solution,
      'apply-settings': a.application_key || a.application, 'application-database-set': a.application_key || a.application,
      'application-delete': a.application_key || a.application, 'module-move': module, 'module-add-to-application': module,
      'commit-message-set': module && a.version && `${module}#${a.version}`, 'extension-publish': a.xif_file }[action];
    if (!target) throw new ProtocolError('The write needs its target (name or key)');
    return { host: this.host, action, target: String(target) };
  }

  async send(surface, operation, args, receipt, target = null) {
    return (await this.bridge.api(this.host, surface, operation, args, { write: true, operationId: receipt.operationId,
      authorizeSha256: receipt.authorization.wordsSha256, target })).result ?? null;
  }

  async applicationGone(applicationKey) {
    return !(await this.applications()).some(r => fold(pyStr(field(r, 'Key', 'ApplicationKey'))) === fold(pyStr(applicationKey)));
  }

  async modulePlan(action, a, kinds = null) {
    const [kind, row] = await this.module(a, kinds);
    return { host: this.host, action, module: field(row, 'Name'), moduleKey: moduleKey(row), moduleKind: kind,
      currentApplicationKey: appKey(row), currentApplication: field(row, 'ApplicationName'), execute: false };
  }

  // The application key the live listing shows for the module now (null when the listing omits it).
  async moduleApplication(plan) {
    const rows = items(await this.call('soap', plan.moduleKind === 'eSpace' ? 'ListEspaces' : 'ListExtensions', {})).filter(r => moduleKey(r) === plan.moduleKey);
    return rows.length === 1 ? appKey(rows[0]) : null;
  }

  async moved(plan, result, applicationKey) {
    if (field(result, 'success', 'returnValue') === false) return { state: 'rejected', message: messageOf(result) };
    const now = await this.moduleApplication(plan);
    return { state: now && fold(pyStr(now)) === fold(pyStr(applicationKey)) ? 'confirmed' : 'accepted-unverified', message: messageOf(result), observedApplicationKey: now };
  }

  async versionRow(plan) {
    const rows = items(await this.call('soap', 'ListVersions', { eSpaceKey: plan.moduleKey })).filter(r => pyStr(field(r, 'Version')) === pyStr(plan.version));
    if (rows.length !== 1) throw new ProtocolError(`Expected exactly one version ${plan.version} of ${pyStr(plan.module)}; found ${rows.length}`);
    return rows[0];
  }

  // Read-only reconciliation of an uncertain API write, from the plan its receipt kept.
  async observe(receipt) {
    const plan = receipt.plan ?? {}; const action = receipt.identity.action;
    if (!Object.keys(plan).length) return false;
    if (action === 'module-delete' || action === 'extension-delete')
      return !items(await this.call('soap', action === 'module-delete' ? 'ListEspaces' : 'ListExtensions', {})).some(r => moduleKey(r) === plan.moduleKey);
    if (action === 'application-database-set') return pyStr(field(await this.call('server-api', 'GetDatabaseByApplicationKey', { applicationKey: plan.applicationKey }), 'Id', 'DatabaseId', 'Key')) === plan.databaseId;
    if (action === 'application-delete') return this.applicationGone(plan.applicationKey);
    if (action === 'module-move' || action === 'module-add-to-application') {
      const now = await this.moduleApplication(plan);
      return Boolean(now) && fold(pyStr(now)) === fold(pyStr(plan.toApplicationKey || plan.applicationKey));
    }
    if (action === 'commit-message-set') return field(await this.versionRow(plan), 'CommitMessage') === plan.commitMessage;
    if (action === 'extension-publish') {
      // By reading only, never by a new upload: the version the server returned is listed, or (the answer lost) the named
      // extension now runs another version than the one read before the upload.
      const rows = items(await this.call('soap', 'ListExtensions', {}));
      if (receipt.extensionVersionId) return rows.some(r => pyStr(versionOf(r)) === pyStr(receipt.extensionVersionId));
      if (plan.extension) {
        const now = rows.filter(r => field(r, 'Name') === plan.extension).map(versionOf);
        return now.length === 1 && now[0] !== null && pyStr(now[0]) !== pyStr(plan.observedVersionId);
      }
      throw new ProtocolError('An uncertain extension publish without --extension cannot be told apart by reading; read the extension versions (extensions), never upload again');
    }
    throw new ProtocolError('This write is a started job; follow its status read (solution-publish-status, apply-settings-status)');
  }
}

const pyRepr = value => { const s = String(value); const q = s.includes("'") && !s.includes('"') ? '"' : "'"; return q + s.replace(/\\/g, '\\\\').replace(q === "'" ? /'/g : /"/g, '\\' + q) + q; };

// action -> [prepare(a, osp), send(plan, state, receipt)], called with the StudioApi as this. module-delete,
// extension-delete and application-delete are the delete engine's (delete.mjs).
const API_HANDLERS = {
  // osp: the absolute .osp the user gave, or the solution's own download (web transport) done in prepare.
  'solution-publish': [async function (a, osp) {
    const name = text(a, 'solution');
    if (!osp) throw new ProtocolError('solution-publish needs the solution package: --osp-file or a Service Center download');
    const body = fs.readFileSync(osp.file);
    if (sha256(body) !== osp.sha256 || !isPk(body)) throw new ProtocolError('The solution package changed or is not an OSP');
    return [{ host: this.host, action: 'solution-publish', solution: name, osp: osp.file, ospSha256: osp.sha256, size: body.length, execute: false,
      note: 'Publishes this package (the versions it holds); status by solution-publish-status' }, {}];
  }, async function (plan, state, receipt) {
    if (sha256File(plan.osp) !== plan.ospSha256) throw new BridgeError('BAD_REQUEST', 'The package changed after it was prepared; nothing was sent', { write: true });
    // The bridge reads the package itself from this absolute path (args.file), inside the Studio process.
    const result = await this.send('soap', 'PublishSolution', { file: plan.osp, filename: path.basename(plan.osp) }, receipt);
    const publishId = field(result, 'solutionPublishId');
    return { state: publishId ? 'accepted' : 'accepted-unverified', executionCompleted: false, solutionPublishId: publishId,
      needsConfiguration: field(result, 'needsConfiguration'), messages: redact(field(result, 'messages', 'returnValue')),
      ...(publishId ? { continuation: continuation('o11_service_center_read', { action: 'solution-publish-status', host: this.host, publishId: String(publishId) }, 'follows the publish job') } : {}) };
  }],

  'apply-settings': [async function (a) {
    const [applicationKey, name] = await this.application(a);
    return [{ host: this.host, action: 'apply-settings', applicationKey, application: name, execute: false }, {}];
  }, async function (plan, state, receipt) {
    const result = await this.send('sc-rest', 'apply-settings', { applicationKey: plan.applicationKey }, receipt);
    // The bridge sends the PUT itself and answers {status, body}; body is StartApplySettingsServerResponse
    // {OperationId, REST_Error{ErrorMessage}}, the shape the Studio checks (ServerCommonService.StartApplySettings).
    const body = field(result, 'body');
    const response = isObject(body) ? body : result;
    const error = field(field(response, 'REST_Error'), 'ErrorMessage');
    if (error) return { state: 'rejected', message: redact(error), result: redact(result) };
    const applyId = field(response, 'OperationId', 'id');
    return { state: 'accepted', executionCompleted: false, applyId, result: redact(result),
      ...(applyId !== null && applyId !== undefined ? { continuation: continuation('o11_service_center_read', { action: 'apply-settings-status', host: this.host, applyId: String(applyId) }, 'follows the apply settings job') } : {}) };
  }],

  'application-database-set': [async function (a) {
    const [applicationKey, name] = await this.application(a);
    const database = text(a, 'database_id');
    const known = items(await this.call('server-api', 'ListDatabases', { withAppsInfo: false })).filter(d => pyStr(field(d, 'Id', 'DatabaseId', 'Key')) === database);
    if (known.length !== 1) throw new ProtocolError('--database-id is not one database of this environment (see databases)');
    const current = await this.call('server-api', 'GetDatabaseByApplicationKey', { applicationKey });
    return [{ host: this.host, action: 'application-database-set', applicationKey, application: name, databaseId: database,
      currentDatabase: redact(field(current, 'Id', 'DatabaseId', 'Key')), execute: false }, {}];
  }, async function (plan, state, receipt) {
    const result = await this.send('server-api', 'AssociateAppWithDatabase', { applicationKey: plan.applicationKey, databaseId: plan.databaseId }, receipt);
    if ((isObject(result) ? field(result, 'associated', 'returnValue') : result) === false) return { state: 'rejected' };
    const now = await this.call('server-api', 'GetDatabaseByApplicationKey', { applicationKey: plan.applicationKey });
    return { state: pyStr(field(now, 'Id', 'DatabaseId', 'Key')) === plan.databaseId ? 'confirmed' : 'accepted-unverified' };
  }],

  'module-move': [async function (a) {
    const plan = await this.modulePlan('module-move', a);
    const [toKey, toName] = await this.application(a, 'to_application', 'to_application_key');
    const source = a.from_application_key || plan.currentApplicationKey;
    if (!source) throw new ProtocolError("The live listing does not show the module's application; give --from-application-key");
    if (a.from_application_key && plan.currentApplicationKey && fold(plan.currentApplicationKey) !== fold(a.from_application_key))
      throw new ProtocolError('--from-application-key is not the application the live listing shows for this module');
    if (fold(pyStr(source)) === fold(pyStr(toKey))) throw new ProtocolError('The module already belongs to that application');
    Object.assign(plan, { fromApplicationKey: source, toApplicationKey: toKey, toApplication: toName });
    return [plan, {}];
  }, async function (plan, state, receipt) {
    const result = await this.send('soap', 'MoveModuleBetweenApps', { fromAppKey: plan.fromApplicationKey, toAppKey: plan.toApplicationKey,
      moduleKind: plan.moduleKind, moduleKey: plan.moduleKey }, receipt);
    return this.moved(plan, result, plan.toApplicationKey);
  }],

  'module-add-to-application': [async function (a) {
    const plan = await this.modulePlan('module-add-to-application', a);
    const [applicationKey, name] = await this.application(a);
    if (plan.currentApplicationKey && fold(pyStr(plan.currentApplicationKey)) === fold(pyStr(applicationKey))) throw new ProtocolError('The module already belongs to that application');
    Object.assign(plan, { applicationKey, application: name });
    return [plan, {}];
  }, async function (plan, state, receipt) {
    const result = await this.send('soap', 'AddModuleToApplication', { appKey: plan.applicationKey, moduleKind: plan.moduleKind, moduleKey: plan.moduleKey }, receipt);
    return this.moved(plan, result, plan.applicationKey);
  }],

  // The commit message of one published module version.
  'commit-message-set': [async function (a) {
    if (!/^[1-9][0-9]{0,6}$/.test(String(a.version ?? ''))) throw new ProtocolError('--version is the module version number (see versions)');
    const plan = await this.modulePlan('commit-message-set', a, ['eSpace']); // versions are listed for modules only
    Object.assign(plan, { version: Number(a.version), commitMessage: commitText(a) });
    const row = await this.versionRow(plan);
    const versionId = field(row, 'Version_Id', 'VersionId', 'ESpaceVersionId');
    if (!/^[0-9]{1,10}$/.test(String(versionId || ''))) throw new ProtocolError("The version listing does not show this version's id");
    Object.assign(plan, { versionId: Number(versionId), currentCommitMessage: redact(field(row, 'CommitMessage')) });
    return [plan, {}];
  }, async function (plan, state, receipt) {
    await this.send('soap', 'ChangeCommitMessage', { eSpaceVersionId: plan.versionId, newCommitMessage: plan.commitMessage }, receipt);
    const now = field(await this.versionRow(plan), 'CommitMessage');
    return { state: now === plan.commitMessage ? 'confirmed' : 'accepted-unverified' };
  }],

  // Upload and publish an extension (.xif), the package prepared and checked by sha256. --extension names it (contract I1):
  // its version is read in the prepare and --expected-version-id (an id, or none for a new extension) must still hold,
  // else EXTENSION_VERSION_CHANGED before any reservation. After the send the call waits until the listing shows the
  // version the server returned.
  'extension-publish': [async function (a) {
    const file = String(a.xif_file ?? '');
    if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.xif' || !fs.existsSync(file) || !fs.statSync(file).isFile())
      throw new ProtocolError('--xif-file must be an absolute, existing .xif file');
    const size = fs.statSync(file).size;
    if (!(size > 0 && size <= XIF_LIMIT)) throw new ProtocolError('The .xif must be nonempty and at most 256 MiB');
    const plan = { host: this.host, action: 'extension-publish', xif: file, xifSha256: sha256File(file), size, execute: false,
      note: 'Uploads and publishes exactly this package; its consumers keep the producer they were built with' };
    if (a.commit_message !== null && a.commit_message !== undefined) plan.commitMessage = commitText(a);
    const expected = a.expected_version_id;
    if (expected !== null && expected !== undefined && !a.extension) throw new ProtocolError('--expected-version-id needs --extension (the extension it names)');
    if (a.extension) {
      if (String(a.extension).length > 200) throw new ProtocolError('--extension is the exact extension name');
      const rows = items(await this.call('soap', 'ListExtensions', {})).filter(r => field(r, 'Name') === a.extension);
      if (rows.length > 1) throw new ProtocolError(`Expected at most one extension named ${pyRepr(a.extension)}; found ${rows.length}`);
      const observed = rows.length ? versionOf(rows[0]) : null;
      Object.assign(plan, { extension: a.extension, extensionKey: rows.length ? moduleKey(rows[0]) : null, observedVersionId: observed });
      if (expected !== null && expected !== undefined) {
        const wanted = String(expected).trim().toLowerCase() === 'none' ? null : String(expected).trim();
        if (pyStr(wanted) !== pyStr(observed))
          throw new Refusal('EXTENSION_VERSION_CHANGED', `${a.extension} runs version ${observed ?? 'none'} now, not ${wanted ?? 'none'} as expected; nothing was reserved or sent`,
            { observed: { versionId: observed } });
        plan.expectedVersionId = wanted;
      }
    }
    if (a.application || a.application_key) [plan.applicationKey, plan.application] = await this.application(a);
    return [plan, {}];
  }, async function (plan, state, receipt) {
    if (sha256File(plan.xif) !== plan.xifSha256) throw new BridgeError('BAD_REQUEST', 'The extension package changed after it was prepared; nothing was sent', { write: true });
    // The bridge reads the package itself from this absolute path (args.file), inside the Studio process.
    const args = { file: plan.xif, ...(Object.hasOwn(plan, 'commitMessage') ? { commitMessage: plan.commitMessage } : {}),
      ...(Object.hasOwn(plan, 'applicationKey') ? { applicationKey: plan.applicationKey } : {}) };
    const result = await this.send('soap', 'UploadAndPublishExtension', args, receipt);
    const messages = field(result, 'messages', 'returnValue'); const versionId = field(result, 'extensionVersionId');
    const errors = failed(messages);
    if (errors.length) return { state: 'rejected', errors, messages: redact(messages) };
    const listed = async () => {
      try { return items(await this.call('soap', 'ListExtensions', {})).some(r => pyStr(versionOf(r)) === pyStr(versionId)); }
      catch (error) { if (error instanceof ProtocolError) return false; throw error; }
    };
    const seen = versionId ? await waitFor(listed, this.wait) : { done: false, attempts: 0, waitedMs: 0 };
    return { state: seen.done ? 'confirmed' : 'accepted-unverified', extensionId: field(result, 'extensionId'), extensionVersionId: versionId,
      messages: redact(messages), reads: seen.attempts, waitedMs: seen.waitedMs };
  }],
};
