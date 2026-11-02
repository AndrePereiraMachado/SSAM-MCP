// Authentication per host and per call, in this order:
//   1. the native Studio session (studio for the Studio API, studio-http for Service Center pages);
//   2. a compatible stored credential profile of the host (credential-profiles.mjs: the selected one, the unique one of
//      the Studio's principal, or an explicit credentialTarget);
//   3. only when the host has no stored credential at all (no SSAM/O11/<host>/ServiceCenter entry, or no LifeTime token,
//      database login or secret site property value for those surfaces): the private Windows prompt in its own window
//      (the managed private window of portal/runtime/credential-prompt.mjs, confirmed visible). The call waits, bounded
//      (SSAM_PROMPT_WAIT_MS, default 120 s, and never past the 29 s read budget of a read); not stored in time,
//      CREDENTIAL_PROMPT_PENDING, resumable: the window stays open and the same call goes on once it is stored. The
//      entry the user typed there is remembered as the host's profile, so later calls reuse it from the vault.
// Ambiguous profiles, a stored entry of another principal and interactive identity challenges (MFA, another identity
// provider) are reported, never prompted. No credential ever passes through arguments, output or chat.
// Hosted (the SSAM server answering a customer, ../executor.mjs) only the customer's Studio session is a path
// (studio, studio-http): the profiles, the vault, the window and the prompt of the server are never used
// (HOSTED_STUDIO_SESSION_ONLY, HOSTED_PROMPT_UNAVAILABLE), so session "vault" and LifeTime are refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anvilRoot } from '../workspace.mjs';
import { LocalExecutor, currentExecutor, hostedContext, workspacePath } from '../executor.mjs';
import { AuthRequired, BridgeError, ProtocolError, connectStudio, continuation } from './errors.mjs';
import { hostName } from './http.mjs';
import { O11_PROMPT_KINDS, createCredentialPrompt, promptStateDir } from '../../portal/runtime/credential-prompt.mjs';
import { fold } from './util.mjs';
import { readCheckpoint, readOptions } from '../read-budget.mjs';

export const KINDS = ['ServiceCenter', 'LifeTime', 'DatabaseConnection', 'SiteProperty'];
export const hostsFile = (root = anvilRoot) => path.join(root, 'scripts', 'service_center', 'hosts.json');
export const promptScript = (root = anvilRoot) => path.join(root, 'scripts', 'service_center', 'windows-o11-credential.ps1');
// Outside %LOCALAPPDATA%: processes of the Claude app (MSIX) see a private copy of it. Not .ssam: that is GitSSAM's.
// Hosted: the customer's <ws>/state/service-center.
export const stateDir = (env = process.env) => (hostedContext() ? workspacePath('state', 'service-center') : path.join(env.USERPROFILE || os.homedir(), '.ssam-hybrid'));

export const hostedStudioOnly = what => new AuthRequired('HOSTED_STUDIO_SESSION_ONLY', what + ' uses the vault of the SSAM server, which is never used in hosted mode: '
  + 'Service Center calls run only through the user\'s own Service Studio session (session "studio" or "studio-web").',
{ continuation: connectStudio('connect the user\'s Service Studio; its session is the only path in hosted mode') });
export const hostedNoPrompt = (host, why) => new AuthRequired('HOSTED_PROMPT_UNAVAILABLE', `${why}; no credential prompt opens in hosted mode. The user signs `
  + `their own Service Studio in on ${host} and repeats the call; its session is the only path in hosted mode.`);

export function credentialTarget(host, kind, name = null) {
  if (!KINDS.includes(kind)) throw new ProtocolError('Unknown credential kind');
  host = hostName(host);
  if (kind === 'DatabaseConnection' || kind === 'SiteProperty') {
    // The same name rule as the vault's secretTarget; the Studio reads these entries inside its own process.
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name ?? '')) throw new ProtocolError(`${kind} vault entries are named by a plain identifier`);
    return `SSAM/O11/${host}/${kind}/${name}`;
  }
  return `SSAM/O11/${host}/${kind}`;
}

