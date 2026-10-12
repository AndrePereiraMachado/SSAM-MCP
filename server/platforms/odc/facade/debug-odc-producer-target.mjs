// The selected key in the consumer remains the imported signature, so the
// original call graph and its input bindings remain intact. Debugger keys come
// from the pinned producer body. Libraries execute inside the consumer runtime;
// a service needs its own deployed source and native runtime binding.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const KEY = /^[A-Za-z0-9_+]{22}$/, HASH = /^[a-f0-9]{64}$/i;
const fail = code => { throw new Error('debug_odc_producer_' + code); };
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sourceGuard(source) {
  if (!source?.path || !HASH.test(source.sha256 ?? '') || digest(source.path) !== source.sha256.toLowerCase()) fail('source_changed');
}
export async function resolveOdcProducerTarget(target, { binding, sourceContract, readExternal }) {
  if (!target?.importedSignature) return target;
  sourceGuard(sourceContract);
  const { signature, reference } = target.importedSignature, p = reference?.properties ?? {};
  const originalKey = signature?.properties?.OriginalKey;
  const library = p.ModuleType === 'ReactiveLibrary', service = signature?.kind === 'ServiceActionSignature' && !library;
  const importedRevision = typeof p.Revision === 'string' && /^[1-9][0-9]*$/.test(p.Revision) ? Number(p.Revision) : null;
  // Native app imports intentionally clear their version lock, including Revision.
  // A null service import revision is preserved; its executable body is pinned by deployment.
  const revisionValid = Number.isSafeInteger(importedRevision) || service && (p.Revision == null || p.Revision === '');
  if (!KEY.test(target.key) || target.key !== signature?.key || !KEY.test(originalKey ?? '') || !KEY.test(p.ModuleKey ?? '') ||
      !new RegExp('^Reference:[^/]+/(?:ServerActionSignature|ServiceActionSignature):[^/]+$').test(signature?.path ?? '') ||
      reference.path !== signature.path.split('/')[0] || !revisionValid || !library && !service) fail('reference_invalid');
  const identity = { schema: 'ssam-odc-producer-target/1', kind: library ? 'library-reference' : 'service-reference',
    signatureKey: target.key, actionKey: originalKey, actionKind: library ? 'ServerAction' : 'ServiceAction',
    importedRevision, referenceKey: reference.key, producerModuleKey: p.ModuleKey,
    consumer: { module: binding.module, moduleKey: binding.moduleKey, runtimeUrl: binding.runtimeUrl,
      tenant: binding.tenant, environmentKey: binding.environmentKey, revision: binding.revision, sourceSha256: sourceContract.sha256.toLowerCase() },
    appUserIdentityProved: false, rolesProved: false, propagationProved: false, requestOwnershipProved: false };
  const producer = await readExternal({ signature, reference });
  if (!producer) return { ...target, producerTarget: { ...identity, executable: false,
    error: library ? 'debug_odc_producer_library_body_unavailable' : 'debug_odc_producer_service_deployment_unavailable' } };
  if (producer.key !== originalKey || producer.source?.moduleKey !== p.ModuleKey || !HASH.test(producer.source?.sha256 ?? '') ||
      !Number.isSafeInteger(producer.source?.revision) || producer.source.revision < 1 ||
      library && producer.source.revision !== importedRevision) fail('source_binding_invalid');
  const source = producer.sourceContract && { ...producer.sourceContract, sha256: producer.sourceContract.sha256?.toLowerCase() };
  if (!source || source.sha256 !== producer.source.sha256.toLowerCase()) fail('source_binding_invalid');
  sourceGuard(source);
  const action = await producer.reader.tree('@' + originalKey);
  if (action.key !== originalKey || action.kind !== identity.actionKind || /^Reference:/.test(action.path ?? '') || action.childrenOmitted) fail('action_binding_invalid');
  // OriginalKey on each imported input is the native relationship. Matching
  // names alone would silently accept an incompatible stale service signature.
  const importedInputs = signature.children.filter(c => c.kind === 'InputParameterSignature');
  const originalInputs = action.children.filter(c => c.kind === 'InputParameter');
  if (importedInputs.length !== originalInputs.length || importedInputs.some((input, i) =>
      input.properties?.OriginalKey !== originalInputs[i].key || input.name !== originalInputs[i].name)) fail('input_signature_changed');
  let runtimeBinding;
  if (library) runtimeBinding = { ...binding, module: p.Name, moduleKey: p.ModuleKey,
    revision: producer.source.revision, runtimeRevision: binding.revision };
  else {
    runtimeBinding = producer.binding;
    if (!runtimeBinding || producer.source.deployed !== true || runtimeBinding.moduleKey !== p.ModuleKey ||
        runtimeBinding.revision !== producer.source.revision || runtimeBinding.tenant !== binding.tenant ||
        runtimeBinding.environmentKey !== binding.environmentKey || new URL(runtimeBinding.runtimeUrl).origin !== new URL(binding.runtimeUrl).origin)
      fail('service_deployment_unavailable');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(runtimeBinding.module ?? '')) fail('module_name_unavailable');
  const metadata = { ...identity, executable: true, actionPath: action.path,
    producerRevision: producer.source.revision, producerSourceSha256: source.sha256,
    sourceContract: source, traceBinding: runtimeBinding,
    nativeContract: 'odc-studio-producer-key-entry-runtime/1',
    bodyInspection: library ? 'imported-library-revision' : 'deployed-service-revision' };
  sourceGuard(sourceContract); sourceGuard(source);
  const result = { ...target, producerTarget: metadata };
  Object.defineProperty(result, 'producerReader', { value: producer.reader });
  if (service) {
    if (typeof producer.verifyPublication !== 'function') fail('service_publication_check_unavailable');
    Object.defineProperty(result, 'verifyProducerPublication', { value: producer.verifyPublication });
  }
  return result;
}

