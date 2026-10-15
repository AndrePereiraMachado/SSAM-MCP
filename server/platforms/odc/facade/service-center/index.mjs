// The Service Center tools in the facade process (port of kernel/scripts/o11_service_center.py): o11_service_center_
// session/read/write call runServiceCenter(argv) with the same arguments the Python entry point took, and get the same
// JSON it printed. Authentication per call and host (auth.mjs): the connected Studio's native APIs and headless HTTP,
// otherwise the stored credential profile of the host, and only with nothing stored the private Windows prompt. Writes prepare
// by default; executing needs the user's words, an operationId UUID and the journal reservation, and is never repeated.
// delete and its aliases (delete.mjs) are one call: with the words they execute, the operationId is minted when absent.
// deps (all optional, for tests): journal, locate, present, opener, running, exports, registry, env, root, send, origin,
// powershell (a PowerShell runner), credential ({setup, read} vault fragments), sleep and wait (the bounded waits),
// uuid (the minted operationId) and consumerNames (the GetConsumers reader), so nothing real is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anvilRoot } from '../workspace.mjs';
import { SEAM_CODES, hostedContext, seamFields, usesWorkspace, workspacePath } from '../executor.mjs';
import { AuthRequired, BridgeError, ProtocolError, connectStudio } from './errors.mjs';
import { Auth, Resolver, credentialTarget, guardWrite, hostClass, hostedNoPrompt, hostedStudioOnly, hostsFile, openPrompt, promptAndWait, promptWaitMs, storedProfile,
  studioRunning } from './auth.mjs';
import { locateStudioBridge, redact } from './bridge.mjs';
import { ACTIONS, Client, Journal, LOG_PAGES, SCHEDULE, SECRET_WRITES, WEB_WRITES } from './client.mjs';
import { StudioWebTransport, Transport, hostName } from './http.mjs';
import { DESTRUCTIVE as API_DESTRUCTIVE, READS as API_READ_TABLE, StudioApi, WRITES as API_WRITE_TABLE } from './studio-api.mjs';
import { DELETE_ACTIONS, DeleteEngine, deleteRequest } from './delete.mjs';
import { createPowerShellRunner, createVault, vaultPresent } from './vault.mjs';
import { CredentialProfiles } from '../credential-profiles.mjs';
import { boundedRead } from '../read-budget.mjs';
import { sha256 } from './util.mjs';
import { ServiceCenterSso } from './sso.mjs';
import { ownedSsoJar } from './solution-download.mjs';
import { ownSsoSessions } from './sso-session-cache.mjs';
import { readOptions } from '../read-budget.mjs';
import { approveDatabasePlan, DB_APPROVAL_ACTIONS } from './db-approval.mjs';
import { authorizationContext } from '../authorization-context.mjs';
import {readPerformanceEvents} from './performance-events.mjs';

export const SESSION = ['session-status', 'session-sign-in', 'session-web-sign-in', 'session-close'];
export const WEB_READS = ['lifetime-capabilities', 'lifetime-web-status', 'timer-events', 'timers', 'site-properties', 'property-value', 'logs', 'integration-log-detail', 'error-detail', 'trace', 'bpt-processes', 'bpt-process',
  'bpt-instance', 'bpt-activity', 'integrations', 'integration-detail', 'db-connections', 'application-runtime-settings', 'solutions', 'solution-versions', 'solution-download', 'solution-download-status', 'async-operation-status', 'page-layout', 'module-references', 'module-dependencies', 'application-dependency-graph', 'application-relationships', 'application-owners'];
const API_READS = Object.keys(API_READ_TABLE);
export const READS = ['capabilities', 'receipt', ...WEB_READS, ...API_READS];
// delete (service-center/delete.mjs): applications, modules and extensions in one call; module-delete, extension-delete and
// application-delete are its aliases (D4).
export const WRITES = [...Object.keys(ACTIONS), ...Object.keys(WEB_WRITES), ...Object.keys(API_WRITE_TABLE), 'delete'];
const DESTRUCTIVE = new Set(['solution-delete', 'db-connection-delete', ...API_DESTRUCTIVE]);
const FLAGS = ['event-auth', 'application', 'module', 'message', 'source', 'server', 'since', 'until', 'error-id', 'request-key', 'operation-id', 'words',
  'application-offset', 'application-batch-size', 'expected-selection-sha256', 'owner-parallelism', 'module-offset', 'module-batch-size', 'expected-module-selection-sha256', 'module-selection-id',
  'expected-value', 'value', 'value-file', 'value-vault', 'application-key', 'extension-key', 'logical-database', 'module-key', 'element-key', 'solution', 'component', 'description', 'osp-file', 'publish-id',
  'last-message-id', 'async-operation-id', 'apply-id', 'database-id', 'process', 'process-key', 'process-id', 'activity-id', 'integration', 'integration-kind', 'level',
  'connection', 'dbms', 'db-server', 'db-database', 'extension', 'extension-id', 'confirm-host', 'stack-contains', 'log-type', 'log-action',
  'timer', 'path', 'to-application', 'to-application-key', 'from-application-key', 'module-kind', 'version', 'commit-message', 'xif-file',
  'prefix', 'prefix-kind', 'max-deletes', 'expected-version-id', 'authorization-context', 'question',
  ...Object.keys(SCHEDULE).map(k => 'schedule-' + k)];
// logs filter -> parsed attribute
const LOG_FILTER_ARGS = { application: 'application', module: 'module', message: 'message', source: 'source', server: 'server', since: 'since',
  until: 'until', type: 'log_type', action: 'log_action', timer: 'timer' };
const CHOICES = { 'event-auth':['basic','service-token'], session: ['auto', 'studio', 'studio-web', 'vault'], 'auth-prompt': ['auto', 'never'], surface: ['service-center', 'lifetime'], kind: Object.keys(LOG_PAGES) };
// verify and discard act on a receipt of the local journal (P6): verify reads the target and resolves what the reading
// proves; discard closes an uncertain receipt with the user's words naming its target. Neither sends anything.
const RECEIPT_ACTIONS = ['verify', 'discard'];
// Local writes: authorized by the user's words, they change only SSAM's own records; nothing is sent to the server.
export const LOCAL_WRITES = ['solution-download-abandon'];
const ACTION_CHOICES = [...new Set([...SESSION, ...READS, ...WRITES, ...LOCAL_WRITES, ...RECEIPT_ACTIONS])];
const SWITCHES = ['capture-module-selection', 'include-system', 'include-references', 'export', 'reveal', 'execute', 'plan-only'];
const VALUED = ['host', 'credential-target', 'session', 'auth-prompt', 'surface', 'module-id', 'name', 'kind', 'limit', 'max-pages', 'module-limit', 'application-id', 'application-limit', 'application-source', ...FLAGS];
// Flags that may repeat (append): --param label=value, --target <kind>:<name or key>.
const APPEND = ['param', 'target', 'graph-application'];
const attribute = flag => flag.replaceAll('-', '_');
const quoted = list => list.map(v => `'${v}'`).join(', ');