// Lote 4, F3 (relatos af6dbc48, e2179576): which source answered a call, beside the session the caller asked for.
// studio, studio-http and studio-web are the connected Studio's login; vault, vault-sso and vault-sso-cache the stored
// credential of the private Windows vault; local-receipt answers from a receipt, without any session.
export const sessionSource = pathName => (/^studio/.test(String(pathName)) ? 'studio' : /^(?:vault|profiles)/.test(String(pathName)) ? 'vault'
  : pathName === 'local-receipt' ? 'local' : 'unknown');

export class Auth {
  constructor(pathName, host, user = null, bridge = null, attempts = []) { this.path = pathName; this.host = host; this.user = user; this.bridge = bridge; this.attempts = attempts; }
  describe() { return { path: this.path, host: this.host, ...(this.user ? { user: this.user } : {}), attempts: this.attempts }; }
  // requested: the caller's session (auto, studio, studio-web or vault), set by the Resolver; source: who answered.
  session() { return { requested: this.requested ?? 'auto', source: sessionSource(this.path) }; }
}

// Whether a Service Studio process is open, connected or not (the studio.processes call of the executor seam; nothing
// else is inspected). Hosted: on the customer's machine. Locally, as before the seam: the pid-only listing
// (paths:false), and a listing that fails means not running.
export async function studioRunning() {
  const executor = currentExecutor();
  if (!executor.hosted && process.platform !== 'win32') return false;
  const listing = executor instanceof LocalExecutor
    ? executor.call('studio.processes', { image: 'ServiceStudio.exe', paths: false }).catch(() => ({ processes: [] }))
    : executor.call('studio.processes', { image: 'ServiceStudio.exe' });
  const { processes } = await listing;
  return (processes ?? []).length > 0;
}

// Lote 4, F3 (relato 88a0d528, 14/10: CREDENTIAL_PROMPT_PENDING declared a window the person never found, not even by
// Alt+Tab). The private window is the one of the ODC prompt manager (portal/runtime/credential-prompt.mjs and
// windows-credential-prompt.ps1, O11 kinds): it owns only its own form, confirms it visible by PID, start time and handle,
// and brings it to the front on every ensure (a repeated call focuses the window that is open, never a second one). A
// launch alone is never a window: what the manager does not confirm visible is refused with its code, nothing stored.
// The state lives in %USERPROFILE%\.ssam-hybrid\auth\prompts\o11-<key> (never %LOCALAPPDATA%), window metadata only.
export const promptTitle = (host, kind) => `SSAM - ${hostName(host)} - ${O11_PROMPT_KINDS[kind]}`;
// Hosted, the refusal is thrown at once (synchronously), before any window or manager: the server never opens one.
export function openPrompt(host, kind, name = null, options = {}) {
  if (hostedContext()) throw hostedNoPrompt(host, `No credential of ${host} can be stored from here`);
  return openManagedPrompt(host, kind, name, options);
}
async function openManagedPrompt(host, kind, name, { env = process.env, manager = null } = {}) {
  const target = credentialTarget(host, kind, name);
  const prompt = manager ?? createCredentialPrompt({ env });
  const managed = [O11_PROMPT_KINDS[kind], hostName(host), name ?? ''];
  const window = await prompt(...managed, 'ensure');
  const status = () => prompt(...managed, 'status');
  const title = promptTitle(host, kind);
  if (window?.state === 'cancelled') { clearPrompt(managed, env); throw promptCancelled(host, target, kind); }
  if (window?.visible !== true)
    throw new AuthRequired(window?.code ?? 'CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE', `The private credential window for ${target} could not be confirmed on the screen `
      + `(${window?.state ?? 'no answer'}); nothing was typed or stored, and SSAM does not claim it opened.`,
    { auth: { path: 'prompt', host: hostName(host), target, window: { title, state: window?.state ?? 'failed', visible: false } },
      attempts: [{ path: 'prompt', outcome: 'window-unconfirmed', target }] });
  return { opened: window.opened === true, alreadyOpen: window.alreadyOpen === true, visible: true, foreground: window.foreground === true,
    pid: window.pid, title, target, status, clear: () => clearPrompt(managed, env) };
}

