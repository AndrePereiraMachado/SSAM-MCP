// Delete O11 applications, modules and extensions through the connected Studio's own Service Center API (bridge sc_api:
// DeleteApplication, DeleteModule), never through Factory pages (contract docs/INTEGRACOES-GITSSAM.md, lane scdelete,
// D1-D3). A delete takes TWO calls (CX15, after the incident of 2026-10-14; D4 "with words it executes in the same call"
// fell): a call without confirmationToken is a PREVIEW, a call with it the EXECUTION (destructive-operations.mjs).
// PREVIEW, reads only, refusing with every problem at once:
//   1. the bridge must list the six operations it needs in its serviceCenter catalog (STUDIO_BRIDGE_OUTDATED);
//   2. targets come from ONE read of each listing, by exact name or key; a prefix matches case-insensitively within its
//      kind, at most maxDeletes (25, up to 100); protected apps matched by a prefix pass only when named whole;
//   3. dependencies are reads: the server's own simulation for an application (DeleteApplication simulate:true:
//      deletedModules, affectedApplications), GetConsumers for a module or an extension; an error or an unreadable shape
//      fails closed (DEPENDENCY_CHECK_UNAVAILABLE): nothing is deleted blind;
//   then the exact list in the engine's order (each target with the modules that go with it, its consumers), its count,
//   a confirmationToken bound to that list and host and the operationId the execution will have. Nothing is reserved or
//   sent; a preview call that brings words answers CONFIRMATION_REQUIRED (they were said before the list).
// EXECUTION: the targets come from the token only (a selection with it is SELECTION_ONLY_IN_PREVIEW); the listings and
// dependencies are read again (another list is PREVIEW_STALE, with a new preview in the same answer); then:
//   4. the owner's words, given AFTER the preview (never words seen before it, never sooner than 5 s after it), state the
//      exact number of items as a number (owner decision 2026-10-14, option C: CONFIRMATION_COUNT_MISMATCH) and name
//      every target as a whole word; the prefix in the words after a preview selected by that prefix names the targets
//      the preview listed (PREFIX_WORDS_NAME_ALL; D2 bound to the token: no new resolution); every consumer outside the
//      set is named too (CONSUMERS_WOULD_BREAK); a standing grant never covers a delete;
//   5. then a parent receipt (the preview's operationId) with the frozen targets and one child receipt per target
//      (operationId derived from the parent and the key), consumers before producers; each target is read again right
//      before its single send (gone: absent; same key, other name: CONFLICT, stop) and the call waits for the real state
//      (about 30 s) until the key is gone (confirmed) or answers DELETE_UNCONFIRMED keeping the target lock.
// The same token again answers by state: a target already gone is absent with its last receipt and nothing is sent; an
// uncertain child read as gone closes confirmed; read as still there, unchanged, it allows exactly one new send (never
// after the preview expired, never for a cancelled operation). An older operationId without a token previews what is
// left of it. The model never polls and never needs verify.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { authorizationContext } from '../authorization-context.mjs';
import { redact } from './bridge.mjs';
import { guardWrite, hostClass, hostsFile, namesWhole } from './auth.mjs';
import { BridgeError, ProtocolError, Refusal, connectStudio } from './errors.mjs';
import { bridgeFailure } from './client.mjs';
import { field, items, messageOf } from './studio-api.mjs';
import { canonicalUuid, fold, same, utc, waitFor } from './util.mjs';
import { OWNER_REPLY, OperationRunning, backupDir, beginOperation, checkExecute, createPreview, derivedOperationId, endOperation, itemsSentence, markItem, noteExecutionRequested, noteWords, parseToken, previewFile, readOperation, readPreview, summarizeOperation, wordsGiven } from '../destructive-operations.mjs';

// D2, bound to the token since CX15: the prefix, as a whole word of the owner's words given AFTER a preview selected by
// that prefix, names the targets that preview listed (protected ones excepted), and the words state their exact count.
export const PREFIX_WORDS_NAME_ALL = true;
export const TOOL = 'o11_service_center_write';
export const TWO_CALLS = "deletes take two calls now: show the list, then call again with confirmationToken and the owner's reply";
// Backup before deleting (CX15): the published OML of each module that goes; an extension has none yet (to confirm: the
// .xif download of DownloadExtension as a backup). Not a backup failure: the preview shows it and the owner confirms it.
export const EXTENSION_BACKUP_WHY = 'an extension (.xif) is not backed up yet: its download as a backup is not proven (to confirm)';
export const DELETE_ACTIONS = ['delete', 'module-delete', 'extension-delete', 'application-delete'];
export const DELETE_OPERATIONS = ['ListApplications', 'ListEspaces', 'ListExtensions', 'GetConsumers', 'DeleteApplication', 'DeleteModule'];
// GitSSAM's protected applications: matched by a prefix, they pass only when the words name them whole.
export const PROTECTED = Object.freeze({ names: ['Users', 'System Components'], prefixes: ['LifeTime', 'OutSystems ', 'System '] });
export const KINDS = ['application', 'module', 'extension'];
export const DEFAULT_MAX_DELETES = 25;
export const MAX_DELETES = 100;
// Rules of SSAM, not of the platform (the platform's own refusals carry no ssamRule).
const SSAM_RULES = new Set(['WORDS_MUST_NAME', 'CONSUMERS_WOULD_BREAK', 'PROTECTED_TARGET', 'DELETE_LIMIT_EXCEEDED', 'DEPENDENCY_CHECK_UNAVAILABLE',
  'CONFIRM_HOST_REQUIRED', 'HOST_READ_ONLY', 'TARGET_PENDING']);
const LISTS = { application: 'applications', module: 'modules', extension: 'extensions' };
const UNSURE = ['uncertain', 'accepted-unverified'];
// CX15 r2 (C4): what the list says of a target whose earlier delete went out and is not settled, and the rule of the
// resend. A delete sent for it may still be running on the server; one whose wait a cancellation cut is read (verify)
// before any new send, never sent again blind.
const previousNotice = earlier => `A delete was already sent for ${earlier.map(x => `${x.name} (${x.previous.sentAt ?? 'time unknown'}, ${x.previous.state}`
  + `${x.previous.cancelled ? ', its wait cut by a cancellation' : ''})`).join(', ')} and may still be running on the server: tell the owner, with this list.`
  + (earlier.some(x => x.previous.cancelled && !x.previous.verifiedPresentAt)
    ? ` Before any new send it is read: o11_service_center_write {action:"verify", operationId:<previousDelete.receipt>}; SSAM never sends a second delete of it blind.` : '');
// CX15 r3 (CT-7): what a preview deletes WITHOUT a backup, said where the model reads what to tell the owner (next,
// confirmWith and the error of CONFIRMATION_REQUIRED): the items whose backup is not possible, with their reasons, and
// the extensions (.xif) inside items that are backed up otherwise. null when every item and module has its backup.
const shortWhy = backup => (backup.prerequisite === 'CLI_NOT_BUILT' ? 'the O11 CLI of this lane is not built'
  : backup.prerequisite === 'STUDIO_NOT_SELECTED' ? 'the Studio selected with ssam_connect is not available'
    : backup.why === EXTENSION_BACKUP_WHY ? 'an extension (.xif) is not backed up yet'
      : text(backup.why).split(/: |; |, so /)[0].trim() || 'no backup is possible');
export function noBackupNote(items = []) {
  const without = items.filter(i => i.backup && i.backup.possible === false);
  const inside = items.filter(i => i.backup?.possible && Array.isArray(i.backup.notBackedUp)).flatMap(i => i.backup.notBackedUp);
  if (!without.length && !inside.length) return null;
  const parts = [];
  if (without.length) parts.push(`${without.length} item${without.length === 1 ? '' : 's'} will be deleted WITHOUT a backup (${[...new Set(without.map(i => shortWhy(i.backup)))].join('; ')})`);
  if (inside.length) parts.push(`${inside.length} extension${inside.length === 1 ? '' : 's'} inside backed-up items ${inside.length === 1 ? 'goes' : 'go'} without a backup (an extension (.xif) is not backed up yet)`);
  return `${parts.join('; ')}: tell the owner.`;
}
// The preview's texts with that note: next and confirmWith carry it from the preview itself (createPreview notes, CX15 r3:
// the common rule of every lane); here, a preview call that brought words, the error.
export function withNoBackupNote(answer, note) {
  if (!note) return {};
  return answer.code === 'CONFIRMATION_REQUIRED' ? { error: `${answer.error}. ${note}` } : {};
}
// CX15 r3 (CT-5): the error of a refusal says what THIS call did (nothing) and, after an interrupted operation (its process
// died), what that operation did item by item: never a bare "nothing was reserved or sent" that reads as "nothing happened".
export function refusalError(problems, operation = null) {
  const count = `${problems.length} problem${problems.length > 1 ? 's' : ''}`;
  return operation?.orphaned
    ? `${count}; this call sent nothing, but the interrupted operation ${operation.operationId} did: ${itemsSentence(operation)} Read ssam_task {id:"${operation.operationId}"} before telling the owner anything`
    : `${count}; nothing was reserved or sent`;
}
const verifyProblem = (t, previous) => problem('VERIFY_REQUIRED', `The delete of ${t.name} sent at ${previous.sentAt ?? 'an unknown time'} was cut by a cancellation and may still be running on the server; nothing is sent again before it is read`,
  `o11_service_center_write {action:"verify", operationId:"${previous.receipt}"} reads it (gone: it closes confirmed); then tell the owner what it says. A new send needs the owner's new reply.`,
  { target: t.name, operationId: previous.receipt });

