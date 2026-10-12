// Delete O11 applications, modules and extensions in ONE call, through the connected Studio's own Service Center API
// (bridge sc_api: DeleteApplication, DeleteModule), never through Factory pages (contract docs/INTEGRACOES-GITSSAM.md,
// lane scdelete, D1-D4). The call delivers a coherent result or refuses BEFORE any change with every problem at once:
//   1. the bridge must list the six operations it needs in its serviceCenter catalog (STUDIO_BRIDGE_OUTDATED);
//   2. targets come from ONE read of each listing, by exact name or key; a prefix matches case-insensitively within its
//      kind, at most maxDeletes (25, up to 100); protected apps matched by a prefix pass only when named whole;
//   3. dependencies are reads: the server's own simulation for an application (DeleteApplication simulate:true:
//      deletedModules, affectedApplications), GetConsumers for a module or an extension; an error or an unreadable shape
//      fails closed (DEPENDENCY_CHECK_UNAVAILABLE): nothing is deleted blind;
//   4. the user's words name every target as a whole word (or the prefix, which names its matches: PREFIX_WORDS_NAME_ALL)
//      and every consumer outside the set (CONSUMERS_WOULD_BREAK); a standing grant never covers a delete;
//   5. then a parent receipt with the frozen targets and one child receipt per target (operationId derived from the
//      parent and the key), consumers before producers; each target is read again right before its single send (gone:
//      absent; same key, other name: CONFLICT, stop) and the call waits for the real state (about 30 s) until the key is
//      gone (confirmed) or answers DELETE_UNCONFIRMED keeping the target lock.
// A repeated call answers by state: a target already gone is absent with its last receipt and nothing is sent; an
// uncertain child read as gone closes confirmed; read as still there, unchanged, it allows exactly one new send. The
// model never polls and never needs verify.
import crypto from 'node:crypto';
import { authorizationContext } from '../authorization-context.mjs';
import { redact } from './bridge.mjs';
import { guardWrite, hostClass, hostsFile, namesWhole } from './auth.mjs';
import { BridgeError, ProtocolError, Refusal, connectStudio } from './errors.mjs';
import { bridgeFailure } from './client.mjs';
import { field, items, messageOf } from './studio-api.mjs';
import { canonicalUuid, fold, same, utc, waitFor } from './util.mjs';

// D2: the prefix, as a whole word of the user's words, names every target it matches (protected ones excepted).
export const PREFIX_WORDS_NAME_ALL = true;
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

const text = value => (value === null || value === undefined ? '' : String(value));
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

// A deterministic UUID (version 5 layout) of a parent operation and the parts that name one child of it.
export function derivedOperationId(parent, ...parts) {
  const hex = crypto.createHash('sha256').update([text(parent).toLowerCase(), ...parts.map(text)].join('\n'), 'utf8').digest('hex').slice(0, 32).split('');
  hex[12] = '5'; hex[16] = '89ab'[parseInt(hex[16], 16) & 3];
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

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

// The request of a delete or of one of its aliases (D4), from the parsed arguments of index.mjs. module-delete takes
// --module/--module-key (eSpace or extension; --module-kind Extension: the extension), extension-delete also --extension,
// application-delete --application/--application-key. With words it executes; --plan-only (execute:false) only plans.
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
  if (!targets.length && prefix === null)
    throw new ProtocolError('delete needs its targets: applications, modules, extensions or prefix (--target=<kind>:<name or key>, --prefix)');
  const words = text(args.words);
  if (args.execute && !words.trim()) throw new ProtocolError("Execution requires the user's own authorization words (they name every target)");
  if (args.execute && args.plan_only) throw new ProtocolError('--execute and --plan-only exclude each other');
  const operationId = args.operation_id ? canonicalUuid(text(args.operation_id)) : null;
  if (args.operation_id && !operationId) throw new ProtocolError('operation-id must be a UUID');
  return { targets, prefix: prefix === null ? null : prefix.trim(), prefixKind, maxDeletes, words, confirmHost: args.confirm_host ?? null,
    operationId, planOnly: Boolean(args.plan_only), authorizationContext: args.authorization_context ?? undefined };
}
// What identifies a delete request across repetitions with the same operationId.
const requestSpec = r => ({ targets: r.targets.map(t => `${t.kind}:${t.value}`).sort(), prefix: r.prefix, prefixKind: r.prefix ? r.prefixKind : null, maxDeletes: r.maxDeletes });

