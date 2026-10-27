// o11_publish: the 1-Click Publish of the module open in the Service Studio selected on the O11 lane, through the
// lane's bridge (kernel\src\Anvil.Bridge\PublishHandler.cs: `publish {message?, timeout?, module_key?, environment?}`).
// The user decided on 2026-10-02 "Publish O11 pelo MCP com palavras"; until then only the person published in the Studio.
//
// Order: the user's words, or a standing grant that covers this module for publish (standing-grants.mjs, contract I6;
// none -> refused, nothing touched) -> assertSelected -> open_module {name, silent} selects the tab (o11_studio's own
// handling of dialogs, sign-in and transport) -> get_active_module (name, environment, no pending dialog) -> get_errors: a
// TrueChange error comes back and nothing is published (the user's rule; no correction catalog) -> one journal line with
// the words' sha256 and an operationId -> publish pinned to the module key and environment just read
// (Studio.RequireTarget refuses, nothing executed, when another tab became active meanwhile).
// Outcome: published -> "publicado" with lastPublication; refused before the command started -> code; the server reported
// failure -> code with every message; anything else once the request left (timeout, lost reply, unconfirmed end,
// cancellation) -> outcome uncertain, never repeated.
// A server operation already running on the module (a publish the person started) is waited for by the bridge, inside
// timeoutSeconds, and then this publication runs: STUDIO_BUSY_TIMEOUT only when that wait expires (C31). The dialogs the
// Studio showed while it published come back in dialogsSeen (C10).
// consumers:true (C26): after the producer is published, each module that consumes it (the environment's GetConsumers)
// is selected, refreshed (the Studio's Refresh References, bridge refresh_references) and published with the same words
// or a grant that covers it; the answer has one outcome per consumer. publishConsumersOf (I11) runs the same cascade for a
// producer that is not a Studio tab (an extension published by o11_extension).
// MB2 (owner rule 2026-10-07): the dependencies dialog never stops the publication. Seen in the open, in the tab's dialogs
// or as the reason the bridge stopped a publication that reached nothing, it is answered (Cancel, bridge capability
// dialogs:dependencies_auto), every producer of the module is refreshed by its key, and the call goes on (the publication
// runs again once); the answer lists dependenciesDialog and referencesRefreshed. A module whose tab is in the Studio's
// second window is published by its key (list_open_modules, merge_from_oml:module_key) instead of MODULE_NOT_ACTIVE.
// The ssam_grant tool (grant, revoke, list standing grants) is registered here too.
// No sleep here: the bridge's publish follows the Studio's own server process and answers at its end.
import { appendJsonLine } from './correlation.mjs';
import { wordsGiven } from './destructive-operations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { o11Bridge, bridgeTarget } from './o11-bridge.mjs';
import { assertSelectedO11 } from './studio-connect.mjs';
import { trackTask, tasksDir } from './ssam-task.mjs';
import { o11Studio, ASK_PERSON, publishFixContinuation, publishCompilerDiagnosis, readInventory, allDialogs, moduleTab, tabAmbiguous, dependenciesCandidate,
  closeDependenciesDialog, refreshAfterDialog, answerDependenciesDialog, dependenciesFields } from './o11-studio.mjs';
import * as writeLock from './studio-write-lock.mjs';
import { clean, WORDS_MARKER } from './o11-cycle.mjs';
import { RESULT } from './result-values.mjs';
import * as standingGrants from './standing-grants.mjs';
import { producerCacheDir, recordPublished, recordPublicationEnded, publicationOpen } from './producer-signatures.mjs';

// F5: every publication this tool starts is recorded in the workspace's producer ledger, and its end (never throws): no
// observation of the module as a producer made before the end counts.
function notePublication(ctx, active) {
  // The ledger's times are the machine's clock (the kernel and the other sessions read the same files), never ctx.now.
  try { return recordPublished(producerCacheDir(ctx.lane?.()?.work), { environment: active?.environment, module: active?.name, key: active?.key ?? null, source: TOOL }); }
  catch { return false; /* a record that cannot be written never changes the publication */ }
}
function notePublicationEnded(handle) {
  try { recordPublicationEnded(handle); } catch { /* see above */ }
}

export const TOOL = 'o11_publish';
export const PUBLISHED = Object.freeze({ ok: true, result: RESULT.published });
// The bridge's own default comment says "publish de prova"; a product publication names its origin instead.
export const DEFAULT_MESSAGE = 'SSAM Hybrid o11_publish';
const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/; // ScGuard.Host of the bridge
const TRANSPORT = new Set(['BRIDGE_NOT_LISTENING', 'BRIDGE_TRANSPORT', 'BRIDGE_PROTOCOL', 'BRIDGE_NO_REPLY']);
const UNTRUSTED = /trusted Hybrid controller/i;
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const bare = message => clean(String(message ?? '').replace(/^\w+Exception:\s*/, ''), 300);
const reply = (value, text = JSON.stringify(value)) => ({ content: [{ type: 'text', text }], structuredContent: value, ...(value?.ok === false ? { isError: true } : {}) });
const placeholder = words => !wordsGiven(words); // CX15 r7 (L-7): one predicate (a marker, a <template>, a sha256, no words)

// ---- Continuations: always an MCP call, never a shell command.
const studio = (command, args, why) => ({ tool: 'o11_studio', arguments: { command, ...(args ? { args } : {}) }, why });
const connect = why => ({ tool: 'ssam_connect', arguments: { lane: 'o11' }, why });
const STATUS_BEFORE = studio('status', null, 'See the Studio of the O11 lane; nothing was published.');
const STATUS_AFTER = studio('status', null, 'Check in the Studio whether the publication finished before any new attempt; never repeat blindly.');
const ERRORS = studio('errors', null, 'Nothing was published. Fix the TrueChange errors in the module and check them here; then call o11_publish again with the user\'s words.');
const refusal = (code, error, continuation, extra = {}) => ({ ok: false, code, error, ...extra, continuation });