// argparse of the Python entry point: --flag=value or --flag value, choices, int, append and store_true.
export function parseArgs(argv) {
  const args = { session: 'auto', auth_prompt: 'auto', surface: 'service-center', kind: 'error', limit: 100, max_pages: 20, param: [], target: [], 'graph-application': [] };
  for (const flag of [...VALUED, 'credential-target']) if (!(attribute(flag) in args)) args[attribute(flag)] = null;
  for (const flag of SWITCHES) args[attribute(flag)] = false;
  let action = null;
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);
    if (!token.startsWith('--')) {
      if (action !== null) throw new ProtocolError('unrecognized arguments: ' + token);
      if (!ACTION_CHOICES.includes(token)) throw new ProtocolError(`argument action: invalid choice: '${token}' (choose from ${quoted(ACTION_CHOICES)})`);
      action = token; continue;
    }
    const eq = token.indexOf('=');
    const flag = eq < 0 ? token.slice(2) : token.slice(2, eq);
    if (SWITCHES.includes(flag)) {
      if (eq >= 0) throw new ProtocolError(`argument --${flag}: ignored explicit argument '${token.slice(eq + 1)}'`);
      args[attribute(flag)] = true; continue;
    }
    if (!VALUED.includes(flag) && !APPEND.includes(flag)) throw new ProtocolError('unrecognized arguments: ' + token);
    let value;
    if (eq >= 0) value = token.slice(eq + 1);
    else { if (i + 1 >= argv.length) throw new ProtocolError(`argument --${flag}: expected one argument`); value = String(argv[++i]); }
    if (CHOICES[flag] && !CHOICES[flag].includes(value)) throw new ProtocolError(`argument --${flag}: invalid choice: '${value}' (choose from ${quoted(CHOICES[flag])})`);
    if (['limit','max-pages','module-limit','application-limit','application-offset','application-batch-size','owner-parallelism','module-offset','module-batch-size'].includes(flag)) {
      if (!/^\s*[+-]?\d+\s*$/.test(value)) throw new ProtocolError(`argument --${flag}: invalid int value: '${value}'`);
      args[attribute(flag)] = Number(value);
    } else if (APPEND.includes(flag)) args[flag].push(value);
    else args[attribute(flag)] = value;
  }
  if (action === null) throw new ProtocolError('the following arguments are required: action');
  args.action = action;
  return args;
}

function required(args, ...names) {
  if (names.some(n => !args[n])) throw new ProtocolError('Required: ' + names.map(n => '--' + n.replaceAll('_', '-')).join(', '));
}

function valueFile(file) {
  if (!path.isAbsolute(file) || fs.statSync(file).size > 1024 * 1024) throw new ProtocolError('Use an absolute UTF-8 value file of at most 1 MiB');
  return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)).replace(/^﻿/, '');
}

// All checkouts and both the user's and the Claude app's processes share one journal outside %LOCALAPPDATA% (the MSIX
// app sees a private copy of it); receipts already written there still answer for their IDs. .ssam-hybrid, never .ssam:
// that folder belongs to GitSSAM (credentials, browser profiles).
// Hosted (../executor.mjs): the customer's <ws>/o11/service-center/receipts, and no legacy folder of this machine.
export function journalDefault(env = process.env) {
  if (hostedContext()) return new Journal(workspacePath('o11', 'service-center', 'receipts'));
  const home = env.USERPROFILE || os.homedir();
  const legacy = path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'SSAM', 'O11', 'ServiceCenter', 'receipts');
  return new Journal(env.SSAM_SC_RECEIPTS || path.join(home, '.ssam-hybrid', 'o11', 'service-center', 'receipts'), legacy);
}

export function capabilities() {
  return { ok: true, protocol: 'Native Service Studio APIs and headless HTTP for Service Center pages (sc_http); no window transport.',
  authentication: 'studio (the connected Studio\'s own session) -> the stored credential profile of the host (Windows Credential Manager, '
    + 'credential-profiles) -> only when the host has nothing stored, the private Windows prompt (windows-o11-credential.ps1 -Mode bootstrap) '
    + 'in its own window, waited for in the same call up to SSAM_PROMPT_WAIT_MS (never past the read budget), then CREDENTIAL_PROMPT_PENDING, '
    + 'resumable. No browser or Studio login dialog is opened. Missing headless SSO support is reported explicitly. Service Center reads share a 90-second budget, including cold SSO authentication.',
  session: SESSION, reads: { 'studio-api': API_READS, pages: WEB_READS, local: ['capabilities', 'receipt'] },
  writes: { pages: [...Object.keys(ACTIONS), ...Object.keys(WEB_WRITES)], 'studio-api': [...Object.keys(API_WRITE_TABLE), 'delete'], local: RECEIPT_ACTIONS },
  default: 'prepare only; execute requires the user words, a UUID operation-id and the journal reservation; never replayed. delete '
    + '(and module-delete, extension-delete, application-delete) executes in one call when the words are given: the tool mints the operation-id',
  guards: ['corporate or unregistered hosts need confirmHost=<host> and words naming the environment on every write',
    'delete reads first (the server simulation of each application, GetConsumers of each module and extension) and refuses before any '
    + 'change, with every problem, unless the words name every target (or its prefix) and every consumer outside the set',
    'db-connection-delete needs words that name the connection and the extensions using it'],
  secrets: 'database logins and secret site property values travel only as vault target names (sc_web secretRefs); '
    + 'the Studio reads them inside its own process; without a Studio, or with a bridge without sc_web:secretRefs, those writes are refused',
  limits: ['Service Center pages are internal English Web Forms; pages modeled only on synthetic fixtures (ASSUMED) '
    + 'refuse another layout with LAYOUT_UNKNOWN and the page-layout read that captures them live',
  'Trace means log correlation, not distributed tracing', 'Run Now schedules work; it does not prove execution completed',
  'Solution publish, extension publish and apply settings start server work; follow their status reads'],
  liveValidation: 'pages and Studio API: offline tests (fake bridge, synthetic pages); the delete engine waits for the real state but its '
    + 'live proofs (simulation shapes, DeleteModule of an extension, GetConsumers of an extension) are pending; see docs/OPERACOES-O11.md' };
}

const answer = (auth, result) => (result && typeof result === 'object' && !Array.isArray(result)
  ? { ok: Object.hasOwn(result, 'ok') ? result.ok : true, host: auth.host, auth: auth.describe(), ...result }
  : { ok: true, host: auth.host, auth: auth.describe(), result });

