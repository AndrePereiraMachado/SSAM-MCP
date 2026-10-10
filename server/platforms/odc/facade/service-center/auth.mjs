// Who authenticates a Service Center call, per call and per host (port of kernel/scripts/service_center/auth.py):
//   1. the Studio connected to SSAM and logged in on the host: its own clients (`studio`), and for .aspx pages its own
//      web window (`studio-web`). A bridge with sc_web:studioSession signs that hidden window in through the Studio's own
//      session first (its browser profile's single sign-on; no vault, nothing typed); a bridge with sc_web:login, or a
//      page that still asks for a login, signs it in with the vault entry SSAM/O11/<host>/ServiceCenter (read inside the
//      Studio, never here); without the entry the private prompt opens. An older bridge shows the window for the user to
//      sign in once (`web-sign-in`);
//   2. a Studio connected but not logged in on that host: STUDIO_NOT_SIGNED_IN (`sign-in` opens the Studio's dialog);
//   3. no Studio: the Windows vault entry SSAM/O11/<host>/ServiceCenter with the existing form login (pages only);
//   4. nothing at all: only then a private Windows prompt in its own window that stores the credential in the vault.
//   A pending prompt is waited for in the same call (SSAM_PROMPT_WAIT_MS, default 120 s): stored, the call goes on; not
//   stored in time, CREDENTIAL_PROMPT_PENDING with the same call as continuation. No credential ever passes through
//   arguments, output or chat.
// LifeTime uses its own service-account token (SSAM/O11/<host>/LifeTime): vault, else the same private prompt.
// Hosted (the SSAM server answering a customer, ../executor.mjs) only the customer's Studio is a path: the vault and the
// prompt of the server are never used (HOSTED_STUDIO_SESSION_ONLY, HOSTED_PROMPT_UNAVAILABLE), so session "vault" and
// LifeTime are refused, and the hidden window signs in with the login stored in the customer's own vault.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anvilRoot } from '../workspace.mjs';
import { LocalExecutor, currentExecutor, hostedContext, workspacePath } from '../executor.mjs';
import { AuthRequired, BridgeError, ProtocolError, connectStudio, continuation } from './errors.mjs';
import { HIDDEN_LOGIN, STUDIO_SESSION } from './bridge.mjs';
import { hostName } from './http.mjs';
import { powershellPath } from './vault.mjs';
import { fold, sha256, utc } from './util.mjs';

export const KINDS = ['ServiceCenter', 'LifeTime', 'DatabaseConnection', 'SiteProperty'];
export const hostsFile = (root = anvilRoot) => path.join(root, 'scripts', 'service_center', 'hosts.json');
export const promptScript = (root = anvilRoot) => path.join(root, 'scripts', 'service_center', 'windows-o11-credential.ps1');
// Outside %LOCALAPPDATA%: processes of the Claude app (MSIX) see a private copy of it. Not .ssam: that is GitSSAM's.
// Hosted: the customer's <ws>/state/service-center.
export const stateDir = (env = process.env) => (hostedContext() ? workspacePath('state', 'service-center') : path.join(env.USERPROFILE || os.homedir(), '.ssam-hybrid'));

export const hostedStudioOnly = what => new AuthRequired('HOSTED_STUDIO_SESSION_ONLY', what + ' uses the vault of the SSAM server, which is never used in hosted mode: '
  + 'Service Center calls run only through the user\'s own Service Studio (session "studio" or "studio-web").',
{ continuation: connectStudio('connect the user\'s Service Studio; its session is the only path in hosted mode') });
export const hostedNoPrompt = (host, why) => new AuthRequired('HOSTED_PROMPT_UNAVAILABLE', `${why}; no credential prompt opens in hosted mode. The user stores the `
  + `Service Center login of ${host} in the vault of their own machine (SSAM/O11/${hostName(host)}/ServiceCenter), where their Studio reads it, then repeats the call.`);

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

