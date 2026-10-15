// Deleting is off on a hosted server (T2 of the CX15 review, C:\t\revisoes\cx15\REVISAO.md "Porte hospedado"). Every
// hosted call is a licensee's, and this line still runs the delete engines of before CX15: one call deletes (the
// incident replay deleted seven applications with confirmHost alone, no token, count or backup). Until the two-step
// destructive protocol of CX15 is ported here, the gate (policy.mjs wrapHostedTool, switch HOSTED_DESTRUCTIVE) refuses a
// call that deletes, or may delete, something of the licensee's environment or tenant, before the agent, any path, any
// read and any send: HOSTED_UNAVAILABLE, cause DESTRUCTIVE_HOSTED_OFF, outcome not-sent, and no continuation.
//   hostedDestructive(name, args)  THE classification, from the server's own tables where they exist: the Service Center
//                                  delete engine and DESTRUCTIVE (service-center), the effect of every ODC operation
//                                  (effects.mjs effectOf: a DELETE, an Undeploy), the Portal routes of effect
//                                  'destructive' (portal-routes.mjs PORTAL_WRITES); and by the effect on the target, not
//                                  the HTTP method (F1 of the review): an ODC body with a non-empty removal field
//                                  (userKeysToRemove, applicationRoleKeysToRemove, any field named like a removal) takes
//                                  members or access away like the DELETE of the same access. A request it cannot read, a
//                                  batch with any delete or a selector of an unexpected type is destructive (fail closed);
//                                  a selector left out is not (F3: nothing can run, the input layer answers INPUT_INVALID
//                                  with the correction).
//   hostedDestructiveFiles(name, args)  the same rule for what a call names by file, read by the gate once the paths are
//                                  resolved (policy.mjs): the revokes of an o11_access apply manifest (manifestRevokes).
//   HOSTED_OFF / hostedListing     the part of each tool that is off, said first in the hosted listing (local unchanged).
// tests/hosted-destructive.test.mjs proves every tool and action of hosted/tools.json that can delete is classified, and,
// with an oracle independent of these tables (F2), that every ODC operation and Portal route whose own text, body fields,
// enum values, method or native action names a removal is refused here or listed with its reason.
// Outside the family (CX15 §6, the owner decides; they delete nothing of the environment or tenant):
// solution-remove-component, timer-deactivate, property-set, studio_close discard (snapshot first), o11_environment
// create-module replace (versions stay in Service Center), receipt discard (local journal), element removal by a job.
import fs from 'node:fs';
import path from 'node:path';
import { PORTAL_WRITES } from '../../portal/runtime/portal-routes.mjs';
import { DEPLOY, effectOf } from '../../portal/runtime/effects.mjs';
import { DELETE_ACTIONS } from '../service-center/delete.mjs';
import { DESTRUCTIVE as SERVICE_CENTER_DESTRUCTIVE } from '../service-center/index.mjs';
import { decodeJobText, duplicateKey } from './job-paths.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const word = value => (typeof value === 'string' ? value.trim().toLowerCase() : null);
// F3: a selector left out (undefined, null) is no deletion: the input layer refuses the call (INPUT_INVALID, with the
// correction) and nothing runs. A selector of a type no tool takes (a number, an array) is no reading of the call: fail closed.
const absent = value => value === undefined || value === null;
const selector = (args, key, destructive) => {
  const value = args[key];
  if (absent(value)) return null;
  return typeof value === 'string' ? destructive(word(value)) : true;
};

// Service Center: the delete engine with its aliases (delete.mjs) and the page and Studio API deletes (index.mjs).
const SC_DELETES = new Set([...DELETE_ACTIONS, ...SERVICE_CENTER_DESTRUCTIVE]);
// Arguments only a delete takes (o11-operations.mjs serviceCenterArguments): with any of them the call is a delete.
const SC_DELETE_ONLY = ['applications', 'modules', 'extensions', 'prefix', 'prefixKind', 'maxDeletes'];

// o11_data: the reads and the two writes that delete nothing; any other operation of an op (delete, or one the kernel
// would not know) is destructive, and so is a request that cannot be read (a text that is not JSON, a batch that is no list).
const DATA_KEEPS = new Set(['read', 'read-all', 'insert', 'update']);
function dataDestructive(request) {
  if (request === undefined || request === null) return false; // nothing to run: the handler refuses
  let value = request;
  if (typeof value === 'string') { try { value = JSON.parse(value.replace(/^\uFEFF/, '')); } catch { return true; } }
  if (!isObject(value)) return true;
  const ops = value.batch !== undefined ? value.batch : [value];
  if (!Array.isArray(ops)) return true;
  return ops.some(op => !isObject(op) || (op.operation != null && !DATA_KEEPS.has(word(op.operation))));
}

