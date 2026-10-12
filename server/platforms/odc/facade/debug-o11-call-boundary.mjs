// Resolve the debugger's runtime host from the actual call path. Linked actions
// execute in the current consumer; ServiceAction starts a producer runtime hop.
// A model edge is not evidence of an app user's identity/roles at that hop.
const fail = code => { throw new Error('debug_o11_native_' + code); };
const KEY = /^[A-Za-z0-9_+]{22}$/;
export function resolveO11TraceRuntime(graph, resolution, captures) {
  if (!Array.isArray(resolution?.path) || !resolution.path.length || !Array.isArray(captures)) fail('trace_path_unresolved');
  const nodes = resolution.path.map(step => graph.nodes.get(step.id));
  if (nodes.some(node => !node || !KEY.test(node.moduleKey ?? ''))) fail('trace_path_unresolved');
  const capture = key => {
    const found = captures.filter(item => item.target?.moduleKey === key);
    if (found.length !== 1) fail('trace_module_binding_ambiguous');
    return found[0];
  };
  let runtime = nodes[0];
  const boundaries = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i], caller = nodes[i - 1];
    if (caller && !graph.edges.some(edge => edge.from === caller.id && edge.to === node.id)) fail('trace_path_unresolved');
    if (node.kind === 'ServiceAction') runtime = node;
    if (caller && caller.moduleKey !== node.moduleKey) {
      const producer = capture(node.moduleKey), consumer = capture(caller.moduleKey);
      boundaries.push({ kind: node.kind === 'ServiceAction' ? 'service-action' : 'linked-action',
        callerModuleKey: caller.moduleKey, producerModuleKey: node.moduleKey, actionKey: node.key,
        runtimeModuleKey: runtime.moduleKey,
        consumerVersionId: consumer.versionId, producerVersionId: producer.versionId,
        modelPathObserved: true, producerFramesObserved: false, valuesObserved: false,
        // Filled only by debug-identity-evidence.mjs (applyIdentityEvidence); never set here.
        identityEvidence: null, appUserIdentityProved: false, rolesProved: false, propagationProved: false });
    }
  }
  return { runtimeCapture: capture(runtime.moduleKey), ownerCapture: capture(nodes.at(-1).moduleKey),
    contract: { schema: 'ssam-o11-native-call-boundary/1', runtimeModuleKey: runtime.moduleKey,
      targetModuleKey: nodes.at(-1).moduleKey, targetActionKey: nodes.at(-1).key, boundaries,
      appUserIdentityProved: false, rolesProved: false, propagationProved: false } };
}