export const publishSchema = z.object({
  module: z.string().trim().min(1).max(200).describe('The module open in the selected Service Studio; its tab is selected first'),
  authorize: z.string().optional().describe('The user\'s own words, verbatim (only their sha256 is kept); absent: a standing grant of this module for publish, else nothing runs'),
  message: z.string().trim().min(1).max(500).optional().describe('Version comment of the publication'),
  timeoutSeconds: z.number().int().min(1).max(1800).default(600).describe('How long the Studio follows the server publication process (and waits for one already running)'),
  expectedEnvironment: z.string().trim().toLowerCase().max(253).regex(HOST, 'bare DNS name of the environment (no scheme, port or path)').optional()
    .describe('Bare host the selected Studio must be connected to'),
  refreshReferences: z.boolean().optional().describe('Refresh all references in the open tab, then publish once'),
  consumers: z.boolean().optional().describe('true: after publishing, refresh and publish every module that consumes this one, with the same words or grant'),
}).strict();

// ---- Failures of the reads before the publication: nothing was published.
const notConnected = () => refusal('O11_NOT_CONNECTED', 'No O11 Studio bridge answers on this lane; nothing was published.', connect('Connect the Service Studio open on this lane.'));
const notAuthorized = () => refusal('O11_NOT_AUTHORIZED', 'The bridge does not trust this controller key; nothing was published.', connect('Select the Studio again to renew the bridge key.'));
function readFailure(error) {
  if (TRANSPORT.has(error?.code)) return notConnected();
  if (UNTRUSTED.test(error?.message ?? '')) return notAuthorized();
  return refusal(error?.code ?? 'BRIDGE_ERROR', bare(error?.message ?? error) || 'The Studio read failed; nothing was published.', STATUS_BEFORE);
}

// PublishHandler.cs answers Server.Fail on both sides of the start, so the sentences of its checks before the command is
// dispatched (Studio.Active, Studio.RequireTarget, IsValid, a running server operation, the reflected Publish method, an
// unknown verb) are the only failures known to have executed nothing. Any other failure once the request left is uncertain.
// A bridge with publish:wait_running waits for the running operation first and refuses only when that wait expires.
const BEFORE = [
  [/has TrueChange errors/i, 'TRUECHANGE_ERRORS', 'The Studio refused: the module has TrueChange errors; nothing was published.', () => ERRORS],
  [/did not end within/i, 'STUDIO_BUSY_TIMEOUT', 'A server operation of the module was still running when the wait for it expired; nothing was published.',
    () => studio('wait', { condition: 'idle' }, 'Wait for the running operation to finish in the Studio; then call o11_publish again with the user\'s words.')],
  [/already has a server operation running/i, 'STUDIO_BUSY', 'The module already has a server operation running in the Studio; nothing was published.',
    () => studio('status', null, 'Wait for the running operation to finish in the Studio; nothing was published.')],
  [/nothing was executed/i, 'TARGET_CHANGED', 'Another module or environment became active before the publication; nothing was published.',
    name => studio('open-module', { name }, 'Select the module again; then call o11_publish with the user\'s words.')],
  [/no module open in the Studio|no aggregator presenter|is not open in the Studio/i, 'MODULE_NOT_ACTIVE', 'No module is active in the Studio; nothing was published.',
    name => studio('open-module', { name }, 'Open or select the module; then call o11_publish with the user\'s words.')],
  [/not found in this build|^Unknown method/i, 'PUBLISH_UNSUPPORTED', 'This Service Studio bridge does not expose the Publish command; nothing was published.',
    () => ({ tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'Shows the version of the bridge and of the Studio of the O11 lane.' })],
];
const FAILED = /completed with failure/i;
// The verb of the operation that kept the module busy, from the bridge sentence "... running (Publish) that did not end ...".
const busyVerb = text => /running \(([^)]+)\) that did not end/i.exec(text)?.[1] ?? /server operation running: (\S+)/i.exec(text)?.[1] ?? null;

// Pure: a failed publication with what the Studio showed for it (the bridge's publishLog: PublishLogHandler.cs; the same
// reader as o11_studio publish-log). Errors first, never cut; then warnings up to limit. Each message keeps type, stage,
// text, detail and element; the continuation points at the element to fix.
export function withPublishLog(refusal, log, name, limit = 40) {
  if (log?.found !== true || !Array.isArray(log.messages)) return refusal;
  const shape = m => ({ type: m.type, stage: m.stage, text: m.text, ...(m.detail ? { detail: m.detail } : {}),
    ...(m.element ? { element: Object.fromEntries(['name', 'key', 'kind', 'path', 'ambiguous'].filter(k => m.element[k] != null).map(k => [k, m.element[k]])) } : {}),
    ...(m.extraInfo ? { extraInfo: m.extraInfo } : {}) });
  const errs = log.messages.filter(m => m?.type === 'Error');
  const rest = log.messages.filter(m => m?.type === 'Warning').slice(0, Math.max(0, limit - errs.length));
  const omitted = (log.omitted ?? 0) + log.messages.length - errs.length - rest.length;
  const first = errs[0];
  const diagnosis = publishCompilerDiagnosis(log);
  return { ...refusal,
    error: 'The publication of ' + (name ?? 'the module') + ' failed' + (log.failedStage ? ' at ' + log.failedStage : '')
      + (first ? ': ' + clean(first.text, 300) : '') + '; it is not published.',
    failedStage: log.failedStage ?? null, errors: log.errors ?? errs.length, warnings: log.warnings ?? 0,
    messages: [...errs, ...rest].map(shape), ...(omitted > 0 ? { messagesOmitted: omitted } : {}),
    ...(log.serverOperationId != null ? { serverOperationId: log.serverOperationId } : {}),
    ...(diagnosis ? { diagnosis } : {}), continuation: publishFixContinuation(log, name) };
}