const text = value => (value === null || value === undefined ? '' : String(value));
const sha256Of = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKey = (a, b) => text(a) !== '' && fold(text(a)) === fold(text(b));
const byName = (a, b) => a.name.localeCompare(b.name);
export const isProtected = name => PROTECTED.names.some(n => fold(n) === fold(name)) || PROTECTED.prefixes.some(p => fold(name).startsWith(fold(p)));
const problem = (code, message, fix, extra = {}) => ({ code, ...extra, message, fix, ...(SSAM_RULES.has(code) ? { ssamRule: true } : {}) });
const entry = t => ({ kind: t.kind, name: t.name, key: t.key, application: t.application ?? null });
const lockOf = (host, t) => (t.kind === 'application' ? { host, applicationKey: text(t.key) } : { host, moduleKey: text(t.key) });
// Names of a simulation list: strings, or rows with a Name (else their Key).
const nameList = value => [...new Set((Array.isArray(value) ? value : []).map(v => (isObject(v) ? text(field(v, 'Name') ?? field(v, 'Key')) : text(v))).filter(Boolean))];
const messagesOf = value => (Array.isArray(value) ? value : value ? [value] : []).map(m => (isObject(m) ? text(field(m, 'Message') ?? messageOf({ message: m })) : text(m)))
  .filter(Boolean).map(m => redact(m));
// A GetConsumers answer is readable when it is a list of rows that each carry a name (ConsumerName/Name).
const consumerRows = value => (Array.isArray(value) ? value : isObject(value) ? field(value, 'returnValue', 'items', 'value', 'consumers') : null);
const rowName = row => { const n = field(row, 'ConsumerName', 'Name'); return typeof n === 'string' && n.trim() ? n.trim() : null; };
const readableConsumers = value => { const rows = consumerRows(value); return Array.isArray(rows) && rows.every(r => isObject(r) && rowName(r)); };

// A22: the distinctive suffix of a module or extension inside its application: <App>_<Suffix> (the application name
// without spaces, case-insensitive), at least two characters; null otherwise.
const compact = value => text(value).replace(/\s+/g, '');
const plainText = value => text(value).normalize('NFD').replace(/\p{M}/gu, '');
export function appSuffix(t) {
  if (!t || t.kind === 'application' || !text(t.application).trim()) return null;
  const app = compact(t.application);
  if (!fold(t.name).startsWith(fold(app) + '_')) return null;
  const suffix = text(t.name).slice(app.length + 1);
  return suffix.replace(/[_\s]/g, '').length >= 2 ? suffix : null;
}
// The words name a suffix as a whole word, case-, accent- and space-insensitive between its parts: "Back Office" and
// "backoffice" name BackOffice, "o UI" names UI; "UIX" or "BackOfficer" do not.
export function namesSuffix(words, suffix) {
  const parts = plainText(suffix).split(/[_\-\s]+/).filter(Boolean)
    .flatMap(part => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+|[^\W_]+/gu) ?? [part]);
  if (!parts.length) return false;
  const pattern = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]*');
  return new RegExp('(?<![\\p{L}\\p{N}_])' + pattern + '(?![\\p{L}\\p{N}_])', 'iu').test(plainText(words));
}

// derivedOperationId (a deterministic UUID of a parent operation and the parts that name one child of it) lives in the
// common module of destructive operations since CX15; re-exported here with the same UUIDs.
export { derivedOperationId };

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = keep; }
  }
  return row[b.length];
}
// Up to five names of the listing closest to what was asked.
export function nearest(value, names, limit = 5) {
  const v = fold(value);
  return [...new Set(names)].map(n => [n, fold(n).startsWith(v) || v.startsWith(fold(n)) ? 0 : distance(v, fold(n))])
    .sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0])).slice(0, limit).map(([n]) => n);
}

export function parseTarget(spec) {
  const value = text(spec); const at = value.indexOf(':');
  const kind = at > 0 ? value.slice(0, at) : null;
  if (!KINDS.includes(kind) || !value.slice(at + 1).trim()) throw new ProtocolError('--target is <application|module|extension>:<exact name or key>');
  return { kind, value: value.slice(at + 1).trim() };
}

// The request of a delete or of one of its aliases, from the parsed arguments of index.mjs. module-delete takes
// --module/--module-key (eSpace or extension; --module-kind Extension: the extension), extension-delete also --extension,
// application-delete --application/--application-key. Without --confirmation-token it previews (--plan-only: a preview
// that ignores the words); with it, it executes the targets of the token (a selection with it is refused by the engine,
// with every other problem).
export function deleteRequest(args) {
  const targets = (args.target ?? []).map(parseTarget);
  const alias = { 'module-delete': args.module_kind === 'Extension' ? 'extension' : 'module', 'extension-delete': 'extension', 'application-delete': 'application' }[args.action];
  if (alias === 'application' && (args.application_key || args.application)) targets.push({ kind: 'application', value: text(args.application_key || args.application) });
  else if (alias && alias !== 'application') {
    const value = args.module_key || args.module || (alias === 'extension' ? args.extension : null);
    if (value) targets.push({ kind: alias, value: text(value) });
  }
  const prefix = args.prefix === null || args.prefix === undefined ? null : text(args.prefix);
  if (prefix !== null && !prefix.trim()) throw new ProtocolError('--prefix must have text');
  if (args.prefix_kind && prefix === null) throw new ProtocolError('--prefix-kind applies to --prefix');
  const prefixKind = args.prefix_kind || 'application';
  if (!KINDS.includes(prefixKind)) throw new ProtocolError('--prefix-kind is application, module or extension');
  let maxDeletes = DEFAULT_MAX_DELETES;
  if (args.max_deletes !== null && args.max_deletes !== undefined) {
    if (!/^\s*\d{1,3}\s*$/.test(text(args.max_deletes)) || Number(args.max_deletes) < 1 || Number(args.max_deletes) > MAX_DELETES)
      throw new ProtocolError(`--max-deletes is a number from 1 to ${MAX_DELETES}`);
    maxDeletes = Number(args.max_deletes);
  }
  const confirmationToken = text(args.confirmation_token).trim() || null;
  const operationId = args.operation_id ? canonicalUuid(text(args.operation_id)) : null;
  if (args.operation_id && !operationId) throw new ProtocolError('operation-id must be a UUID');
  if (!targets.length && prefix === null && !confirmationToken && !operationId)
    throw new ProtocolError('delete needs its targets: applications, modules, extensions or prefix (--target=<kind>:<name or key>, --prefix)');
  const words = text(args.words);
  if (args.execute && !wordsGiven(words) && !confirmationToken) throw new ProtocolError( // CX15 r7 (M-3): one predicate
   "Execution requires the user's own authorization words (they name every target)");
  if (args.execute && args.plan_only) throw new ProtocolError('--execute and --plan-only exclude each other');
  if (confirmationToken && args.plan_only) throw new ProtocolError('--plan-only previews; a confirmation-token executes: give one of them');
  return { targets, prefix: prefix === null ? null : prefix.trim(), prefixKind, maxDeletes, words, confirmHost: args.confirm_host ?? null,
    operationId, planOnly: Boolean(args.plan_only), execute: Boolean(args.execute), confirmationToken, ownerRequest: text(args.owner_request) || null,
    authorizationContext: args.authorization_context ?? undefined };
}
// What identifies a delete request across repetitions with the same operationId (receipts before CX15).
const requestSpec = r => ({ targets: r.targets.map(t => `${t.kind}:${t.value}`).sort(), prefix: r.prefix, prefixKind: r.prefix ? r.prefixKind : null, maxDeletes: r.maxDeletes });
const selected = r => r.targets.length > 0 || r.prefix !== null;

export class DeleteEngine {
  // api: the StudioApi of the host (its bridge carries the Studio's session). journal: the Service Center journal.
  // tool: the entry the token is bound to (o11_service_center_write, o11_environment, o11_extension). clock: ms now
  // (CONFIRM_MIN_AGE_MS of a confirmation). root: the destructive root (previews, records). previewUuid: the previewId.
  constructor(api, { journal, registry = hostsFile(), uuid = () => crypto.randomUUID(), sleep = undefined, wait = {}, consumerNames = null,
    tool = TOOL, clock = Date.now, root = undefined, previewUuid = () => crypto.randomUUID(), signal = undefined, backup = null, backupReady = null } = {}) {
    if (!journal) throw new ProtocolError('A delete needs the durable journal');
    this.api = api; this.host = api.host; this.journal = journal; this.registry = registry; this.uuid = uuid;
    this.wait = { ...wait, ...(sleep ? { sleep } : {}) }; this.consumerNamesFn = consumerNames;
    this.tool = tool; this.now = clock; this.root = root; this.previewUuid = previewUuid; this.signal = signal;
    // backup(item, {operationId, host, signal}) -> {files:[{path, sha256, bytes, module, versionId?}], cancelled?}
    this.backup = backup;
    // backupReady() -> null | {code, why}: the cheap prerequisites of that backup (CX15 r2, M5), read once per call.
    this.backupReady = backupReady; this.notReady = null;
  }

  call(surface, operation, args) { return this.api.call(surface, operation, args); }
  send(surface, operation, args, receipt, target) { return this.api.send(surface, operation, args, receipt, target); }
  async consumerNames(value, producer) {
    // The reader of o11_publish (contract 1.4.6), loaded only when a module or an extension is checked.
    this.consumerNamesFn ??= (await import('../o11-publish.mjs')).consumerNames;
    return this.consumerNamesFn(value, producer);
  }

  // 1. Before any read: the bridge must send every operation of a delete (its manifest's serviceCenter catalog).
  async gate() {
    const bridge = this.api.bridge;
    const catalog = typeof bridge?.serviceCenterCatalog === 'function' ? await bridge.serviceCenterCatalog() : null;
    const soap = new Set((Array.isArray(catalog?.soap) ? catalog.soap : []).map(n => fold(text(n))));
    const missing = DELETE_OPERATIONS.filter(op => !soap.has(fold(op)));
    if (missing.length)
      throw new Refusal('STUDIO_BRIDGE_OUTDATED', `The bridge loaded in the Studio does not send ${missing.join(', ')} (its serviceCenter catalog), so nothing was `
        + 'read or sent. Open the Service Studio through the "Service Studio (SSAM)" shortcut so the current bridge loads, then reconnect it.',
      { action: 'delete', state: 'refused', missing, continuation: connectStudio('reconnect after the Studio loads the current bridge') });
  }

