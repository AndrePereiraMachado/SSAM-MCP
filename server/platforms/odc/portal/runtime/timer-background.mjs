// The original Portal Timer action, qualified against immutable public assets.
// A wake schedules native background work. It carries no application-user identity.
import { wordsGiven } from '../../facade/destructive-operations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nativeEndpointBinding } from '../../facade/debug-native-endpoint.mjs';
import { keyToGuid } from '../../facade/debug-odc-native-runtime.mjs';
import { createTimerScreenDefaults } from './timer-screen-defaults.mjs';

const fail = code => { throw new Error('debug_odc_timer_' + code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : Array.isArray(value?.List) ? value.List : fail('response_list_invalid');
const freeze = value => { if (record(value) || Array.isArray(value)) { for (const x of Object.values(value)) freeze(x); Object.freeze(value); } return value; };
const common = { applicationUserContext: false, appUserIdentityProved: false, rolesProved: false,
  propagationProved: false, requestOwnershipProved: false, executionCompleted: false };
export const TIMER_PORTAL_CONTRACT = freeze({ view: 'Timers.timer', module: 'apps',
  assets: {
    '_oschunk-O7E5YMCG.js': '81c6fb711f051d470448959d15c39d03155c7f30f44df9d69b16be4cee3e2315',
    '_oschunk-OHPBHQR5.js': 'fdd4c8e47ac6cf19b19aefb0544fa86f19c3ecee14aa19103cc1b3443ea35135',
    '_oschunk-XQJ7DYIK.js': '5df8dcb4e0b72cfa979071b24eda73a0529928a561e9f7aa762b785b519a75b3',
  }, actions: {
    ActionWakeTimer_Wrapper: 'BNQs9dKrpeQv0M8g35Qkxw',
    DataActionGetApplicationStages: 'XAKs+E_wDHkDUSEK+tCa3Q',
    DataActionGetTimerInfo: 'LPz_y3Zq140cxmdYIFEFrw',
    DataActionGetCurrentTimerRunInformation: 'quUqdidkOGgYoe7NiyynVA',
    DataActionCheckLatestDeployment: 'HFSSnK_LZjt0biSKckKcDA',
  } });
const actionPath = name => 'apps/Timers/timer/' + name;
const safeError = error => /^debug_odc_timer_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_odc_timer_request_failed';
function write(file, value, exclusive = false) {
  const destination = exclusive ? file : file + '.tmp';
  const fd = fs.openSync(destination, exclusive ? 'wx' : 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!exclusive) fs.renameSync(destination, file);
}
function normalizedUrl(value) { try { const u = new URL(value); if (u.search || u.hash || u.username || u.password) fail('runtime_binding_invalid'); return u.href.replace(/\/$/, ''); } catch { fail('runtime_binding_invalid'); } }
function successful(response) {
  if (response?.status !== 200) fail('request_failed');
  let body; try { body = JSON.parse(response.text); } catch { fail('response_invalid'); }
  if (!record(body) || !record(body.versionInfo) || !record(body.data) || body.exception || body.error || body.versionInfo.hasApiVersionChanged || body.versionInfo.hasModuleVersionChanged) fail('response_invalid');
  return body;
}
export function validateTimerRunState(value) {
  if (!record(value) || typeof value.isRunning !== 'boolean' || typeof value.isPendingRun !== 'boolean' ||
      !Number.isSafeInteger(value.lastRunDuration) || value.lastRunDuration < 0 ||
      ['currentStartedOn', 'lastRunStartedOn', 'lastRunFinishedOn', 'nextRunStartsOn'].some(k =>
        typeof value[k] !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value[k]) || !Number.isFinite(Date.parse(value[k])))) fail('run_state_invalid');
  return Object.fromEntries(['isRunning','isPendingRun','lastRunDuration','currentStartedOn','lastRunStartedOn','lastRunFinishedOn','nextRunStartsOn'].map(k => [k,value[k]]));
}

export async function verifyTimerPortalAssets(broker, signal) {
  for (const [asset, sha256] of Object.entries(TIMER_PORTAL_CONTRACT.assets)) {
    const response = await broker.request(broker.origin + '/apps/scripts/' + asset, { signal });
    if (response.status !== 200 || hash(response.text) !== sha256) fail('contract_changed');
  }
}
export function createOdcTimerPortalAdapter({ broker, root, now = Date.now, verifyAssets = verifyTimerPortalAssets } = {}) {
  if (!broker || !path.isAbsolute(root ?? '')) fail('dependencies_missing');
  const prepared = new WeakMap();
  function identity(plan) {
    const binding = nativeEndpointBinding(plan?.binding);
    if (binding.lane !== 'odc' || plan?.trigger !== 'odc-portal-timer-wake' || !GUID.test(plan.environmentKey ?? '') ||
        plan.portalOrigin !== broker.origin || broker.target !== 'odc3' || !/^[A-Za-z0-9_+]{22}$/.test(plan.entryKey ?? '') ||
        !/^[A-Za-z_]\w*$/.test(plan.name ?? '')) fail('binding_invalid');
    return { binding, StageKey: plan.environmentKey, ApplicationKey: keyToGuid(binding.moduleKey), TimerKey: keyToGuid(plan.entryKey) };
  }
  async function metadata(signal) {
    if (!broker.authenticated) fail('portal_session_required');
    const found = {};
    for (const [name, apiVersion] of Object.entries(TIMER_PORTAL_CONTRACT.actions)) {
      const meta = await broker.metadata.resolve('apps', TIMER_PORTAL_CONTRACT.view, actionPath(name), signal);
      if (meta.action !== actionPath(name) || meta.apiVersion !== apiVersion || typeof meta.moduleVersion !== 'string' || !meta.moduleVersion ||
          Object.values(found).some(x => x.moduleVersion !== meta.moduleVersion)) fail('contract_changed');
      found[name] = meta;
    }
    // Names/API hashes alone do not prove the native defaults or serializer ABI.
    await verifyAssets(broker, signal);
    return found;
  }
  async function readData(state, name, signal) {
    const result = await broker.action('apps', TIMER_PORTAL_CONTRACT.view, actionPath(name), {}, state.screen, signal, state.clientVariables);
    if (!record(result?.data) || result.exception || result.error) fail('response_invalid');
    return result.data;
  }
  async function publication(state, signal) {
    const data = await readData(state, 'DataActionGetApplicationStages', signal);
    const rows = list(data.EnvironmentsApplicationVersion).filter(x => x.Environment?.Key === state.identity.StageKey);
    if (rows.length !== 1) fail('environment_scope_mismatch');
    const row = rows[0], deployed = row.DeployedAssetVersion, binding = state.identity.binding;
    if (row.IsDevEnv !== true || !record(deployed) || deployed.AssetKey !== state.identity.ApplicationKey ||
        deployed.EnvironmentKey !== state.identity.StageKey || deployed.Revision !== binding.revision ||
        normalizedUrl(deployed.Url) !== normalizedUrl(binding.runtimeUrl) ||
        !GUID.test(row.Environment.PortfolioKey ?? '')) fail('publication_scope_mismatch');
    state.screen.SelectedStage = row.Environment;
    state.screen.ActivePortfolioKey = row.Environment.PortfolioKey;
    const deployment = await readData(state, 'DataActionCheckLatestDeployment', signal);
    if (deployment.HasOngoingDeployments !== false) fail('deployment_not_stable');
    return { revision: deployed.Revision, environmentKey: state.identity.StageKey, appKey: state.identity.ApplicationKey };
  }
  async function timerState(state, signal) {
    const data = await readData(state, 'DataActionGetCurrentTimerRunInformation', signal);
    if (!Number.isSafeInteger(data.CurrentDuration) || data.CurrentDuration < 0) fail('run_state_invalid');
    return { ...validateTimerRunState(data.TimerRunInformation), currentDuration: data.CurrentDuration };
  }
  return {
    async prepare(plan, { signal } = {}) {
      const id = identity(plan), meta = await metadata(signal);
      const state = { identity: id, meta, ...createTimerScreenDefaults() };
      Object.assign(state.screen, { appid:id.ApplicationKey, stageid:id.StageKey, id:id.TimerKey });
      const deployed = await publication(state, signal), data = await readData(state, 'DataActionGetTimerInfo', signal);
      if (data.NotFound !== false || data.TimerInfo?.Timer?.Key !== id.TimerKey || data.TimerInfo?.Timer?.Name !== plan.name) fail('timer_scope_mismatch');
      state.screen.ScreenTimerInformationStructure.TimerInfo = data.TimerInfo;
      state.screen.ScreenTimerInformationStructure.TimerInfoIsFetched = true;
      const before = await timerState(state, signal);
      const result = freeze({ ...plan, nativeAuthenticationQualified: true, nativePreparation: { deployed, before,
        moduleVersion: meta.ActionWakeTimer_Wrapper.moduleVersion, apiVersion: meta.ActionWakeTimer_Wrapper.apiVersion,
        contractPins: TIMER_PORTAL_CONTRACT.assets, preparedAt: new Date(now()).toISOString() } });
      state.plan = result; prepared.set(result,state); return result;
    },
    async readState(plan, { signal } = {}) {
      const state = prepared.get(plan); if (!state) fail('unprepared');
      return { ...await timerState(state,signal), ...common, nativeRunIdAvailable: false };
    },
    async run(plan, { operationId, context, authorizationWords, inputs = {}, signal } = {}) {
      const state = prepared.get(plan); if (!state) fail('unprepared');
      if (!GUID.test(operationId ?? '') || context !== 'native-background' || !wordsGiven(authorizationWords) || // CX15 r7: one predicate
          authorizationWords.length > 8192 || !record(inputs) || Object.keys(inputs).length) fail('explicit_authorization_required');
      if (!broker.authenticated || now()-Date.parse(plan.nativePreparation.preparedAt) > 300000) fail('preparation_expired');
      const bindingHash = hash('odc|' + plan.binding.runtimeUrl + '|' + plan.binding.moduleKey);
      const base = path.join(root,'.local','debugger'), dir = path.join(base,'native-background','odc',operationId);
      const file = path.join(dir,'timer-trigger.json'), lock = path.join(base,'native-background-bindings',bindingHash+'.lock');
      for (const other of [path.join(base,'native-endpoint-bindings',bindingHash+'.lock'),path.join(base,'blocked-bindings',bindingHash+'.json')])
        if (fs.existsSync(other)) fail('binding_blocked');
      const active = path.join(base,'native-runs',bindingHash+'.lock');
      if (fs.existsSync(active)) { let owner; try { owner=JSON.parse(fs.readFileSync(active)); } catch { fail('binding_blocked'); } if (owner.operationId !== operationId) fail('binding_blocked'); }
      if (fs.existsSync(file)) fail('already_submitted');
      await publication(state, signal); // Read-only revision guard, before the one-send marker.
      const cookies = await broker.jar.getCookies(broker.origin+'/apps/');
      const csrf = cookies.find(x=>x.key==='crf')?.value; if (!csrf) fail('portal_session_required');
      const meta = state.meta.ActionWakeTimer_Wrapper;
      const report = { schema:'ssam-odc-timer-trigger/1', operationId, binding:plan.binding, entryKey:plan.entryKey,
        state:'sending', sent:true, answered:false, uncertain:true, accepted:false, scheduled:false, ok:false,
        authorizationWordsSha256:hash(authorizationWords), context:'native-background', ...common,
        contractPins:TIMER_PORTAL_CONTRACT.assets, at:new Date(now()).toISOString(), receiptPath:file };
      fs.mkdirSync(dir,{recursive:true}); fs.mkdirSync(path.dirname(lock),{recursive:true});
      let reserved=false, owns=false;
      try {
        write(lock,{operationId,state:'sending'},true); owns=true;
        // Record the user's exact authorization with the immutable intent before the business request.
        // CX15 r5 (N-3): the sha256 of the words, never the words (the request below carries no words).
        write(path.join(dir,'authorization.json'),{operationId,context,wordsSha256:hash(authorizationWords),identity:state.identity,at:report.at},true);
        write(file,report,true); reserved=true;
        const response = await broker.request(broker.origin+'/apps/screenservices/'+meta.action,{method:'POST',signal,
          headers:{Origin:broker.origin,Referer:broker.origin+'/apps/','outsystems-client-env':'browser','x-csrftoken':csrf},
          body:{versionInfo:{moduleVersion:meta.moduleVersion,apiVersion:meta.apiVersion},viewName:TIMER_PORTAL_CONTRACT.view,
            inputParameters:{StageKey:state.identity.StageKey,ApplicationKey:state.identity.ApplicationKey,TimerKey:state.identity.TimerKey}}});
        successful(response);
        Object.assign(report,{state:'accepted',answered:true,uncertain:false,accepted:true,scheduled:true,ok:true});
      } catch(error) {
        report.error=error?.code==='EEXIST'?'debug_odc_timer_already_submitted':safeError(error);
        if (!reserved) Object.assign(report,{state:'refused',sent:false,uncertain:false});
        else report.state='uncertain'; // HTTP errors do not prove absence of a scheduler side effect.
      } finally {
        if (reserved) write(file,report);
        if (owns && !report.uncertain) fs.unlinkSync(lock);
        report.lockRetained=owns&&report.uncertain;
        if (reserved) write(file,report);
      }
      return report;
    },
  };
}