// C10 (bridge capability publish:blocked_by_dialog): a dialog kept the publication from going on in three reads in a row
// and the bridge stopped waiting for it. not-started: nothing reached the server (outcome blocked); started: it may still
// finish (outcome uncertain, never repeated blindly). The references dialog (Manage Dependencies) is answered by the
// Studio's own Refresh References; any other dialog by the person (I8, section 5.3).
function blockedByDialog(data, name, operationId) {
  const dialogs = (Array.isArray(data.blockedBy) ? data.blockedBy : []).slice(0, 4)
    .map(d => ({ kind: d?.kind ?? null, ...(d?.title ? { title: d.title } : {}), ...(d?.module ? { module: d.module } : {}) }));
  const references = dialogs.find(d => d.kind === 'ManageDependencies');
  const started = data.outcome === 'uncertain';
  return { ok: false, outcome: started ? 'uncertain' : 'blocked', code: 'PUBLISH_BLOCKED_BY_DIALOG', blockedBy: dialogs, ...(operationId ? { operationId } : {}),
    error: clean('The publication of ' + (name ?? 'the module') + ' is blocked by ' + (dialogs.map(d => d.kind + (d.module ? ' of ' + d.module : '')).join(', ') || 'a dialog')
      + (started ? '; it had started and may still finish: read the publish log before any new attempt.' : '; nothing was published.'), 400),
    continuation: references
      ? studio('refresh-references', { module: references.module ?? name }, 'Refreshes the references through the Studio\'s own Refresh References (the Manage Dependencies dialog); then call o11_publish again with the user\'s words.')
      : studio('status', null, 'See the dialog open in the Studio; the person answers it; then call o11_publish again with the user\'s words.') };
}

// Pure: the answer for what the bridge's publish returned (data) or threw (error, a BridgeError of o11-bridge.mjs).
export function publishOutcome({ data, error } = {}, { name } = {}, operationId = null) {
  const uncertain = reason => ({ ok: false, outcome: 'uncertain', code: 'PUBLISH_UNCERTAIN', ...(operationId ? { operationId } : {}),
    error: clean('The publication of ' + (name ?? 'the module') + ' has no confirmed end (' + reason + '). Nothing was repeated; check the Studio before any new attempt.', 400),
    continuation: STATUS_AFTER });
  if (!error && data?.published === false && data?.code === 'PUBLISH_BLOCKED_BY_DIALOG') return blockedByDialog(data, name, operationId);
  if (!error && data?.state === 'CompletedWithFailure') return withPublishLog(refusal('PUBLISH_FAILED',
    'The Studio reports that publication completed with failure; nothing was repeated.', STATUS_AFTER,
    { outcome: 'failed', ...(operationId ? { operationId } : {}) }), data.publishLog, name);
  if (!error && data?.state && !['CompletedWithSuccessNotOpenedInBrowser', 'CompletedWithSuccessOpenedInBrowserOrClosed'].includes(data.state))
    return uncertain('the Studio state is ' + String(data.state));
  if (!error) return data?.published === true && (!data.module || !name || same(data.module, name)) ? PUBLISHED : uncertain('the bridge answered without confirming it');
  const message = String(error?.message ?? error);
  // The caller stopped waiting (MCP cancellation): the publication may still run in the Studio.
  if (error?.code === 'CANCELLED') return { ok: false, outcome: error.executed === false ? 'not-sent' : 'uncertain', code: 'CANCELLED', ...(operationId ? { operationId } : {}),
    error: 'The call was cancelled' + (error.executed === false ? ' before the publication was sent; nothing was published.' : ' while ' + (name ?? 'the module')
      + ' was being published; it may still finish in the Studio. Nothing was repeated.'), continuation: STATUS_AFTER };
  const fromBridge = error?.reply != null; // a reply of the bridge, as opposed to a transport failure
  if (error?.executed === false) {
    if (!fromBridge) return notConnected();
    if (UNTRUSTED.test(message)) return notAuthorized();
    return refusal(error.reply?.code ?? error.reply?.data?.code ?? 'PUBLISH_REFUSED', bare(message) || 'The bridge refused the publication; nothing was published.', STATUS_BEFORE);
  }
  if (fromBridge) {
    const text = message.replace(/^\w+Exception:\s*/, '');
    // First: the failure text now quotes the server's first error, which must never read as a check before the start.
    if (!FAILED.test(text)) for (const [pattern, code, why, next] of BEFORE) if (pattern.test(text)) {
      const verb = code.startsWith('STUDIO_BUSY') ? busyVerb(text) : null;
      return refusal(code, why, next(name), verb ? { verb } : {});
    }
    if (FAILED.test(text)) return withPublishLog(refusal('PUBLISH_FAILED', 'The Studio reports that the publication of ' + (name ?? 'the module') + ' completed with failure (server compilation or deployment); it is not published.',
      studio('status', null, 'See the messages of the publication in the Studio before any new attempt.'), { outcome: 'failed', ...(operationId ? { operationId } : {}) }),
      error.reply?.data?.publishLog, name);
    return uncertain(bare(text));
  }
  return uncertain(error?.code === 'BRIDGE_TIMEOUT' ? 'no reply from the bridge in time' : bare(message) || 'the reply was lost');
}

