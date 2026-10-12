// Locks retained by user decision (req 18) and the reading of native-background receipts by kind.
// A retained lock is never archived, reconciled or neutralized: every such entry calls assertLockNotRetained
// first. No proof (BPT, Timer or otherwise) releases it; only an edit of this frozen list by the user does.
// Receipts are classified by receipt.background.kind/schema, never by the error prefix: before the kind-specific
// namespace, Timer-path failures were written as debug_native_background_bpt_*. The alias tables below translate
// those historical codes and folders for READING only; historical receipts stay byte-identical.
import path from 'node:path';

export const RETAINED_LOCK_ERROR = 'debug_lock_retained_by_decision';
export const RETAINED_LOCKS = Object.freeze([
  // SSAMDebuggerProbe Timer wake (background.kind timer-original-wake; endpoint-timer-wake.json answered HTTP 200).
  Object.freeze({ operationId: '60aa32e5-1100-4e1f-9d5a-7d74e5bc5ce2', host: 'personal-2qqw9srv.outsystemscloud.com',
    moduleKey: 'bf7WCuRy7keTqvquautTGg', reason: 'retained by user decision' }),
]);

// kind -> namespace and observation schema written by debug-o11-bpt-run.mjs.
export const BACKGROUND_KINDS = Object.freeze({
  'timer-original-wake': Object.freeze({ namespace: 'timer', schema: 'ssam-o11-timer-observation/1' }),
  'process-original-launch': Object.freeze({ namespace: 'bpt', schema: 'ssam-o11-bpt-observation/1' }),
});
// Every code the Timer path could emit under the old single prefix (debug-o11-bpt-run.mjs fail()).
const TIMER_PATH_CODES = ['original_launcher_unresolved', 'explicit_background_context_required', 'explicit_launch_contract_required',
  'ambiguous_activity_inputs', 'original_launcher_protocol_unavailable', 'automatic_flow_required', 'native_process_path_unproved',
  'native_timer_path_unproved', 'runtime_boundary_unqualified', 'published_module_unavailable', 'published_source_changed',
  'target_projection_incomplete', 'target_projection_ambiguous', 'target_start_mismatch', 'launcher_source_binding_mismatch',
  'launcher_authentication_unavailable', 'launcher_context_mismatch', 'explicit_authorization_required', 'launcher_credential_binding_invalid',
  'watch_start_uncertain', 'watch_not_connected', 'interactive_deadline_invalid', 'timer_instance_baseline_unavailable', 'launch_outcome_uncertain'];
export const HISTORICAL_CODE_ALIASES = Object.freeze(Object.fromEntries(TIMER_PATH_CODES.map(code =>
  ['debug_native_background_bpt_' + code, 'debug_native_background_timer_' + code])));
export const HISTORICAL_FOLDER_ALIASES = Object.freeze({ 'publication-before-bpt': 'publication-before-timer',
  'publication-before-bpt-send': 'publication-before-timer-send' });
export const publicationFolders = namespace => ['publication-before-' + namespace, 'publication-before-' + namespace + '-send'];

const opId = value => typeof value === 'string' ? value.toLowerCase().replace(/-/g, '') : null;
const sameHost = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
// <...>/native-runs/o11/<host>/<moduleKey>.lock, or any file inside the run directory <host>/<operationId>/.
function lockMatches(lockPath, r) {
  if (typeof lockPath !== 'string' || !lockPath) return false;
  const parts = path.resolve(lockPath).split(/[\\/]+/), n = parts.length;
  if (parts[n - 1] === r.moduleKey + '.lock' && sameHost(parts[n - 2], r.host) && parts[n - 3] === 'o11' && parts[n - 4] === 'native-runs') return true;
  const at = parts.findIndex(p => p.length === 36 && opId(p) === opId(r.operationId));
  return at > 0 && sameHost(parts[at - 1], r.host);
}
export function retainedLock({ operationId, host, moduleKey, lockPath } = {}) {
  return RETAINED_LOCKS.find(r => opId(operationId) === opId(r.operationId) ||
    sameHost(host, r.host) && moduleKey === r.moduleKey || lockMatches(lockPath, r)) ?? null;
}
// action: 'reconcile' | 'archive' | 'neutralize' | 'prepare' (informational; every action is refused).
export function assertLockNotRetained(binding = {}) {
  if (retainedLock(binding)) throw new Error(RETAINED_LOCK_ERROR);
}

// Classification by background.kind, else background.schema; never by the error text.
export function classifyBackgroundReceipt(receipt) {
  const b = receipt?.background && typeof receipt.background === 'object' ? receipt.background : {};
  const error = typeof receipt?.error === 'string' ? receipt.error : null;
  const bySchema = Object.entries(BACKGROUND_KINDS).find(([, v]) => v.schema === b.schema)?.[0] ?? null;
  const known = Object.hasOwn(BACKGROUND_KINDS, b.kind ?? '') ? b.kind : null;
  const consistent = !(known && bySchema && known !== bySchema) && !(b.kind != null && !known);
  const kind = consistent ? known ?? bySchema : null;
  const namespace = kind ? BACKGROUND_KINDS[kind].namespace : null;
  const canonicalError = namespace === 'timer' && error && Object.hasOwn(HISTORICAL_CODE_ALIASES, error) ? HISTORICAL_CODE_ALIASES[error] : error;
  return { kind, schema: b.schema ?? null, namespace, source: !consistent ? null : known ? 'background.kind' : bySchema ? 'background.schema' : null,
    consistent, error, canonicalError, aliased: canonicalError !== error,
    publicationFolders: namespace ? { current: publicationFolders(namespace),
      historical: namespace === 'timer' ? Object.keys(HISTORICAL_FOLDER_ALIASES) : [] } : null };
}