// studio_command: the bridge commands that delete (data-delete, the API Client fixture cleanup) and the raw Portal
// transports, whose request can be any DELETE (portal-call, portal-private-call, portal-session fetch). The bridge takes
// the whole line, so every word of the command and its arguments is read, whatever the spelling, case or split: args given
// as a text (F3) or with items of another type are read word by word too (the input layer then refuses their type).
const STUDIO_DELETES = ['data-delete', 'portal-api-client-fixture-cleanup', 'portal-call', 'portal-private-call'];
const textOf = value => (typeof value === 'string' ? value : JSON.stringify(value) ?? '');
function studioCommandDestructive(args) {
  if (absent(args.command)) return false; // F3: no command, nothing runs (INPUT_INVALID "/command is required")
  if (typeof args.command !== 'string') return true;
  const rest = absent(args.args) ? [] : Array.isArray(args.args) ? args.args.map(textOf) : [textOf(args.args)];
  const words = [args.command, ...rest].join(' ').toLowerCase().split(/[\s"'`,:;[\]{}]+/).filter(Boolean);
  if (words.some(w => STUDIO_DELETES.some(command => w.includes(command)))) return true;
  return words.some(w => w.includes('portal-session')) && words.includes('fetch');
}

// F1: a body field that takes something away (userKeysToRemove, applicationRoleKeysToRemove: the catalog's two today, and
// any field named like a removal in any operation, at any depth) with a non-empty value. A body given as text is read as
// JSON; a text that does not parse is read by its words. Too deep to read whole: destructive (fail closed).
const REMOVAL_FIELD = /delet|remov|revok|undeploy|unpublish|unassign|purg|prune|clear|deactivat|rotat|destroy|wipe|truncat|erase/i;
const filled = value => !absent(value) && value !== false && value !== '' && !(Array.isArray(value) && value.length === 0)
  && !(isObject(value) && Object.keys(value).length === 0) && !(typeof value === 'string' && value.trim() === '');
function removalFields(body) {
  let value = body;
  if (typeof value === 'string') {
    try { value = JSON.parse(value.replace(/^\ufeff/, '')); } catch { return REMOVAL_FIELD.test(value); }
  }
  const budget = { left: 100000 };
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object') return false;
    if (depth > 64 || --budget.left < 0) return true;
    if (Array.isArray(node)) return node.some(item => walk(item, depth + 1));
    return Object.entries(node).some(([key, child]) => (REMOVAL_FIELD.test(key) && filled(child)) || walk(child, depth + 1));
  };
  return walk(value, 0);
}

// ODC public API: the effect of the operation (effects.mjs), its id being <api>:<method>:<path>; a body given as text is
// read as the access layer reads it, and Undeploy in any case; then the effect of the body on the target (F1).
function odcEffectDestructive(operationId, body) {
  if (absent(operationId)) return false; // F3: no operationId, nothing runs (INPUT_INVALID "/operationId is required")
  if (typeof operationId !== 'string') return true;
  const method = operationId.split(':')[1];
  if (!method) return true;
  let value = body;
  if (typeof value === 'string' && operationId === DEPLOY) { try { value = JSON.parse(value); } catch { return true; } }
  const operation = isObject(value) && typeof value.operation === 'string' && word(value.operation) === 'undeploy' ? { ...value, operation: 'Undeploy' } : value;
  if (effectOf({ id: operationId, method: method.toUpperCase(), readOnly: false }, operation) === 'destructive') return true;
  return removalFields(body);
}

// Internal Portal: the listed routes of effect 'destructive', and the two raw saves of a connection's selection, which drop
// every entity or action their list leaves out or marks IsSelected:false (CX15 review D; the typed tools stay:
// odc_external_db_connection import-entities, odc_mcp_import). A route the server does not map is refused by its handler;
// one named like a deletion is refused here.
const RAW_SELECTION_SAVES = new Set(['connections.importEntities', 'connections.importActions']);
const DELETE_NAME = /delet|remov|purg|drop|destroy|discard|wipe|truncat|eras|clean/i;
function portalDestructive(operationId) {
  if (absent(operationId)) return false; // F3: no operationId, nothing runs (INPUT_INVALID)
  if (typeof operationId !== 'string') return true;
  if (RAW_SELECTION_SAVES.has(operationId)) return true;
  if (Object.hasOwn(PORTAL_WRITES, operationId)) return PORTAL_WRITES[operationId].effect === 'destructive';
  return DELETE_NAME.test(operationId);
}

// true when the call deletes (or may delete) something of the licensee's environment or tenant.
export function hostedDestructive(name, args) {
  const a = isObject(args) ? args : {};
  if (typeof name === 'string' && name.endsWith('_delete')) return true; // odc_asset_delete, odc_a2a_connection_delete, studio_data_delete
  switch (name) {
    case 'o11_service_center_write':
      return SC_DELETE_ONLY.some(key => a[key] !== undefined) || (selector(a, 'action', action => SC_DELETES.has(action)) ?? false);
    case 'o11_environment': return selector(a, 'action', action => action === 'delete-app') ?? false;
    case 'o11_extension': return selector(a, 'action', action => action === 'delete') ?? false;
    case 'o11_data': return dataDestructive(a.request);
    case 'studio_command': return studioCommandDestructive(a);
    case 'odc_write': return odcEffectDestructive(a.operationId, a.body);
    case 'odc_deploy': return selector(a, 'operation', operation => operation === 'undeploy') ?? false;
    case 'odc_portal_write': return portalDestructive(a.operationId);
    case 'odc_external_db_connection': return selector(a, 'action', action => action === 'delete' || action === 'remove-entities') ?? false;
    case 'odc_external_library': return selector(a, 'action', action => action === 'discard') ?? false;
    default: return false;
  }
}

// ---- F1: what a call names by file. o11_access apply executes the revokes of its manifest (kernel AccessPlanner: "Revokes
// are never blocked"); the gate reads the manifest as the kernel reads it (AccessManifest.Read: File.ReadAllText, so UTF-8
// or UTF-16 with its byte-order mark; JsonNode.Parse; the entry key "action", trimmed and lowercased, "grant" or "revoke")
// and counts every entry whose action is not a plain grant. null: no file there (the handler answers MANIFEST_NOT_FOUND).
// {revokes: n}, or {revokes: null, unreadable}: a manifest the gate cannot read whole (not UTF-8/UTF-16 JSON, a key written
// twice in one object, too large), refused (fail closed: the kernel's reader could see a revoke the gate does not).
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const TRIM = /^[\s\u0085\u180e\u200b-\u200d\u2060\ufeff]+|[\s\u0085\u180e\u200b-\u200d\u2060\ufeff]+$/g;
export function manifestRevokes(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_MANIFEST_BYTES) return { revokes: null, unreadable: 'a manifest over ' + MAX_MANIFEST_BYTES + ' bytes' };
  let text;
  try { text = decodeJobText(fs.readFileSync(file)); } catch { text = null; }
  if (text === null) return { revokes: null, unreadable: 'a manifest that is not UTF-8 or UTF-16 text' };
  let document;
  try { document = JSON.parse(text); } catch { return { revokes: null, unreadable: 'a manifest that is not valid JSON' }; }
  const twice = duplicateKey(text);
  if (twice !== null) return { revokes: null, unreadable: 'a manifest with the key ' + JSON.stringify(twice).slice(0, 80) + ' twice in one object' };
  // The kernel refuses a root that is no object and entries that are no list: nothing of such a manifest is applied.
  const entries = isObject(document) && Array.isArray(document.entries) ? document.entries : [];
  const revokes = entries.filter(entry => isObject(entry) && Object.hasOwn(entry, 'action')
    && !(typeof entry.action === 'string' && entry.action.replace(TRIM, '').toLowerCase() === 'grant')).length;
  return { revokes };
}
const RECIPE = 'an o11_access apply with grants only still works here; the user revokes the roles in the Users application of the environment (or Service Center)'
  + ' / um apply só com concessões continua funcionando; o usuário revoga os papéis no aplicativo Users do ambiente (ou no Service Center)';