// New TrueChange errors of get_errors, short: rawMessages ({id, type, key, path, detail}) of an Error type, else the text lines.
export function trueChangeErrors(verdict, limit = 20) {
  const raw = Array.isArray(verdict?.rawMessages) ? verdict.rawMessages.filter(m => /Error/.test(String(m?.type ?? ''))) : [];
  const all = raw.length ? raw.map(m => clean([m.type, m.id ? m.id + ':' : null, m.detail, m.path ? '@ ' + m.path : null].filter(Boolean).join(' '), 300))
    : (verdict?.messages ?? []).filter(m => /^\S*Error\b/.test(String(m))).map(m => clean(m, 300));
  const count = Math.max(Number(verdict?.errors) || 0, all.length);
  return { count, messages: all.slice(0, limit), omitted: Math.max(0, all.length - limit) };
}

// Pure: the consumer module names of a GetConsumers answer: the rows (Name/name, or ConsumerName) of the first list of
// rows found breadth-first, without the producer itself.
const rowName = row => { const name = row?.ConsumerName ?? row?.consumerName ?? row?.Name ?? row?.name; return typeof name === 'string' && name.trim() ? name.trim() : null; };
export function consumerNames(value, producer) {
  const queue = [value]; let rows = null;
  for (let seen = 0; queue.length && seen < 200 && !rows; seen++) {
    const node = queue.shift();
    if (Array.isArray(node)) { if (node.some(item => item && typeof item === 'object' && rowName(item))) rows = node; else queue.push(...node); }
    else if (node && typeof node === 'object') queue.push(...Object.values(node).filter(child => child && typeof child === 'object'));
  }
  return [...new Set((rows ?? []).map(rowName).filter(Boolean))].filter(n => !same(n, producer)).sort((a, b) => a.localeCompare(b));
}

// The module's consumers through the environment's own GetConsumers (o11_service_center_read consumers), on the Studio
// session. Loaded only when consumers:true is asked.
async function defaultConsumersOf({ moduleKey, host }) {
  const { serviceCenterTool } = await import('./service-center/index.mjs');
  const value = await serviceCenterTool(['consumers', '--module-key=' + moduleKey, ...(host ? ['--host=' + host] : [])], {});
  if (value?.ok === false) throw new Error(value.error ?? 'GetConsumers failed');
  return value;
}

