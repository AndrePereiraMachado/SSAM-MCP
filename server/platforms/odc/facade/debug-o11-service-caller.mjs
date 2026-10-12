// O11 Service hop: resolveO11TraceRuntime makes the ServiceAction module the
// runtime, so the consumer (caller) module needs its own native session for its
// frames, on its own runtime URL with its own published row; the Service session
// keeps the plan's runtime, row and no entry. Only for ssam_debug_server starts, with
// pinned caller captures and caller-module scopes; at most two modules. Pure: reads and
// validates both published rows, writes nothing. Step-into across the hop is not automatic.
import fs from 'node:fs';
import path from 'node:path';
import { o11Hash } from './debug-o11-lifecycle.mjs';
import { validateO11PublicationProof } from './debug-o11-auth.mjs';

const KEY = /^[A-Za-z0-9_+]{22}$/, NAME = /^[A-Za-z_][A-Za-z0-9_]{0,198}$/;
const fail = code => { throw new Error('debug_o11_native_' + code); };
// Own HTTPS runtime URL on port 443 of the proved host, path = the module (the O11 same-module runtime entry rule).
const runtimeOf = (c, host) => { try { const u = new URL(c.target.runtimeUrl); return u.protocol === 'https:' && !u.port && !u.username && !u.password && !u.search && !u.hash &&
  u.hostname === String(host ?? '').toLowerCase() && ['/' + c.target.module, '/' + c.target.module + '/'].includes(u.pathname) ? u.origin + '/' + c.target.module + '/' : null; } catch { return null; } };
const pinned = (c, host) => c && NAME.test(c.target?.module ?? '') && KEY.test(c.target?.moduleKey ?? '') && KEY.test(c.target?.applicationKey ?? '') &&
  Number.isSafeInteger(c.versionId) && c.versionId > 0 && path.isAbsolute(c.inventoryProof?.path ?? '') && /^[a-f0-9]{64}$/.test(c.inventoryProof?.sha256 ?? '') && !!runtimeOf(c, host);

// runtime: resolveO11TraceRuntime(...) result; scopes: the coordinator's interactive scopes.
// Returns null (plan unchanged), {refusal:{reason,...}} or {serviceCaller, boundary}.
export function deriveServiceCaller(runtime, scopes, captures, { serverSession = false, host, blocked, now = Date.now() } = {}) {
  if (typeof blocked !== 'function') fail('service_caller_blocked_check_required');
  const contract = runtime?.contract;
  if (!serverSession || !contract || !Array.isArray(scopes) || !Array.isArray(captures)) return null;
  const hop = contract.boundaries?.filter(b => b.kind === 'service-action' && b.producerModuleKey === contract.runtimeModuleKey).at(-1);
  if (!hop || !scopes.some(s => s?.moduleKey === hop.callerModuleKey)) return null;
  const boundary = { kind: 'service-action', callerModuleKey: hop.callerModuleKey, producerModuleKey: hop.producerModuleKey, actionKey: hop.actionKey };
  // Caller + Service only: a trace owner beyond the Service or a foreign scope is a third module.
  if (contract.targetModuleKey !== contract.runtimeModuleKey ||
      scopes.some(s => (s?.moduleKey ?? contract.targetModuleKey) !== hop.callerModuleKey && (s?.moduleKey ?? contract.targetModuleKey) !== hop.producerModuleKey))
    return { refusal: { reason: 'service_caller_third_module' }, boundary };
  const block = blocked(hop.callerModuleKey);
  if (block) return { refusal: { reason: 'binding_blocked', blockedBy: block.operationId ?? null }, boundary };
  const callers = captures.filter(c => c.target?.moduleKey === hop.callerModuleKey), services = captures.filter(c => c.target?.moduleKey === hop.producerModuleKey);
  if (callers.length !== 1 || services.length !== 1 || !pinned(callers[0], host) || !pinned(services[0], host))
    return { refusal: { reason: 'service_caller_capture_unpinned' }, boundary };
  const [caller, service] = [callers[0], services[0]];
  // Both published rows, each in its own proof, validated as debug-o11-auth.mjs validates a session target.
  for (const c of [service, caller]) {
    const bytes = fs.readFileSync(c.inventoryProof.path);
    if (o11Hash(bytes) !== c.inventoryProof.sha256) fail('inventory_changed');
    validateO11PublicationProof({ host: String(host ?? '').toLowerCase(), module: c.target.module, moduleKey: c.target.moduleKey,
      applicationKey: c.target.applicationKey, publishedVersionId: c.versionId }, JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')), now);
  }
  return { serviceCaller: { module: caller.target.module, moduleKey: caller.target.moduleKey, applicationKey: caller.target.applicationKey,
    publishedVersionId: caller.versionId, runtimeUrl: runtimeOf(caller, host), publishedProof: caller.inventoryProof }, boundary };
}
