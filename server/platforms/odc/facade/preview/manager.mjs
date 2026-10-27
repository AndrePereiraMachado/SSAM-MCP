import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, loadProfile, publicProfile, check, fail } from './profile.mjs';
import { compareBrowserPages } from './compare.mjs';
import { acceptMigration } from './acceptance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const validId = id => /^[a-z0-9][a-z0-9-]{0,79}$/.test(id ?? '');

// Meta de 20/10/2026, item 18 (relatos 2f39462f, 162de9b2, 48783193: three sessions found profiles:[] and had nothing to
// do with it). A list without a profile for the target says who prepares one and how, and the route that exists now:
// the published screen in the person's browser (ssam_app_url), which SSAM does not capture.
function withPrepare(args, answer) {
  if (answer.profiles.length > 0) return answer;
  const target = { ...(args.lane ? { lane: args.lane } : {}), ...(args.app ? { app: args.app } : {}), ...(args.tenant ? { tenant: args.tenant } : {}) };
  return { ...answer, prepare: {
    by: 'integrator', why: 'no prepared local preview matches this target; an app session never prepares one (no shell, no profile installation)',
    api: 'platforms/odc/facade/preview/prepare.mjs prepareProfile({directory, id, lane, target:{app, tenant}, screens, limitations, hostConfig, watcherConfig?, port})',
    doc: 'docs/PREVIEW-LOCAL.md',
    meanwhile: { tool: 'ssam_app_url', arguments: { app: args.app ?? '<app>', screen: '<screen>', ...(args.lane ? { lane: args.lane } : {}) },
      why: "the published screen opens in the person's browser; SSAM does not capture or compare it" },
    target } };
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
export function createPreviewManager({ workspace, env = process.env, spawnProcess = spawn } = {}) {
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
  function choose(args) {
    const matches = profiles().filter(({profile:p}) => (!args.profile || p.id === args.profile) && (!args.lane || p.lane === args.lane) && (!args.app || p.target.app === args.app) && (!args.tenant || p.target.tenant === args.tenant));
    check(matches.length !== 0, 'PREVIEW_PROFILE_NOT_PREPARED', 'No prepared local preview matches this target. Use ssam_preview action=list; the integrator must prepare an unsupported target.');
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
  async function open(args) {
    const chosen = choose(args), p = chosen.profile, f = files(p.id);
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
  return async function preview(args = {}) {
    try {
      const action = args.action || 'list';
      if (action === 'compare') return await compareBrowserPages(args, { workspace });
      if (action === 'accept') return acceptMigration(args, { workspace });
      if (action === 'list') return withPrepare(args, { ok:true, experimental:true, profiles:profiles().filter(({profile:p})=>(!args.lane||args.lane===p.lane)&&(!args.app||args.app===p.target.app)&&(!args.tenant||args.tenant===p.target.tenant)&&(!args.profile||args.profile===p.id)).map(v=>publicProfile(v.profile)), installationRequired:!fs.existsSync(catalogFile), note:'Only explicitly prepared profiles are available. ODC uses an O11-adapted renderer; it is not native ODC runtime equivalence.' });
      if (action === 'open') return await open(args);
      check(['status','refresh','stop'].includes(action), 'PREVIEW_ACTION');
      const id = args.sessionId || choose(args).profile.id;
      const current = await status(id);
      if (action === 'status' || ['stopped','failed'].includes(current.status)) return current;
      if (!current.ok || current.status === 'starting') return current;
      const f = files(id);
      const endpoint=readJson(f.endpoint); check(endpoint.instanceId===current.instanceId,'PREVIEW_INSTANCE_MISMATCH');
      return await control(endpoint, action, 8000);
    } catch(e) { return {ok:false, code:e.code || 'PREVIEW_ERROR', error:e.message, continuation:{tool:'ssam_preview',arguments:{action:'list'},why:'Inspect prepared profiles and their exact limits.'}}; }
  };
}