async function publish(input, ctx, options = {}) {
  const signal = options.signal;
  // The words: the user's, or a standing grant that covers this module for publish (contract I6).
  const resolved = standingGrants.wordsFor({ authorize: input.authorize, lane: 'o11', module: input.module, app: ctx.appOf(input.module), verb: 'publish' }, ctx.grants, { file: ctx.grantsFile });
  const words = resolved.words;
  const authorization = options.authorization ?? resolved.authorization;
  // Blank words, or a placeholder such as the continuation marker, are not the user's words.
  if (!wordsGiven(words)) return refusal('WORDS_REQUIRED', 'o11_publish needs the user\'s own words in authorize, verbatim (or a standing grant of this module for publish).',
    { tool: TOOL, arguments: { module: input.module, authorize: WORDS_MARKER }, why: 'Ask the user for the words that authorize this publication and pass them verbatim in authorize.' });
  if (signal?.aborted) return { ...publishOutcome({ error: { code: 'CANCELLED', executed: false } }, { name: input.module }) };
  try { await ctx.assertSelected(); }
  catch (error) { return refusal('STUDIO_NOT_SELECTED', clean(error?.message) || 'The selected Studio is not confirmed.', connect('Select again the Service Studio open on the O11 lane.')); }
  let bridge;
  try { bridge = ctx.bridge(); } catch (error) { return readFailure(error); }

  // 1. Select the tab. The selection was just checked, so the open-module runner does not check it again.
  const opened = await o11Studio({ bridge: () => bridge, assertSelected: async () => {}, lane: ctx.laneName, root: ctx.root, env: ctx.env })({
    command: 'open-module', args: { name: input.module, ...(input.expectedEnvironment ? { environment: input.expectedEnvironment } : {}) } }, { signal });
  if (opened?.ok !== true) return { ...opened, ok: false, code: opened?.code ?? 'OPEN_FAILED', continuation: opened?.continuation ?? STATUS_BEFORE };
  const moduleName = opened.name && same(opened.name, input.module) ? input.module : opened.name ?? input.module;
  // C10: the open says the references are outdated (a producer was republished): the Studio's own Refresh References runs
  // first, in this call and under its write lock, so the publication never stops at the Manage Dependencies dialog; the
  // answer lists what was refreshed. An explicit refreshReferences also refreshes up-to-date references. A failed refresh publishes nothing.
  let referencesRefreshed = null;
  // MB2: the open met the dependencies dialog, answered it (Cancel) and refreshed every producer already.
  const dependencies = [];
  if (opened.referencesRefreshed) { dependencies.push({ dependenciesDialog: opened.dependenciesDialog, referencesRefreshed: opened.referencesRefreshed }); referencesRefreshed = opened.referencesRefreshed; }
  else if (input.refreshReferences === true || opened.referencesOutdated === true) {
    const refreshed = await o11Studio({ bridge: () => bridge, assertSelected: async () => {}, lane: ctx.laneName, root: ctx.root, env: ctx.env })({
      command: 'refresh-references', args: { module: moduleName, ...(input.expectedEnvironment ? { environment: input.expectedEnvironment } : {}) } }, { signal });
    if (refreshed?.ok !== true) return { ...refreshed, ok: false, code: refreshed?.code ?? 'REFRESH_FAILED', module: moduleName,
      error: 'The references of ' + moduleName + (opened.referencesOutdated === true ? ' are outdated and their refresh did not complete; nothing was published. ' : ' could not be refreshed; nothing was published. ') + (refreshed?.error ?? ''),
      continuation: refreshed?.continuation ?? STATUS_BEFORE };
    referencesRefreshed = { refreshed: refreshed.refreshed ?? [], ...(refreshed.upToDate?.length ? { upToDate: refreshed.upToDate } : {}) };
  }

  // 2-3. The tab active now, then its TrueChange (pinned to its key).
  let active, verdict, listed = null;
  // The module's tab: the active one, or (2026-10-07, a client session) its tab in any Studio window, addressed by key from here on.
  const readTarget = async () => {
    const selected = await bridge.ok('get_active_module');
    const selectedNamed = same(selected?.name, moduleName);
    if (selectedNamed && (!input.expectedEnvironment || same(selected?.environment, input.expectedEnvironment))) return { active: selected };
    const found = await moduleTab(bridge, moduleName, { environment: input.expectedEnvironment });
    if (found.ambiguous) return { refused: { ...tabAmbiguous(moduleName, found.ambiguous, 'shows the open tabs; close the duplicate in the Studio and call o11_publish again with the user\'s words'),
      error: 'More than one Studio tab is named ' + moduleName + '; nothing was published.' } };
    if (!found.tab && selectedNamed) return { active: selected }; // preserve the explicit environment-mismatch refusal
    if (!found.tab) return { refused: refusal('MODULE_NOT_ACTIVE', 'The active module is ' + (selected?.name ?? 'none') + ', not ' + moduleName + '; nothing was published.',
      studio('open-module', { name: moduleName }, 'Select the module in the Studio; then call o11_publish with the user\'s words.')) };
    return { active: { name: found.tab.name, key: found.tab.key, environment: found.tab.environment ?? null, pendingDialogs: found.tab.pendingDialogs ?? [], byKey: true },
      listed: found.listed };
  };
  try {
    let target = await readTarget();
    if (target.refused) return target.refused;
    ({ active, listed = null } = target);
    if (input.expectedEnvironment && !same(active?.environment, input.expectedEnvironment))
      return refusal('ENVIRONMENT_MISMATCH', 'The selected Studio is connected to ' + (active?.environment ?? 'no environment') + ', not ' + input.expectedEnvironment + '; nothing was published.',
        studio('status', null, 'See which environment the selected Studio is connected to; nothing was published.'));
    // C10: the one detector of o11_studio (this tab's dialogs and, with list_open_modules:dialogs, every other tab's and window's).
    let pending = allDialogs(active, listed);
    // MB2: the dependencies dialog among them is answered (Cancel) and the module's references refreshed; then read again.
    if (dependenciesCandidate(pending)) {
      const answered = await answerDependenciesDialog(bridge, { module: active.name, key: active.key ?? null, environment: active.environment ?? null, signal });
      if (answered?.ok === false) return { ...answered, error: answered.error + ' Nothing was published.' };
      if (answered) {
        dependencies.push(answered); referencesRefreshed = answered.referencesRefreshed;
        target = await readTarget();
        if (target.refused) return target.refused;
        ({ active, listed = null } = target);
        pending = allDialogs(active, listed);
      }
    }
    if (pending.length)
      return refusal('DIALOG_BLOCKING', 'A dialog is open in the Studio; nothing was published.', studio('wait', { condition: 'no-dialogs' }, ASK_PERSON),
        { dialogs: pending.slice(0, 4).map(d => ({ kind: d?.kind ?? null, ...(d?.title ? { title: d.title } : {}), ...(d?.module ? { module: d.module } : {}) })) });
    verdict = await bridge.ok('get_errors', { max: 60, ...(active?.key ? { module_key: active.key } : {}) });
  } catch (error) { return readFailure(error); }
  const errors = trueChangeErrors(verdict);
  if (errors.count > 0 || verdict?.isValid === false)
    return refusal('TRUECHANGE_ERRORS', active.name + ' has ' + (errors.count || 'unlisted') + ' TrueChange error(s); nothing was published.', ERRORS,
      { module: active.name, errors: errors.count, ...(errors.messages.length ? { messages: errors.messages } : {}), ...(errors.omitted ? { messagesOmitted: errors.omitted } : {}) });

  // 4-5. Journal, then the publication, as one tracked task (ssam_task reads it meanwhile).
  const operationId = randomUUID();
  const summary = { module: active.name, environment: active.environment ?? null, operationId, ...(input.consumers ? { consumers: true } : {}) };
  const value = await trackTask({ tool: TOOL, summary, dir: ctx.tasks, now: ctx.now }, async task => {
    const line = entry => ctx.journal(ctx.lane().local, { tool: TOOL, operationId, task: task.id, ...entry });
    try { line({ event: 'start', module: active.name, moduleKey: active.key ?? null, environment: active.environment ?? null, wordsSha256: sha256(words),
      ...(authorization?.grantId ? { grantId: authorization.grantId } : {}) }); }
    catch (error) {
      return refusal('JOURNAL_FAILED', clean('The journal line could not be written, so nothing was published: ' + error.message, 300),
        { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'Shows the folders of the O11 lane.' });
    }
    const params = { message: input.message ?? DEFAULT_MESSAGE, timeout: input.timeoutSeconds ?? 600,
      ...(active.key ? { module_key: active.key } : {}), ...(active.environment ? { environment: active.environment } : {}) };
    let value, data = null;
    // I2 (C07): the publication is a server operation of this module, addressed by its key: the Studio's write lock narrows to
    // the module (a write of another module of the same Studio runs meanwhile). Inert where the lock lacks it.
    try { writeLock.narrowStudioWrite?.({ module: active.name, moduleKey: active.key ?? null }); } catch { /* the publication goes on under the Studio lock */ }
    // F5 (producer-signatures.mjs): from now on no earlier observation of this module as a producer counts; the next delivery
    // that references it observes it on the server again (and captures it again when the version moved).
    const publication = notePublication(ctx, active);
    try {
    try { data = await bridge.ok('publish', params, signal ? { signal } : undefined); value = publishOutcome({ data }, active, operationId); }
    catch (error) { value = publishOutcome({ error }, active, operationId); data = error?.reply?.data ?? null; }
    // MB2: the dependencies dialog stopped the publication before anything reached the server: answered (Cancel, or the
    // bridge already did), every producer refreshed, and the publication runs again once, in this call.
    if (value.code === 'PUBLISH_BLOCKED_BY_DIALOG' && value.outcome === 'blocked' && !signal?.aborted
      && (data?.dependenciesDialog?.answered?.length || dependenciesCandidate(data?.blockedBy))) {
      const closed = data?.dependenciesDialog?.answered?.length ? { answered: data.dependenciesDialog.answered } : await closeDependenciesDialog(bridge).catch(() => null);
      if (closed) {
        const refreshed = await refreshAfterDialog(bridge, closed, { module: active.name, key: active.key ?? null, environment: active.environment ?? null, signal });
        if (refreshed?.ok !== true) value = { ...refreshed, ...(operationId ? { operationId } : {}), error: (refreshed?.error ?? 'The refresh did not complete.') + ' Nothing was published.' };
        else {
          dependencies.push(refreshed); referencesRefreshed = refreshed.referencesRefreshed;
          try { data = await bridge.ok('publish', { ...params, answer_dependencies: true }, signal ? { signal } : undefined); value = publishOutcome({ data }, active, operationId); }
          catch (error) { value = publishOutcome({ error }, active, operationId); data = error?.reply?.data ?? null; }
        }
      }
    }
    } finally { if (!publicationOpen(value)) notePublicationEnded(publication); }
    // A bridge that answers the failure without its messages: read them as o11_studio publish-log does (one read, no retry).
    let log = data?.publishLog ?? null;
    if (value.code === 'PUBLISH_FAILED' && !value.messages) {
      try {
        const read = await bridge.ok('publish_log', { module: active.name, max: 200 });
        if (read?.found === true && read.status === 'failed' && same(read.module, active.name)) { value = withPublishLog(value, read, active.name); log = read; }
      } catch { /* an older bridge: the refusal stays as it is */ }
    }
    value = decorate(value, { data, log, ctx });
    // A failed end line never changes what happened; the task file still records the outcome.
    try { line({ event: 'end', outcome: value.ok ? 'published' : value.outcome ?? 'refused', ...(value.code ? { code: value.code } : {}) }); } catch { /* see above */ }
    return value;
  });
  const answered = dependencies.length ? dependenciesFields(dependencies) : null;
  const refreshedValue = answered && value && typeof value === 'object' ? { ...value, ...answered }
    : referencesRefreshed && value && typeof value === 'object' ? { ...value, referencesRefreshed } : value;
  const withAuthorization = authorization && refreshedValue && typeof refreshedValue === 'object' ? { ...refreshedValue, authorization } : refreshedValue;
  if (!input.consumers || withAuthorization.ok !== true) return withAuthorization;
  return publishConsumers(withAuthorization, { input, active, words, authorization, bridge, ctx, signal });
}