  // One read of each listing; modules and extensions carry their application's name.
  async listings() {
    const appRow = r => ({ kind: 'application', key: text(field(r, 'Key', 'ApplicationKey', 'AppKey')), name: text(field(r, 'Name')) });
    const moduleRow = (r, kind) => ({ kind, moduleKind: kind === 'module' ? 'eSpace' : 'Extension', key: text(field(r, 'Key', 'ESpaceKey', 'ModuleKey', 'ExtensionKey', 'SS_Key')),
      name: text(field(r, 'Name')), applicationKey: text(field(r, 'ApplicationKey', 'AppKey')) || null, applicationName: text(field(r, 'ApplicationName')) || null });
    const valid = row => row.key && row.name;
    const apps = items(await this.call('soap', 'ListApplications', { withIcons: false })).map(appRow).filter(valid);
    const espaces = items(await this.call('soap', 'ListEspaces', {})).map(r => moduleRow(r, 'module')).filter(valid);
    const extensions = items(await this.call('soap', 'ListExtensions', {})).map(r => moduleRow(r, 'extension')).filter(valid);
    for (const m of [...espaces, ...extensions]) m.application = apps.find(a => sameKey(a.key, m.applicationKey))?.name ?? m.applicationName;
    for (const a of apps) a.application = a.name;
    return { apps, espaces, extensions };
  }
  // A module target is an eSpace or an extension (the Service Center sense); extension and application are their own.
  pool(kind, L) { return kind === 'application' ? L.apps : kind === 'extension' ? L.extensions : [...L.espaces, ...L.extensions]; }
  find(L, kind, key) { return (kind === 'application' ? L.apps : kind === 'extension' ? L.extensions : L.espaces).find(r => sameKey(r.key, key)) ?? null; }

  // 2. The targets: exact name or key, the prefix within its kind. Not found specs are returned for the receipts check.
  resolve(request, L) {
    const problems = []; const targets = []; const missing = []; const seen = new Set();
    const add = (row, via, given) => { const id = row.kind + ':' + fold(row.key); if (seen.has(id)) return; seen.add(id); targets.push({ ...row, via, given }); };
    for (const spec of request.targets) {
      const pool = this.pool(spec.kind, L);
      const matches = pool.filter(r => sameKey(r.key, spec.value) || r.name === spec.value);
      if (matches.length === 1) add(matches[0], 'list', spec.value);
      else if (!matches.length) missing.push({ ...spec, nearest: nearest(spec.value, pool.map(r => r.name)) });
      else problems.push(problem('TARGET_AMBIGUOUS', `"${spec.value}" is ${matches.map(m => `the ${m.kind} ${m.name} (${m.key})`).join(' and ')}`,
        `its key (${matches.map(m => `${m.key} for the ${m.kind}`).join(', ')})${matches.some(m => m.kind === 'extension') && spec.kind !== 'extension' ? `, or extensions:["${spec.value}"] for the extension` : ''}`,
        { target: spec.value, candidates: matches.map(entry) }));
    }
    if (request.prefix !== null) {
      const pool = this.pool(request.prefixKind, L);
      const matches = pool.filter(r => fold(r.name).startsWith(fold(request.prefix))).sort(byName);
      if (!matches.length)
        problems.push(problem('TARGET_NOT_FOUND', `No ${request.prefixKind} name starts with "${request.prefix}"`, `a prefix of an existing ${request.prefixKind}`,
          { target: request.prefix, prefix: true, nearest: nearest(request.prefix, pool.map(r => r.name)) }));
      else if (matches.length > request.maxDeletes)
        problems.push(problem('DELETE_LIMIT_EXCEEDED', `${matches.length} ${LISTS[request.prefixKind]} start with "${request.prefix}", more than maxDeletes=${request.maxDeletes}`,
          `a narrower prefix, or the exact names in ${LISTS[request.prefixKind]} (maxDeletes up to ${MAX_DELETES})`, { target: request.prefix, matches: matches.map(m => m.name), maxDeletes: request.maxDeletes }));
      else for (const m of matches) add({ ...m, protected: isProtected(m.name) }, 'prefix', request.prefix);
    }
    if (targets.length > request.maxDeletes && !problems.some(p => p.code === 'DELETE_LIMIT_EXCEEDED'))
      problems.push(problem('DELETE_LIMIT_EXCEEDED', `${targets.length} targets, more than maxDeletes=${request.maxDeletes}`, `fewer targets per call (maxDeletes up to ${MAX_DELETES})`,
        { matches: targets.map(t => t.name), maxDeletes: request.maxDeletes }));
    // A module of an application of the set goes with it: the server's cascade deletes it.
    for (const t of targets) if (t.kind !== 'application' && targets.some(a => a.kind === 'application' && sameKey(a.key, t.applicationKey))) t.withApplication = true;
    return { targets, problems, missing };
  }

  // The last receipt of a target that is gone: by its name or key, kind by kind.
  priorReceipt(spec) {
    const kinds = spec.kind === 'module' ? ['module', 'extension'] : [spec.kind];
    for (const kind of kinds) {
      const id = this.journal.pointed({ host: this.host, kind, ref: fold(spec.value) });
      const receipt = id ? this.journal.lookup(id) : null;
      if (receipt?.identity?.action === 'delete') return receipt;
    }
    return null;
  }
  // A target read as gone: an uncertain child of it closes confirmed (the read is the proof); otherwise it is absent.
  settleGone(t, receipt) {
    const out = { ...entry(t), ...(receipt ? { receipt: receipt.receipt, receiptState: receipt.state } : {}) };
    if (receipt && UNSURE.includes(receipt.state) && this.journal.rawState(receipt.operationId) !== 'sending') {
      try { this.journal.reconcile(receipt); return { deleted: { ...out, receiptState: 'confirmed', reconciled: true } }; } catch (error) { if (!(error instanceof ProtocolError)) throw error; }
    }
    return { absent: out };
  }

  // 3. Dependencies, reads only. A failure fails closed for that target.
  async dependencies(targets) {
    const problems = [];
    const unavailable = (t, error, what) => problem('DEPENDENCY_CHECK_UNAVAILABLE', `${what} of ${t.name} could not be read${error ? ` (${error.code ?? 'error'}: ${redact(error.message).slice(0, 200)})` : ' (unreadable answer)'}; nothing is deleted blind`,
      `repeat the same call once the Studio's Service Center answers ${what}`, { target: t.name, ...(error?.code ? { cause: error.code } : {}) });
    for (const t of targets) {
      if (t.kind === 'application') {
        let sim;
        try { sim = await this.call('soap', 'DeleteApplication', { appKey: t.key, simulate: true }); }
        catch (error) { if (!(error instanceof ProtocolError)) throw error; problems.push(unavailable(t, error, 'The server simulation (DeleteApplication simulate:true)')); continue; }
        const success = isObject(sim) ? field(sim, 'success', 'returnValue') : null;
        if (typeof success !== 'boolean') { problems.push(unavailable(t, null, 'The server simulation (DeleteApplication simulate:true)')); continue; }
        Object.assign(t, { deletedModules: nameList(field(sim, 'deletedModules', 'deletedComponents')), affectedApplications: nameList(field(sim, 'affectedApplications', 'affectedApps')),
          simulationMessages: messagesOf(field(sim, 'messages', 'message')) });
        if (!success)
          problems.push(problem('SIMULATION_REFUSED', `The Service Center simulation refuses to delete ${t.name}${t.simulationMessages.length ? ': ' + t.simulationMessages.join('; ') : ''}`,
            'what the server messages ask (the platform refuses this delete as it is)', { target: t.name, messages: t.simulationMessages }));
      } else if (!t.withApplication) {
        let value;
        try { value = await this.call('soap', 'GetConsumers', { producerESpaceKey: t.key, referenceableElementKey: '' }); }
        catch (error) { if (!(error instanceof ProtocolError)) throw error; problems.push(unavailable(t, error, 'GetConsumers')); continue; }
        if (!readableConsumers(value)) { problems.push(unavailable(t, null, 'GetConsumers')); continue; }
        t.consumers = await this.consumerNames(value, t.name);
      }
    }
    return problems;
  }

  // Consumers outside the set (a consumer or an affected application that is not deleted with it) and the order edges
  // [consumer target, producer target] inside the set.
  externals(targets, L) {
    const apps = targets.filter(t => t.kind === 'application');
    const modules = [...L.espaces, ...L.extensions];
    const moduleByName = name => modules.find(m => fold(m.name) === fold(name)) ?? null;
    const holder = name => {
      const own = targets.find(t => t.kind !== 'application' && fold(t.name) === fold(name));
      if (own) return own;
      const m = moduleByName(name);
      return (m && apps.find(a => sameKey(a.key, m.applicationKey))) || apps.find(a => (a.deletedModules ?? []).some(d => fold(d) === fold(name))) || null;
    };
    const external = []; const edges = [];
    for (const t of targets) {
      if (t.kind === 'application') {
        for (const a of t.affectedApplications ?? []) {
          if (fold(a) === fold(t.name)) continue;
          const inSet = apps.find(x => fold(x.name) === fold(a));
          if (inSet) edges.push([inSet, t]); else external.push({ consumer: a, application: a, of: t.name, kind: 'application' });
        }
        // The modules of an application of the set go after it: the server's cascade takes them.
        for (const m of targets.filter(x => x.withApplication && sameKey(x.applicationKey, t.key))) edges.push([t, m]);
      } else for (const c of t.consumers ?? []) {
        const inSet = holder(c);
        if (inSet) edges.push([inSet, t]); else external.push({ consumer: c, application: moduleByName(c)?.application ?? null, of: t.name, kind: 'module' });
      }
    }
    return { external, edges };
  }

  // Consumers before producers; a cycle keeps the order of the request.
  static order(targets, edges) {
    const before = new Map(targets.map(t => [t, new Set()]));
    for (const [first, then] of edges) if (first !== then && before.has(then)) before.get(then).add(first);
    const done = new Set(); const out = [];
    while (out.length < targets.length) {
      const next = targets.find(t => !done.has(t) && [...before.get(t)].every(x => done.has(x) || !before.has(x))) ?? targets.find(t => !done.has(t));
      done.add(next); out.push(next);
    }
    return out;
  }

