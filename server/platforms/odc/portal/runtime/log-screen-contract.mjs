import { fail } from './errors.mjs';
import { createLogScreenDefaults } from './log-screen-defaults.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const successfulData = result => {
  if (!record(result?.data) || result.exception || result.error || result.data.ExceptionMessage) {
    fail('PORTAL_CONTRACT_CHANGED', 'Log dependency did not return its expected successful data envelope.');
  }
  return result.data;
};

// Reproduce the native read prerequisites, with backend-derived settings and
// environment identity. No app identity, role or permission state is asserted.
export async function readLogScreenservice(action, request) {
  const stageKey = request.clientVariables?.StageId;
  if (typeof stageKey !== 'string' || !stageKey || request.screenVariables?.SelectedEnviroment?.Key !== stageKey) {
    fail('INPUT_INVALID', 'Log reads require the same explicit environment in both native contexts.');
  }
  const { screen, clientVariables } = createLogScreenDefaults();
  Object.assign(screen, { stageid: stageKey });
  Object.assign(clientVariables, request.clientVariables, { DateTimeIsPreset: false });
  const call = name => action('monitoring', 'logs.logs', `monitoring/logs/logs/DataAction${name}`,
    {}, screen, request.signal, clientVariables, 'logs.logs');
  const settings = successfulData(await call('GetSettings'));
  for (const [name, defaultValue] of Object.entries(screen.GetSettings)) {
    if (name === 'DataFetchStatus') continue;
    const value = settings[name];
    if (typeof defaultValue === 'boolean' ? typeof value !== 'boolean'
      : !Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
      fail('PORTAL_CONTRACT_CHANGED', 'Log settings dependency returned invalid native input types.');
    }
    screen.GetSettings[name] = value;
  }
  screen.GetSettings.DataFetchStatus = 1;
  screen.AllDataReady_Apps.DataSettings = true;
  const stages = successfulData(await call('GetFilter_Stages'));
  const stageList = Array.isArray(stages.EnvironmentList) ? stages.EnvironmentList : stages.EnvironmentList?.List;
  if (!Array.isArray(stageList)) fail('PORTAL_CONTRACT_CHANGED', 'Log environment list dependency is absent.');
  const matches = stageList.map(row => row?.Environment).filter(environment => environment?.Key === stageKey);
  if (matches.length !== 1) fail('PORTAL_ACCESS_DENIED', 'Log environment dependency did not confirm the exact requested environment.');
  const environment = matches[0];
  for (const [name, defaultValue] of Object.entries(screen.SelectedEnviroment)) {
    const value = environment[name];
    if (typeof value !== typeof defaultValue || (typeof value === 'number' && !Number.isSafeInteger(value))) {
      fail('PORTAL_CONTRACT_CHANGED', 'Log environment dependency returned invalid native input types.');
    }
    screen.SelectedEnviroment[name] = value;
  }
  if (!environment.PortfolioKey) fail('PORTAL_CONTRACT_CHANGED', 'Log environment dependency did not identify its portfolio.');
  screen.ActivePortfolioKey = environment.PortfolioKey;
  screen.Page = { ...screen.Page, ...request.screenVariables.Page };
  screen.SeverityList = { ...screen.SeverityList, ...request.screenVariables.SeverityList };
  // Native UsersData/UsersEnablement remain NoAccess; UserId is only an empty
  // search filter. Backend authorization still governs every original read.
  return action(request.module, request.view, request.action, {}, screen, request.signal, clientVariables, 'logs.logs');
}