// Internal redaction contract, not a public way to borrow credentials. The
// descriptor belongs to the original consumer and is never used to log in to
// the producer or to assert identity propagation.
export function validateOdcProducerRedaction(input, source, contract) {
  if (contract?.schema !== 'ssam-odc-producer-target/1' || contract.executable !== true ||
      contract.nativeContract !== 'odc-studio-producer-key-entry-runtime/1' || input.lane !== 'odc' || source?.lane !== 'odc' ||
      !HASH.test(contract.consumer?.sourceSha256 ?? '') || !HASH.test(contract.producerSourceSha256 ?? '') ||
      !KEY.test(contract.signatureKey ?? '') || !KEY.test(contract.actionKey ?? '') ||
      !['library-reference', 'service-reference'].includes(contract.kind)) fail('redaction_binding_invalid');
  const consumer = contract.consumer, target = contract.traceBinding, library = contract.kind === 'library-reference';
  // Per-node breakpoint owners: the producer, or for a library (which runs inside the consumer runtime) the original
  // consumer pinned by its source hash. A service runs in its own app: consumer owners are never admitted there.
  const owners = input.nodeModuleKeys, allowedOwners = library ? [contract.producerModuleKey, consumer.moduleKey] : [contract.producerModuleKey];
  const ownersValid = owners === undefined || !!owners && typeof owners === 'object' && !Array.isArray(owners) && Array.isArray(input.nodeKeys) &&
    Object.keys(owners).length === input.nodeKeys.length && input.nodeKeys.every(key => allowedOwners.includes(owners[key]));
  const producerScope = scope => scope.moduleKey === contract.producerModuleKey && scope.functionKey === contract.actionKey &&
    scope.sourceSha256 === contract.producerSourceSha256;
  const consumerScope = scope => library && scope.moduleKey === consumer.moduleKey && KEY.test(scope.functionKey ?? '') &&
    scope.sourceSha256 === consumer.sourceSha256;
  const automatic = input.trace?.focusFunctionKey === contract.actionKey && input.trace.requireFunctionKey === contract.actionKey &&
    Object.keys(input.trace.scopes ?? {}).every(key => key === contract.actionKey) && !input.inspection && ownersValid;
  const scopes = input.inspection?.scopes ?? [];
  const sourcesValid = (input.inspection?.sources ?? []).every(s =>
    s.moduleKey === contract.producerModuleKey && s.sourceSha256 === contract.producerSourceSha256 ||
    s.moduleKey === consumer.moduleKey && s.sourceSha256 === consumer.sourceSha256);
  const interactive = !input.trace && input.autoContinue === false && scopes.length > 0 && sourcesValid && ownersValid &&
    scopes.every(scope => (producerScope(scope) || consumerScope(scope)) && input.nodeKeys.includes(scope.nodeKey) &&
      (owners === undefined || owners[scope.nodeKey] === scope.moduleKey)) &&
    input.nodeKeys.every(key => new Set(scopes.filter(scope => scope.nodeKey === key).map(scope => scope.moduleKey)).size === 1) &&
    input.inspection.variables.every(v => scopes.some(scope => scope.nodeKey === v.nodeKey && scope.moduleKey === v.moduleKey &&
      scope.functionKey === v.functionKey && scope.sourceSha256 === v.sourceSha256));
  if (!target || target.tenant !== consumer.tenant || target.environmentKey !== consumer.environmentKey ||
      input.tenant !== target.tenant || input.module !== target.module || input.moduleKey !== contract.producerModuleKey ||
      input.moduleKey !== target.moduleKey || input.runtimeUrl !== target.runtimeUrl ||
      source.module !== consumer.module || source.moduleKey !== consumer.moduleKey || source.runtimeUrl !== consumer.runtimeUrl ||
      !automatic && !interactive ||
      new URL(source.runtimeUrl).origin !== new URL(input.runtimeUrl).origin ||
      contract.kind === 'library-reference' && (target.runtimeUrl !== consumer.runtimeUrl || contract.producerRevision !== contract.importedRevision))
    fail('redaction_binding_invalid');
  sourceGuard(contract.sourceContract);
  return true;
}