// Vault status, once per target and call; many() asks several targets at once (one PowerShell run by default).
function memoPresent(single, many) {
  const seen = new Map();
  const present = target => { if (!seen.has(target)) seen.set(target, Promise.resolve(single(target))); return seen.get(target); };
  present.many = targets => {
    const missing = [...new Set(targets.filter(t => !seen.has(t)))];
    if (missing.length) { const values = Promise.resolve(many(missing)); missing.forEach((t, i) => seen.set(t, values.then(v => v[i]))); }
    return Promise.all(targets.map(t => seen.get(t)));
  };
  // A fresh look (the bounded wait of a pending prompt): the entry may have been stored since the first one.
  present.fresh = async target => { const value = Boolean(await single(target)); seen.set(target, Promise.resolve(value)); return value; };
  return present;
}

async function session(args, { locate, present, opener, running, registry, profiles = null, wait = {} }) {
  const host = args.host ? hostName(args.host) : null;
  if (args.action === 'session-status') {
    let bridge = null; let problem = null;
    try { bridge = await locate(); }
    catch (error) { if (!(error instanceof BridgeError)) throw error; problem = { code: error.code, error: error.message }; }
    const verbs = bridge ? await bridge.supports() : false;
    const out = { ok: true, studio: { connected: bridge !== null, ...(bridge ? { pid: bridge.pid, bridgeVersion: bridge.version, serviceCenterVerbs: verbs } : {}),
      ...(problem ? { problem } : {}) } };
    if (host) {
      const [serviceCenter, lifeTime] = hostedContext() ? [null, null] : await present.many([credentialTarget(host, 'ServiceCenter'), credentialTarget(host, 'LifeTime')]);
      Object.assign(out, { host, hostClass: hostClass(host, registry),
        vault: hostedContext() ? 'not used in hosted mode' : { ServiceCenter: Boolean(serviceCenter), LifeTime: Boolean(lifeTime) } });
      if (bridge && verbs) out.session = redact(await bridge.session(host));
      const dry = new Resolver(host, { session: args.session, prompt: 'never', locate: () => bridge, present, running, opener, profiles, login: false, wait: { waitMs: 0 } });
      out.wouldUse = {};
      for (const need of ['api', 'web']) {
        try { out.wouldUse[need] = (await dry.resolve(need)).path; }
        catch (error) { if (!(error instanceof AuthRequired)) throw error; out.wouldUse[need] = error.code; }
      }
    }
    return out;
  }
  required(args, 'host');
  if (args.action === 'session-sign-in' && args.surface === 'lifetime') {
    if (hostedContext()) throw hostedStudioOnly('LifeTime (its service-account token)');
    const target = credentialTarget(host, 'LifeTime');
    if (await present(target)) return { ok: true, host, already: true, auth: { path: 'vault', host, target } };
    const stored = await promptAndWait({ host, kind: 'LifeTime', target, opener, present, wait, why: `No LifeTime service-account token is stored for ${host}` });
    return { ok: true, host, stored: true, auth: { path: 'vault', host, target }, attempts: [stored] };
  }
  const bridge = await locate();
  if (bridge && !await bridge.supports())
    throw new AuthRequired('STUDIO_BRIDGE_OUTDATED', 'The connected Studio runs a bridge without the Service Center verbs; reconnect a new bridge version.',
      { continuation: connectStudio('reconnect after the Studio loads the new bridge') });
  if (args.action === 'session-sign-in') {
    if (bridge) {
      const info = await bridge.session(host);
      const studio = info?.studio && typeof info.studio === 'object' && !Array.isArray(info.studio) ? info.studio : info;
      if (studio.signedIn === true) return { ok: true, host, already: true, auth: { path: 'studio', host, user: studio.user ?? null } };
      throw new AuthRequired('STUDIO_NOT_SIGNED_IN', 'The selected Studio is not authenticated on this host; no login dialog was opened.');
    }
    if (hostedContext())
      throw new AuthRequired('STUDIO_NOT_CONNECTED', 'No Service Studio of the user is connected to SSAM; the user opens it and ssam_connect {lane:"o11"} connects it.',
        { continuation: connectStudio('connect the user\'s Service Studio; in hosted mode it is the only path') });
    if (await running())
      throw new AuthRequired('STUDIO_NOT_CONNECTED', 'A Service Studio is open but not connected to SSAM; run ssam_connect {lane:"o11"}.',
        { continuation: connectStudio('connect the open Service Studio') });
    if (profiles) {
      // The stored profile of the host; with nothing stored at all, the private window stores one (auth.mjs storedProfile).
      const { selected, attempts } = await storedProfile({ profiles, host, target: args.credential_target || null, present, opener, wait });
      if (!selected.ok) throw new AuthRequired(selected.code, selected.reason ?? 'Private credential selection was cancelled.', { attempts });
      return { ok: true, host, stored: true, auth: { path: 'vault', host, user: selected.principal, source: selected.source }, attempts };
    }
    const target = args.credential_target || credentialTarget(host, 'ServiceCenter');
    if (await present(target)) return { ok: true, host, already: true, auth: { path: 'vault', host, target } };
    const stored = await promptAndWait({ host, target, opener, present, wait, why: `No Studio and no vault entry for ${host}` });
    return { ok: true, host, stored: true, auth: { path: 'vault', host, target }, attempts: [stored] };
  }
  if (!bridge)
    throw new AuthRequired('STUDIO_NOT_CONNECTED', "The headless native HTTP session needs a connected Studio; run ssam_connect {lane:\"o11\"}.",
      { continuation: connectStudio("the headless native HTTP session needs a connected Studio") });
  if (args.action === 'session-web-sign-in') {
    const reply = await bridge.web(host, 'login', { studioSession: true });
    return { ok: true, host, windowCreated: false, signedIn: reply.signedIn === true,
      submitted: reply.submitted === true, auth: { path: 'studio-http', host } };
  }
  const reply = await bridge.web(host, 'close');
  return { ok: true, host, closed: true, ...(Object.hasOwn(reply, 'signedIn') ? { signedIn: reply.signedIn } : {}) };
}

// --value-vault names the same-host SiteProperty vault entry; its value is never read here.
function sitePropertyTarget(host, target) {
  const prefix = `SSAM/O11/${host}/SiteProperty/`;
  if (!target.startsWith(prefix)) throw new ProtocolError(`--value-vault must be ${prefix}<name> (an entry of this host)`);
  return credentialTarget(host, 'SiteProperty', target.slice(prefix.length));
}

// Before reservation: secretRefs require native HTTP and an existing vault entry.
// A missing entry opens the private Windows prompt in its own window (promptAndWait; without an opener, a refusal);
// values stay inside the Studio.
async function secretReady(client, present, opener, host, kind, name, wait = {}) {
  if (!await client.http.secretsSupported()) throw client.secretRefusal();
  const target = credentialTarget(host, kind, name);
  if (!await present(target)) {
    const what = kind === 'DatabaseConnection' ? `database login for ${name}` : `secret value of the site property ${name}`;
    await promptAndWait({ host, kind, name, target, opener, present, wait, why: `The ${what} is not stored` });
  }
}