export class Auth {
  constructor(pathName, host, user = null, bridge = null, attempts = []) { this.path = pathName; this.host = host; this.user = user; this.bridge = bridge; this.attempts = attempts; }
  describe() { return { path: this.path, host: this.host, ...(this.user ? { user: this.user } : {}), attempts: this.attempts }; }
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

// Open the private credential window (Get-Credential + CredWriteW, windows-o11-credential.ps1 -Mode bootstrap)
// detached, in its own console. Its output is never read: the only result is that the vault entry exists afterwards.
// One window per target at a time.
export function openPrompt(host, kind, name = null, { state = null, env = process.env, root = anvilRoot, spawnFn = spawn, now = Date.now } = {}) {
  if (hostedContext()) throw hostedNoPrompt(host, `No credential of ${host} can be stored from here`);
  const target = credentialTarget(host, kind, name);
  const folder = path.join(state ?? stateDir(env), 'auth', 'prompts');
  fs.mkdirSync(folder, { recursive: true });
  const marker = path.join(folder, 'o11-' + sha256(Buffer.from(target, 'utf8')).slice(0, 24) + '.json');
  if (fs.existsSync(marker) && now() - fs.statSync(marker).mtimeMs < 300000) return { opened: false, alreadyOpen: true, target };
  const argv = ['-NoProfile', '-File', promptScript(root), '-Mode', 'bootstrap', '-Kind', kind, '-HostName', hostName(host), ...(name ? ['-Name', name] : [])];
  const child = spawnFn(powershellPath(env), argv, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref?.();
  fs.writeFileSync(marker, JSON.stringify({ target, pid: child.pid ?? null, openedAt: utc() }), 'utf8');
  return { opened: true, target };
}

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
export async function awaitStored(present, target, { waitMs = promptWaitMs(), sleep = realSleep, now = Date.now, interval = 1000 } = {}) {
  const check = typeof present.fresh === 'function' ? present.fresh : present;
  const start = now();
  for (;;) {
    if (await check(target)) return { stored: true, waitedMs: now() - start };
    const left = waitMs - (now() - start);
    if (left <= 0) return { stored: false, waitedMs: now() - start };
    await sleep(Math.min(interval, left));
  }
}
const promptPending = (why, host, target, opened, waited, attempts) => new AuthRequired('CREDENTIAL_PROMPT_PENDING',
  `${why}: a private Windows prompt is open in its own window for ${target}. The user types the login there (for an OutSystems account: its `
  + `e-mail and password); nothing passes through the chat. This call waited ${Math.round(waited.waitedMs / 1000)} s and nothing was stored yet; `
  + 'the same call goes on once it is stored (the prompt stays open).',
  { auth: { path: 'prompt', host, target, alreadyOpen: opened?.alreadyOpen ?? false, waitedMs: waited.waitedMs, resumable: true },
    attempts: [...attempts, { path: 'prompt', outcome: 'pending', target }] });

// Opens the private prompt for target (or finds it open) and waits for the entry; throws CREDENTIAL_PROMPT_PENDING when it
// does not arrive in time. Returns the attempt that records the stored entry.
export async function promptAndWait({ host, kind = 'ServiceCenter', name = null, target, opener, present, wait = {}, why, attempts = [] }) {
  const opened = await opener(host, kind, ...(name ? [name] : []));
  const waited = await awaitStored(present, target, wait);
  if (!waited.stored) throw promptPending(why, host, target, opened, waited, attempts);
  return { path: 'prompt', outcome: 'stored', target, waitedMs: waited.waitedMs };
}

const interactive = (host, attempts, error, path = 'studio-web') => new AuthRequired('WEB_SIGN_IN_INTERACTIVE', `The sign-in of ${host} needs the user (another identity provider, MFA or a consent `
  + 'page); the hidden Service Center window is never shown, so its pages are unavailable here.',
{ attempts: [...attempts, { path, outcome: 'interactive', submitted: error.extra?.submitted ?? null }] });

// The hidden window of the Studio signs in. studioSession (bridge with sc_web:studioSession, A13): first through the
// Studio's own session only (its browser profile's single sign-on; the vault is not read), so a Studio signed in by SSO
// never asks for a separate login; only a page that still asks for a typed login goes on to the stored login. Then the
// stored ServiceCenter login (bridge sc_web login): one submit, never repeated. No entry: the private prompt opens and
// the call waits for it (bounded, promptAndWait). An entry the form rejected: the prompt opens to store it again
// (CREDENTIAL_PROMPT_OPENED: a new entry cannot be told from the old one by its presence). A sign-in that needs the user
// (another identity provider, MFA) is reported; the window is never shown. silent (older bridge with reentry): the bridge
// re-enters through the Studio's single sign-on first, so the stored login is asked only when its sign-in form needs one.
// Hosted: no check of the server's vault first (the login is in the customer's vault, read by their Studio), and no
// prompt afterwards (HOSTED_PROMPT_UNAVAILABLE).
export async function hiddenSignIn(bridge, host, { present, opener, prompt = 'auto', attempts = [], silent = false, studioSession = false, wait = {} }) {
  host = hostName(host);
  const target = credentialTarget(host, 'ServiceCenter');
  const hosted = hostedContext() !== null;
  let tried = attempts;
  if (studioSession) {
    try { return await bridge.web(host, 'login', { studioSession: true }); }
    catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      if (error.code === 'STUDIO_NOT_SIGNED_IN')
        throw new AuthRequired('STUDIO_NOT_SIGNED_IN', `The connected Studio is not logged in on ${host}. o11_service_center_session action=sign-in `
          + "opens the Studio's own login dialog (password or SSO); the user signs in there.",
        { attempts: [...attempts, { path: 'studio-session', outcome: 'not-signed-in' }], continuation: signIn(host) });
      if (error.code === 'WEB_SIGN_IN_INTERACTIVE') throw interactive(host, attempts, error, 'studio-session');
      if (error.code !== 'WEB_SIGN_IN_NEEDS_LOGIN') throw error;
      tried = [...attempts, { path: 'studio-session', outcome: 'needs-login' }];
    }
  }
  const ask = async (why, rejected = false) => {
    if (hosted) throw hostedNoPrompt(host, why);
    if (prompt === 'never')
      throw new AuthRequired('AUTH_REQUIRED', `${why}; nothing was prompted (authPrompt=never).`,
        { attempts: [...tried, { path: 'studio-web', outcome: rejected ? 'rejected' : 'no-login', target }], continuation: hiddenSignInNext(host) });
    if (rejected) {
      const opened = await opener(host, 'ServiceCenter');
      throw new AuthRequired('CREDENTIAL_PROMPT_OPENED', `${why}: a private Windows prompt opened in its own window for ${target}. The user types `
        + 'the Service Center login there again; nothing passes through the chat. Repeat this call after it is stored.',
      { auth: { path: 'prompt', host, target, alreadyOpen: opened?.alreadyOpen ?? false, rejected: true },
        attempts: [...tried, { path: 'prompt', outcome: 'pending', target }] });
    }
    tried = [...tried, await promptAndWait({ host, target, opener, present, wait, why, attempts: tried })];
  };
  const login = async again => {
    try { return await bridge.web(host, 'login'); }
    catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      if (error.code === 'SECRET_NOT_FOUND' && !again) { await ask(`No Service Center login is stored for ${host}`); return login(true); }
      if (error.code === 'WEB_LOGIN_REJECTED') await ask(`The sign-in form rejected the Service Center login stored for ${host} (it is not submitted again)`, true);
      if (error.code === 'WEB_SIGN_IN_INTERACTIVE') throw interactive(host, tried, error);
      throw error;
    }
  };
  // Without a silent bridge, or once the Studio's own session asked for a typed login, the stored login must exist first.
  // Hosted, the server's vault is never checked: the customer's bridge reads their own vault (SECRET_NOT_FOUND otherwise).
  if (!hosted && (!silent || studioSession) && !await present(target)) await ask(`No Service Center login is stored for ${host}`);
  return login(false);
}

