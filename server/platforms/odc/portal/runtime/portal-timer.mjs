import { fail } from './errors.mjs';
import { isUuid } from './write-journal.mjs';

export const TIMER_CONFIGURATION = 'asset-configurations-api-v1:get:/environments/{environmentKey}/applications/{applicationKey}/revisions/deployed/configurations';
export const TIMER_APPLICATION_REVISION = 'asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}';
const sameKey = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const text = value => typeof value === 'string' && value.trim() && !value.includes('[REDACTED]');

// Wake has no caller-supplied screen state, revision override or arbitrary options.
// Normalize IDs so a casing change cannot create another journal target lock.
export function timerWakeInput(raw) {
  const fields = ['StageKey', 'ApplicationKey', 'TimerKey'];
  if (Object.keys(raw.screenVariables).length || Object.keys(raw.clientVariables).length
      || Object.keys(raw.inputParameters).length !== fields.length
      || fields.some(k => !isUuid(raw.inputParameters[k]))) {
    fail('INPUT_INVALID', 'timers.run accepts only inputParameters {StageKey, ApplicationKey, TimerKey}, all UUIDs; screenVariables and clientVariables must be empty.');
  }
  const inputParameters = Object.fromEntries(fields.map(k => [k, raw.inputParameters[k].toLowerCase()]));
  return { inputParameters, screenVariables: {}, clientVariables: {} };
}

export function timerVariables({ StageKey, ApplicationKey, TimerKey }) {
  return { appid: ApplicationKey, stageid: StageKey, id: TimerKey,
    _appidInDataFetchStatus: 1, _stageidInDataFetchStatus: 1, _idInDataFetchStatus: 1 };
}

// Cross-check both contracts before any receipt reservation or Wake POST. Reads
// are supplied by the same tenant-aware resolver; no credentials are handled here.
export async function prepareTimerWake(raw, { configuration, application, portalRead }) {
  const input = timerWakeInput(raw), ids = input.inputParameters;
  const configs = await configuration({ environmentKey: ids.StageKey, applicationKey: ids.ApplicationKey });
  if (!configs?.ok) fail('TIMER_CONTEXT_UNAVAILABLE', 'The deployed application configurations could not be read; no timer was requested.', { cause: configs?.error?.code ?? null });
  const deployed = configs.data;
  if (!Array.isArray(deployed?.timers)
      || !Number.isInteger(deployed.revisionBaseline) || !Number.isInteger(deployed.revisionDeployed)
      || deployed.revisionDeployed <= 0 || deployed.revisionBaseline !== deployed.revisionDeployed) {
    fail('TIMER_CONTEXT_UNPROVEN', 'Application identity or deployed revision is unproven or has drifted; no timer was requested.');
  }
  // Current configuration DTOs may have null key/name. Verify the exact deployed
  // revision through asset-repository instead of inventing identity from them.
  const asset = await application({ assetKey: ids.ApplicationKey, revisionNumber: deployed.revisionDeployed });
  const app = asset?.data;
  if (!asset?.ok || !sameKey(app?.assetKey, ids.ApplicationKey) || !text(app?.name) || app?.revision !== deployed.revisionDeployed)
    fail('TIMER_CONTEXT_UNPROVEN', 'The exact deployed application revision could not be identified.');
  const matches = deployed.timers.filter(t => sameKey(t?.key, ids.TimerKey));
  if (matches.length !== 1 || !text(matches[0].name)) fail('TIMER_CONTEXT_UNPROVEN', 'Exactly one deployed timer with this key is required.');
  // The two services can observe different configuration states. A positive
  // Portal flag alone must not override an inactive/unknown public API result.
  const activeConfigs = Array.isArray(matches[0].configs) ? matches[0].configs.filter(c => c?.key === 'IsActive') : [];
  const active = activeConfigs?.[0];
  const booleanValue = value => typeof value === 'string' && /^(?:true|false)$/i.test(value);
  if (activeConfigs?.length !== 1 || active.dataType !== 'Boolean' || active.isSecret !== false
      || !booleanValue(active.value) || !booleanValue(active.deployedValue))
    fail('TIMER_CONTEXT_UNPROVEN', 'The public API did not return one readable Boolean IsActive configuration.');
  if (active.value.toLowerCase() !== 'true' || active.deployedValue.toLowerCase() !== 'true')
    fail('TIMER_NOT_ACTIVE', 'The public API does not confirm an active current and deployed timer.');
  const variables = timerVariables(ids);
  const info = await portalRead('timers.info', variables);
  const timer = info?.data?.TimerInfo?.Timer;
  if (!info?.ok || info.data?.NotFound !== false || !sameKey(timer?.Key, ids.TimerKey) || timer?.Name !== matches[0].name
      || typeof info.data?.TimerInfo?.HasPendingConfigurations !== 'boolean') {
    fail('TIMER_CONTEXT_UNPROVEN', 'The Portal timer identity does not match the deployed application configuration.');
  }
  if (info.data.TimerInfo.HasPendingConfigurations) fail('TIMER_CONFIGURATION_PENDING', 'The timer has pending configuration changes; no timer was requested.');
  if (timer.Configs?.IsActive?.Current !== true || timer.Configs?.IsActive?.Deployed !== true)
    fail('TIMER_NOT_ACTIVE', 'This execution contract requires an active deployed timer. Inactive or ambiguous state is not accepted.');
  const running = await portalRead('timers.currentRun', variables);
  const state = running?.data?.TimerRunInformation;
  const lastStarted = state?.lastRunStartedOn;
  const timestamp = typeof lastStarted === 'string' && (lastStarted === '1900-01-01T00:00:00'
    || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(lastStarted));
  if (!running?.ok || typeof state?.isRunning !== 'boolean' || typeof state?.isPendingRun !== 'boolean'
      || !timestamp || !Number.isFinite(Date.parse(lastStarted))) {
    fail('TIMER_STATE_UNPROVEN', 'The current timer execution state could not be proved; no timer was requested.');
  }
  if (state.isRunning || state.isPendingRun) fail('TIMER_ALREADY_RUNNING', 'The timer is already running or pending; no second execution was requested.');
  return { input, target: { environmentKey: ids.StageKey, applicationKey: ids.ApplicationKey, timerKey: ids.TimerKey },
    before: { applicationName: app.name, timerName: timer.Name, revision: deployed.revisionDeployed, active: true,
      pendingConfiguration: false, isRunning: false, isPendingRun: false, lastRunStartedOn: state.lastRunStartedOn },
    observation: { operationId: 'timers.currentRun', input: { screenVariables: variables } } };
}