// The arguments of a page write, by name; secrets are never among them.
function webArguments(args) {
  const a = args.action;
  if (a === 'application-timeout-set') {
    required(args,'application','value','expected_value');
    return {application:args.application,value:args.value,expectedValue:args.expected_value};
  }
  if (a.startsWith('solution-')) {
    required(args, 'solution', ...(a.includes('component') ? ['component'] : []));
    return { solution: args.solution, component: args.component, description: args.description, includeReferences: args.include_references };
  }
  if (a.startsWith('db-connection-')) {
    required(args, 'connection');
    const parameters = {};
    for (const item of args.param) {
      const eq = item.indexOf('=');
      const label = eq < 0 ? item : item.slice(0, eq);
      if (eq < 0 || !label.trim()) throw new ProtocolError('--param takes label=value');
      parameters[label.trim()] = item.slice(eq + 1);
    }
    return { connection: args.connection, dbms: args.dbms, server: args.db_server, database: args.db_database, parameters,
      ...(args.authorization_context ? { authorization_context: args.authorization_context } : {}) };
  }
  if (a === 'extension-db-connection') {
    required(args, 'connection');
    if (!args.extension_id && !args.extension) throw new ProtocolError('Use --extension-id <n> or --extension <name>');
    return { extensionId: args.extension_id || args.extension, connection: args.connection };
  }
  required(args, 'module_id', 'integration', 'level');
  return { moduleId: args.module_id, integration: args.integration, kind: args.integration_kind, level: args.level,
    ...(args.expected_value !== undefined ? { expectedValue: args.expected_value } : {}) };
}

