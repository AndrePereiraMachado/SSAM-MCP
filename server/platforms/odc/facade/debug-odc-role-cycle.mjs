// Temporary ODC application-role grant around one debug run. Before the app-user
// sign-in: read the role set (hash), journal the intent, grant once by exact role
// key with the user's words, read presence. After the run, in finally: revoke
// once by exact key and compare hashes. An uncertain grant or revoke is never
// resent; only a later read decides what remains. Roles reach the app-user token
// at sign-in, so the grant precedes it (wrapPrepareUser).
import { wordsGiven } from './destructive-operations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { guardTarget } from '../portal/runtime/access.mjs';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = code => { throw new Error('debug_odc_role_cycle_' + code); };
const sha = value => createHash('sha256').update(value).digest('hex');
export const APPLICATION_ROLES = 'user-access-management-api-v1:get:/application-roles';
export const USER_APPLICATION_ROLES = 'user-access-management-api-v1:get:/users/{key}/application-roles';
export const GRANT_APPLICATION_ROLE = 'user-access-management-api-v1:post:/users/{key}/application-roles/{roleKey}';
export const REVOKE_APPLICATION_ROLE = 'user-access-management-api-v1:delete:/users/{key}/application-roles/{roleKey}';
export const roleSetSha256 = keys => sha(JSON.stringify([...new Set(keys)].sort()));
// accepted | not-sent | rejected (nothing applied) | uncertain (may have applied).
export function roleWriteOutcome(answer) {
  if (answer?.ok === true) return 'accepted';
  if (answer?.sent === false) return 'not-sent';
  return ['rejected', 'not-sent'].includes(answer?.receipt?.state) ? answer.receipt.state : 'uncertain';
}
const writeSummary = answer => ({ outcome: roleWriteOutcome(answer), receiptState: answer?.receipt?.state ?? null,
  ...(typeof answer?.error?.code === 'string' ? { errorCode: answer.error.code } : {}) });