// After the gate resolved the paths of the call (policy.mjs): null, or what the refusal says ({revokes, detail}).
export function hostedDestructiveFiles(name, args) {
  if (name !== 'o11_access' || !isObject(args) || word(args.action) !== 'apply') return null;
  const file = args.manifestPath;
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null; // the handler refuses it (MANIFEST_NOT_ABSOLUTE) and runs nothing
  const read = manifestRevokes(file);
  if (read === null || read.revokes === 0) return null;
  if (read.revokes === null) return { revokes: null, detail: 'The gate could not read this access manifest whole to count its revokes (' + read.unreadable
    + '), so it was refused as one that may revoke. Save it as JSON in UTF-8, every key once per object; ' + RECIPE + '.' };
  return { revokes: read.revokes, detail: 'This access manifest has ' + read.revokes + ' revoke' + (read.revokes === 1 ? '' : 's')
    + ' (an entry whose action is not grant): revoking end-user roles is off on a hosted server, like deleting; ' + RECIPE + '.' };
}

// The refusal: one answer, nothing to retry, no other path offered. extra: what the gate counted (o11_access: revokes, detail).
export const destructiveUnavailable = (name, extra = null) => ({ ok: false, code: 'HOSTED_UNAVAILABLE', cause: 'DESTRUCTIVE_HOSTED_OFF', policy: 'HOSTED_DESTRUCTIVE', tool: name,
  outcome: 'not-sent', ...(extra ?? {}),
  error: 'Deleting (applications, modules, extensions, solutions, records, assets, connections, deployments, and taking access away: removing '
    + 'users or roles from a group, revoking roles) is not available on a hosted SSAM server yet: this call was refused and nothing was read, '
    + 'reserved or sent. Tell the user; the user deletes it in Service Center or the ODC Portal (records: in Service Studio or ODC Studio). / '
    + 'Apagar (aplicações, módulos, extensões, soluções, registros, assets, conexões, implantações, e tirar acesso: remover usuários ou papéis de '
    + 'um grupo, revogar papéis) ainda não está disponível no SSAM hospedado: esta chamada foi recusada e nada foi lido, reservado nem enviado. '
    + 'Diga ao usuário; ele apaga no Service Center ou no Portal do ODC (registros: no Service Studio ou no ODC Studio).' });

