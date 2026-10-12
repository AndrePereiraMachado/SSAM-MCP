// Files of the SC/Portal lane the debugger needs and the consolidation does not have yet (port of 2026-10-11,
// integrator decision D7). Each dependency is checked against the files on disk: while one is pending, the registry
// rows that need it are 'unavailable' (never described as runnable) and the tests that need it skip with this name.
// When the SC/Portal lane delivers the file, or the named export, everything turns on by itself: nothing here changes.
import fs from 'node:fs';

const here = new URL('./', import.meta.url);
const deep = value => { Object.values(value).forEach(v => v && typeof v === 'object' && deep(v)); return Object.freeze(value); };
export const FOREIGN_DEPENDENCIES = deep({
  // ODC app-user sign-in (debug-app-user-odc.mjs) runs on the consolidation's cognito-login.mjs for us-east-1 user
  // pools; only us-east-2 pools wait for cognitoRegionSupported (until then they get debug_app_auth_provider_unsupported).
  'cognito-region': { file: '../portal/runtime/cognito-login.mjs', marker: /export\s+const\s+cognitoRegionSupported\b/,
    what: 'portal/runtime/cognito-login.mjs with cognitoRegionSupported (ODC app-user sign-in on us-east-2 user pools)' },
  // Classified Cognito rejections in the private sign-in receipt (debug-app-user-diagnostic.mjs).
  'cognito-provider-error': { file: '../portal/runtime/cognito-login.mjs', marker: /export\s+function\s+createCognitoTransport\s*\(\s*\{[^}]*\bobserver\b/,
    what: 'portal/runtime/cognito-login.mjs with the provider-error observer in createCognitoTransport (private sign-in receipt)' },
  // The Studio developer session as the bridge's authority (debug-odc-portal-session.mjs).
  'bridge-auth': { file: '../portal/runtime/bridge.mjs', marker: /typeof auth\.method\b/,
    what: 'portal/runtime/bridge.mjs with a pluggable auth method (ODC Studio developer session)' },
  // ODC Timer: Portal wake and read-only instance correlation.
  'timer-background': { file: '../portal/runtime/timer-background.mjs', what: 'portal/runtime/timer-background.mjs (ODC Timer wake and instance)' },
  'timer-screen-defaults': { file: '../portal/runtime/timer-screen-defaults.mjs', what: 'portal/runtime/timer-screen-defaults.mjs' },
  // O11 Timer: read-only Service Center instance observer.
  'timer-observation': { file: 'service-center/timer-observation.mjs', what: 'service-center/timer-observation.mjs (O11 Timer instance observer)' },
  // ODC role cycle and settings reset inside the interactive sessions.
  'sc-portal-access': { file: 'sc-portal-access.mjs', what: 'sc-portal-access.mjs (ODC access for roleCycle in the interactive sessions)' },
});

const present = key => {
  const dependency = FOREIGN_DEPENDENCIES[key];
  if (!dependency) throw new Error('debug_foreign_dependency_unknown:' + key);
  let text;
  try { text = fs.readFileSync(new URL(dependency.file, here), 'utf8'); } catch { return false; }
  return dependency.marker ? dependency.marker.test(text) : true;
};
// The keys among `keys` still pending, in order.
export const pendingForeign = (keys = []) => keys.filter(key => !present(key));
// The registry's typed refusal for a feature that needs `keys` ('debug_adapter_dependency_pending:<pending keys>'), or
// null when everything is here.
export function pendingRefusal(...keys) {
  const pending = pendingForeign(keys);
  return pending.length ? 'debug_adapter_dependency_pending:' + pending.join(',') : null;
}
// run.roleCycle of the interactive ODC sessions: its default access is sc-portal-access.mjs. While that file is pending,
// ssam_debug_server/ssam_debug_client refuse a roleCycle start (unless a roleCycleAccess is injected) before creating
// the session, and the three debug tool descriptions say it is unavailable.
export const roleCyclePending = () => pendingRefusal('sc-portal-access');
export const ROLE_CYCLE_UNAVAILABLE = 'is unavailable in this build until the SC/Portal dependency sc-portal-access (sc-portal-access.mjs) lands: ' +
  'ssam_debug_server and ssam_debug_client refuse a start that carries it with debug_adapter_dependency_pending:sc-portal-access before creating the session (no sign-in, no role read or write)';
// A skip reason naming what is pending, or false when everything is here.
export function foreignPendingReason(...keys) {
  const pending = pendingForeign(keys);
  return pending.length ? 'pending SC/Portal delivery (port D7): ' + pending.map(key => FOREIGN_DEPENDENCIES[key].what).join('; ') : false;
}