// A cancelled window leaves no state behind: the next call that needs the credential opens a new window, only when the
// person repeats it.
function clearPrompt([kind, host, name], env) {
  try { fs.rmSync(path.join(promptStateDir(kind, host, name, env), 'window.json'), { force: true }); } catch { /* best effort */ }
}
const promptCancelled = (host, target, kind) => new AuthRequired('CREDENTIAL_PROMPT_CANCELLED',
  `The private credential window for ${target} was cancelled; nothing was stored and nothing was sent. It opens again only when the person asks to continue.`,
  { auth: { path: 'prompt', host: hostName(host), target, window: { title: promptTitle(host, kind), state: 'cancelled', visible: false } },
    attempts: [{ path: 'prompt', outcome: 'cancelled', target }] });

export function hostClass(host, registry = hostsFile()) {
  let hosts = {};
  if (fs.existsSync(registry) && fs.statSync(registry).isFile()) hosts = JSON.parse(fs.readFileSync(registry, 'utf8').replace(/^﻿/, '')).hosts ?? {};
  // An environment nobody registered counts as corporate.
  return hosts[hostName(host)]?.class ?? 'corporate';
}

// The user's words name a destructive target as a whole word, case- and accent-insensitive; a space in the name matches
// any run of spaces. "apagar ZZDemo2" does not name ZZDemo, "Orders2" does not name Orders.
const plain = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '');
export function namesWhole(words, name) {
  const target = plain(name).trim();
  if (!target) return false;
  const pattern = target.split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp('(?<![\\p{L}\\p{N}_])' + pattern + '(?![\\p{L}\\p{N}_])', 'iu').test(plain(words));
}

// Corporate/unknown hosts need confirmHost and words that name the environment, on every operation; destructive
// operations need words that name each target (namesWhole).
export function guardWrite(host, words, confirmHost = null, targets = [], registry = hostsFile()) {
  const kind = hostClass(host, registry);
  if (kind === 'read-only') throw new ProtocolError(`${host} is registered read-only; no Service Center write is sent`);
  const folded = fold(words ?? '');
  if (kind !== 'personal') {
    const label = fold(host.split('.')[0]);
    if (confirmHost !== host || (!folded.includes(label) && !folded.includes(fold(host))))
      throw new ProtocolError(`${host} is a ${kind} environment: every write needs confirmHost=${host} and words that name this environment`);
  }
  const missing = targets.filter(t => t && !namesWhole(words, String(t)));
  if (missing.length) throw new ProtocolError("A destructive operation needs the user's words to name its target: " + missing.map(String).join(', '));
  return kind;
}

// A bridge whose sc_web answers carry reentry (ScWebSession.Describe) signs its hidden window in through the identity
// session of the Studio's browser profile (single sign-on, nothing typed) and keeps it alive itself; the facade knows it
// by that field of the sc_session web object, never by a manifest capability.
export const silentReentry = web => typeof web?.reentry === 'string' && web.reentry.length > 0;