// Hosted (../executor.mjs): the vault of the server is never read (present answers false) and no prompt opens; receipts
// and exports are the customer's (<ws>/o11/service-center).
export async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  const env = deps.env ?? process.env;
  const root = deps.root ?? anvilRoot;
  const hosted = hostedContext() !== null;
  const registry = deps.registry ?? hostsFile(root);
  const locate = deps.locate ?? (() => locateStudioBridge({ root, env }));
  const powershell = deps.powershell ?? null;
  const vaultOptions = { run: powershell ?? createPowerShellRunner({ env }), ...(deps.credential ? { credential: deps.credential } : {}) };
  const present = deps.present ? memoPresent(deps.present, targets => Promise.all(targets.map(deps.present)))
    : hosted ? memoPresent(() => false, targets => targets.map(() => false))
    : memoPresent(target => vaultPresent(target, vaultOptions), targets => vaultPresent(targets, vaultOptions));
  const opener = deps.opener ?? (hosted ? (host => { throw hostedNoPrompt(host, `No credential of ${host} can be stored from here`); })
    : (host, kind, name = null) => openPrompt(host, kind, name, { env, root }));
  const running = deps.running ?? (() => studioRunning());
  // Injected tests stay isolated from the real Windows vault unless they explicitly supply a profiles fake. Hosted, no
  // credential profile of the server is ever used: the user's Studio session is the only path.
  const profiles = hosted ? null : deps.profiles ?? (deps.present || deps.powershell ? null : new CredentialProfiles());
  const exportsDir = deps.exports ?? (usesWorkspace(root, anvilRoot) ? workspacePath('o11', 'service-center', 'exports') : path.join(root, '.local', 'service-center', 'exports'));
  if (args.action === 'capabilities') return capabilities();
  const journal = deps.journal ?? journalDefault(env);
  if (args.action === 'receipt') {
    required(args, 'operation_id');
    const result = journal.lookup(args.operation_id);
    if (result === null) throw new ProtocolError('Receipt not found');
    return result;
  }
  // servidor/fase4-24 (R3): credentialTarget names an entry (a profile) of the SSAM server's vault: refused before anything.
  if (hosted && args.credential_target) throw hostedStudioOnly('credentialTarget (a credential profile of the server)');
  // The bounded wait of a pending private prompt (A13): SSAM_PROMPT_WAIT_MS; deps.promptWaitMs, promptSleep and now in tests.
  const wait = { waitMs: promptWaitMs(env, deps.promptWaitMs), ...(deps.promptSleep ? { sleep: deps.promptSleep } : {}), ...(deps.now ? { now: deps.now } : {}) };
  if (SESSION.includes(args.action)) return session(args, { locate, present, opener, running, registry, profiles, wait });
  required(args, 'host');
  const host = hostName(args.host);
  if (args.action === 'solution-download-status') required(args,'operation_id');
  const write = WRITES.includes(args.action);
  const deletes = DELETE_ACTIONS.includes(args.action);
  if (args.execute && !write && !LOCAL_WRITES.includes(args.action)) throw new ProtocolError('--execute is only valid for a write operation');
  if (!(args.limit >= 1 && args.limit <= 5000)) throw new ProtocolError('--limit must be between 1 and 5000');
  const local = LOCAL_WRITES.includes(args.action);
  if (!write && !RECEIPT_ACTIONS.includes(args.action) && ((local ? [args.value_file, args.value_vault] : [args.words, args.value_file, args.value_vault, args.confirm_host]).some(Boolean) || args.value !== null))
    throw new ProtocolError('Read operations cannot carry authorization or a property value');
  if (args.question !== null && !local) throw new ProtocolError('--question applies to solution-download-abandon only');
  if (args.reveal && args.action !== 'property-value') throw new ProtocolError('--reveal applies to property-value only');
  if(args.event_auth!=null&&args.action!=='timer-events')throw new ProtocolError('--event-auth applies to timer-events only');
  if (!deletes && (args.plan_only || args.target.length || [args.prefix, args.prefix_kind, args.max_deletes].some(v => v !== null)))
    throw new ProtocolError('--target, --prefix, --prefix-kind, --max-deletes and --plan-only apply to delete (and its aliases) only');
  if ((args.expected_version_id !== null) && args.action !== 'extension-publish') throw new ProtocolError('--expected-version-id applies to extension-publish only');
  const scheduleEntries = Object.keys(SCHEDULE).filter(k => args['schedule_' + k] !== null).map(k => [k, args['schedule_' + k]]);
  const schedule = scheduleEntries.length ? Object.fromEntries(scheduleEntries) : null;
  if (schedule && args.action !== 'timer-schedule') throw new ProtocolError('--schedule-* applies to timer-schedule only');
  if (write && args.execute && !deletes) {
    required(args, 'words', 'operation_id');
    guardWrite(host, args.words, args.confirm_host, [], registry);
  }
  // Past the guard, a write to a non-personal host tells the bridge it carries the explicit instruction (a delete sets it
  // itself, past its own host rule).
  const corporate = write && args.execute && !deletes && hostClass(host, registry) !== 'personal';
  const resolver = new Resolver(host, { session: args.session, prompt: args.auth_prompt, credentialTarget: args.credential_target, locate, present, running, opener, profiles, wait });
  // Hosted, LifeTime (single sign-on with a stored account profile, or its service-account token) and the timer events of
  // session "vault" use the server's vault and direct HTTPS: refused before any attempt.
  if (hosted && ['lifetime-web-status', 'lifetime-capabilities'].includes(args.action)) throw hostedStudioOnly('LifeTime (a stored account profile)');
  if (hosted && args.action === 'timer-events') throw hostedStudioOnly('Timer events (session "vault")');
  if(['lifetime-web-status','lifetime-capabilities'].includes(args.action)){
    if(args.session!=='vault')throw new ProtocolError('lifetime-web-status requires session=vault and a compatible private account profile.');
    const auth=await resolver.resolve('web');
    if(!auth.user||!auth.credentialTarget)throw new AuthRequired('AUTH_REQUIRED','LifeTime SSO requires a selected account profile; no credential prompt was opened.');
    const identity=deps.createSso?deps.createSso(auth):new ServiceCenterSso({host,principal:auth.user,target:auth.credentialTarget,...readOptions('authentication')});
    try{
      const result=await identity.authenticateLifetime();
      const capabilities=args.action==='lifetime-capabilities'?await identity.lifetimeCapabilities():null;
      return {ok:result.ok===true,host,surface:'lifetime',signedIn:result.signedIn===true,
        protectedReadVerified:result.protectedReadVerified===true,transport:'headless-sso',windowCreated:false,
        serviceAccountTokenVerified:false,...(capabilities?{capabilities}:{}),auth:auth.describe()};
    }catch(error){
      if(error instanceof AuthRequired){
        const d=error.diagnostic??{};
        error.auth={surface:'lifetime',...Object.fromEntries(['expectedForm','logoutControl'].filter(k=>typeof d[k]==='boolean').map(k=>[k,d[k]])),
          ...(Number.isInteger(d.httpStatus)?{httpStatus:d.httpStatus}:{})};
      }
      throw error;
    }finally{await identity.close();}
  }
  if(args.action==='timer-events'){
    if(args.session!=='vault')throw new ProtocolError('timer-events requires session=vault for its private Basic or service-token authentication transport.');
    required(args,'since','until');
    if(args.event_auth==='service-token'){
      const target=credentialTarget(host,'LifeTime');
      if(args.credential_target&&args.credential_target!==target)throw new ProtocolError('Service-token events require the exact same-host LifeTime vault entry.');
      if(!await present(target))throw new AuthRequired('AUTH_REQUIRED','No LifeTime service-account token is stored for this host. No prompt or authentication fallback was opened.');
      return readPerformanceEvents({host,target,eventAuth:'service-token',since:args.since,until:args.until,limit:args.limit},deps.performanceEvents??{});
    }
    const auth=await resolver.resolve('web');
    const [,info]=await resolver.studio();
    const principal=auth.user??info?.studio?.user;
    return readPerformanceEvents({host,target:auth.credentialTarget??resolver.vaultTarget('web'),principal,
      since:args.since,until:args.until,limit:args.limit},deps.performanceEvents??{});
  }
  const studio = auth => { if (corporate && auth.bridge) auth.bridge.corporate = true; return auth; };
  const pagesClient = async () => {
    const auth = studio(await resolver.resolve('web'));
    // Hosted, the direct HTTPS transport (vault form login, private transport, single sign-on) is never used.
    if (hosted && !['studio-web', 'studio-http'].includes(auth.path)) throw hostedStudioOnly('Service Center pages over direct HTTPS (vault form login)');
    const transport = ['studio-web', 'studio-http'].includes(auth.path) ? new StudioWebTransport(host, auth.bridge, { reenter: auth.reenter })
      : new Transport(host, { send: deps.send ?? null, origin: deps.origin ?? null,
        privateBridge: auth.bridge, privatePrincipal: auth.user });
    const vault = createVault(host, auth.credentialTarget ?? args.credential_target, { present, ...vaultOptions });
    if (auth.path === 'vault' && auth.user && auth.credentialTarget && deps.authResources) {
      const cached=deps.ssoCache.get(auth);
      if(cached){
        deps.ssoKeys.push(cached.key);
        transport.jar=ownedSsoJar(cached.jar,host,{onUpdate:jar=>deps.ssoCache.update?.(auth,jar)});transport.preauthenticated=true;
        deps.authResources.push({close:()=>cached.jar.removeAllCookies()});
        auth.path='vault-sso-cache';
        auth.attempts.push({path:'vault-sso-cache',outcome:auth.bridge?'same-principal-profile-studio-memory-session':'same-principal-explicit-profile-memory-session',headless:true});
      }
      transport.authenticateSso = async () => {
        const create = () => deps.createSso ? deps.createSso(auth) : new ServiceCenterSso({ host, principal: auth.user,
          target: auth.credentialTarget, ...readOptions('authentication') });
        const {key,jar}=await deps.ssoCache.authenticate(auth,create);if(key)deps.ssoKeys.push(key);
        deps.authResources.push({close:()=>jar.removeAllCookies()});
        // Only a reserved download may persist these tool-owned SC cookies,
        // encrypted outside the repository. Community tokens stay in memory.
        transport.jar = ownedSsoJar(jar,host,{onUpdate:jar=>deps.ssoCache.update?.(auth,jar)});
        transport.preauthenticated = true;
        auth.path = 'vault-sso';
        auth.attempts.push({ path: 'vault-sso', outcome: 'protected-read-verified', headless: true, sessionReuse:key?'memory-scoped':'not-retained' });
      };
    }
    const client = new Client(vault, transport, exportsDir);
    client.ownerSelectionIdentity = {host,principal:auth.user,credentialTarget:auth.credentialTarget??null};
    client.downloadOptions = { principal:auth.user, ...(deps.downloadStore ? {store:deps.downloadStore} : {}),
      transportOptions:{send:deps.send ?? null,origin:deps.origin ?? null},onSource:source=>{auth.path=source;} };
    return [auth, client];
  };
  if (args.action === 'solution-download-abandon') {
    required(args, 'solution', 'operation_id');
    if (!args.execute) return { ok: true, action: args.action, host, solution: args.solution, operationId: args.operation_id, prepared: true, sent: false,
      note: "Local only. Execute with the user's words to mark this download abandoned: nothing is sent to Service Center and the UUID is never resumed." };
    // Nothing reaches the host, so no host guard; the words still authorize the change of SSAM's own record.
    required(args, 'words');
    const [auth, client] = await pagesClient();
    return answer(auth, await client.solutionDownloadAbandon(args.solution, { operationId: args.operation_id, words: args.words, question: args.question }));
  }
  const waits = { sleep: deps.sleep, wait: deps.wait };
  const api = async () => { const auth = studio(await resolver.resolve('api')); return [auth, new StudioApi(auth.bridge, host, waits)]; };
  if (!args.module_id && (args.module || args.module_key) && (Object.hasOwn(ACTIONS, args.action) || ['timers', 'site-properties', 'property-value', 'integrations', 'integration-detail'].includes(args.action))) {
    const [, native] = await api();
    args.module_id = await native.numericModuleId(args);
  }
  const engine = client => new DeleteEngine(client, { journal, registry, ...(deps.uuid ? { uuid: deps.uuid } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}),
    wait: deps.wait ?? {}, consumerNames: deps.consumerNames ?? null });
  const approveFor = () => args.execute && args.authorization_context && DB_APPROVAL_ACTIONS.includes(args.action)
    ? plan => { plan.authorizationContext = approveDatabasePlan(args.authorization_context, args.words, plan); }
    : args.execute && args.authorization_context && args.action === 'solution-delete'
    ? plan => { plan.authorizationContext = authorizationContext(args.authorization_context,args.words,{lane:'o11',host,operation:'solution-delete',targets:plan.namedTargets}); }
    : args.execute && args.authorization_context && args.action === 'extension-publish'
    ? plan => {
      if (!plan.extension || plan.observedVersionId !== null || plan.expectedVersionId !== null || plan.applicationKey)
        throw new ProtocolError('Context publication requires an exact new standalone extension and expected-version-id=none; nothing sent');
      plan.authorizationContext = authorizationContext(args.authorization_context,args.words,{lane:'o11',host,operation:'extension-publish',targets:[plan.extension],constraints:{createOnly:true}});
    }
    : (DESTRUCTIVE.has(args.action) && args.execute
    // The words name the resolved target and everything the plan says goes with it.
    ? plan => guardWrite(host, args.words, args.confirm_host, plan.namedTargets?.length ? plan.namedTargets : [plan.name || plan.connection], registry) : null);
  const options = () => ({ execute: args.execute, words: args.words, operationId: args.operation_id, journal });

  if (args.action === 'discard') {
    // Local: no Studio, no page, nothing sent. The words must name the receipt's target (and the environment on a
    // corporate host); the receipt keeps their sha256, the journal its resolutions.jsonl line.
    required(args, 'operation_id', 'words');
    const receipt = journal.lookup(args.operation_id);
    if (!receipt) throw new ProtocolError('Receipt not found');
    if (receipt.identity?.host !== host) throw new ProtocolError('Receipt belongs to another host');
    const named = receipt.identity?.name ?? receipt.plan?.name ?? receipt.identity?.connection ?? receipt.identity?.solution ?? null;
    guardWrite(host, args.words, args.confirm_host, named ? [named] : [], registry);
    const resolved = journal.discard(receipt, args.words);
    return { ...resolved, ok: true, host, discarded: true, sent: false,
      next: `The target is free; a new ${receipt.identity?.action ?? 'write'} needs its own operationId and the user's words (prepare first).` };
  }

  if (args.action === 'verify') {
    required(args, 'operation_id');
    const receipt = journal.lookup(args.operation_id);
    if (!receipt) throw new ProtocolError('Receipt not found');
    if (args.words || args.value_vault) throw new ProtocolError('Verification takes no authorization words; a vault value is never read back to compare');
    const action = receipt.identity.action;
    if (action === 'db-connection-test' && receipt.responseEvidence) {
      const local = new Client({host}, {}, exportsDir);
      return answer(new Auth('local-receipt',host), await local.verify(receipt,journal));
    }
    if (action === 'delete') {
      const [auth, client] = await api();
      return answer(auth, await engine(client).verify(receipt));
    }
    if (Object.hasOwn(API_WRITE_TABLE, action)) {
      const [auth, client] = await api();
      const observed = await client.observe(receipt);
      if (observed) journal.reconcile(receipt);
      return answer(auth, { ...receipt, observedDesiredState: observed, replayed: false });
    }
    const [auth, client] = await pagesClient();
    // A schedule is compared with the one its receipt kept; a property only with the value file the user gives.
    const value = args.value_file ? valueFile(args.value_file) : null;
    return answer(auth, await client.verify(receipt, journal, value));
  }

  if (deletes) {
    // One call: reads, the refusal with every problem or the plan, else the deletes and the wait for the real state.
    const request = deleteRequest(args);
    const [auth, client] = await api();
    return answer(auth, await engine(client).run(request));
  }

  if (write) {
    const approve = approveFor();
    if (Object.hasOwn(ACTIONS, args.action)) {
      required(args, 'module_id', 'name');
      if (args.action !== 'property-set' && (args.value_file || args.value_vault || args.value !== null)) throw new ProtocolError('Only property-set accepts a value source');
      if (args.action === 'timer-schedule' && args.execute && !schedule)
        throw new ProtocolError('timer-schedule needs at least one of --schedule-recurrence, --schedule-at, --schedule-every, --schedule-timeout');
      if ([args.value, args.value_file, args.value_vault].filter(v => v !== null).length > 1) throw new ProtocolError('Choose one property value source');
      const [auth, client] = await pagesClient();
      let value = args.action === 'timer-schedule' ? schedule : null; let secret = null;
      if (args.action === 'property-set') {
        if (args.value_vault) secret = sitePropertyTarget(host, args.value_vault);
        if (args.execute) {
          const existing = journal.lookup(args.operation_id, { host, action: args.action, moduleId: args.module_id, name: args.name });
          if (existing) return answer(auth, { ...existing, existingReceipt: true, replayed: false });
          if (args.value !== null) value = args.value;
          else if (args.value_file) value = valueFile(args.value_file);
          // The value stays in the vault: only its target name goes, and the Studio fills the field.
          else if (secret) await secretReady(client, present, opener, host, 'SiteProperty', secret.split('/').at(-1), wait);
          else throw new ProtocolError('Use --value or --value-file for nonsecret values, or --value-vault SSAM/O11/<host>/SiteProperty/<name> for secrets');
        }
      }
      return answer(auth, await client.mutate(args.action, args.module_id, args.name, { value, secret, ...options() }));
    }
    if (Object.hasOwn(WEB_WRITES, args.action)) {
      const data = webArguments(args);
      const [auth, client] = await pagesClient();
      if (SECRET_WRITES.includes(args.action) && args.execute && !journal.lookup(args.operation_id, { host, action: args.action, connection: args.connection }))
        await secretReady(client, present, opener, host, 'DatabaseConnection', args.connection, wait);
      return answer(auth, await client.webWrite(args.action, data, { ...options(), approve }));
    }
    const [auth, client] = await api();
    let osp = null;
    if (args.action === 'solution-publish') {
      required(args, 'solution');
      if (args.osp_file) {
        const file = args.osp_file;
        if (!path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > 64 * 1024 * 1024)
          throw new ProtocolError('--osp-file must be an absolute .osp of at most 64 MiB');
        osp = { file, sha256: sha256(fs.readFileSync(file)) };
      } else if (!(args.execute && journal.lookup(args.operation_id, client.identity(args.action, args)))) {
        required(args,'operation_id');
        osp = await (await pagesClient())[1].solutionDownload(args.solution,{operationId:args.operation_id,create:true});
        if (!osp.complete) return answer(auth,osp);
      }
    }
    return answer(auth, await client.write(args.action, args, { osp, approve, ...options() }));
  }

  if (!(args.max_pages >= 1 && args.max_pages <= 100)) throw new ProtocolError('--max-pages must be between 1 and 100');
  if (args.action === 'modules' && ['auto', 'studio'].includes(args.session)) {
    // The Studio's module listing when a Studio is connected; the page listing (numeric IDs) otherwise.
    let pair = null;
    try { pair = await api(); } catch (error) { if (!(error instanceof AuthRequired) || error.code !== 'STUDIO_REQUIRED') throw error; }
    if (pair) return answer(pair[0], await pair[1].read('modules', args));
  }
  if (API_READS.includes(args.action) && args.action !== 'modules') {
    const [auth, client] = await api();
    if (args.action === 'apply-settings-status' && args.operation_id) {
      const receipt = journal.lookup(args.operation_id);
      if (!receipt || receipt.identity?.host !== host || receipt.identity?.action !== 'apply-settings'
          || String(receipt.applyId) !== String(args.apply_id))
        throw new ProtocolError('Apply settings status must match the recorded host, operation and job');
      if (receipt.state === 'confirmed' && receipt.applySettingsObservation?.success)
        return answer(auth, { operation: 'apply-settings-status', source: 'confirmed-receipt',
          receiptState: receipt.state, executionCompleted: true, applySettingsObservation: receipt.applySettingsObservation });
      const result = await client.read(args.action, args);
      if (client.observeApplySettingsStatus(receipt, result.result)) journal.reconcile(receipt);
      return answer(auth, { ...result, receiptState: receipt.state, executionCompleted: receipt.executionCompleted,
        applySettingsObservation: receipt.applySettingsObservation });
    }
    if (args.action === 'solution-publish-status' && args.operation_id) {
      const receipt = journal.lookup(args.operation_id);
      if (!receipt || receipt.identity?.host !== host || receipt.identity?.action !== 'solution-publish'
          || String(receipt.solutionPublishId) !== String(args.publish_id))
        throw new ProtocolError('Publication status must match the recorded host, operation and job');
      if (receipt.state === 'confirmed' && receipt.publicationObservation?.success)
        return answer(auth, { operation: 'CheckSolutionPublish', source: 'confirmed-receipt',
          receiptState: receipt.state, executionCompleted: true, publicationObservation: receipt.publicationObservation });
      if (Number(args.last_message_id || 0) !== 0)
        throw new ProtocolError('Receipt reconciliation requires the complete publication status (lastMessageId=0)');
      const result = await client.read(args.action, args);
      if (client.observePublicationStatus(receipt, result.result)) journal.reconcile(receipt);
      return answer(auth, { ...result, receiptState: receipt.state, executionCompleted: receipt.executionCompleted,
        publicationObservation: receipt.publicationObservation });
    }
    return answer(auth, await client.read(args.action, args));
  }
  const [auth, client] = await pagesClient();
  let result;
  switch (args.action) {
    case 'modules': result = await client.modules(args.limit, args.max_pages); break;
    // timers with a name: that timer's own page (schedule, runs, actions), read by labels and captions (C40).
    case 'timers': case 'site-properties': required(args, 'module_id');
      result = args.action === 'timers' && args.name ? await client.timer(args.module_id, args.name) : await client.resources(args.module_id, args.action, args.limit); break;
    case 'property-value': required(args, 'module_id', 'name'); result = await client.propertyValue(args.module_id, args.name, args.reveal); break;
    case 'logs': {
      const filters = Object.fromEntries(Object.entries(LOG_FILTER_ARGS).filter(([, a]) => args[a] !== null).map(([k, a]) => [k, args[a]]));
      result = await client.logs(args.kind, args.limit, filters, { stackContains: args.stack_contains, exportAll: args.export, maxPages: args.max_pages });
      break;
    }
    case 'application-owners': result = await client.applicationOwners({moduleLimit:args.module_limit??2000,maxPages:args.max_pages,moduleOffset:args.module_offset??0,moduleBatchSize:args.module_batch_size??10,captureModuleSelection:args.capture_module_selection,moduleSelectionId:args.module_selection_id,expectedModuleSelectionSha256:args.expected_module_selection_sha256,ownerParallelism:args.owner_parallelism??1}); break;
    case 'application-relationships': result = await client.applicationRelationships({applicationId:args.application_id,application:args.application,applications:args['graph-application'],applicationSource:args.application_source??'auto',applicationLimit:args.application_limit??20,moduleLimit:args.module_limit??20,includeSystem:args.include_system,limit:args.limit,maxPages:args.max_pages,applicationOffset:args.application_offset??0,applicationBatchSize:args.application_batch_size??3,expectedSelectionSha256:args.expected_selection_sha256,ownerParallelism:args.owner_parallelism??1}); break;
    case 'application-dependency-graph': result = await client.applicationDependencyGraph({application:args.application,applications:args['graph-application'],includeSystem:args.include_system,moduleId:args.module_id,module:args.module,limit:args.limit,moduleLimit:args.module_limit??20,maxPages:args.max_pages}); break;
    case 'module-dependencies': result = await client.moduleDependencies({moduleId:args.module_id,module:args.module,limit:args.limit,moduleLimit:args.module_limit??20,maxPages:args.max_pages}); break;
    case 'module-references': required(args, 'module_id'); result = await client.moduleReferences(args.module_id, args.limit, args.max_pages); break;
    case 'page-layout': required(args, 'path'); result = await client.pageLayout(args.path); break;
    case 'error-detail': required(args, 'error_id'); result = await client.errorDetail(args.error_id); break;
    case 'integration-log-detail': required(args, 'request_key', 'log_action'); result = await client.integrationLogDetail({ requestKey: args.request_key, action: args.log_action, moduleId: args.module_id }); break;
    case 'trace': required(args, 'request_key'); result = await client.trace(args.request_key, args.limit, args.max_pages); break;
    case 'bpt-processes': result = await client.bptProcesses(args.module, args.process, args.limit, args.max_pages); break;
    case 'bpt-process': required(args, 'process_key', 'module_key'); result = await client.bptProcess(args.process_key, args.module_key, args.limit, args.max_pages); break;
    case 'bpt-instance': required(args, 'process_id'); result = await client.bptInstance(args.process_id, args.limit, args.max_pages); break;
    case 'bpt-activity': required(args, 'activity_id'); result = await client.bptActivity(args.activity_id); break;
    case 'integrations': required(args, 'module_id'); result = await client.integrations(args.module_id); break;
    case 'integration-detail': required(args, 'module_id', 'integration'); result = await client.integrationDetail(args.module_id, args.integration, args.integration_kind ?? null); break;
    case 'db-connections': result = await client.dbConnections(); break;
    case 'application-runtime-settings': required(args,'application'); result = await client.applicationRuntimeSettings(args.application); break;
    case 'solutions': result = await client.solutions(args.limit); break;
    case 'solution-versions': required(args,'solution'); result = await client.solutionVersions(args.solution, args.limit, args.max_pages); break;
    case 'async-operation-status': required(args, 'async_operation_id'); result = await client.asyncOperationStatus(args.async_operation_id, args.last_message_id ?? -1); break;
    case 'solution-download-status': required(args,'solution'); result=await client.solutionDownloadStatus(args.solution,{operationId:args.operation_id}); break;
    default: required(args, 'solution'); result = await client.solutionDownload(args.solution,{operationId:args.operation_id});
  }
  return answer(auth, result);
}