// Section 3.2 fields of a publication: dialogsSeen (C10) from the bridge reply, lastPublication from the publish result
// (succeeded, by SSAM) or from the publish log of a failure. Nothing is added when there is nothing to say, so a plain
// success with an older bridge still reads {ok, result}.
function decorate(value, { data, log, ctx }) {
  const dialogsSeen = Array.isArray(data?.dialogsSeen) && data.dialogsSeen.length ? data.dialogsSeen.slice(0, 10).map(d => clean(typeof d === 'string' ? d : d?.title ?? JSON.stringify(d), 120)) : null;
  let lastPublication = null;
  if (value.ok === true) lastPublication = { at: ctx.now().toISOString(), status: 'succeeded', version: data?.version ?? null, author: null, by: 'ssam', source: 'publish-result' };
  else if (log?.found === true) lastPublication = { at: log.endedAt ?? log.startedAt ?? null, status: ['succeeded', 'failed', 'running'].includes(log.status) ? log.status : 'unknown',
    version: null, author: null, by: log.triggeredBy === 'bridge' ? 'ssam' : log.triggeredBy === 'studio' ? 'person' : 'unknown', source: 'publish-log' };
  if (!dialogsSeen && !lastPublication) return value;
  // publish:settled (UI freeze of 2026-10-08): the tab was still finishing the publication when the bridge answered; a
  // close-module now answers MODULE_BUSY until it is idle (o11_studio wait idle first).
  const unsettled = value.ok === true && data?.settled === false ? { settled: false } : {};
  return { ...value, ...(dialogsSeen ? { dialogsSeen } : {}), ...(lastPublication ? { lastPublication } : {}), ...unsettled };
}

// consumers:true: every consumer of the published producer, one after the other: select, refresh its references to the
// producer, publish with the same words or a grant that covers it. An uncertain step stops the rest (they are skipped):
// nothing is repeated over an unknown state.
async function publishConsumers(value, { input, active, words, authorization, bridge, ctx, signal }) {
  let names;
  try { names = consumerNames(await ctx.consumersOf({ module: active.name, moduleKey: active.key, host: active.environment ?? null }), active.name); }
  catch (error) {
    return { ...value, ok: false, code: 'CONSUMERS_UNKNOWN', error: 'The producer was published; its consumers could not be read: ' + bare(error?.message ?? error),
      consumers: [], continuation: { tool: 'o11_service_center_read', arguments: { action: 'consumers', moduleKey: active.key }, why: 'read the consumers of the published producer' } };
  }
  const results = await cascade(names, active.name, { words, authorization, message: input.message, timeoutSeconds: input.timeoutSeconds,
    expectedEnvironment: input.expectedEnvironment, bridge, ctx, signal });
  const complete = results.every(r => r.outcome === 'published');
  return complete ? { ...value, consumers: results }
    : { ...value, ok: false, code: results.some(r => r.outcome === 'uncertain') ? 'CONSUMERS_UNCERTAIN' : 'CONSUMERS_INCOMPLETE', consumers: results,
      error: 'The producer ' + active.name + ' was published; not every consumer was refreshed and published. Nothing was repeated.',
      continuation: studio('status', null, 'See the Studio state; publish each missing consumer with o11_publish and the user\'s words.') };
}