// A13: a pending private prompt is waited for in the same call, bounded: SSAM_PROMPT_WAIT_MS (default 120000 ms, 0 does
// not wait). The wait polls only whether the vault entry exists (never its value). Stored: the call goes on. Not stored
// in time: CREDENTIAL_PROMPT_PENDING, resumable (the prompt stays open; the same call goes on once it is stored).
export const PROMPT_WAIT_MS = 120000;
export function promptWaitMs(env = process.env, override = undefined) {
  if (Number.isFinite(override)) return Math.max(0, override);
  const value = Number(env?.SSAM_PROMPT_WAIT_MS);
  return env?.SSAM_PROMPT_WAIT_MS !== undefined && env?.SSAM_PROMPT_WAIT_MS !== '' && Number.isFinite(value) && value >= 0 ? value : PROMPT_WAIT_MS;
}
const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Inside a bounded read (read-budget.mjs) the wait ends 2 s before the read budget does, so a read answers
// CREDENTIAL_PROMPT_PENDING (resumable) instead of READ_DEADLINE_EXCEEDED.
// cancelled: an optional check of the window (the manager's status, every third poll): a window the person cancelled
// ends the wait at once ({cancelled:true}) instead of holding the call until the deadline.
export async function awaitStored(present, target, { waitMs = promptWaitMs(), sleep = realSleep, now = Date.now, interval = 1000, cancelled = null } = {}) {
  const check = typeof present.fresh === 'function' ? present.fresh : present;
  const budget = readOptions('authentication').timeoutMs;
  if (Number.isFinite(budget)) waitMs = Math.max(0, Math.min(waitMs, budget - 2000));
  const start = now();
  for (let poll = 0; ; poll++) {
    readCheckpoint('authentication');
    if (await check(target)) return { stored: true, waitedMs: now() - start };
    if (typeof cancelled === 'function' && poll % 3 === 2 && await cancelled()) return { stored: false, cancelled: true, waitedMs: now() - start };
    const left = waitMs - (now() - start);
    if (left <= 0) return { stored: false, waitedMs: now() - start };
    await sleep(Math.min(interval, left));
  }
}
const TYPED = { ServiceCenter: 'the Service Center login there (an OutSystems account: its e-mail and password)',
  LifeTime: 'the LifeTime service account and its token there', DatabaseConnection: 'the database login there',
  SiteProperty: 'the secret value there (as the password)' };
const promptPending = (why, host, target, opened, waited, attempts, kind = 'ServiceCenter') => new AuthRequired('CREDENTIAL_PROMPT_PENDING',
  `${why}: a private Windows prompt is open in its own window for ${target}. The user types ${TYPED[kind] ?? TYPED.ServiceCenter}; `
  + `nothing passes through the chat. This call waited ${Math.round(waited.waitedMs / 1000)} s and nothing was stored yet; `
  + 'the same call goes on once it is stored (the prompt stays open).',
  { auth: { path: 'prompt', host, target, alreadyOpen: opened?.alreadyOpen ?? false, waitedMs: waited.waitedMs, resumable: true,
    // The window the manager confirmed on the screen (openPrompt), and the exact question to relay to the person.
    ...(opened?.visible === true ? { window: { title: opened.title, visible: true, foreground: opened.foreground === true, pid: opened.pid } } : {}) },
    ...(opened?.title ? { question: `A private SSAM window titled "${opened.title}" is open on your screen. Please type ${TYPED[kind] ?? TYPED.ServiceCenter}, `
      + 'then click Save (or Cancel to stop). Nothing goes through this chat. Tell me when it is saved and I will continue.' } : {}),
    attempts: [...attempts, { path: 'prompt', outcome: 'pending', target }] });

// Opens the private prompt for target (or finds it open) and waits for the entry; throws CREDENTIAL_PROMPT_PENDING when it
// does not arrive in time. Returns the attempt that records the stored entry. Without an opener (tests, offline) the
// call is refused as before: AUTH_REQUIRED, nothing opened.
export async function promptAndWait({ host, kind = 'ServiceCenter', name = null, target, opener, present, wait = {}, why, attempts = [] }) {
  if (hostedContext()) throw hostedNoPrompt(host, why);
  if (typeof opener !== 'function' || typeof present !== 'function')
    throw new AuthRequired('AUTH_REQUIRED', `${why}; no credential prompt is available here.`, { attempts, auth: { target } });
  readCheckpoint('authentication');
  const opened = await opener(host, kind, ...(name ? [name] : []));
  const cancelled = typeof opened?.status === 'function' ? async () => (await opened.status())?.state === 'cancelled' : null;
  const waited = await awaitStored(present, target, { ...wait, ...(cancelled && !wait.cancelled ? { cancelled } : {}) });
  if (waited.cancelled) { opened.clear?.(); throw promptCancelled(host, target, kind); }
  if (!waited.stored) throw promptPending(why, host, target, opened, waited, attempts, kind);
  return { path: 'prompt', outcome: 'stored', target, waitedMs: waited.waitedMs };
}