  // 4. The words (D2, D3) and the environment rule as it is (confirmHost and words naming a corporate host).
  // A22: a module or extension of the target application <App> named <App>_<Suffix> is also named by its distinctive
  // suffix ("o UI e o Back Office" names Cardapio_UI and Cardapio_BackOffice), when no other target has the same suffix;
  // t.namedBy records how each target was named, for the answer (named).
  wordProblems(request, targets, external, words) {
    const problems = [];
    const prefixNamed = request.prefix !== null && PREFIX_WORDS_NAME_ALL && namesWhole(words, request.prefix);
    const suffixes = new Map();
    for (const t of targets) { const s = appSuffix(t); if (s) suffixes.set(fold(compact(s)), [...(suffixes.get(fold(compact(s))) ?? []), t]); }
    for (const t of targets) {
      if (request.approval?.targets.includes(t.name)) { t.namedBy = 'approved-proposal'; continue; }
      if (namesWhole(words, t.name)) { t.namedBy = 'name'; continue; }
      if (t.protected) {
        problems.push(problem('PROTECTED_TARGET', `${t.name} is protected and the prefix "${request.prefix}" matches it`, `a narrower prefix that leaves ${t.name} out, or words that name ${t.name} by its whole name`, { target: t.name }));
        continue;
      }
      if (t.via === 'prefix' && prefixNamed) { t.namedBy = 'prefix'; continue; }
      const suffix = appSuffix(t);
      const sharing = suffix ? suffixes.get(fold(compact(suffix))) ?? [] : [];
      if (suffix && namesSuffix(words, suffix)) {
        if (sharing.length === 1) { t.namedBy = 'suffix'; t.namedAs = suffix; continue; }
        problems.push(problem('WORDS_MUST_NAME', `The user's words name "${suffix}", which is the suffix of ${sharing.map(x => x.name).join(' and ')}; it does not say which`,
          `words that name ${t.name} by its whole name`, { target: t.name, candidates: sharing.map(entry) }));
        continue;
      }
      problems.push(problem('WORDS_MUST_NAME', `The user's words do not name the ${t.kind} ${t.name}`, `words that name ${t.name}${t.via === 'prefix' ? ` (or the prefix ${request.prefix} as a whole word)` : ''}${suffix && sharing.length === 1 ? ` (or ${suffix}, its name inside ${t.application})` : ''}`, { target: t.name }));
    }
    for (const e of external) if (!namesWhole(words, e.consumer))
      problems.push(problem('CONSUMERS_WOULD_BREAK', `${e.consumer}${e.application && fold(e.application) !== fold(e.consumer) ? ` (application ${e.application})` : ''} uses ${e.of} and is not deleted with it`,
        `words that also name ${e.consumer}, or add it to ${e.kind === 'application' ? 'applications' : 'modules'}`, { target: e.of, consumer: e.consumer, application: e.application, of: e.of }));
    return problems;
  }
  hostProblems(words, confirmHost) {
    const kind = hostClass(this.host, this.registry);
    try { guardWrite(this.host, words, confirmHost, [], this.registry); return []; }
    catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      return [kind === 'read-only' ? problem('HOST_READ_ONLY', error.message, null)
        : problem('CONFIRM_HOST_REQUIRED', error.message, `confirmHost:"${this.host}" and words that name ${this.host.split('.')[0]}`)];
    }
  }
  // A target whose lock another receipt holds: an uncertain delete of it allows one new send (attempt 2); anything else
  // pending on it blocks the call.
  pending(targets) {
    const problems = [];
    for (const t of targets) {
      const holder = this.journal.holder(lockOf(this.host, t));
      if (!holder) continue;
      const receipt = this.journal.lookup(holder);
      const deleteOf = receipt && (receipt.identity?.action === 'delete' || ['module-delete', 'extension-delete', 'application-delete'].includes(receipt.identity?.action));
      if (deleteOf && UNSURE.includes(receipt.state) && this.journal.rawState(holder) !== 'sending') {
        if ((receipt.plan?.attempt ?? 1) >= 2) problems.push(problem('DELETE_UNCONFIRMED', `${t.name} is still listed after a delete that was already sent again once (receipt ${holder})`,
          'look at the target in Service Center; SSAM never sends a third time', { target: t.name, operationId: holder }));
        else t.supersede = receipt;
        continue;
      }
      problems.push(problem('TARGET_PENDING', `${t.name} has a pending or uncertain operation (${receipt?.identity?.action ?? 'unknown'}, receipt ${holder})`,
        'o11_service_center_write {action:"verify", operationId} reconciles it by reading', { target: t.name, operationId: holder }));
    }
    return problems;
  }

  repeat(request, needed, extra = {}) {
    const out = { action: 'delete', host: this.host };
    for (const [kind, list] of Object.entries(LISTS)) { const values = request.targets.filter(t => t.kind === kind).map(t => t.value); if (values.length) out[list] = values; }
    if (request.prefix !== null) Object.assign(out, { prefix: request.prefix, prefixKind: request.prefixKind });
    if (request.maxDeletes !== DEFAULT_MAX_DELETES) out.maxDeletes = request.maxDeletes;
    out.words = needed.length ? `<the user's own words naming ${needed.join(', ')}>` : "<the user's own words>";
    if (hostClass(this.host, this.registry) !== 'personal') out.confirmHost = this.host;
    return { ...out, ...extra };
  }
  summary(request, targets, external, gone) {
    const consumers = {};
    for (const t of targets) { const list = t.kind === 'application' ? t.affectedApplications : t.consumers; if (list?.length) consumers[t.name] = list; }
    const unique = list => [...new Set(list)];
    const needed = unique([...targets.filter(t => t.via !== 'prefix' || t.protected || !PREFIX_WORDS_NAME_ALL).map(t => t.name), ...(request.prefix !== null ? [request.prefix] : []),
      ...external.map(e => e.consumer)]);
    const named = targets.filter(t => t.namedBy).map(t => ({ ...entry(t), by: t.namedBy, ...(t.namedAs ? { as: t.namedAs } : {}) }));
    return { targets: targets.map(t => ({ ...entry(t), via: t.via, ...(t.protected ? { protected: true } : {}), ...(t.withApplication ? { withApplication: true } : {}) })),
      absent: gone.absent, deletedModules: unique(targets.flatMap(t => t.deletedModules ?? [])),
      affectedApplications: unique(targets.flatMap(t => t.affectedApplications ?? []).filter(a => !targets.some(t => t.kind === 'application' && fold(t.name) === fold(a)))),
      consumers, externalConsumers: external, wordsMustName: needed, ...(named.some(n => n.by === 'suffix') ? { named } : {}) };
  }

  // The whole call. request: deleteRequest(...). The words (and the owner's request) are noted first, before anything.
  async run(request) {
    const words = text(request.words);
    for (const value of [words, request.ownerRequest]) noteWords({ host: this.host, tool: this.tool, words: value, now: this.now(), root: this.root });
    // CX15 r3 (CT-2): an execution is visible from its start: the gate, the listings, the simulations and the checks run
    // before its record opens, so the call notes "execution requested" (with its pid) for the token's preview first;
    // ssam_task of that preview then says a call with the token is running, never a bare "executed:false". The note goes
    // when the record opens (execute) or the call ends without one (a refusal, a failure).
    this.requested = request.confirmationToken ? this.noteRequested(request.confirmationToken) : null;
    try {
      await this.gate();
      const L = await this.listings();
      this.notReady = this.backupReady ? await this.backupReady() : null;
      return await (request.confirmationToken ? this.confirm(request, words, L) : this.preview(request, words, L));
    } finally { this.requested?.done(); this.requested = null; }
  }
  // The note of a requested execution, only for a preview of this tool and host (another token is refused by the checks).
  noteRequested(token) {
    const parsed = parseToken(token);
    const preview = parsed ? readPreview(parsed.previewId, { root: this.root }) : null;
    if (!preview || preview.tool !== this.tool || text(preview.host).toLowerCase() !== text(this.host).toLowerCase()) return null;
    return noteExecutionRequested(preview, { now: this.now(), root: this.root });
  }

  // The targets of a parent receipt still listed, by state (the same operationId again, or a token already executed).
  frozen(parent, request, L) {
    const problems = []; const targets = []; const gone = { absent: [], deleted: [] };
    if (parent.identity?.action !== 'delete' || parent.identity.host !== this.host || !Array.isArray(parent.plan?.targets) || parent.plan?.parent)
      throw new ProtocolError('operation-id already belongs to a different target or operation');
    if (selected(request) && !same(parent.plan.request, requestSpec(request))) throw new ProtocolError('operation-id already belongs to a delete of other targets');
    for (const frozen of parent.plan.targets) {
      const now = this.find(L, frozen.kind, frozen.key);
      const last = this.lastChild(parent.operationId, frozen);
      if (!now) { const settled = this.settleGone(frozen, last); if (settled.deleted) gone.deleted.push(settled.deleted); else gone.absent.push(settled.absent); continue; }
      if (now.name !== frozen.name) { problems.push(problem('CONFLICT', `The key ${frozen.key} of ${frozen.name} is now named ${now.name}`, 'a new call that names the target as it is now', { target: frozen.name, observed: now.name })); continue; }
      if (last?.state === 'rejected') { problems.push(problem('DELETE_REJECTED', `The server rejected the delete of ${frozen.name}${last.message ? ': ' + last.message : ''}`, 'what the server message asks, then a new call', { target: frozen.name, operationId: last.operationId })); continue; }
      targets.push({ ...now, ...frozen, application: now.application ?? frozen.application, withApplication: frozen.withApplication, via: frozen.via ?? 'list', ...(last ? { previous: last } : {}) });
    }
    return { targets, problems, gone };
  }
  // The targets a selection names now (names, keys, prefix); gone ones answer by their last receipt.
  resolved(request, L) {
    const gone = { absent: [], deleted: [] };
    const { targets, problems, missing } = this.resolve(request, L);
    for (const spec of missing) {
      const prior = this.priorReceipt(spec);
      if (prior) { const settled = this.settleGone({ kind: prior.plan?.kind ?? spec.kind, name: prior.plan?.name ?? spec.value, key: prior.plan?.key ?? null, application: prior.plan?.application ?? null }, prior); if (settled.deleted) gone.deleted.push(settled.deleted); else gone.absent.push(settled.absent); }
      else problems.push(problem('TARGET_NOT_FOUND', `No ${spec.kind === 'module' ? 'module or extension' : spec.kind} is named (or keyed) "${spec.value}"`, spec.nearest.length ? `one of: ${spec.nearest.join(', ')}` : 'the exact name or key from the listing',
        { target: spec.value, nearest: spec.nearest }));
    }
    return { targets, problems, gone };
  }
  // One item of the preview: what goes with it (the server's cascade and the listing rows of an application), its
  // consumers (outside or inside the set) and how it was selected.
  item(t, L) {
    const unique = list => [...new Set(list.filter(Boolean))];
    const cascade = t.kind === 'application'
      ? unique([...(t.deletedModules ?? []), ...[...L.espaces, ...L.extensions].filter(m => sameKey(m.applicationKey, t.key)).map(m => m.name)]) : [];
    const consumers = t.kind === 'application' ? (t.affectedApplications ?? []).filter(a => fold(a) !== fold(t.name)) : (t.consumers ?? []);
    const previous = this.previousDeleteOf(t);
    return { kind: t.kind, key: t.key, name: t.name, application: t.application ?? null, via: t.via ?? 'list', ...(t.protected ? { protected: true } : {}),
      ...(t.moduleKind ? { moduleKind: t.moduleKind } : {}), ...(t.withApplication ? { withApplication: true, applicationKey: t.applicationKey } : {}), cascade, consumers,
      backup: this.backupPlan(t, L), ...(previous ? { previousDelete: previous } : {}) };
  }
  // The earlier delete of a target that is not settled (its lock holder, or the last child of this operation): its receipt,
  // state, when it went out and whether a cancellation cut its wait (CX15 r2, C4).
  previousDeleteOf(t) {
    const r = [t.supersede, t.previous].find(x => x && UNSURE.includes(x.state));
    return r ? { receipt: r.operationId, state: r.state, sentAt: r.createdAt ?? null, cancelled: r.cancelled === true, ...(r.verifiedPresentAt ? { verifiedPresentAt: r.verifiedPresentAt } : {}) } : null;
  }
  // VERIFY_REQUIRED for every target whose earlier delete a cancellation cut and that nothing read since.
  verifyProblems(targets) {
    return targets.map(t => [t, this.previousDeleteOf(t)]).filter(([, p]) => p?.cancelled && !p.verifiedPresentAt).map(([t, p]) => verifyProblem(t, p));
  }
  // What the backup of a target saves before its send: the published OML of the module, or of every eSpace of the
  // application (its listing rows and the server's simulation); extensions are named as not backed up.
  // CX15 r2 (M5): a backup whose cheap prerequisites do not hold now (the CLI not built, the selected Studio gone) is
  // shown as not possible, with the reason: the item is then deleted without a backup, like an application with no module.
  backupPlan(t, L, { ready = !this.notReady } = {}) {
    const plan = this.modulePlan(t, L);
    if (!plan.possible || ready) return plan;
    return { possible: false, why: `${this.notReady.why}: it is deleted without a backup, like an application with no module`, prerequisite: this.notReady.code,
      ...(plan.notBackedUp ? { notBackedUp: plan.notBackedUp } : {}) };
  }
  // The plan of the execution follows the preview the owner confirmed: an item it showed without a backup is deleted without
  // one; an item it showed with a backup gets it (a download that fails is BACKUP_FAILED, nothing sent for it).
  executionPlan(t, L, preview) {
    const shown = preview?.items?.find(i => i.kind === t.kind && sameKey(i.key, t.key))?.backup;
    return shown && shown.possible === false ? shown : this.backupPlan(t, L, { ready: true });
  }
  modulePlan(t, L) {
    if (t.kind === 'extension') return { possible: false, why: EXTENSION_BACKUP_WHY };
    if (t.kind === 'module') return { possible: true, how: 'the published OML of the module', modules: [t.name] };
    const isExtension = name => L.extensions.some(x => fold(x.name) === fold(name));
    const modules = [...new Set([...L.espaces.filter(m => sameKey(m.applicationKey, t.key)).map(m => m.name), ...(t.deletedModules ?? []).filter(n => !isExtension(n))])];
    const extensions = L.extensions.filter(x => sameKey(x.applicationKey, t.key)).map(x => x.name);
    if (!modules.length) return { possible: false, why: extensions.length ? EXTENSION_BACKUP_WHY : 'the application has no module to back up', ...(extensions.length ? { notBackedUp: extensions } : {}) };
    return { possible: true, how: `the published OML of ${modules.length} module${modules.length > 1 ? 's' : ''}`, modules,
      ...(extensions.length ? { notBackedUp: extensions, why: EXTENSION_BACKUP_WHY } : {}) };
  }
  // The next call after a preview: the token and the owner's reply. The words are the neutral marker (CX15 r2, T1): no
  // number and no name, so a copy of the template never confirms (checkExecute refuses any <...> and any server text).
  confirmCall(token, count, needed, extra = {}) {
    const out = { action: 'delete', host: this.host, confirmationToken: token, words: OWNER_REPLY };
    if (hostClass(this.host, this.registry) !== 'personal') out.confirmHost = this.host;
    return { ...out, ...extra };
  }
  // The notice of earlier deletes of these targets, for a refusal (its fresh preview lists them with previousDelete).
  earlierNotice(targets) {
    const earlier = targets.map(t => ({ name: t.name, previous: this.previousDeleteOf(t) })).filter(x => x.previous);
    return earlier.length ? { previousDelete: earlier.map(x => ({ name: x.name, ...x.previous })), notice: previousNotice(earlier) } : {};
  }
  refused(problems, extra = {}) {
    return { ok: false, action: 'delete', state: 'refused', code: 'DELETE_REFUSED', error: refusalError(problems), problems, ...extra };
  }
  // CX15 r3 (CT-5): the fields of a refusal after an interrupted operation (its process died): what that operation did,
  // from its record (deleted and uncertain by name, operation: its summary), and the next steps (ssam_task, then the new
  // preview of what is left); never deleted:[] when it deleted something.
  interruptedFields(record) {
    const of = state => record.items.filter(i => i.state === state);
    return { operation: summarizeOperation(record, { root: this.root }), deleted: of('deleted').map(i => ({ kind: i.kind, name: i.name, key: i.key, application: i.application ?? null })),
      ...(of('uncertain').length ? { uncertain: of('uncertain').map(i => i.name) } : {}),
      next: `read ssam_task {id:"${record.operationId}"} and tell the owner what the interrupted operation did (deleted, uncertain); this call sent nothing. `
        + 'Then show the owner the new preview of what is left (preview) and confirm it with its own token and the owner\'s new reply; never this token again',
      continuation: { tool: 'ssam_task', arguments: { id: record.operationId }, why: 'the record of the interrupted operation, item by item, before telling the owner anything' } };
  }

  // PREVIEW: the reads, then the exact list with its token; nothing reserved, nothing sent.
  async preview(request, words, L) {
    const parent = request.operationId ? this.journal.lookup(request.operationId) : null;
    if (!parent && !selected(request)) throw new ProtocolError('delete needs its targets: applications, modules, extensions or prefix (--target=<kind>:<name or key>, --prefix)');
    const { targets, problems, gone } = parent ? this.frozen(parent, request, L) : this.resolved(request, L);
    problems.push(...this.pending(targets));
    problems.push(...await this.dependencies(targets));
    const { external, edges } = this.externals(targets, L);
    const summary = this.summary(request, targets, external, gone);
    const base = { action: 'delete', ...(parent ? { resumes: parent.operationId } : {}) };
    const settled = [...gone.deleted, ...gone.absent].map(x => x.receipt).filter(Boolean);
    if (problems.length)
      return this.refused(problems, { ...base, ...summary, deleted: gone.deleted, receipts: settled, repeat: this.repeat(request, [], parent ? { operationId: parent.operationId } : {}) });
    if (!targets.length)
      return { ok: true, ...base, state: gone.deleted.length ? 'confirmed' : 'absent', operationId: parent?.operationId ?? null, deleted: gone.deleted, absent: gone.absent,
        deletedModules: [], affectedApplications: [], consumers: {}, receipts: settled };
    const ordered = DeleteEngine.order(targets, edges);
    const selection = parent ? { resumes: parent.operationId } : { prefix: request.prefix, prefixKind: request.prefix !== null ? request.prefixKind : null,
      targets: request.targets.map(t => `${t.kind}:${t.value}`), maxDeletes: request.maxDeletes };
    const items = ordered.map(t => this.item(t, L));
    const earlier = items.filter(i => i.previousDelete).map(i => ({ name: i.name, previous: i.previousDelete }));
    const notice = earlier.length ? previousNotice(earlier) : null;
    // CX15 r3 (CT-7): what goes without a backup is said in next, confirmWith and the error (and is a text of the server).
    const noBackup = noBackupNote(items);
    const block = createPreview({ tool: this.tool, lane: 'o11', host: this.host, operation: 'delete', selection, items,
      ownerRequest: request.ownerRequest, words, mustName: summary.wordsMustName, now: this.now(), root: this.root, uuid: this.previewUuid, serverTexts: [notice, noBackup].filter(Boolean), notes: noBackup ? [noBackup] : [] });
    // Words in a preview call were said before the list: CONFIRMATION_REQUIRED (the incident of 2026-10-14). --plan-only
    // asks only for the list.
    const asked = !request.planOnly && (words.trim() !== '' || request.execute);
    // The list is the preview's items (each with what goes with it and its consumers): the summary's copies of it
    // (targets, deletedModules, consumers) stay out of the answer, so a preview fits its answer budget.
    const { targets: _targets, deletedModules: _modules, consumers: _consumers, ...lean } = summary;
    const answer = { ok: !asked, ...base, ...(asked ? { code: 'CONFIRMATION_REQUIRED', error: TWO_CALLS } : {}), ...block, ...(notice ? { next: `${block.next} ${notice}` } : {}) };
    return { ...answer, ...withNoBackupNote(answer, noBackup), ...lean, deleted: gone.deleted, receipts: settled,
      repeat: this.confirmCall(block.confirmationToken, block.count, summary.wordsMustName) };
  }

  // EXECUTION: the targets of the token, read again; every problem at once; then the deletes in order.
  async confirm(request, words, L) {
    const token = request.confirmationToken;
    const selection = { targets: request.targets.map(t => `${t.kind}:${t.value}`), prefix: request.prefix };
    const head = checkExecute({ token, tool: this.tool, host: this.host, operation: 'delete', words, selection, now: this.now(), root: this.root, count: false });
    if (!head.preview || head.problems.some(p => ['OPERATION_CANCELLED', 'OPERATION_RUNNING'].includes(p.code)))
      return this.refused(head.problems, { ...(head.operation ? { operationId: head.operation.operationId, operation: head.operation } : {}) });
    const preview = head.preview;
    const asked = { prefix: preview.selection?.prefix ?? null, prefixKind: preview.selection?.prefixKind ?? 'application', targets: [] };
    const parent = this.journal.lookup(preview.operationId);
    // A token that already sent (its parent receipt exists) goes by state; one whose process died (interrupted) or whose
    // record has no receipt runs the checks below, which refuse the first and apply every rule to the second.
    if (parent && !head.interrupted) return this.byState(request, words, L, preview, parent, head);
    // The frozen targets as listed now; a prefix that matches more now adds them (and the list is stale).
    const targets = [];
    for (const item of preview.items) {
      const now = this.find(L, item.kind, item.key);
      if (now) targets.push({ ...now, via: item.via ?? 'list', ...(item.protected ? { protected: true } : {}), ...(item.moduleKind ? { moduleKind: item.moduleKind } : {}) });
    }
    if (asked.prefix !== null) for (const m of this.pool(asked.prefixKind, L).filter(r => fold(r.name).startsWith(fold(asked.prefix))).sort(byName))
      if (!targets.some(t => t.kind === m.kind && sameKey(t.key, m.key))) targets.push({ ...m, via: 'prefix', protected: isProtected(m.name) });
    for (const t of targets) if (t.kind !== 'application' && targets.some(a => a.kind === 'application' && sameKey(a.key, t.applicationKey))) t.withApplication = true;
    const problems = [...this.pending(targets), ...await this.dependencies(targets)];
    problems.push(...this.verifyProblems(targets));
    const { external, edges } = this.externals(targets, L);
    const ordered = DeleteEngine.order(targets, edges);
    if (request.authorizationContext && targets.length) {
      if (asked.prefix !== null) throw new ProtocolError('Context approval requires exact targets, never a prefix');
      asked.approval = authorizationContext(request.authorizationContext, words, { lane: 'o11', host: this.host, operation: 'delete', targets: targets.map(t => t.name) });
      // The approval's proposal is this preview (the owner approved the list it shows), so it necessarily came after it.
      if (asked.approval.proposalSha256 !== sha256Of(fs.readFileSync(previewFile(preview.previewId, { root: this.root }))))
        throw new ProtocolError(`The authorization context must approve the preview ${previewFile(preview.previewId, { root: this.root })} (its proposal file); nothing was sent`, 'AUTHORIZATION_CONTEXT_INVALID');
    }
    const check = checkExecute({ token, tool: this.tool, host: this.host, operation: 'delete', words, selection, current: ordered.map(t => this.item(t, L)),
      nameRule: () => [...this.hostProblems(words, request.confirmHost), ...this.wordProblems(asked, ordered, external, words)], now: this.now(), root: this.root, uuid: this.previewUuid,
      mustName: this.summary(asked, ordered, external, { absent: [], deleted: [] }).wordsMustName, used: Boolean(head.used) });
    problems.push(...check.problems);
    for (const t of ordered) t.backupPlan = this.executionPlan(t, L, preview);
    const summary = this.summary(asked, ordered, external, { absent: [], deleted: [] });
    const interrupted = check.interrupted ? check.operation : head.interrupted ? head.operation : null;
    if (problems.length)
      return this.refused(problems, { operationId: preview.operationId, ...summary, deleted: [], receipts: [], ...this.earlierNotice(ordered),
        ...(interrupted ? { ...this.interruptedFields(interrupted), error: refusalError(problems, interrupted) } : {}),
        ...(check.fresh ? { preview: check.fresh, repeat: this.confirmCall(check.fresh.confirmationToken, check.fresh.count, summary.wordsMustName) }
          : { repeat: this.confirmCall(token, preview.items.length, summary.wordsMustName) }) });
    return this.execute(request, words, ordered, summary, { absent: [], deleted: [] }, null, preview, asked.approval);
  }

  // A token whose operation already sent: by state (CX15 r2, A/B). Every rule runs again (expiry, host, count, names, the
  // list read now) and the owner's words must be NEW (CONFIRMATION_ALREADY_USED). Without a new preview only a target
  // whose last child is uncertain and that is still listed may be sent again (the rule of before: one more send, never a
  // third); a target never tried, or refused, needs a new preview and the owner's confirmation of it.
  async byState(request, words, L, preview, parent, head) {
    const { targets, problems, gone } = this.frozen(parent, { targets: [], prefix: null }, L);
    const settled = [...gone.deleted, ...gone.absent].map(x => x.receipt).filter(Boolean);
    const base = { action: 'delete', operationId: preview.operationId, ...(head.operation ? { operation: head.operation } : {}) };
    if (!targets.length && !problems.length)
      return { ok: true, ...base, state: gone.deleted.length ? 'confirmed' : 'absent', deleted: gone.deleted, absent: gone.absent, deletedModules: [], affectedApplications: [], consumers: {}, receipts: settled };
    const resend = targets.filter(t => t.previous && ['uncertain', 'accepted-unverified'].includes(t.previous.state));
    const waiting = targets.filter(t => !resend.includes(t));
    const pendingProblems = this.pending(resend);
    const dependencyProblems = (await this.dependencies(targets)).filter(p => resend.some(t => t.name === p.target));
    const { external, edges } = this.externals(resend, L);
    const asked = { prefix: preview.selection?.prefix ?? null, targets: [] };
    const gonePairs = [...gone.deleted, ...gone.absent];
    const expected = preview.items.filter(i => !gonePairs.some(g => g.kind === i.kind && sameKey(g.key, i.key)));
    const check = checkExecute({ token: request.confirmationToken, tool: this.tool, host: this.host, operation: 'delete', words,
      selection: { targets: request.targets.map(t => `${t.kind}:${t.value}`), prefix: request.prefix }, current: targets.map(t => this.item(t, L)), frozen: expected,
      nameRule: () => [...this.hostProblems(words, request.confirmHost), ...this.wordProblems(asked, resend.length ? resend : targets, external, words)],
      used: true, now: this.now(), root: this.root, uuid: this.previewUuid });
    problems.push(...pendingProblems, ...dependencyProblems, ...this.verifyProblems(resend), ...check.problems);
    const summary = this.summary(asked, resend, external, gone);
    const later = waiting.length ? { notStarted: waiting.map(t => t.name), next: `${waiting.map(t => t.name).join(', ')} never went out: a new preview (the call without confirmationToken) lists what is left, and the owner confirms that new list` } : {};
    if (problems.length)
      return this.refused(problems, { ...base, ...summary, deleted: gone.deleted, receipts: settled, ...this.earlierNotice(targets), ...(check.fresh ? { preview: check.fresh } : {}),
        repeat: this.confirmCall(request.confirmationToken, preview.items.length, summary.wordsMustName), ...later });
    if (!resend.length)
      return { ok: false, ...base, state: 'refused', code: 'NEW_PREVIEW_REQUIRED', error: 'Nothing of this token may be sent again without a new preview', deleted: gone.deleted, absent: gone.absent,
        receipts: settled, ...later };
    for (const t of resend) t.backupPlan = this.executionPlan(t, L, preview);
    const answer = await this.execute(request, words, DeleteEngine.order(resend, edges), summary, gone, parent, preview);
    return waiting.length ? { ...answer, notStarted: [...(answer.notStarted ?? []), ...later.notStarted], next: later.next } : answer;
  }

  lastChild(parentId, t) {
    for (const attempt of [3, 2, 1]) { const receipt = this.journal.lookup(derivedOperationId(parentId, t.kind, t.key, attempt)); if (receipt) return receipt; }
    return null;
  }

  // 5. The parent receipt (the preview's operationId), then each target once, in order; the first failure stops the rest.
  async execute(request, words, ordered, summary, gone, parent, preview, approval = null) {
    const operationId = parent?.operationId ?? preview.operationId;
    const frozen = ordered.map(t => ({ ...entry(t), via: t.via ?? 'list', ...(t.moduleKind ? { moduleKind: t.moduleKind } : {}), ...(t.withApplication ? { withApplication: true, applicationKey: t.applicationKey } : {}) }));
    // The durable record of the operation (ssam_task {id}): every item not-started, then each step as it happens. It
    // takes the lease of the operation first (CX15 r2, I): another execution of this token running now answers
    // OPERATION_RUNNING and sends nothing.
    let record;
    try { record = beginOperation({ preview, now: this.now(), root: this.root, words }); }
    catch (error) { if (error instanceof OperationRunning) return this.refused([error.problem], { operationId }); throw error; }
    // The record is open: ssam_task reads it from now on (CX15 r3, CT-2).
    this.requested?.done();
    let receipt;
    try {
      receipt = parent ?? this.journal.create(operationId, { host: this.host, action: 'delete', target: frozen.map(t => `${t.kind}:${t.key}`).sort().join(',') }, words,
        { host: this.host, action: 'delete', request: { previewId: preview.previewId, selection: preview.selection ?? null }, targets: frozen, ...(approval ? { authorizationContext: approval } : {}) });
    } catch (error) {
      endOperation(record, 'refused', { now: this.now(), root: this.root, notSent: true });
      if (error?.code === 'EEXIST') return this.refused([new OperationRunning(operationId, null).problem], { operationId });
      throw error;
    }
    // A record that cannot be written stops the rest (fail closed): the next items are not sent.
    let recordError = null;
    const mark = (t, patch) => {
      const item = record.items.find(i => i.kind === t.kind && sameKey(i.key, t.key));
      if (!item) return;
      try { markItem(record, item, patch, { now: this.now(), root: this.root }); } catch (error) { recordError ??= error; }
    };
    // Past the host rule, a write to a non-personal host tells the bridge it carries the explicit instruction.
    if (hostClass(this.host, this.registry) !== 'personal' && this.api.bridge) this.api.bridge.corporate = true;
    const deleted = [...gone.deleted]; const absent = [...gone.absent]; const notSent = []; const receipts = [receipt.receipt];
    const children = [...(receipt.children ?? [])]; const before = children.length;
    const deletedApps = new Set(); const uncertain = []; const refusedNames = []; const backups = [];
    let failure = null; let cancelledAt = null;
    // CX15 r2 (C1): the real time of the client's abort, and the send that was in flight when it came (that send went out:
    // a send is never cut). The signal is read at the top of each item AND right before each send (after the read again
    // and the backup), so an abort during either sends nothing more.
    let abortedAt = this.signal?.aborted ? utc() : null; let inFlight = null; const inFlightAtAbort = [];
    const onAbort = () => { abortedAt ??= utc(); if (inFlight) inFlightAtAbort.push(inFlight.name); };
    if (this.signal && !this.signal.aborted) this.signal.addEventListener('abort', onAbort, { once: true });
    const aborted = () => Boolean(abortedAt || this.signal?.aborted);
    // After each child the parent receipt is rewritten (o11_service_center_read receipt and verify see the progress).
    const progress = () => { Object.assign(receipt, { children, updatedAt: utc() }); this.journal.rewrite(receipt); };
    // CX15 r2 (C5): a local failure in the middle (a receipt that cannot be rewritten, a bridge failure of a send) never
    // leaves the record running: it closes uncertain with each item as known, the parent receipt keeps its children, and
    // the answer names the operation and the targets by state.
    try {
    for (const t of ordered) {
      // The client's cancellation stops the rest before its next item; a send in flight is never cut.
      if (!failure && !cancelledAt && aborted()) cancelledAt = abortedAt ?? utc();
      if (!failure && !cancelledAt && recordError)
        failure = { code: 'OPERATION_RECORD_FAILED', state: 'refused', target: t, error: `The record of this operation could not be written (${recordError.code ?? 'error'}); nothing more was sent` };
      if (failure || cancelledAt) { notSent.push(entry(t)); continue; }
      let now;
      try { now = await this.reread(t); }
      catch (error) { if (!(error instanceof ProtocolError)) throw error; failure = { code: error.code ?? 'REMOTE_ERROR', state: 'refused', target: t, error: `The listing could not be read again before deleting ${t.name}; nothing was sent for it` }; notSent.push(entry(t)); continue; }
      if (!now) {
        if (t.withApplication && deletedApps.has(fold(t.applicationKey))) { deleted.push({ ...entry(t), cascade: true }); mark(t, { state: 'deleted', cascade: true }); }
        else { absent.push(entry(t)); mark(t, { state: 'absent' }); }
        continue;
      }
      if (now.name !== t.name) { failure = { code: 'CONFLICT', state: 'refused', target: t, observed: now.name, error: `The key ${t.key} of ${t.name} is now named ${now.name}; nothing was sent for it and the remaining targets stopped` }; notSent.push(entry(t)); continue; }
      // The backup of the item, BEFORE its reservation: a failure sends nothing for it and stops the rest; a cancellation
      // between its modules leaves it not started.
      if (t.backupPlan?.possible && this.backup) {
        mark(t, { state: 'backing-up' });
        let saved;
        try { saved = await this.backup({ ...entry(t), modules: t.backupPlan.modules }, { operationId, host: this.host, signal: this.signal }); }
        catch (error) {
          const cause = redact(String(error?.message ?? error)).slice(0, 300);
          mark(t, { state: 'backup-failed', error: cause });
          failure = { code: 'BACKUP_FAILED', state: 'refused', target: t, error: `The backup of ${t.name} failed (${cause}); nothing was sent for it and the remaining targets stopped` };
          notSent.push(entry(t)); continue;
        }
        const files = Array.isArray(saved?.files) ? saved.files : [];
        if (saved?.cancelled) { mark(t, { state: 'not-started', backup: { files } }); cancelledAt ??= utc(); notSent.push(entry(t)); continue; }
        t.backupFiles = files; backups.push({ name: t.name, files });
        mark(t, { state: 'backed-up', backup: { files } });
      }
      // The last point before the send: an abort during the read again or the backup leaves this item not started.
      if (aborted()) { cancelledAt = abortedAt ?? utc(); mark(t, { state: 'not-started', ...(t.backupFiles ? { backup: { files: t.backupFiles } } : {}) }); notSent.push(entry(t)); continue; }
      let child;
      mark(t, { state: 'sending' });
      // CX15 r2 (C7): 'sending' is durable before the send, or there is no send (the record would not say it went out).
      if (recordError) {
        const unsent = record.items.find(i => i.kind === t.kind && sameKey(i.key, t.key));
        if (unsent) unsent.state = 'not-started';
        failure = { code: 'OPERATION_RECORD_FAILED', state: 'refused', target: t, error: `The record of this operation could not be written before sending ${t.name} (${recordError.code ?? 'error'}); nothing was sent for it and the remaining targets stopped` };
        notSent.push(entry(t)); continue;
      }
      inFlight = t;
      try { child = await this.sendOne(operationId, t, words); }
      catch (error) {
        inFlight = null;
        if (!(error instanceof ProtocolError) || error instanceof BridgeError) { mark(t, { state: 'uncertain', ...(inFlightAtAbort.includes(t.name) ? { cancelledInFlight: true } : {}) }); throw error; }
        failure = { code: 'TARGET_PENDING', state: 'refused', target: t, error: error.message }; notSent.push(entry(t)); mark(t, { state: 'not-started', error: 'TARGET_PENDING' }); continue;
      }
      inFlight = null;
      children.push({ kind: t.kind, key: t.key, name: t.name, operationId: child.operationId, state: child.state });
      receipts.push(child.receipt);
      const itemState = child.state === 'confirmed' ? 'deleted' : child.state === 'rejected' || child.state === 'refused' ? 'refused' : 'uncertain';
      // The record first (what happened to the target), then the parent receipt.
      mark(t, { state: itemState, receipt: child.receipt, receiptState: child.state, ...(child.cancelled ? { cancelled: true } : {}), ...(inFlightAtAbort.includes(t.name) ? { cancelledInFlight: true } : {}) });
      if (child.state === 'confirmed') deleted.push(entry(t));
      progress();
      if (child.state === 'confirmed') {
        if (t.kind === 'application') { deletedApps.add(fold(t.key)); for (const m of child.deletedModules ?? []) if (!summary.deletedModules.includes(m)) summary.deletedModules.push(m); }
        continue;
      }
      if (itemState === 'uncertain') uncertain.push(t.name); else refusedNames.push(t.name);
      if (child.cancelled) cancelledAt ??= utc();
      failure = child.state === 'rejected' ? { code: 'DELETE_REJECTED', state: 'refused', target: t, error: `The server rejected the delete of ${t.name}${child.message || child.error ? ': ' + (child.message || child.error) : ''}; the remaining targets stopped`, message: child.message ?? child.error ?? null }
        : child.state === 'accepted-unverified' ? { code: 'DELETE_UNCONFIRMED', state: 'uncertain', target: t, error: child.cancelled
          ? `${t.name} was accepted and the wait for it stopped at the cancellation; it may still be deleting: the target stays locked and nothing else was sent`
          : `${t.name} is still listed ${Math.round((child.waitedMs ?? 0) / 1000)} s after its delete was accepted; the target stays locked and the remaining targets stopped` }
          : child.state === 'refused' ? { code: child.code ?? 'NOT_ALLOWED', state: 'refused', target: t, error: child.error ?? `The bridge refused the delete of ${t.name}; nothing was sent` }
            : { code: 'UNCERTAIN', state: 'uncertain', target: t, error: `The delete of ${t.name} was sent but its answer was lost; it is never sent blind again` };
    }
    } catch (error) {
      this.signal?.removeEventListener?.('abort', onAbort);
      return this.localFailure(error, { record, receipt, children, ordered, deleted, absent, uncertain, refusedNames, receipts, operationId });
    }
    this.signal?.removeEventListener?.('abort', onAbort);
    // An abort that came during the last item (its read again, its backup or its send) still cancels the operation: the
    // answer is never 'confirmed' without cancelledAt.
    if (!cancelledAt && aborted()) cancelledAt = abortedAt ?? utc();
    const unsure = failure?.state === 'uncertain' || uncertain.length > 0;
    Object.assign(receipt, { children, state: unsure ? 'uncertain' : failure ? 'rejected' : cancelledAt ? 'cancelled' : 'confirmed', ok: !failure && !cancelledAt, updatedAt: utc(),
      outcome: { deleted: deleted.map(d => d.key), absent: absent.map(a => a.key), notSent: notSent.map(n => n.key), ...(cancelledAt ? { cancelledAt } : {}) } });
    try { this.journal.rewrite(receipt); }
    catch (error) { return this.localFailure(error, { record, receipt, children, ordered, deleted, absent, uncertain, refusedNames, receipts, operationId }); }
    try {
      endOperation(record, cancelledAt ? 'cancelled' : unsure ? 'uncertain' : failure ? (deleted.length ? 'partial' : 'refused') : 'completed',
        { now: this.now(), root: this.root, ...(cancelledAt ? { cancelledAt } : {}) });
    } catch { /* the receipts keep the outcome; the lease is released; the record stays running and reads orphaned once this process ends */ }
    const sent = children.length > before;
    const byName = { notStarted: notSent.map(n => n.name), uncertain, refused: refusedNames };
    const answer = { ok: !failure && !cancelledAt, action: 'delete', state: cancelledAt ? 'cancelled' : failure ? failure.state : sent || deleted.length ? 'confirmed' : 'absent', operationId: receipt.operationId,
      deleted, absent, ...(notSent.length ? { notSent } : {}), ...Object.fromEntries(Object.entries(byName).filter(([, list]) => list.length)),
      deletedModules: summary.deletedModules, affectedApplications: summary.affectedApplications,
      consumers: summary.consumers, ...(summary.named ? { named: summary.named } : {}), receipts,
      // The backups: their folder and count per item (each path and sha256 is in the child receipt and the operation record).
      ...(backups.length ? { backup: { dir: backupDir(operationId, { root: this.root }), files: backups.reduce((n, b) => n + b.files.length, 0), items: backups.map(b => ({ name: b.name, files: b.files.length })) } } : {}), operation: summarizeOperation(readOperation(operationId, { root: this.root }) ?? record, { root: this.root }) };
    // The send in flight when the abort came went out: the answer says so, never "nothing was sent after the cancellation".
    const flight = inFlightAtAbort.length ? { inFlightAtCancel: inFlightAtAbort } : {};
    const flightText = inFlightAtAbort.length ? `; the cancellation came while ${inFlightAtAbort.join(', ')} was being sent: that send went out (see deleted/uncertain), nothing was sent after it` : '; nothing was sent after the cancellation';
    if (cancelledAt && !failure)
      return { ...answer, ...flight, code: 'CANCELLED', cancelledAt, error: `Cancelled by the client after ${deleted.length} of ${ordered.length} target(s)${flightText}`,
        next: `read ssam_task {id:"${operationId}"}; a new call without confirmationToken previews what is left; this token never sends again` };
    if (!failure) return answer;
    const repeat = failure.state === 'uncertain' && !cancelledAt ? { repeat: this.confirmCall(request.confirmationToken, preview.items.length, summary.wordsMustName),
      next: `read ssam_task {id:"${receipt.operationId}"} and tell the owner what is uncertain; never repeat this call by yourself: a new send needs the owner's new reply` }
      : cancelledAt ? { cancelledAt, next: `read ssam_task {id:"${operationId}"}; a new call without confirmationToken previews what is left (an uncertain target is read again first)` } : {};
    return { ...answer, ...flight, ...(cancelledAt ? { cancelledAt } : {}), code: failure.code, error: failure.error, failed: entry(failure.target), ...(failure.observed ? { observed: failure.observed } : {}),
      ...(failure.message ? { message: failure.message } : {}), ...repeat };
  }

  // The answer of a local failure in the middle of the deletes (CX15 r2, C5): the record closed uncertain (an item caught
  // sending may have gone out; one caught backing up was not sent), the parent receipt rewritten with the children known,
  // and the names by state with the operation to read. Nothing is sent from here.
  localFailure(error, { record, receipt, children, ordered, deleted, absent, uncertain, refusedNames, receipts, operationId }) {
    const code = (error instanceof BridgeError || error instanceof ProtocolError) && error.code ? error.code : 'SC_LOCAL_FAILURE';
    const detail = redact(String(error instanceof ProtocolError || error instanceof BridgeError ? error.message : error?.code ?? error?.message ?? error)).slice(0, 200);
    for (const item of record.items) {
      if (item.state === 'sending') item.state = 'uncertain';
      else if (item.state === 'backing-up') item.state = 'not-started';
    }
    const names = state => record.items.filter(i => i.state === state).map(i => i.name);
    try { Object.assign(receipt, { children, state: 'uncertain', ok: false, updatedAt: utc(), localFailure: code }); this.journal.rewrite(receipt); } catch { /* the record says it */ }
    try { endOperation(record, 'uncertain', { now: this.now(), root: this.root, localFailure: code }); } catch { /* the lease is released; the record reads orphaned once this process ends */ }
    const deletedNames = [...new Set([...deleted.map(d => d.name), ...names('deleted')])];
    return { ok: false, action: 'delete', state: 'uncertain', code, operationId, stage: 'service-center',
      error: `The deletes stopped on a local failure (${detail}) after ${deletedNames.length} of ${ordered.length} target(s); read ssam_task {id:"${operationId}"} before telling the owner anything`,
      deleted, absent, uncertain: [...new Set([...uncertain, ...names('uncertain')])], notStarted: names('not-started'), ...(refusedNames.length ? { refused: refusedNames } : {}),
      receipts, operation: summarizeOperation(readOperation(operationId, { root: this.root }) ?? record, { root: this.root }),
      next: `read ssam_task {id:"${operationId}"} and tell the owner item by item; never repeat this call by yourself: a new send needs a new preview or the owner's new reply` };
  }

  async reread(t) {
    if (t.kind === 'application') return items(await this.call('soap', 'ListApplications', { withIcons: false })).map(r => ({ key: text(field(r, 'Key', 'ApplicationKey', 'AppKey')), name: text(field(r, 'Name')) }))
      .find(r => sameKey(r.key, t.key)) ?? null;
    const rows = items(await this.call('soap', t.kind === 'extension' ? 'ListExtensions' : 'ListEspaces', {}));
    return rows.map(r => ({ key: text(field(r, 'Key', 'ESpaceKey', 'ModuleKey', 'ExtensionKey', 'SS_Key')), name: text(field(r, 'Name')) })).find(r => sameKey(r.key, t.key)) ?? null;
  }

  // One child: its reservation (the target lock), ONE send, then the wait until the key is gone.
  async sendOne(parentId, t, words) {
    // A resend after an uncertain child, or a send after a child the bridge refused (never sent), takes the next attempt.
    const prior = t.supersede ?? t.previous ?? null;
    const attempt = prior ? (prior.plan?.attempt ?? 1) + 1 : 1;
    if (attempt > 3) throw new ProtocolError(`${t.name} already has ${attempt - 1} delete receipts in this operation; start a new call`);
    const operationId = derivedOperationId(parentId, t.kind, t.key, attempt);
    const identity = { host: this.host, action: 'delete', kind: t.kind, target: text(t.key) };
    const plan = { host: this.host, action: 'delete', kind: t.kind, ...(t.moduleKind ? { moduleKind: t.moduleKind } : {}), key: t.key, name: t.name,
      application: t.application ?? null, parent: parentId, attempt, ...(t.deletedModules ? { deletedModules: t.deletedModules } : {}),
      ...(t.affectedApplications ? { affectedApplications: t.affectedApplications } : {}), ...(t.consumers ? { consumers: t.consumers } : {}),
      ...(t.supersede ? { supersedes: t.supersede.operationId } : {}), ...(t.backupFiles ? { backup: { files: t.backupFiles } } : {}) };
    if (t.supersede) this.journal.supersede(t.supersede, operationId);
    for (const ref of [t.name, t.key]) this.journal.point({ host: this.host, kind: t.kind, ref: fold(ref) }, operationId);
    return this.journal.reserve(operationId, identity, words, plan, lockOf(this.host, t), async receipt => {
      receipt.plan = plan;
      try {
        // target names the key of the arguments, so the bridge checks the destructive call is the one planned.
        const result = t.kind === 'application'
          ? await this.send('soap', 'DeleteApplication', { appKey: t.key, simulate: false }, receipt, t.key)
          : await this.send('soap', 'DeleteModule', { moduleKey: t.key, moduleKind: t.moduleKind }, receipt, t.key);
        const accepted = isObject(result) ? field(result, 'success', 'returnValue') : result;
        const messages = messagesOf(isObject(result) ? field(result, 'messages', 'message') : null);
        if (accepted === false) Object.assign(receipt, { state: 'rejected', message: messages.join('; ') || null, messages });
        else {
          if (t.kind === 'application') receipt.deletedModules = nameList(field(result, 'deletedModules', 'deletedComponents'));
          // The wait for the real state stops at once when the client cancels (the send itself is never cut).
          const gone = await waitFor(async () => {
            try { return !(await this.reread(t)); } catch (error) { if (error instanceof ProtocolError) return false; throw error; }
          }, { ...this.wait, signal: this.signal });
          Object.assign(receipt, { state: gone.done ? 'confirmed' : 'accepted-unverified', messages, reads: gone.attempts, waitedMs: gone.waitedMs, ...(gone.cancelled ? { cancelled: true } : {}) });
        }
      } catch (error) {
        if (error instanceof BridgeError) Object.assign(receipt, bridgeFailure(error, {}, identity));
        else Object.assign(receipt, { state: 'uncertain', ok: false, error: 'Response or readback was not confirmed; the same call reads the state before anything else' });
      }
      receipt.ok = receipt.state === 'confirmed';
      receipt.updatedAt = utc();
      return receipt;
    });
  }

  // verify of a delete receipt (parent or child): reads only; an uncertain child read as gone closes confirmed.
  async verify(receipt) {
    const children = receipt.plan?.parent ? [receipt] : (receipt.children ?? []).map(c => this.journal.lookup(c.operationId)).filter(Boolean);
    const L = await this.listings();
    let observed = children.length > 0;
    for (const child of children) {
      const present = this.find(L, child.plan?.kind, child.plan?.key);
      if (present) {
        observed = false;
        // CX15 r2 (C4): read still listed after an unsure send: the next send of it is no longer blind.
        if (UNSURE.includes(child.state) && this.journal.rawState(child.operationId) !== 'sending')
          try { child.verifiedPresentAt = utc(); this.journal.rewrite(child); } catch { /* the next verify writes it */ }
        continue;
      }
      if (UNSURE.includes(child.state) && this.journal.rawState(child.operationId) !== 'sending') {
        try { this.journal.reconcile(child); } catch (error) { if (!(error instanceof ProtocolError)) throw error; }
      }
    }
    if (!receipt.plan?.parent && observed && receipt.state !== 'confirmed') {
      Object.assign(receipt, { state: 'confirmed', ok: true, reconciledAt: utc(), children: (receipt.children ?? []).map(c => ({ ...c, state: this.journal.lookup(c.operationId)?.state ?? c.state })) });
      this.journal.rewrite(receipt);
    }
    return { ...(this.journal.lookup(receipt.operationId) ?? receipt), observedDesiredState: observed, replayed: false };
  }
}