// One consumer after the other: select, refresh its references to the producer, publish with the same words or a grant
// that covers it. An uncertain step stops the rest (they are skipped): nothing is repeated over an unknown state.
async function cascade(names, producerName, { words, authorization, message, timeoutSeconds, expectedEnvironment, bridge, ctx, signal }) {
  const results = [];
  let stop = false;
  const runner = o11Studio({ bridge: () => bridge, assertSelected: async () => {}, lane: ctx.laneName, root: ctx.root, env: ctx.env });
  for (const name of names) {
    if (stop || signal?.aborted) { results.push({ module: name, outcome: 'skipped' }); continue; }
    // The same words cover a consumer only when given by the user; a grant must cover the consumer itself.
    const consumerWords = authorization?.source === 'standing-grant'
      ? standingGrants.wordsFor({ lane: 'o11', module: name, app: ctx.appOf(name), verb: 'publish' }, ctx.grants, { file: ctx.grantsFile }) : { words };
    if (!consumerWords.words) { results.push({ module: name, outcome: 'refused', code: 'WORDS_REQUIRED' }); continue; }
    const refreshed = await runner({ command: 'refresh-references', args: { module: name, producers: [producerName] } }, { signal });
    if (refreshed?.ok !== true) {
      results.push({ module: name, outcome: refreshed?.outcome === 'uncertain' ? 'uncertain' : 'refused', code: refreshed?.code ?? 'REFRESH_FAILED' });
      if (refreshed?.outcome === 'uncertain') stop = true;
      continue;
    }
    const published = await publish({ module: name, authorize: consumerWords.words, message, timeoutSeconds,
      ...(expectedEnvironment ? { expectedEnvironment } : {}) }, ctx, { signal, authorization: consumerWords.authorization });
    const outcome = published.ok === true ? 'published' : published.outcome === 'uncertain' ? 'uncertain' : published.outcome === 'failed' ? 'failed' : 'refused';
    results.push({ module: name, outcome, ...(published.code ? { code: published.code } : {}) });
    if (outcome === 'uncertain') stop = true;
  }
  return results;
}

// I11 (contract docs/INTEGRACOES-GITSSAM.md): the consumer cascade of a producer that is not a Studio tab (an extension
// published through the Service Center by o11_extension). producer {name, key, environment}: its consumers come from the
// environment's GetConsumers (deps.consumersOf, as for consumers:true); each one is refreshed and published with the same
// words, or with a grant that covers it when the producer's own authorization was a grant. The first uncertain step
// stops the rest (skipped), nothing is repeated. deps: those of createO11Publish.
export async function publishConsumersOf({ producer, words, authorization = null, message, timeoutSeconds } = {}, deps = {}) {
  const ctx = context(deps);
  if (!producer?.name) return refusal('PRODUCER_REQUIRED', 'publishConsumersOf needs producer {name, key, environment}.', STATUS_BEFORE, { consumers: [] });
  let names;
  try { names = consumerNames(await ctx.consumersOf({ module: producer.name, moduleKey: producer.key ?? null, host: producer.environment ?? null }), producer.name); }
  catch (error) {
    return { ok: false, code: 'CONSUMERS_UNKNOWN', error: 'The consumers of ' + producer.name + ' could not be read: ' + bare(error?.message ?? error), consumers: [],
      continuation: { tool: 'o11_service_center_read', arguments: { action: 'consumers', moduleKey: producer.key ?? null }, why: 'read the consumers of the published producer' } };
  }
  if (!names.length) return { ok: true, consumers: [] };
  try { await ctx.assertSelected(); }
  catch (error) { return { ...refusal('STUDIO_NOT_SELECTED', clean(error?.message) || 'The selected Studio is not confirmed.', connect('Select again the Service Studio open on the O11 lane.')), consumers: [] }; }
  let bridge;
  try { bridge = ctx.bridge(); } catch (error) { return { ...readFailure(error), consumers: [] }; }
  const results = await cascade(names, producer.name, { words, authorization, message: message ?? DEFAULT_MESSAGE, timeoutSeconds: timeoutSeconds ?? 600,
    expectedEnvironment: producer.environment ?? null, bridge, ctx });
  const complete = results.every(r => r.outcome === 'published');
  return complete ? { ok: true, consumers: results }
    : { ok: false, code: results.some(r => r.outcome === 'uncertain') ? 'CONSUMERS_UNCERTAIN' : 'CONSUMERS_INCOMPLETE', consumers: results,
      error: 'Not every consumer of ' + producer.name + ' was refreshed and published. Nothing was repeated.',
      continuation: studio('status', null, 'See the Studio state; publish each missing consumer with o11_publish and the user\'s words.') };
}

function appendJournal(now) {
  return (local, entry) => {
    const dir = path.join(local, 'journal');
    fs.mkdirSync(dir, { recursive: true });
    appendJsonLine(path.join(dir, TOOL + '.jsonl'), { at: now().toISOString(), ...entry });
  };
}

// The publication runner behind o11_publish, also used by o11_deliver {publish:true}. deps: root, env, lane, now (-> Date),
// bridge (a client of o11-bridge.mjs, or a function returning one; default the lane's target read per call),
// assertSelected, tasksDir, journal(local, entry), grants (standing-grants.mjs API), grantsFile, consumersOf({module,
// moduleKey, host}). Returns run(input, {signal, authorization}) -> value.
export function createO11Publish(deps = {}) {
  const ctx = context(deps);
  return (input, options = {}) => publish(input ?? {}, ctx, options);
}

