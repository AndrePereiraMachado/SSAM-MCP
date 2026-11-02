export const SCHEMA = 'ssam-private-dialog/1';
export const FRAME_LIMIT = 32768;
export const DIALOG_TIMEOUT_MS = 120000;
export const APPROVE_DELAY_MS = 1500;
export const ERROR_TEXT = Object.freeze({
  PRIVATE_DIALOG_INVALID_INPUT: 'Check the fields and try again.',
  CREDENTIAL_STORE_FAILED: 'Could not save the credential. Please try again.',
  CREDENTIAL_PERMISSION_DENIED: 'Permission to save this credential was denied.',
  CREDENTIAL_NOT_FOUND: 'The selected credential is no longer available.',
  CREDENTIAL_REQUEST_FAILED: 'The private request could not be completed.',
  PASSWORD_MISMATCH: 'The passwords do not match.',
});
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.length > 0) && !value.includes('\0');
const profile = value => typeof value === 'string' && /^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value);
function invalid() { throw new Error('PRIVATE_DIALOG_INVALID_INPUT'); }
export function validateModel(value) {
  if (!exact(value, ['schema', 'id', 'form', 'host', 'service', 'auth', 'rows', 'profiles']) || value.schema !== SCHEMA || !text(value.id, 128) || !/^[a-zA-Z0-9-]{16,128}$/.test(value.id ?? '')) invalid();
  if (!['login', 'password', 'approve', 'profile', 'forget'].includes(value.form) || !['users', 'service-center', 'odc-portal'].includes(value.service)) invalid();
  if (!text(value.host, 253) || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value.host) || value.host.includes('..')) invalid();
  if (value.auth !== undefined && !['credential', 'api-client', 'basic', 'service-token'].includes(value.auth)) invalid();
  if (value.rows !== undefined && (!Array.isArray(value.rows) || value.rows.length > 128 || value.rows.some(row => !exact(row, ['label', 'value', 'data']) || !text(row.label, 256) || !text(row.value, 16384, true) || row.data !== undefined && typeof row.data !== 'boolean'))) invalid();
  if (value.profiles !== undefined && (!Array.isArray(value.profiles) || value.profiles.length > 128 || value.profiles.some(row => !exact(row, ['profile', 'principal']) || !profile(row.profile) || !text(row.principal, 2048)))) invalid();
  if (value.form === 'approve' && !value.rows?.length) invalid();
  if (value.form === 'profile' && !value.profiles?.length) invalid();
  if (value.profiles && new Set(value.profiles.map(row => row.profile)).size !== value.profiles.length) invalid();
  if (Buffer.byteLength(JSON.stringify(value)) > FRAME_LIMIT) invalid();
  return structuredClone(value);
}
export function validateSubmission(model, values) {
  if (model.form === 'login') {
    if (!exact(values, ['username', 'password', 'remember']) || !text(values.username, 1024) || !text(values.password, 5120) || typeof values.remember !== 'boolean') invalid();
  } else if (model.form === 'password') {
    if (!exact(values, ['password', 'confirmation']) || !text(values.password, 5120) || !text(values.confirmation, 5120)) invalid();
    if (values.password !== values.confirmation) throw new Error('PASSWORD_MISMATCH');
  } else if (model.form === 'profile') {
    if (!exact(values, ['profile']) || !model.profiles.some(row => row.profile === values.profile)) invalid();
  } else if (!exact(values, ['approved']) || values.approved !== true) invalid();
  if (Buffer.byteLength(JSON.stringify(values)) > FRAME_LIMIT - 512) invalid();
  return values;
}
export function validateDecision(model, value) {
  if (!exact(value, ['type', 'id', 'ok', 'code']) || value.type !== 'decision' || value.id !== model.id || typeof value.ok !== 'boolean') invalid();
  if (value.ok ? value.code !== undefined : !Object.hasOwn(ERROR_TEXT, value.code)) invalid();
  return value;
}
