import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, loadProfile, publicProfile, check, fail } from './profile.mjs';
import { compareBrowserPages } from './compare.mjs';
import { acceptMigration } from './acceptance.mjs';
import { ENGINES, autoPrepare } from './auto-prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const validId = id => /^[a-z0-9][a-z0-9-]{0,79}$/.test(id ?? '');

// Meta de 20/10/2026, item 18 (relatos 2f39462f, 162de9b2, 48783193) and relato 84a4a6a3 (23/10; proto dd4264de): a target
// without a profile is prepared here when a qualified input names it (auto-prepare.mjs, PREVIEW_PROFILE_PREPARED); otherwise
// the list says who prepares one, the exact input path and command, and the route that exists now: the published screen in
// the person's browser (ssam_app_url), which SSAM does not capture.
function withPrepare(answer, notPrepared) {
  if (answer.profiles.length > 0 || !notPrepared) return answer;
  return { ...answer, prepare: notPrepared };
}
export function control(endpoint, action, timeoutMs = 2500) {
  check(endpoint && endpoint.host === '127.0.0.1' && Number.isInteger(endpoint.port), 'PREVIEW_CONTROL_ENDPOINT');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: endpoint.host, port: endpoint.port, path: '/' + action, method: action === 'status' ? 'GET' : 'POST', headers: { 'Authorization': 'Bearer ' + endpoint.token } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', value => { text += value; if (text.length > 262144) req.destroy(new Error('Preview response too large')); });
      res.on('end', () => { try { const value = JSON.parse(text); check(value.instanceId === endpoint.instanceId, 'PREVIEW_INSTANCE_MISMATCH'); resolve(value); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('Preview control timed out; consult status before retrying.'), { code: 'PREVIEW_CONTROL_TIMEOUT' })));
    req.end();
  });
}
// engines: the engines folder the automatic preparation pins (tests: a simulated engine).
export function createPreviewManager({ workspace, env = process.env, spawnProcess = spawn, engines = ENGINES } = {}) {
  check(path.isAbsolute(workspace ?? ''), 'PREVIEW_WORKSPACE');
  const root = path.join(workspace, '.local', 'preview');
  const catalogFile = env.SSAM_PREVIEW_CATALOG || path.join(root, 'catalog.json');
  const sessionRoot = path.join(root, 'sessions');
  function profiles() {
    if (!fs.existsSync(catalogFile)) return [];
    const catalog = readJson(catalogFile);
    check(catalog.schema === 'ssam-preview-catalog/1' && Array.isArray(catalog.profiles), 'PREVIEW_CATALOG_SCHEMA');
    const values = catalog.profiles.map(loadProfile);
    check(new Set(values.map(v => v.profile.id)).size === values.length, 'PREVIEW_DUPLICATE_PROFILE');
    return values;
  }
  const matching = args => profiles().filter(({profile:p}) => (!args.profile || p.id === args.profile) && (!args.lane || p.lane === args.lane) && (!args.app || p.target.app === args.app) && (!args.tenant || p.target.tenant === args.tenant));
  // A target without a profile: prepared now when a qualified input names it, else the integrator's block of the refusal.
  const ensure = args => (matching(args).length > 0 ? {} : autoPrepare(args, { workspace, catalogFile, env, engines }));
  function choose(args, notPrepared = null) {
    const matches = matching(args);
    if (matches.length === 0) fail('PREVIEW_PROFILE_NOT_PREPARED', 'No prepared local preview matches this target and none could be prepared here: '
      + (notPrepared?.why ?? 'the integrator prepares it') + '. The integrator writes the input ' + (notPrepared?.input ?? '<input>') + ' and runs ' + (notPrepared?.command ?? 'prepare.mjs') + '.', notPrepared ? { prepare: notPrepared } : {});
    check(matches.length === 1, 'PREVIEW_PROFILE_AMBIGUOUS', 'Several profiles match. Select profile or tenant explicitly.');
    const selected = matches[0];
    if (args.screen) check(selected.profile.screens.some(s => s.name === args.screen || s.key === args.screen), 'PREVIEW_SCREEN_NOT_PREPARED');
    return selected;
  }
  function files(id) {
    check(validId(id), 'PREVIEW_SESSION_ID');
    const dir = path.join(sessionRoot, id);
    return { dir, receipt: path.join(dir, 'receipt.json'), endpoint: path.join(dir, 'control.json'), request: path.join(dir, 'request.json') };
  }
  async function status(id) {
    const f = files(id);
    if (!fs.existsSync(f.receipt)) fail('PREVIEW_SESSION_NOT_FOUND', 'Unknown preview session.');
    const receipt = readJson(f.receipt);
    if (['stopped', 'failed'].includes(receipt.status)) return { ok: receipt.status !== 'failed', ...receipt };
    if (fs.existsSync(f.endpoint)) {
      try { const endpoint=readJson(f.endpoint); check(endpoint.instanceId === receipt.instanceId, 'PREVIEW_INSTANCE_MISMATCH'); return await control(endpoint, 'status'); }
      catch (e) { return { ok: false, sessionId: id, instanceId: receipt.instanceId, status: 'unreachable', code: e.code || 'PREVIEW_UNREACHABLE', outcome: 'uncertain', continuation: { tool: 'ssam_preview', arguments: { action: 'status', sessionId: id }, why: 'Reconcile this instance before starting another.' } }; }
    }
    return { ok: true, ...receipt };
  }
  async function open(args, notPrepared = null) {
    const chosen = choose(args, notPrepared), p = chosen.profile, f = files(p.id);
    fs.mkdirSync(f.dir, { recursive: true });
    const lock = path.join(f.dir, 'open.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx'); }
    catch(e) { if(e.code === 'EEXIST') return { ok:false, code:'PREVIEW_OPEN_BUSY', continuation:{tool:'ssam_preview',arguments:{action:'status',sessionId:p.id},why:'Another open is in progress; do not duplicate it.'}}; throw e; }
    try {
      if (fs.existsSync(f.receipt)) {
        const current = await status(p.id);
        if (!['stopped','failed'].includes(current.status)) {
          check(readJson(f.receipt).profileSha256 === chosen.pin.sha256, 'PREVIEW_PROFILE_IN_USE', 'The active session uses a different profile revision. Stop and reconcile that session before reopening.');
          return withScreen({ ...current, reused: true }, p, args.screen);
        }
      }
      const instanceId = randomUUID();
      const request = { schema:'ssam-preview-request/1', sessionId:p.id, instanceId, profile:chosen.pin, directory:f.dir };
      atomicJson(f.request, request);
      atomicJson(f.receipt, { sessionId:p.id, instanceId, profileSha256:chosen.pin.sha256, status:'starting', startedAt:new Date().toISOString(), profile:publicProfile(p) });
      // Each launch has its own log; never truncate a previous launch's evidence.
      const log = fs.openSync(path.join(f.dir, instanceId + '.log'), 'wx', 0o600);
      let child;
      try { child = spawnProcess(process.execPath, [path.join(here,'worker.mjs'), f.request], { cwd:workspace, windowsHide:true, detached:true, stdio:['ignore',log,log], env }); }
      finally { fs.closeSync(log); }
      let spawnError;
      child.once('error', e => { spawnError = e; atomicJson(f.receipt, { sessionId:p.id, instanceId, status:'failed', code:e.code || 'PREVIEW_START_FAILED', error:e.message }); });
      child.unref();
      const until = Date.now() + 8000;
      while (Date.now() < until) {
        if (spawnError) return status(p.id);
        const current = await status(p.id);
        if (!['starting','unreachable'].includes(current.status)) return withScreen(current, p, args.screen);
        await wait(100);
      }
      return { ok:true, sessionId:p.id, instanceId, status:'starting', continuation:{tool:'ssam_preview',arguments:{action:'status',sessionId:p.id},why:'The worker is starting; observe this instance, do not launch another.'} };
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  function withScreen(result, profile, screen) {
    if (!result.url) return result;
    const selected = profile.lane==='o11' && screen && profile.screens.find(s => s.name === screen || s.key === screen);
    return { ...result, ...(selected ? { url: result.url.split('?')[0] + '?entry=' + encodeURIComponent(selected.key) } : {}), browser: { action:'open-visible', url: selected ? result.url.split('?')[0] + '?entry=' + encodeURIComponent(selected.key) : result.url }, instructions:'Open browser.url visibly and keep that tab for development. This tool does not publish or open a headless browser.' };
  }
  // (a refused open after the preparation keeps its own code: PREVIEW_OPEN_BUSY, PREVIEW_SCREEN_NOT_PREPARED...)
  const withPrepared = (value, prepared) => (prepared ? { ...value, ...(value.ok === false ? {} : { code: prepared.code }), prepared } : value);
  return async function preview(args = {}) {
    let prepared = null;
    try {
      const action = args.action || 'list';
      if (action === 'compare') return await compareBrowserPages(args, { workspace });
      if (action === 'accept') return acceptMigration(args, { workspace });
      const ensured = ['list', 'open'].includes(action) || (!args.sessionId && ['status', 'refresh', 'stop'].includes(action)) ? ensure(args) : {};
      const notPrepared = ensured.notPrepared ?? null;
      prepared = ensured.prepared ?? null;
      if (action === 'list') return withPrepared(withPrepare({ ok:true, experimental:true, profiles:profiles().filter(({profile:p})=>(!args.lane||args.lane===p.lane)&&(!args.app||args.app===p.target.app)&&(!args.tenant||args.tenant===p.target.tenant)&&(!args.profile||args.profile===p.id)).map(v=>publicProfile(v.profile)), installationRequired:!fs.existsSync(catalogFile), note:'Only explicitly prepared profiles are available. ODC uses an O11-adapted renderer; it is not native ODC runtime equivalence.' }, notPrepared), prepared);
      if (action === 'open') return withPrepared(await open(args, notPrepared), prepared);
      check(['status','refresh','stop'].includes(action), 'PREVIEW_ACTION');
      const id = args.sessionId || choose(args, notPrepared).profile.id;
      const current = await status(id);
      if (action === 'status' || ['stopped','failed'].includes(current.status)) return current;
      if (!current.ok || current.status === 'starting') return current;
      const f = files(id);
      const endpoint=readJson(f.endpoint); check(endpoint.instanceId===current.instanceId,'PREVIEW_INSTANCE_MISMATCH');
      return await control(endpoint, action, 8000);
    } catch(e) { return {ok:false, code:e.code || 'PREVIEW_ERROR', error:e.message, ...(e.prepare ? { prepare: e.prepare } : {}), ...(prepared ? { prepared } : {}), continuation:{tool:'ssam_preview',arguments:{action:'list'},why:'Inspect prepared profiles and their exact limits.'}}; }
  };
}