function context(deps = {}) {
  const root = deps.root ?? anvilRoot;
  const env = deps.env ?? process.env;
  const laneName = deps.lane ?? o11Lane.lane;
  const now = deps.now ?? (() => new Date());
  const ctx = {
    root, env, laneName, now,
    lane: () => o11LaneOf(laneName, { root, env }),
    bridge: () => (typeof deps.bridge === 'function' ? deps.bridge() : deps.bridge ?? o11Bridge(bridgeTarget({ lane: laneName, root, env }))),
    assertSelected: deps.assertSelected ?? assertSelectedO11,
    tasks: deps.tasksDir ?? tasksDir(root),
    journal: deps.journal ?? appendJournal(now),
    grants: deps.grants ?? standingGrants,
    grantsFile: deps.grantsFile,
    consumersOf: deps.consumersOf ?? defaultConsumersOf,
    // The application of a module, for a grant given per app: the newest o11_environment inventory (o11-studio.mjs).
    inventory: deps.inventory ?? (() => readInventory({ local: o11LaneOf(laneName, { root, env }).local })),
    appOf: module => { try { return ctx.inventory()?.modules?.find(m => m.name && module && m.name.toLowerCase() === String(module).toLowerCase())?.app ?? null; } catch { return null; } },
  };
  return ctx;
}

// ---- ssam_grant: the standing grants (contract I6). Served with the O11 tools (with SSAM_MCP_LANES=odc it is not
// served); the ODC studio_deliver/studio_publish read the same file.
const grantSchema = z.object({
  action: z.enum(['grant', 'revoke', 'list']),
  lane: z.enum(standingGrants.GRANT_LANES).optional().describe('o11 or odc (required to grant)'),
  app: z.string().trim().min(1).max(200).optional().describe('grant: the application the grant covers; the words must name it'),
  modules: z.union([z.literal('*'), z.array(z.string().trim().min(1).max(200)).min(1).max(64)]).optional().describe('grant: "*" (default) or the module names it covers'),
  verbs: z.array(z.enum(standingGrants.GRANT_VERBS)).min(1).max(2).optional().describe('grant: deliver and/or publish (default both)'),
  words: z.string().max(2000).optional().describe('grant: the user\'s own words, verbatim, naming the app'),
  grantId: z.string().trim().min(1).max(64).optional().describe('revoke: the grant to revoke (or lane and app: every grant of the app)'),
}).strict();

export function registerSsamGrant(server, deps = {}) {
  const grants = deps.grants ?? standingGrants;
  const file = deps.grantsFile;
  const now = deps.now;
  server.registerTool('ssam_grant', {
    title: 'Standing authorization of deliveries and publications',
    description: 'A standing grant: the user\'s own words, given once, authorize deliver and/or publish of an application (all its modules, '
      + 'or the listed ones) until revoked. grant {lane, app, modules?, verbs?, words}: the words must name the app as written '
      + '(GRANT_WORDS_MUST_NAME_APP otherwise); revoke {grantId} or {lane, app}; list {lane?}. Then o11_deliver, o11_publish (and the ODC '
      + 'studio_deliver/studio_publish) without authorize use the grant and answer authorization {source:"standing-grant", grantId}. '
      + 'Only the sha256 of the words is ever shown. Never create a grant without the user asking for it in their own words.',
    inputSchema: grantSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async input => {
    let value;
    try {
      const { action, ...rest } = input ?? {};
      if (action === 'grant') value = grants.addGrant(rest, { file, now });
      else if (action === 'revoke') value = grants.revokeGrant(rest.grantId ? { grantId: rest.grantId } : { lane: rest.lane, app: rest.app }, { file, now });
      else value = grants.listGrants({ lane: rest.lane }, { file });
      if (value?.ok === false) value = { ...value, continuation: { tool: 'ssam_grant', arguments: { action: 'list' }, why: 'see the existing grants' } };
    } catch (error) { value = { ok: false, code: 'GRANT_FAILED', error: clean(error?.message ?? String(error)) }; }
    return reply(value);
  });
}

// deps: those of createO11Publish, plus registerGrant (false when ssam_grant is registered elsewhere).
export function registerO11Publish(server, deps = {}) {
  const run = createO11Publish(deps);
  server.registerTool(TOOL, {
    title: 'Publish the module open in the O11 Service Studio',
    description: '[o11] Publishes (1-Click Publish) the module open in the Service Studio selected on the O11 lane, with the user\'s words '
      + 'in authorize or a standing grant of the module for publish (ssam_grant). It checks the active module (and expectedEnvironment), '
      + 'waits for a server operation already running on it (STUDIO_BUSY_TIMEOUT), reads TrueChange: with errors it returns them and '
      + 'publishes nothing. Published: "published" with lastPublication. PUBLISH_FAILED (server compilation or deployment) carries every '
      + 'message the Studio showed (type, stage, text, detail, element) and a continuation to the element to fix. '
      + 'consumers:true then refreshes and publishes every consumer of the module, one outcome per consumer. '
      + 'outcome "uncertain" (timeout, lost reply, cancellation, unconfirmed end) is never repeated: check o11_studio status before '
      + 'retry. refreshReferences:true refreshes; answers when it ends.',
    inputSchema: publishSchema, annotations,
  }, async (input, extra) => {
    try { const value = await run(input ?? {}, { signal: extra?.signal }); return value === PUBLISHED ? reply(value, value.result) : reply(value); }
    catch (error) { return reply(refusal('PUBLISH_ERROR', clean(error?.message ?? String(error)) || 'o11_publish failed', STATUS_AFTER)); }
  });
  if (deps.registerGrant !== false) registerSsamGrant(server, deps);
}