const hiddenSignInNext = host => continuation('o11_service_center_session', { action: 'web-sign-in', host },
  'signs the hidden Service Center window of the Studio in with the stored login (the private prompt stores it)');

// The window of a signed-in Studio expired (a read answered by the Service Center sign-in page): it re-enters without
// asking anyone. A login is asked only when the Studio itself is logged out (sc_session studio.signedIn), and then it
// is the Studio's own sign-in. A bridge with reentry loads the Service Center again and lets the Studio's single
// sign-on answer (else its stored login); an older bridge with sc_web:login re-enters only with a stored login. No
// prompt opens here: an expiry never becomes a credential request.
export async function reenterWindow(bridge, host, { present, attempts = [] }) {
  host = hostName(host);
  const info = await bridge.session(host);
  const studio = info?.studio && typeof info.studio === 'object' && !Array.isArray(info.studio) ? info.studio : (info ?? {});
  const web = info?.web && typeof info.web === 'object' && !Array.isArray(info.web) ? info.web : {};
  if (studio.signedIn !== true)
    throw new AuthRequired('STUDIO_NOT_SIGNED_IN', `The Service Center window of ${host} expired and the connected Studio is not logged in on ${host} `
      + "either. o11_service_center_session action=sign-in opens the Studio's own login dialog (password or SSO); nothing was read.",
    { attempts: [...attempts, { path: 'studio-web', outcome: 'expired' }, { path: 'studio', outcome: 'not-signed-in' }], continuation: signIn(host) });
  const silent = silentReentry(web);
  const target = credentialTarget(host, 'ServiceCenter');
  // Hosted, the stored login is in the customer's vault, read by their Studio: the server's vault is never checked.
  const hosted = hostedContext() !== null;
  // A13: a bridge with sc_web:studioSession re-enters through the Studio's own session first; the stored login only after
  // WEB_SIGN_IN_NEEDS_LOGIN, and only when it exists (an expiry never opens a prompt).
  if ((await bridge.capabilities()).has(STUDIO_SESSION)) {
    try { return await bridge.web(host, 'login', { reenter: true, studioSession: true }); }
    catch (error) {
      if (!(error instanceof BridgeError) || !['WEB_SIGN_IN_NEEDS_LOGIN', 'WEB_SIGN_IN_INTERACTIVE'].includes(error.code)) throw error;
      if (error.code === 'WEB_SIGN_IN_INTERACTIVE' || (!hosted && !await present(target)))
        throw new AuthRequired('WEB_SIGN_IN_INTERACTIVE', `The Studio is logged in on ${host}, but its own session did not sign the Service Center window in again `
          + `(${error.code === 'WEB_SIGN_IN_NEEDS_LOGIN' ? 'no single sign-on session left in the Studio\'s browser profile and no stored login'
            : 'the sign-in needs the user: another identity provider, MFA or a consent page'}). `
          + 'o11_service_center_session action=web-sign-in signs the window in once; nothing was read.',
        { attempts: [...attempts, { path: 'studio-web', outcome: 'expired' }, { path: 'studio-session', outcome: error.code.toLowerCase() }], continuation: hiddenSignInNext(host) });
    }
  }
  if (!silent && !((await bridge.capabilities()).has(HIDDEN_LOGIN) && (hosted || await present(target))))
    throw new AuthRequired('WEB_SIGN_IN_REQUIRED', `The Studio is logged in on ${host}, but its Service Center window expired and the loaded bridge `
      + 're-enters only with a stored login, and none is stored. A Studio started through the SSAM shortcut loads the bridge that re-enters '
      + 'through the Studio\'s single sign-on by itself; until then o11_service_center_session action=web-sign-in signs the window in once. Nothing was read.',
    { attempts: [...attempts, { path: 'studio-web', outcome: 'expired', reentry: 'unsupported' }], continuation: hiddenSignInNext(host) });
  try { return await bridge.web(host, 'login', { reenter: true }); }
  catch (error) {
    if (!(error instanceof BridgeError) || !['SECRET_NOT_FOUND', 'WEB_LOGIN_REJECTED', 'WEB_SIGN_IN_INTERACTIVE'].includes(error.code)) throw error;
    // The single sign-on session of the Studio's browser profile is gone and the page asks for a login again.
    throw new AuthRequired('WEB_SIGN_IN_INTERACTIVE', `The Studio is logged in on ${host}, but the identity provider asked its Service Center window `
      + `for a login again (${error.code}: no single sign-on session left in the Studio's browser profile${error.code === 'SECRET_NOT_FOUND' ? ' and no stored login' : ''}). `
      + 'o11_service_center_session action=web-sign-in signs the window in once; nothing was read.',
    { attempts: [...attempts, { path: 'studio-web', outcome: 'expired', reentry: error.code.toLowerCase() }], continuation: hiddenSignInNext(host) });
  }
}