export async function runWithRoleCycle({ roleKey, words, access, journalDir } = {}, run) {
  if (!GUID.test(roleKey ?? '') || !wordsGiven(words) || words.trim().length < 8 || !access || typeof run !== 'function' ||
      typeof journalDir !== 'string' || !path.isAbsolute(journalDir)) fail('input_invalid');
  const key = roleKey.toLowerCase(), file = path.join(journalDir, 'role-cycle.json');
  const record = { schema: 'ssam-odc-role-cycle/1', roleKey: key, wordsSha256: sha(words), grantOperationUuid: randomUUID(), revokeOperationUuid: randomUUID(),
    state: 'prepared', createdAt: new Date().toISOString() };
  fs.mkdirSync(journalDir, { recursive: true });
  // One journal per cycle: a directory is never reused, so neither write can be replayed from it.
  try { fs.writeFileSync(file, JSON.stringify(record, null, 1), { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') fail('journal_exists'); throw error; }
  const save = () => { const temporary = file + '.' + randomUUID() + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(record, null, 1)); fs.renameSync(temporary, file); };
  let grant = null;
  async function beforeSignIn(binding) {
    if (record.state !== 'prepared') fail('sign_in_repeated');
    record.state = 'reading'; save();
    const role = await access.role(key);
    if (String(role?.key ?? '').toLowerCase() !== key) fail('role_not_found');
    record.roleName = typeof role.name === 'string' ? role.name : null;
    // The revoke is destructive and needs words naming the role; check before granting.
    try { guardTarget(words, [record.roleName, key]); } catch { fail('words_must_name_role'); }
    const before = await access.readRoles(binding);
    record.beforeSha256 = roleSetSha256(before); record.originalRolePresent = before.includes(key);
    if (record.originalRolePresent) { record.state = 'already-present'; save(); return; }
    record.state = 'grant-intent'; record.grantAttempted = true; save();
    const answer = await access.grant({ roleKey: key, words, operationUuid: record.grantOperationUuid }).catch(() => ({ ok: false, thrown: true }));
    record.grant = writeSummary(answer); grant = record.grant.outcome;
    record.state = grant === 'accepted' ? 'granted' : 'grant-' + grant; save();
    if (grant !== 'accepted') fail(grant === 'uncertain' ? 'grant_uncertain' : 'grant_refused');
    record.rolePresentAfterGrant = (await access.readRoles(binding)).includes(key);
    record.state = record.rolePresentAfterGrant ? 'role-present' : 'grant-unobserved'; save();
    if (!record.rolePresentAfterGrant) fail('grant_unobserved');
  }
  async function compare() {
    try { const after = await access.readRoles(); record.afterSha256 = roleSetSha256(after); record.restored = record.afterSha256 === record.beforeSha256; }
    catch { record.restored = null; }
  }
  async function restore() {
    if (record.state === 'prepared') { record.state = 'not-started'; record.restored = null; return; }
    if (record.grantAttempted) {
      let present = false;
      if (grant === 'accepted' || grant === 'uncertain') {
        // A confirmed grant is revoked once even without a presence read; an uncertain one only when observed.
        try { present = (await access.readRoles()).includes(key); } catch { present = grant === 'accepted'; }
      }
      if (present) {
        record.state = 'revoke-intent'; record.revokeAttempted = true; save();
        const answer = await access.revoke({ roleKey: key, words, operationUuid: record.revokeOperationUuid }).catch(() => ({ ok: false, thrown: true }));
        record.revoke = writeSummary(answer); save();
      }
    }
    if (record.beforeSha256) await compare(); else record.restored = null;
    record.state = record.restored === true ? 'restored' : record.restored === false ? 'role-set-changed' : record.grantAttempted ? 'restore-unconfirmed' : 'not-granted';
  }
  let result, thrown, failedRestore = false;
  try { result = await run({ beforeSignIn, wrapPrepareUser: prepareUser => async (...args) => { await beforeSignIn(args[0]); return prepareUser(...args); } }); }
  catch (error) { thrown = error; }
  try { await restore(); save(); } catch { failedRestore = true; record.restored = null; }
  const uncertain = record.restored == null && (failedRestore || grant === 'accepted' || grant === 'uncertain');
  // A requested cycle that never reached the sign-in never granted the role: the run is not a proof with it.
  const error = record.restored === false ? 'debug_odc_role_cycle_role_set_changed' : uncertain ? 'debug_odc_role_cycle_restore_unconfirmed'
    : record.state === 'not-started' ? 'debug_odc_role_cycle_not_started' : null;
  const roleCycle = { roleKey: key, roleName: record.roleName ?? null, state: record.state, originalRolePresent: record.originalRolePresent ?? null,
    grantAttempted: record.grantAttempted === true, ...(record.grant ? { grant: record.grant } : {}), rolePresentAfterGrant: record.rolePresentAfterGrant ?? null,
    revokeAttempted: record.revokeAttempted === true, ...(record.revoke ? { revoke: record.revoke } : {}),
    beforeSha256: record.beforeSha256 ?? null, afterSha256: record.afterSha256 ?? null, restored: record.restored ?? null, uncertain,
    grantOperationUuid: record.grantOperationUuid, revokeOperationUuid: record.revokeOperationUuid, journal: file, ...(error ? { error } : {}) };
  if (thrown) { if (thrown && typeof thrown === 'object') thrown.roleCycle = roleCycle; throw thrown; }
  const value = result && typeof result === 'object' ? result : { ok: false };
  return { ...value, ...(error && !value.error ? { error } : {}), roleCycle, ok: value.ok === true && !error, uncertain: value.uncertain === true || uncertain };
}

// Application roles of one user on one tenant through the public ODC API, by exact key.
export function odcRoleCycleAccess({ access, tenant, auth = 'auto', confirmTenant, resolveUserKey }) {
  let userKey;
  async function user(binding) {
    if (!userKey) {
      const resolved = await resolveUserKey(binding);
      if (!GUID.test(resolved ?? '')) fail('user_key_unavailable');
      userKey = resolved.toLowerCase();
    }
    return userKey;
  }
  const write = async (operationId, { roleKey, words, operationUuid }) => access.write({ tenant, auth, operationId, path: { key: await user(), roleKey },
    authorize: words, operationUuid, ...(confirmTenant ? { confirmTenant } : {}) });
  return {
    async role(roleKey) {
      const seen = await access.read({ tenant, auth, operationId: APPLICATION_ROLES, query: { key: roleKey } });
      const rows = seen?.ok && Array.isArray(seen.data?.results) ? seen.data.results : [];
      if (rows.length !== 1 || String(rows[0]?.key ?? '').toLowerCase() !== roleKey.toLowerCase()) fail('role_not_found');
      return { key: roleKey.toLowerCase(), name: typeof rows[0].name === 'string' ? rows[0].name : null };
    },
    async readRoles(binding) {
      const key = await user(binding);
      const seen = await access.read({ tenant, auth, operationId: USER_APPLICATION_ROLES, path: { key } });
      if (!seen?.ok || !Array.isArray(seen.data?.results) || seen.data.page?.nextPageOffset !== null) fail('role_read_incomplete');
      return [...new Set(seen.data.results.map(row => String(row?.key ?? '').toLowerCase()))].sort();
    },
    grant: input => write(GRANT_APPLICATION_ROLE, input),
    revoke: input => write(REVOKE_APPLICATION_ROLE, input),
  };
}

// The app user's key comes from one private sign-in that is released before the grant.
export function appUserKeyResolver({ prepareUser, releaseUser } = {}) {
  return async binding => {
    const prepare = prepareUser ?? (await import('./debug-app-user.mjs')).prepareDebugAppUser;
    const release = releaseUser ?? (await import('./debug-app-user.mjs')).releaseDebugAppUser;
    const { seconds: _lease, ...target } = binding ?? {};
    const entered = await prepare({ ...target, seconds: 60 });
    if (!entered?.ok || !entered.descriptor) fail('user_key_unavailable');
    let released = false;
    try { released = (await release(entered.descriptor))?.ok === true; } catch { released = false; }
    if (!released) fail('credentials_unreleased');
    if (!GUID.test(entered.descriptor.userKey ?? '')) fail('user_key_unavailable');
    return entered.descriptor.userKey.toLowerCase();
  };
}