export class DeleteEngine {
  // api: the StudioApi of the host (its bridge carries the Studio's session). journal: the Service Center journal.
  constructor(api, { journal, registry = hostsFile(), uuid = () => crypto.randomUUID(), sleep = undefined, wait = {}, consumerNames = null } = {}) {
    if (!journal) throw new ProtocolError('A delete needs the durable journal');
    this.api = api; this.host = api.host; this.journal = journal; this.registry = registry; this.uuid = uuid;
    this.wait = { ...wait, ...(sleep ? { sleep } : {}) }; this.consumerNamesFn = consumerNames;
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

  // The whole call. request: deleteRequest(...).
  async run(request) {
    const words = text(request.words);
    const execute = !request.planOnly && words.trim() !== '';
    await this.gate();
    const L = await this.listings();
    const parent = request.operationId ? this.journal.lookup(request.operationId) : null;
    let targets; const problems = []; const gone = { absent: [], deleted: [] };
    if (parent) {
      // The same operationId again: its frozen targets, by state.
      if (parent.identity?.action !== 'delete' || parent.identity.host !== this.host || !Array.isArray(parent.plan?.targets) || parent.plan?.parent)
        throw new ProtocolError('operation-id already belongs to a different target or operation');
      if (!same(parent.plan.request, requestSpec(request))) throw new ProtocolError('operation-id already belongs to a delete of other targets');
      targets = [];
      for (const frozen of parent.plan.targets) {
        const now = this.find(L, frozen.kind, frozen.key);
        const last = this.lastChild(parent.operationId, frozen);
        if (!now) { const settled = this.settleGone(frozen, last); if (settled.deleted) gone.deleted.push(settled.deleted); else gone.absent.push(settled.absent); continue; }
        if (now.name !== frozen.name) { problems.push(problem('CONFLICT', `The key ${frozen.key} of ${frozen.name} is now named ${now.name}`, 'a new call that names the target as it is now', { target: frozen.name, observed: now.name })); continue; }
        if (last?.state === 'rejected') { problems.push(problem('DELETE_REJECTED', `The server rejected the delete of ${frozen.name}${last.message ? ': ' + last.message : ''}`, 'what the server message asks, then a new call', { target: frozen.name, operationId: last.operationId })); continue; }
        targets.push({ ...now, ...frozen, application: now.application ?? frozen.application, withApplication: frozen.withApplication, ...(last ? { previous: last } : {}) });
      }
    } else {
      const resolved = this.resolve(request, L);
      targets = resolved.targets; problems.push(...resolved.problems);
      for (const spec of resolved.missing) {
        const prior = this.priorReceipt(spec);
        if (prior) { const settled = this.settleGone({ kind: prior.plan?.kind ?? spec.kind, name: prior.plan?.name ?? spec.value, key: prior.plan?.key ?? null, application: prior.plan?.application ?? null }, prior); if (settled.deleted) gone.deleted.push(settled.deleted); else gone.absent.push(settled.absent); }
        else problems.push(problem('TARGET_NOT_FOUND', `No ${spec.kind === 'module' ? 'module or extension' : spec.kind} is named (or keyed) "${spec.value}"`, spec.nearest.length ? `one of: ${spec.nearest.join(', ')}` : 'the exact name or key from the listing',
          { target: spec.value, nearest: spec.nearest }));
      }
    }
    problems.push(...this.pending(targets));
    problems.push(...await this.dependencies(targets));
    const { external, edges } = this.externals(targets, L);
    if (execute && request.authorizationContext && targets.length) {
      if (request.prefix) throw new ProtocolError('Context approval requires exact targets, never a prefix');
      request.approval = authorizationContext(request.authorizationContext, words, { lane: 'o11', host: this.host, operation: 'delete', targets: targets.map(t => t.name) });
    }
    if (execute) problems.push(...this.hostProblems(words, request.confirmHost), ...this.wordProblems(request, targets, external, words));
    const summary = this.summary(request, targets, external, gone);
    const base = { action: 'delete', ...(parent ? { operationId: parent.operationId } : {}) };
    const settled = [...gone.deleted, ...gone.absent].map(x => x.receipt).filter(Boolean);
    if (problems.length)
      return { ok: false, ...base, state: 'refused', code: 'DELETE_REFUSED', error: `${problems.length} problem${problems.length > 1 ? 's' : ''}; nothing was reserved or sent`,
        problems, ...summary, deleted: gone.deleted, receipts: settled, repeat: this.repeat(request, summary.wordsMustName, parent ? { operationId: parent.operationId } : {}) };
    if (!execute)
      return { ok: true, ...base, state: 'planned', ...summary, deleted: gone.deleted, receipts: settled, repeat: this.repeat(request, summary.wordsMustName) };
    if (!targets.length)
      return { ok: true, ...base, state: gone.deleted.length ? 'confirmed' : 'absent', operationId: parent?.operationId ?? null, deleted: gone.deleted, absent: gone.absent,
        deletedModules: [], affectedApplications: [], consumers: {}, receipts: settled };
    return this.execute(request, words, DeleteEngine.order(targets, edges), summary, gone, parent);
  }

  lastChild(parentId, t) {
    for (const attempt of [3, 2, 1]) { const receipt = this.journal.lookup(derivedOperationId(parentId, t.kind, t.key, attempt)); if (receipt) return receipt; }
    return null;
  }

  // 5. The parent receipt, then each target once, in order; the first failure stops the rest.
  async execute(request, words, ordered, summary, gone, parent) {
    const operationId = parent?.operationId ?? (request.operationId ? request.operationId : this.uuid());
    const frozen = ordered.map(t => ({ ...entry(t), ...(t.moduleKind ? { moduleKind: t.moduleKind } : {}), ...(t.withApplication ? { withApplication: true, applicationKey: t.applicationKey } : {}) }));
    const receipt = parent ?? this.journal.create(operationId, { host: this.host, action: 'delete', target: frozen.map(t => `${t.kind}:${t.key}`).sort().join(',') }, words,
      { host: this.host, action: 'delete', request: requestSpec(request), targets: frozen, ...(request.approval ? { authorizationContext: request.approval } : {}) });
    // Past the host rule, a write to a non-personal host tells the bridge it carries the explicit instruction.
    if (hostClass(this.host, this.registry) !== 'personal' && this.api.bridge) this.api.bridge.corporate = true;
    const deleted = [...gone.deleted]; const absent = [...gone.absent]; const notSent = []; const receipts = [receipt.receipt];
    const children = [...(receipt.children ?? [])]; const before = children.length;
    const deletedApps = new Set();
    let failure = null;
    for (const t of ordered) {
      if (failure) { notSent.push(entry(t)); continue; }
      let now;
      try { now = await this.reread(t); }
      catch (error) { if (!(error instanceof ProtocolError)) throw error; failure = { code: error.code ?? 'REMOTE_ERROR', state: 'refused', target: t, error: `The listing could not be read again before deleting ${t.name}; nothing was sent for it` }; notSent.push(entry(t)); continue; }
      if (!now) {
        if (t.withApplication && deletedApps.has(fold(t.applicationKey))) deleted.push({ ...entry(t), cascade: true }); else absent.push(entry(t));
        continue;
      }
      if (now.name !== t.name) { failure = { code: 'CONFLICT', state: 'refused', target: t, observed: now.name, error: `The key ${t.key} of ${t.name} is now named ${now.name}; nothing was sent for it and the remaining targets stopped` }; notSent.push(entry(t)); continue; }
      let child;
      try { child = await this.sendOne(operationId, t, words); }
      catch (error) {
        if (!(error instanceof ProtocolError) || error instanceof BridgeError) throw error;
        failure = { code: 'TARGET_PENDING', state: 'refused', target: t, error: error.message }; notSent.push(entry(t)); continue;
      }
      children.push({ kind: t.kind, key: t.key, name: t.name, operationId: child.operationId, state: child.state });
      receipts.push(child.receipt);
      if (child.state === 'confirmed') {
        deleted.push(entry(t));
        if (t.kind === 'application') { deletedApps.add(fold(t.key)); for (const m of child.deletedModules ?? []) if (!summary.deletedModules.includes(m)) summary.deletedModules.push(m); }
        continue;
      }
      failure = child.state === 'rejected' ? { code: 'DELETE_REJECTED', state: 'refused', target: t, error: `The server rejected the delete of ${t.name}${child.message || child.error ? ': ' + (child.message || child.error) : ''}; the remaining targets stopped`, message: child.message ?? child.error ?? null }
        : child.state === 'accepted-unverified' ? { code: 'DELETE_UNCONFIRMED', state: 'uncertain', target: t, error: `${t.name} is still listed ${Math.round((child.waitedMs ?? 0) / 1000)} s after its delete was accepted; the target stays locked and the remaining targets stopped` }
          : child.state === 'refused' ? { code: child.code ?? 'NOT_ALLOWED', state: 'refused', target: t, error: child.error ?? `The bridge refused the delete of ${t.name}; nothing was sent` }
            : { code: 'UNCERTAIN', state: 'uncertain', target: t, error: `The delete of ${t.name} was sent but its answer was lost; it is never sent blind again` };
    }
    Object.assign(receipt, { children, state: failure ? (failure.state === 'uncertain' ? 'uncertain' : 'rejected') : 'confirmed', ok: !failure, updatedAt: utc(),
      outcome: { deleted: deleted.map(d => d.key), absent: absent.map(a => a.key), notSent: notSent.map(n => n.key) } });
    this.journal.rewrite(receipt);
    const sent = children.length > before;
    const answer = { ok: !failure, action: 'delete', state: failure ? failure.state : sent || deleted.length ? 'confirmed' : 'absent', operationId: receipt.operationId,
      deleted, absent, ...(notSent.length ? { notSent } : {}), deletedModules: summary.deletedModules, affectedApplications: summary.affectedApplications,
      consumers: summary.consumers, ...(summary.named ? { named: summary.named } : {}), receipts };
    if (!failure) return answer;
    const repeat = failure.state === 'uncertain' ? { repeat: this.repeat(request, summary.wordsMustName, { operationId: receipt.operationId }),
      next: 'repeat this same call with this operationId: it reads the state, closes a delete that took effect and never sends blind' } : {};
    return { ...answer, code: failure.code, error: failure.error, failed: entry(failure.target), ...(failure.observed ? { observed: failure.observed } : {}),
      ...(failure.message ? { message: failure.message } : {}), ...repeat };
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
      ...(t.supersede ? { supersedes: t.supersede.operationId } : {}) };
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
          const gone = await waitFor(async () => {
            try { return !(await this.reread(t)); } catch (error) { if (error instanceof ProtocolError) return false; throw error; }
          }, this.wait);
          Object.assign(receipt, { state: gone.done ? 'confirmed' : 'accepted-unverified', messages, reads: gone.attempts, waitedMs: gone.waitedMs });
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
      if (present) { observed = false; continue; }
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