// The part of each tool that hostedDestructive refuses, said first in its hosted description. whole: every call.
export const HOSTED_OFF = Object.freeze({
  o11_service_center_write: { part: 'delete, module-delete, extension-delete, application-delete, solution-delete and db-connection-delete', where: 'Service Center' },
  o11_environment: { part: 'delete-app', where: 'Service Center' },
  o11_extension: { part: 'delete', where: 'Service Center' },
  o11_data: { part: 'the delete operation (alone or in a batch)', where: 'Service Studio' },
  studio_data_delete: { whole: true, where: 'ODC Studio' },
  studio_command: { part: 'data-delete, portal-call, portal-private-call, portal-api-client-fixture-cleanup and portal-session fetch', where: 'ODC Studio or the ODC Portal' },
  odc_write: { part: 'every DELETE operation, a deployment with Undeploy and a body with a non-empty removal field (userKeysToRemove, applicationRoleKeysToRemove, any field named like a removal)', where: 'the ODC Portal' },
  o11_access: { part: 'apply calls whose manifest revokes a role', where: 'the Users application of the environment (or Service Center)' },
  odc_deploy: { part: 'Undeploy', where: 'the ODC Portal' },
  odc_portal_write: { part: 'the delete routes and the raw saves connections.importEntities/importActions (use odc_external_db_connection import-entities and odc_mcp_import)', where: 'the ODC Portal' },
  odc_external_db_connection: { part: 'delete and remove-entities', where: 'the ODC Portal' },
  odc_external_library: { part: 'discard', where: 'the ODC Portal' },
  odc_asset_delete: { whole: true, where: 'the ODC Portal' },
  odc_a2a_connection_delete: { whole: true, where: 'the ODC Portal' },
});
const NOTE = off => 'Hosted: deleting is off on this server: ' + (off.whole ? 'every call of this tool is' : off.part + ' are')
  + ' refused before anything is read or sent (HOSTED_UNAVAILABLE, cause DESTRUCTIVE_HOSTED_OFF); the user deletes in ' + off.where + '. ';
// The config a hosted session registers: the note in front of the description; any other tool as it came.
export function hostedListing(name, config) {
  const off = Object.hasOwn(HOSTED_OFF, name) ? HOSTED_OFF[name] : null;
  return off ? { ...config, description: NOTE(off) + (config?.description ?? '') } : config;
}