// Step 2 then step 3 of the order above for Service Center pages: the stored profile of the host; when the host has no
// stored entry at all (the profile broker says AUTH_REQUIRED and SSAM/O11/<host>/ServiceCenter is absent), the private
// window stores one and the call goes on with it, remembered for the next calls. An entry that exists (of any principal)
// is never overwritten through the window: a profile refusal is reported as it is.
export async function storedProfile({ profiles, host, principal = null, target = null, present, opener, prompt = 'auto', wait = {}, attempts = [] }) {
  if (hostedContext()) throw hostedStudioOnly('A stored credential profile');
  const context = { lane: 'o11', host, principal };
  const selected = await profiles.resolve(context, { interactive: false, ...(target ? { target } : {}) });
  if (selected.ok || selected.code !== 'AUTH_REQUIRED' || target || prompt === 'never' || typeof opener !== 'function' || typeof present !== 'function')
    return { selected, attempts };
  const base = credentialTarget(host, 'ServiceCenter');
  if (await present(base)) return { selected, attempts };
  const stored = await promptAndWait({ host, target: base, opener, present, wait, attempts,
    why: principal ? `No stored Service Center credential for ${principal} on ${host}` : `No Studio session and no stored Service Center credential for ${host}` });
  const typed = await profiles.resolve(context, { interactive: false, target: base });
  if (typed.ok && typeof profiles.remember === 'function') await profiles.remember(context, typed);
  return { selected: typed.ok ? { ...typed, source: 'private-window' } : typed, attempts: [...attempts, stored] };
}

// Compatibility entry points now enforce the same headless capability as
// ordinary reads; neither can submit stored credentials or open a selector.
export async function hiddenSignIn(bridge, host) {
  if (!(await bridge.capabilities()).has('sc_http:studioSession'))
    throw new AuthRequired('HEADLESS_AUTH_UNAVAILABLE', 'The loaded bridge has no headless Service Center transport.');
  return bridge.web(hostName(host), 'login', { studioSession: true });
}

export async function reenterWindow(bridge, host) {
  const info = await bridge.session(hostName(host));
  if ((info?.studio ?? info)?.signedIn !== true)
    throw new AuthRequired('STUDIO_NOT_SIGNED_IN', 'The selected Studio is not authenticated; no dialog was opened.');
  return hiddenSignIn(bridge, host);
}

export class Resolver {
  // login: false only for a dry run (session-status wouldUse, prompt 'never'); no Studio login dialog is ever opened.
  // prompt: 'never' refuses instead of opening the private window; wait: its bounded wait ({waitMs, sleep, now}; awaitStored).
  constructor(host, { session = 'auto', prompt = 'auto', credentialTarget: target = null, locate, present, running = () => studioRunning(), opener, profiles = null, login = true, wait = {} }) {
    if (!['auto', 'studio', 'studio-web', 'vault'].includes(session)) throw new ProtocolError('session must be auto, studio, studio-web or vault');
    if (!['auto', 'never'].includes(prompt)) throw new ProtocolError('authPrompt must be auto or never');
    this.host = hostName(host);
    this.session = session; this.prompt = prompt; this.target = target;
    this.locate = locate; this.present = present; this.running = running; this.opener = opener; this.login = login; this.wait = wait;
    this.studioState = null;
    this.profiles = profiles;
  }