const signIn = (host, extra = {}) => continuation('o11_service_center_session', { action: 'sign-in', host, ...extra }, 'opens the login of the connected Studio (password or SSO)');
const webSignIn = host => continuation('o11_service_center_session', { action: 'web-sign-in', host }, "opens the Studio's own Service Center window for one sign-in (SSO)");

export class Resolver {
  // login: false only for a dry run (session-status wouldUse), which never signs the hidden window in.
  // wait: the bounded wait for a pending private prompt ({waitMs, sleep, now}; awaitStored).
  constructor(host, { session = 'auto', prompt = 'auto', credentialTarget: target = null, locate, present, running = () => studioRunning(), opener, login = true, wait = {} }) {
    if (!['auto', 'studio', 'studio-web', 'vault'].includes(session)) throw new ProtocolError('session must be auto, studio, studio-web or vault');
    if (!['auto', 'never'].includes(prompt)) throw new ProtocolError('authPrompt must be auto or never');
    this.host = hostName(host);
    this.session = session; this.prompt = prompt; this.target = target;
    this.locate = locate; this.present = present; this.running = running; this.opener = opener; this.login = login; this.wait = wait;
    this.studioState = null;
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

  // need: api (SOAP/server.api/rest through the Studio), web (.aspx pages) or lifetime (LifeTime token).
  async resolve(need) {
    if (!['api', 'web', 'lifetime'].includes(need)) throw new ProtocolError('Unknown authentication need');
    const hosted = hostedContext() !== null;
    if (hosted && need === 'lifetime') throw hostedStudioOnly('LifeTime (its service-account token)');
    if (hosted && this.session === 'vault') throw hostedStudioOnly('session "vault"');
    let attempts = [];
    if (this.session !== 'vault' && need !== 'lifetime') {
      const [bridge, info, found] = await this.studio();
      attempts = [...attempts, ...found];
      if (bridge && info === null) {
        if (need === 'web' && this.session === 'auto' && await this.present(this.vaultTarget('web')))
          return new Auth('vault', this.host, null, null, [...attempts, { path: 'vault', outcome: 'used', target: this.vaultTarget('web') }]);
        throw new AuthRequired('STUDIO_BRIDGE_OUTDATED', 'The connected Studio runs a bridge without the Service Center verbs. Open the '
          + 'Studio through the SSAM shortcut so the new bridge loads, then reconnect it with ssam_connect {lane:"o11"}. No credential '
          + 'prompt is opened while a Studio is connected.', { attempts, continuation: connectStudio('reconnect after the Studio loads the new bridge') });
      }
      if (info !== null) {
        const studio = info?.studio && typeof info.studio === 'object' && !Array.isArray(info.studio) ? info.studio : info;
        const web = info?.web && typeof info.web === 'object' && !Array.isArray(info.web) ? info.web : {};
        const user = studio.user ?? null;
        if (studio.signedIn !== true)
          throw new AuthRequired('STUDIO_NOT_SIGNED_IN', `The connected Studio is not logged in on ${this.host}. o11_service_center_session `
            + "action=sign-in opens the Studio's own login dialog (password or SSO); the user signs in there.",
          { attempts: [...attempts, { path: 'studio', outcome: 'not-signed-in' }], continuation: signIn(this.host) });
        if (need === 'api') return new Auth('studio', this.host, user, bridge, [...attempts, { path: 'studio', outcome: 'used' }]);
        // Page reads go through the window; an expired window re-enters by itself (reenterWindow) during the same call.
        const withReentry = auth => Object.assign(auth, { reenter: () => reenterWindow(bridge, this.host, { present: this.present, attempts }) });
        const silent = silentReentry(web);
        if (web.signedIn === true) return withReentry(new Auth('studio-web', this.host, user, bridge, [...attempts, { path: 'studio-web', outcome: 'used' }]));
        if ((await bridge.capabilities()).has(HIDDEN_LOGIN)) {
          if (!this.login)
            throw new AuthRequired('WEB_SIGN_IN_REQUIRED', `The hidden Service Center window of the Studio is not signed in on ${this.host} yet; `
              + (silent ? "the next page call signs it in through the Studio's single sign-on (else the stored login)." : 'the next page call signs it in with the stored login.'),
            { attempts: [...attempts, { path: 'studio-web', outcome: 'not-signed-in' }], continuation: hiddenSignInNext(this.host) });
          const studioSession = (await bridge.capabilities()).has(STUDIO_SESSION);
          await hiddenSignIn(bridge, this.host, { present: this.present, opener: this.opener, prompt: this.prompt, attempts, silent, studioSession, wait: this.wait });
          return withReentry(new Auth('studio-web', this.host, user, bridge, [...attempts, { path: 'studio-web', outcome: 'signed-in-hidden' }]));
        }
        throw new AuthRequired('WEB_SIGN_IN_REQUIRED', `Service Center pages go through the Studio's own web window, not signed in on ${this.host} yet. `
          + 'o11_service_center_session action=web-sign-in opens it; the user signs in once there, then repeat this call.',
        { attempts: [...attempts, { path: 'studio-web', outcome: 'not-signed-in' }], continuation: webSignIn(this.host) });
      }
      if (['studio', 'studio-web'].includes(this.session))
        throw new AuthRequired('STUDIO_NOT_CONNECTED', 'No Studio is connected to SSAM; open the Service Studio and run ssam_connect {lane:"o11"}.',
          { attempts, continuation: connectStudio('connect the open Service Studio') });
      if (await this.running())
        throw new AuthRequired('STUDIO_NOT_CONNECTED', 'A Service Studio is open but not connected to SSAM; run ssam_connect {lane:"o11"} and '
          + 'repeat. Credentials are asked only when no Studio is open.', { attempts, continuation: connectStudio('connect the open Service Studio') });
    }
    // Hosted, the user's Studio is the only path: no vault and no prompt of the server.
    if (hosted) throw new AuthRequired('STUDIO_NOT_CONNECTED', `No Service Studio of the user is connected to SSAM for ${this.host}; the user opens it, `
      + 'signs in, and ssam_connect {lane:"o11"} connects it (in hosted mode the Studio session is the only path).',
    { attempts, continuation: connectStudio('connect the user\'s Service Studio; in hosted mode it is the only path') });
    if (need === 'api')
      throw new AuthRequired('STUDIO_REQUIRED', `This operation runs through the Service Studio API; open the Service Studio, log in to ${this.host} `
        + 'and run ssam_connect {lane:"o11"}. The vault login covers Service Center pages only.', { attempts, continuation: connectStudio('the Service Studio API needs a connected Studio') });
    const target = this.vaultTarget(need);
    if (await this.present(target)) return new Auth('vault', this.host, null, null, [...attempts, { path: 'vault', outcome: 'used', target }]);
    attempts.push({ path: 'vault', outcome: 'absent', target });
    const next = signIn(this.host, need === 'lifetime' ? { surface: 'lifetime' } : {});
    if (this.prompt === 'never')
      throw new AuthRequired('AUTH_REQUIRED', `No Studio and no vault credential for ${this.host}; nothing was prompted (authPrompt=never).`, { attempts, continuation: next });
    const stored = await promptAndWait({ host: this.host, kind: need === 'lifetime' ? 'LifeTime' : 'ServiceCenter', target, opener: this.opener, present: this.present,
      wait: this.wait, why: 'No Studio and no vault credential', attempts });
    return new Auth('vault', this.host, null, null, [...attempts, stored, { path: 'vault', outcome: 'used', target }]);
  }

  vaultTarget(need) {
    if (need === 'lifetime') return credentialTarget(this.host, 'LifeTime');
    return this.target || credentialTarget(this.host, 'ServiceCenter');
  }
}
