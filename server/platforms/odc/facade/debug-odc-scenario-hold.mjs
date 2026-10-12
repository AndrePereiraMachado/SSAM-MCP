// ODC hold between scenarios (run.holdBetweenScenarios): after a scenario is
// answered and its thread ended, the runner confirms the native stop, waits for
// the coordinator's resume, re-verifies the publication and runtime version and
// starts a fresh native session. O11 reflects changes inside the pause; static
// reads and client-local runs have no native session to renew.
import { odcNativeEndpoints } from './debug-odc-native-transport.mjs';

const fail = code => { throw new Error('debug_odc_native_' + code); };
export function qualifyScenarioHold(input, services = {}, { localOnly = false, staticOnly = false } = {}) {
  if (input?.holdBetweenScenarios === undefined || input.holdBetweenScenarios === false) return false;
  if (input.holdBetweenScenarios !== true) fail('hold_invalid');
  if (input.lane === 'o11') fail('hold_o11_unsupported');
  if (localOnly) fail('hold_client_local_unsupported');
  if (staticOnly) fail('hold_static_read_unsupported');
  if (typeof services.holdBetweenScenarios !== 'function') fail('hold_coordinator_required');
  return true;
}

// The published version token, as the asset acquisition reads it. An
// ApplyConfigs that changes it leaves the pinned runtime stale.
export async function readOdcRuntimeVersion(binding, { fetchImpl = fetch, now = Date.now } = {}) {
  const endpoints = odcNativeEndpoints(binding), url = new URL(endpoints.origin + endpoints.versionInfo + '?' + now());
  try {
    const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000) });
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url.href)) fail('publication_check_failed');
    const token = (await response.json())?.versionToken;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_+]{1,150}$/.test(token)) fail('publication_check_failed');
    return token;
  } catch { fail('publication_check_failed'); }
}