  // [bridge or null, session info or null, attempts] for this host, computed once per call.
  async studio() {
    if (this.studioState === null) {
      const attempts = []; let bridge = null; let info = null;
      try { bridge = await this.locate(); }
      catch (error) {
        if (error instanceof BridgeError) throw new AuthRequired(error.code, error.message, { continuation: connectStudio('the O11 lane has no valid Studio connection') });
        throw error;
      }
      if (!bridge) attempts.push({ path: 'studio', outcome: 'absent', reason: 'no SSAM bridge answers on the O11 lane' });
      else if (!await bridge.supports()) attempts.push({ path: 'studio', outcome: 'unsupported', reason: 'the loaded bridge predates sc_session/sc_api/sc_web/studio_login' });
      else info = await bridge.session(this.host);
      this.studioState = [bridge, info, attempts];
    }
    return this.studioState;
  }

  // need: api (SOAP/server.api/rest through the Studio), web (.aspx pages) or lifetime (LifeTime token). The answer says
  // which session was asked (Auth.session().requested) beside the source that answered.
  async resolve(need) {
    const auth = await this.resolveNeed(need);
    auth.requested = this.session;
    return auth;
  }

  async resolveNeed(need) {
    if (!['api', 'web', 'lifetime'].includes(need)) throw new ProtocolError('Unknown authentication need');
    const hosted = hostedContext() !== null;
    if (hosted && need === 'lifetime') throw hostedStudioOnly('LifeTime (its service-account token)');
    if (hosted && this.session === 'vault') throw hostedStudioOnly('session "vault"');
    let bridge = null, info = null, attempts = [];
    // Resolve identity metadata without opening a browser or a private dialog.
    if (need !== 'lifetime') [bridge, info, attempts] = await this.studio();
    const studio = info?.studio ?? info;
    const principal = studio?.signedIn === true ? studio.user ?? null : null;
    if (need === 'api') {
      if (this.session !== 'vault' && studio?.signedIn === true)
        return new Auth('studio', this.host, principal, bridge, [...attempts, { path: 'studio', outcome: 'used' }]);
      // Relatos af6dbc48/e2179576 (18/10): session=vault with the Studio signed in answered STUDIO_NOT_SIGNED_IN. The
      // stored credential serves the Service Center pages; the API (SOAP, server.api, module ids) has no transport but the
      // Studio's own login, and the explicit vault is never swapped for the Studio silently.
      if (this.session === 'vault' && studio?.signedIn === true)
        throw new AuthRequired('VAULT_API_UNAVAILABLE', `session=vault selects the stored credential, which serves the Service Center pages; this step needs the `
          + `Service Center API, which SSAM reaches only through the signed-in Studio${principal ? ' (' + principal + ')' : ''}. Nothing was sent. `
          + 'Repeat with session=auto to use the Studio for it, or name the module by moduleId so the pages need no API lookup.',
        { attempts: [...attempts, { path: 'vault', outcome: 'no-api-transport' }], auth: { path: 'vault', host: this.host, requested: 'vault' },
          continuation: { tool: 'o11_service_center_session', arguments: { action: 'status', host: this.host, session: 'vault' },
            why: 'shows which source answers each need (wouldUse.api, wouldUse.web) and whether the vault holds a credential for this host' } });
      if (!bridge && await this.running())
        throw new AuthRequired('STUDIO_NOT_CONNECTED', 'A Studio is already open but has no valid SSAM connection; attach it without opening a login dialog.',
          { attempts, continuation: connectStudio('attach the existing Studio') });
      if (bridge && info === null)
        throw new AuthRequired('STUDIO_BRIDGE_OUTDATED', 'The loaded bridge does not expose the Service Center session contract.', { attempts });
      throw new AuthRequired(bridge ? 'STUDIO_NOT_SIGNED_IN' : 'STUDIO_REQUIRED',
        'This operation requires an authenticated Studio on the requested host; no login dialog was opened.', { attempts });
    }
    if (need === 'web' && this.session !== 'vault' && principal && (await bridge.capabilities()).has('sc_http:studioSession')) {
      // Probe before selecting a fallback, never after a protected POST. Explicit
      // Studio selection keeps its identity source, even when the web session expired.
      const probe = this.session === 'auto' && this.profiles && this.login
        ? await bridge.web(this.host, 'status') : null;
      if (probe === null || probe?.signedIn === true)
        return new Auth('studio-http', this.host, principal, bridge,
          [...attempts, { path: 'studio-http', outcome: 'selected', headless: true }]);
      attempts = [...attempts, { path: 'studio-http', outcome: probe?.signedIn === false ? 'web-session-absent' : 'web-session-unverified', headless: true }];
    }
    // Hosted, the user's Studio session (studio-http) is the only path: no profile, vault, window or prompt of the server.
    if (hosted) {
      if (!bridge)
        throw new AuthRequired('STUDIO_NOT_CONNECTED', `No Service Studio of the user is connected to SSAM for ${this.host}; the user opens it, `
          + 'signs in, and ssam_connect {lane:"o11"} connects it (in hosted mode the Studio session is the only path).',
        { attempts, continuation: connectStudio('connect the user\'s Service Studio; in hosted mode it is the only path') });
      if (info === null || !(await bridge.capabilities()).has('sc_http:studioSession'))
        throw new AuthRequired('STUDIO_BRIDGE_OUTDATED', 'The bridge of the user\'s Studio has no headless Service Center session (sc_http:studioSession). '
          + 'The user installs the current SSAM agent package and reconnects; in hosted mode the Studio session is the only path.',
        { attempts, continuation: connectStudio('reconnect after the current agent package is installed') });
      throw new AuthRequired('STUDIO_NOT_SIGNED_IN', `The user's Service Studio is not logged in on ${this.host}; the user signs in there and repeats the call. `
        + 'No login dialog is opened from here.', { attempts });
    }
    if (need === 'web' && ['studio', 'studio-web'].includes(this.session))
      throw new AuthRequired('HEADLESS_AUTH_UNAVAILABLE', 'The selected Studio has no headless Service Center session transport. No browser or credential fallback was opened.', { attempts });
    if (need === 'web' && this.profiles) {
      const found = await storedProfile({ profiles: this.profiles, host: this.host, principal, target: this.target, present: this.present,
        opener: this.opener, prompt: this.prompt, wait: this.wait, attempts });
      const selected = found.selected; attempts = found.attempts;
      if (!selected.ok) throw new AuthRequired(selected.code, selected.reason ?? 'A compatible stored credential profile is required; headless calls never open a selector.',
        { attempts, auth: { path: 'profiles', host: this.host, candidateCount: selected.candidateCount } });
      return Object.assign(new Auth('vault', this.host, selected.principal,
        principal && principal.toLowerCase() === selected.principal?.toLowerCase() ? bridge : null,
        [...attempts, { path: 'vault', outcome: 'selected', source: selected.source, headless: true }]),
        { credentialTarget: selected.target, credentialSelection: selected.source });
    }
    const target = this.vaultTarget(need);
    if (await this.present(target)) return new Auth('vault', this.host, null, null, [...attempts, { path: 'vault', outcome: 'used', target }]);
    // Nothing stored for this host: the private window (step 3), unless authPrompt=never.
    if (this.prompt === 'never')
      throw new AuthRequired('AUTH_REQUIRED', `No compatible stored credential for ${this.host}; nothing was prompted (authPrompt=never).`, { attempts });
    const stored = await promptAndWait({ host: this.host, kind: need === 'lifetime' ? 'LifeTime' : 'ServiceCenter', target, opener: this.opener,
      present: this.present, wait: this.wait, attempts: [...attempts, { path: 'vault', outcome: 'absent', target }],
      why: need === 'lifetime' ? `No LifeTime service-account token is stored for ${this.host}` : `No Studio session and no stored credential for ${this.host}` });
    return new Auth('vault', this.host, null, null, [...attempts, stored, { path: 'vault', outcome: 'used', target }]);
  }

  vaultTarget(need) {
    if (need === 'lifetime') return credentialTarget(this.host, 'LifeTime');
    return this.target || credentialTarget(this.host, 'ServiceCenter');
  }
}