// The MCP call an argv came from (o11-operations.mjs builds the argv from it): the tool by action, the arguments by
// flag (kebab -> camel), lists, schedule and parameters back in their objects. The user's words stay a placeholder.
const NUMBER_FLAGS = ['limit', 'max_pages', 'max_deletes'];
const DEFAULT_VALUES = { session: 'auto', auth_prompt: 'auto', surface: 'service-center', kind: 'error', limit: 100, max_pages: 20 };
const camel = name => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
export function sameCall(argv) {
  const args = parseArgs(argv);
  const session = SESSION.includes(args.action);
  const tool = session ? 'o11_service_center_session' : WRITES.includes(args.action) || LOCAL_WRITES.includes(args.action) || RECEIPT_ACTIONS.includes(args.action) ? 'o11_service_center_write' : 'o11_service_center_read';
  const out = { action: session ? args.action.slice('session-'.length) : args.action };
  for (const flag of [...new Set([...VALUED, ...FLAGS])].filter(f => !f.startsWith('schedule-'))) {
    const key = attribute(flag); const value = args[key];
    if (value === null || value === undefined || DEFAULT_VALUES[key] === value) continue;
    out[camel(key)] = key === 'words' ? "<the user's own words>" : NUMBER_FLAGS.includes(key) ? Number(value) : value;
  }
  for (const flag of SWITCHES) if (args[attribute(flag)] && flag !== 'plan-only') out[camel(attribute(flag))] = true;
  if (args.plan_only) out.execute = false;
  const schedule = Object.fromEntries(Object.keys(SCHEDULE).filter(k => args['schedule_' + k] !== null).map(k => [k, args['schedule_' + k]]));
  if (Object.keys(schedule).length) out.schedule = schedule;
  if (args.param.length) out.parameters = Object.fromEntries(args.param.map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  for (const t of args.target) {
    const at = t.indexOf(':'); const list = { application: 'applications', module: 'modules', extension: 'extensions' }[t.slice(0, at)];
    if (list) (out[list] ??= []).push(t.slice(at + 1));
  }
  return { tool, arguments: out };
}

// The JSON the Python entry point printed, never an exception: refusals keep their code and continuation; native or
// network failures are never serialized (they may contain a form value or credential).
export async function runServiceCenter(argv, deps = {}) {
  if (WRITES.includes(argv[0])) return runServiceCenterWithinBudget(argv, deps);
  const result = await boundedRead('o11-sc:' + JSON.stringify(argv), () => runServiceCenterWithinBudget(argv, deps), { timeoutMs: deps.readTimeoutMs ?? 90000 });
  if (result?.code === 'READ_DEADLINE_EXCEEDED') result.continuation = { ...sameCall(argv), why: 'Check the original pending read without resending; its result belongs to the original request context.' };
  return result;
}
async function runServiceCenterWithinBudget(argv, deps) {
  const authResources = [];
  const ssoCache=deps.ssoCache??ownSsoSessions,ssoKeys=[];
  try { return await main(argv, { ...deps, authResources, ssoCache, ssoKeys }); }
  catch (error) {
    // Terminal failure evicts the session after any bounded same-identity GET
    // recovery. Protected writes are never replayed; the next call starts fresh.
    // Local validation and layout refusals say nothing about authentication.
    // Evict only an authentication failure, not a healthy session after a bad input.
    if(error instanceof AuthRequired)for(const key of ssoKeys)ssoCache.drop(key);
    // A pending private prompt is resumable: the next call is this same one (A13).
    if (error instanceof AuthRequired && ['CREDENTIAL_PROMPT_PENDING', 'CREDENTIAL_SELECTION_PENDING', 'CREDENTIAL_SELECTION_REQUIRED', 'CREDENTIAL_SELECTION_CANCELLED', 'CREDENTIAL_METADATA_UNAVAILABLE'].includes(error.code) && !error.continuation) {
      try { error.continuation = { ...sameCall(argv), why: 'the same call goes on once the login is stored in the private prompt; nothing else to do' }; }
      catch { /* the answer keeps its auth fields */ }
    }
    // AuthRequired and the planned refusals (ScheduleInModule) answer with their own fields.
    if (error instanceof BridgeError && typeof error.answer === 'function') return error.answer();
    if (error instanceof BridgeError) return { ok: false, code: error.code, error: error.message, stage: 'service-center',
      ...(error.extra?.fault ? { cause: { kind: 'soap' } } : {}),
      ...(error.extra?.transport ? {transport:error.extra.transport} : {}),
      ...(error.extra?.continuation ? { continuation: error.extra.continuation } : {}),
      ...Object.fromEntries(['inventoryVerified','emptyInventoryProven','databaseVerified','databaseAbsentProven'].filter(k=>typeof error.extra?.[k]==='boolean').map(k=>[k,error.extra[k]])),
      ...Object.fromEntries(['executed', 'sent', 'submitted', 'status'].filter(k => error.extra?.[k] !== undefined).map(k => [k, error.extra[k]])) };
    // A local refusal with its own fields (TARGET_PENDING: the holder receipt, verify and discard).
    if (error instanceof ProtocolError && typeof error.answer === 'function') return error.answer();
    if (error instanceof ProtocolError) return { ok: false, code: error.code, stage: 'service-center', error: error.message };
    // A refusal of the executor seam or the agent carries no form value or credential: its code and text stay.
    if (SEAM_CODES.has(error?.code)) return { ok: false, ...seamFields(error), error: error.message };
    return { ok: false, code: 'SC_LOCAL_FAILURE', stage: 'service-center', error: 'Service Center operation failed locally; no automatic retry' };
  }
  finally { for (const resource of authResources) await resource.close(); }
}

// The answer of the MCP tools: the shape lanes.run() gave the Python output ({ok, lane, verb, exitCode, result}),
// without the command line, since nothing is spawned any more.
export async function serviceCenterTool(argv, deps = {}) {
  const result = await runServiceCenter(argv, deps);
  const exitCode = (result.ok ?? true) ? 0 : 1;
  return { ok: exitCode === 0, lane: 'o11', verb: 'service-center', exitCode, result,
    ...(exitCode ? { code: result.code ?? 'SC_LOCAL_FAILURE', stage: result.stage ?? 'service-center',
      ...(result.continuation ? { continuation: result.continuation } : {}) } : {}) };
}
