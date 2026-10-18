// Context-bound credential metadata only. Secret values stay in Credential Manager and the authentication provider.
// servidor/fase4-24 (R3 of PLANO-24-PRODUCAO): the profiles, their selections and the private selector belong to the
// machine that runs SSAM. Hosted (the SSAM server answering a customer) no profile is ever listed, selected, remembered
// or prompted: every method answers HOSTED_STUDIO_SESSION_ONLY and the native helpers never start (lib.mjs and
// service-center/index.mjs pass profiles null there; this is the second lock).
import { wordsGiven } from './destructive-operations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCheckpoint } from './read-budget.mjs';
import { hostedContext } from './executor.mjs';

const HOSTED_REFUSAL = Object.freeze({ ok: false, code: 'HOSTED_STUDIO_SESSION_ONLY', stage: 'authentication',
  reason: 'Credential profiles are the vault of the machine that runs SSAM, never used in hosted mode: only the session of the user\'s own Studio is a path.' });
const hostedError = () => Object.assign(new Error(HOSTED_REFUSAL.reason), { code: HOSTED_REFUSAL.code, executed: false });

const helper = fileURLToPath(new URL('../../../scripts/credential-profiles.ps1', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
export const principalName = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export function profileContext({ lane, host, principal = null }) {
  host = String(host ?? '').toLowerCase();
  if (!['o11', 'odc'].includes(lane) || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) throw new Error('Invalid credential context');
  principal = principalName(principal);
  const base = lane === 'o11' ? `SSAM/O11/${host}/ServiceCenter` : `SSAM/ODC3/${host}/Portal`;
  return { lane, host, principal, base, key: digest(JSON.stringify([lane, host, principal])) };
}
export function compatibleProfiles(context, profiles) {
  const prefix = context.base + '/Profiles/';
  return profiles.filter(p => p && typeof p.target === 'string' && (p.target === context.base
    || (p.target.startsWith(prefix) && /^[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(p.target.slice(prefix.length))))
    && principalName(p.principal) && (!context.principal || principalName(p.principal) === context.principal))
    .map(p => ({ target: p.target, principal: principalName(p.principal) }));
}

export class CredentialProfiles {
  constructor({ state = path.join(process.env.USERPROFILE || os.homedir(), '.ssam-hybrid', 'auth', 'profiles'),
    list, open, now = Date.now } = {}) {
    Object.assign(this, { state, list: list ?? nativeList, open: open ?? nativeOpen, now });
    this.nativeDialog = !open;
  }
  async resolve(input, { interactive = true, force = false, target = null } = {}) {
    if (hostedContext()) return { ...HOSTED_REFUSAL };
    readCheckpoint('authentication');
    const context = profileContext(input);
    let available;
    try { available = await this.list(context); }
    catch { return { ok: false, code: 'CREDENTIAL_METADATA_UNAVAILABLE', stage: 'authentication', reason: 'The private credential metadata could not be read; no credential was used and no alternate identity was selected.' }; }
    const candidates = compatibleProfiles(context, available);
    if(target!==null){
      const exact=candidates.filter(p=>p.target===target);
      if(exact.length!==1)return {ok:false,code:'CREDENTIAL_PROFILE_MISMATCH',stage:'authentication',reason:'The explicitly requested vault target is not a unique compatible profile for this host and principal.'};
      return {ok:true,...exact[0],source:'explicit-target'};
    }
    const selectionFile = path.join(this.state, context.key + '.json');
    let selection;
    try { selection = JSON.parse(fs.readFileSync(selectionFile, 'utf8')); } catch { /* no previous choice */ }
    if (force) {
      selection = { contextKey: context.key, requiresSelection: true, at: this.now() };
      fs.mkdirSync(this.state, { recursive: true });
      fs.writeFileSync(selectionFile, JSON.stringify(selection), 'utf8');
    }
    if (!force && selection?.contextKey === context.key && selection?.cancelled && this.now() - selection.at < 300000)
      return { ok: false, code: 'CREDENTIAL_SELECTION_CANCELLED', stage: 'authentication', candidateCount: candidates.length };
    const selected = candidates.find(p => p.target === selection?.target && p.principal === selection?.principal);
    // A saved choice must still be offered by a fresh same-context listing. Never silently change principals.
    if (!force && selected && selection.contextKey === context.key) return { ok: true, ...selected, source: 'selected' };
    if (!force && !selection?.target && !selection?.requiresSelection && !selection?.cancelled && context.principal && candidates.length === 1) return { ok: true, ...candidates[0], source: 'unique-compatible' };
    if (!interactive) return { ok: false, code: candidates.length ? 'CREDENTIAL_SELECTION_REQUIRED' : 'AUTH_REQUIRED', stage: 'authentication',
      candidateCount: candidates.length, reason: context.principal ? 'A compatible private credential must be configured and selected separately. Headless execution cannot open a profile dialog.' : 'The development principal is unproven; a compatible private profile must be explicitly configured before headless execution.' };
    fs.mkdirSync(this.state, { recursive: true });
    const pending = path.join(this.state, context.key + '.pending');
    if (!fs.existsSync(pending) || this.now() - fs.statSync(pending).mtimeMs >= 300000 || this.nativeDialog && !liveDialog(pending)) {
      readCheckpoint('authentication');
      try { await this.open(context, selectionFile, pending); }
      catch { return { ok: false, code: 'CREDENTIAL_DIALOG_UNAVAILABLE', stage: 'authentication', reason: 'The private selector could not start; no credential was used.' }; }
    }
    return { ok: false, code: 'CREDENTIAL_SELECTION_PENDING', stage: 'authentication', candidateCount: candidates.length,
      resumable: true, reason: 'Choose an existing credential or add one in the private Windows dialog, then repeat the same call. Cancel closes the dialog.' };
  }

  // The entry the user has just typed in the private window for this context (service-center/auth.mjs storedProfile)
  // becomes its choice, so the next calls reuse it from the vault. Only a profile still offered by a fresh listing of
  // the same context is remembered; nothing else is written.
  async remember(input, { target, principal } = {}) {
    if (hostedContext()) return { ...HOSTED_REFUSAL };
    const context = profileContext(input);
    let available;
    try { available = await this.list(context); } catch { return { ok: false, code: 'CREDENTIAL_METADATA_UNAVAILABLE' }; }
    const matches = compatibleProfiles(context, available).filter(p => p.target === target && p.principal === principalName(principal));
    if (matches.length !== 1) return { ok: false, code: 'CREDENTIAL_PROFILE_MISMATCH' };
    const selection = { contextKey: context.key, ...matches[0], at: this.now(), source: 'private-window' };
    fs.mkdirSync(this.state, { recursive: true });
    const file = path.join(this.state, context.key + '.json'), temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(selection), 'utf8'); fs.renameSync(temp, file);
    return { ok: true, ...matches[0], source: selection.source };
  }

  async select(input, { target, principal, authorize } = {}) {
    if (hostedContext()) return { ...HOSTED_REFUSAL };
    const context=profileContext(input), chosen=principalName(principal);
    const words=wordsGiven(authorize)?authorize.trim():''; // CX15 r7: one predicate (a server text names nothing)
    if (!chosen || !words.toLowerCase().includes(context.host) || !words.toLowerCase().includes(chosen))
      return {ok:false,code:'CREDENTIAL_SELECTION_AUTHORIZATION_REQUIRED',reason:'Explicit words must identify the tenant and existing profile principal. No profile was selected.'};
    let available;
    try { available=await this.list(context); }
    catch { return {ok:false,code:'CREDENTIAL_METADATA_UNAVAILABLE',reason:'Credential metadata could not be read. No profile was selected.'}; }
    const matches=compatibleProfiles(context,available).filter(p=>p.target===target&&p.principal===chosen);
    if(matches.length!==1)return {ok:false,code:'CREDENTIAL_PROFILE_MISMATCH',reason:'The exact profile is not available in this context. No profile was selected.'};
    const selection={contextKey:context.key,...matches[0],at:this.now(),source:'explicit-headless',authorizationSha256:digest(words)};
    fs.mkdirSync(this.state,{recursive:true});
    const file=path.join(this.state,context.key+'.json'),temp=file+'.'+process.pid+'.tmp';
    fs.writeFileSync(temp,JSON.stringify(selection),'utf8');fs.renameSync(temp,file);
    return {ok:true,...matches[0],source:selection.source,windowCreated:false};
  }
}

function liveDialog(file) {
  try { const state = JSON.parse(fs.readFileSync(file, 'utf8')); if (state.state !== 'visible' || !Number.isInteger(state.pid) || state.pid <= 0) return false; process.kill(state.pid, 0); return true; }
  catch { return false; }
}

const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const argumentsFor = context => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
  '-Lane', context.lane, '-HostName', context.host, ...(context.principal ? ['-Principal', context.principal] : [])];
function nativeList(context) {
  if (hostedContext()) return Promise.reject(hostedError());
  return new Promise((resolve, reject) => execFile(powershell(), [...argumentsFor(context), '-Mode', 'list'],
    { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) return reject(Object.assign(new Error('Credential metadata is unavailable; no credential was used.'), { code: 'CREDENTIAL_METADATA_UNAVAILABLE' }));
      try { resolve(JSON.parse(stdout).profiles ?? []); } catch { reject(new Error('Invalid credential metadata response')); }
    }));
}
async function nativeOpen(context, selectionFile, pendingFile) {
  if (hostedContext()) throw hostedError();
  // DETACHED_PROCESS makes Windows PowerShell exit 0 before executing its script on
  // supported Windows hosts. A short bootstrap uses Start-Process Hidden instead.
  await new Promise((resolve, reject) => execFile(powershell(), [...argumentsFor(context), '-Mode', 'launch', '-SelectionFile', selectionFile,
    '-ContextKey', context.key, '-PendingFile', pendingFile], { windowsHide: true, timeout: 5000, maxBuffer: 1024 }, error => error ? reject(new Error('Private selector unavailable')) : resolve()));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    readCheckpoint('authentication');
    try {
      const state = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      if (state.state === 'visible' && Number.isInteger(state.pid)) { process.kill(state.pid, 0); return; }
    } catch { /* not visible yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Private selector did not confirm a visible window');
}
