// Deleting is off on a hosted server (T2 of the CX15 review, C:\t\revisoes\cx15\REVISAO.md "Porte hospedado"). Every
// hosted call is a licensee's, and this line still runs the delete engines of before CX15: one call deletes (the
// incident replay deleted seven applications with confirmHost alone, no token, count or backup). Until the two-step
// destructive protocol of CX15 is ported here, the gate (policy.mjs wrapHostedTool, switch HOSTED_DESTRUCTIVE) refuses a
// call that deletes, or may delete, something of the licensee's environment or tenant, before the agent, any path, any
// read and any send: HOSTED_UNAVAILABLE, cause DESTRUCTIVE_HOSTED_OFF, outcome not-sent, and no continuation.
//   hostedDestructive(name, args)  THE classification, from the server's own tables where they exist: the Service Center
//                                  delete engine and DESTRUCTIVE (service-center), the effect of every ODC operation
//                                  (effects.mjs effectOf: a DELETE, an Undeploy), the Portal routes of effect
//                                  'destructive' (portal-routes.mjs PORTAL_WRITES). A request it cannot read, a batch
//                                  with any delete or a selector of an unexpected type is destructive (fail closed).
//   HOSTED_OFF / hostedListing     the part of each tool that is off, said first in the hosted listing (local unchanged).
// tests/hosted-destructive.test.mjs proves every tool and action of hosted/tools.json that can delete is classified.
// Outside the family (CX15 §6, the owner decides; they delete nothing of the environment or tenant): o11_access apply,
// solution-remove-component, timer-deactivate, property-set, studio_close discard (snapshot first), o11_environment
// create-module replace (versions stay in Service Center), receipt discard (local journal), element removal by a job.
import { PORTAL_WRITES } from '../../portal/runtime/portal-routes.mjs';
import { DEPLOY, effectOf } from '../../portal/runtime/effects.mjs';
import { DELETE_ACTIONS } from '../service-center/delete.mjs';
import { DESTRUCTIVE as SERVICE_CENTER_DESTRUCTIVE } from '../service-center/index.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const word = value => (typeof value === 'string' ? value.trim().toLowerCase() : null);
// A selector of a type no tool takes (a number, an array) is no reading of the call: fail closed.
const selector = (args, key, destructive) => {
  const value = args[key];
  if (value === undefined || value === null) return null;
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
// the whole line, so every word of the command and its arguments is read, whatever the spelling, case or split.
const STUDIO_DELETES = ['data-delete', 'portal-api-client-fixture-cleanup', 'portal-call', 'portal-private-call'];
function studioCommandDestructive(args) {
  if (typeof args.command !== 'string') return true;
  const rest = args.args === undefined || args.args === null ? [] : args.args;
  if (!Array.isArray(rest) || rest.some(a => typeof a !== 'string')) return true;
  const words = [args.command, ...rest].join(' ').toLowerCase().split(/[\s"'`]+/).filter(Boolean);
  if (words.some(w => STUDIO_DELETES.some(command => w.includes(command)))) return true;
  return words.some(w => w.includes('portal-session')) && words.includes('fetch');
}

// ODC public API: the effect of the operation (effects.mjs), its id being <api>:<method>:<path>; a body given as text is
// read as the access layer reads it, and Undeploy in any case.
function odcEffectDestructive(operationId, body) {
  if (typeof operationId !== 'string') return true;
  const method = operationId.split(':')[1];
  if (!method) return true;
  let value = body;
  if (typeof value === 'string' && operationId === DEPLOY) { try { value = JSON.parse(value); } catch { return true; } }
  const operation = isObject(value) && typeof value.operation === 'string' && word(value.operation) === 'undeploy' ? { ...value, operation: 'Undeploy' } : value;
  return effectOf({ id: operationId, method: method.toUpperCase(), readOnly: false }, operation) === 'destructive';
}

// Internal Portal: the listed routes of effect 'destructive', and the two raw saves of a connection's selection, which drop
// every entity or action their list leaves out or marks IsSelected:false (CX15 review D; the typed tools stay:
// odc_external_db_connection import-entities, odc_mcp_import). A route the server does not map is refused by its handler;
// one named like a deletion is refused here.
const RAW_SELECTION_SAVES = new Set(['connections.importEntities', 'connections.importActions']);
const DELETE_NAME = /delet|remov|purg|drop|destroy|discard|wipe|truncat|eras|clean/i;
function portalDestructive(operationId) {
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

// The refusal: one answer, nothing to retry, no other path offered.
export const destructiveUnavailable = name => ({ ok: false, code: 'HOSTED_UNAVAILABLE', cause: 'DESTRUCTIVE_HOSTED_OFF', policy: 'HOSTED_DESTRUCTIVE', tool: name,
  outcome: 'not-sent',
  error: 'Deleting (applications, modules, extensions, solutions, records, assets, connections, deployments) is not available on a hosted SSAM '
    + 'server yet: this call was refused and nothing was read, reserved or sent. Tell the user; the user deletes it in Service Center or the ODC '
    + 'Portal (records: in Service Studio or ODC Studio). / Apagar (aplicações, módulos, extensões, soluções, registros, assets, conexões, '
    + 'implantações) ainda não está disponível no SSAM hospedado: esta chamada foi recusada e nada foi lido, reservado nem enviado. Diga ao '
    + 'usuário; ele apaga no Service Center ou no Portal do ODC (registros: no Service Studio ou no ODC Studio).' });

// The part of each tool that hostedDestructive refuses, said first in its hosted description. whole: every call.
export const HOSTED_OFF = Object.freeze({
  o11_service_center_write: { part: 'delete, module-delete, extension-delete, application-delete, solution-delete and db-connection-delete', where: 'Service Center' },
  o11_environment: { part: 'delete-app', where: 'Service Center' },
  o11_extension: { part: 'delete', where: 'Service Center' },
  o11_data: { part: 'the delete operation (alone or in a batch)', where: 'Service Studio' },
  studio_data_delete: { whole: true, where: 'ODC Studio' },
  studio_command: { part: 'data-delete, portal-call, portal-private-call, portal-api-client-fixture-cleanup and portal-session fetch', where: 'ODC Studio or the ODC Portal' },
  odc_write: { part: 'every DELETE operation and a deployment with Undeploy', where: 'the ODC Portal' },
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
