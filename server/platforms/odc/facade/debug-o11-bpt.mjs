// Native process ownership and flow projection. This describes launch reachability,
// never an activity invocation, scheduler completion or an authenticated app user.
const KEY = /^[A-Za-z0-9_+]{22}$/;
const fail = code => { throw new Error('debug_o11_native_bpt_' + code); };
const refs = (node, name, optional = false) => {
  const list = node.propertyReferenceCollections?.[name];
  if (!list && optional) return [];
  if (!list || list.omitted !== 0 || !Array.isArray(list.items) || list.total !== list.items.length ||
      list.items.some(item => !item?.key)) fail('native_' + name.toLowerCase() + '_incomplete');
  return list.items;
};
export function nativeO11Process(node) {
  if (node.kind !== 'Process' || !KEY.test(node.key ?? '')) fail('process_identity_invalid');
  if (node.childrenOmitted !== 0 || node.childrenTotal !== node.children?.length) fail('process_children_incomplete');
  const children = new Map(node.children.map(child => [child.key, child]));
  const owned = refs(node, 'Nodes');
  if (owned.some(ref => !children.has(ref.key) || children.get(ref.key).kind !== ref.kind)) fail('owned_nodes_incomplete');
  const processNodes = new Map(owned.map(ref => [ref.key, children.get(ref.key)]));
  const launch = node.propertyReferences?.LaunchProcessAction, signature = children.get(launch?.key);
  // The generated native key is intentionally preserved verbatim, including .#LaunchProcess.
  if (!launch || !signature || launch.kind !== 'ActionSignature' || signature.kind !== launch.kind || signature.key !== launch.key ||
      !launch.key.startsWith(node.key + '.')) fail('launch_signature_unavailable');
  if (signature.childrenOmitted !== 0 || signature.childrenTotal !== signature.children?.length ||
      signature.children.filter(child => child.kind === 'InputParameter').some(child =>
        Object.keys(child.propertyErrors ?? {}).length || Object.keys(child.propertiesOmitted ?? {}).length || child.propertiesMissing?.length ||
        !child.properties?.DataType || !child.propertyReferences?.DataType?.key)) fail('launch_input_type_unavailable');
  const starts = [...processNodes.values()].filter(n => n.kind === 'StartNode');
  if (starts.length !== 1) fail('process_start_unavailable');
  const edges = new Map();
  for (const source of processNodes.values()) {
    const targets = refs(source, 'Targets', source.kind === 'EndNode');
    if (targets.some(ref => !processNodes.has(ref.key))) fail('flow_target_outside_process');
    const connectorRefs = refs(source, 'Connectors');
    const connectors = connectorRefs.map(ref => source.children?.find(child => child.key === ref.key));
    if (connectors.some(c => !c || c.propertyReferences?.Source?.key !== source.key || !processNodes.has(c.propertyReferences?.Target?.key)))
      fail('flow_connector_incomplete');
    const byConnector = new Set(connectors.map(c => c.propertyReferences.Target.key));
    if (targets.length !== byConnector.size || targets.some(ref => !byConnector.has(ref.key))) fail('flow_targets_disagree');
    edges.set(source.key, targets.map(ref => ref.key).sort());
  }
  const paths = new Map([[starts[0].key, [starts[0].key]]]), queue = [starts[0].key];
  for (let i = 0; i < queue.length; i++) for (const target of edges.get(queue[i]) ?? []) if (!paths.has(target)) {
    paths.set(target, [...paths.get(queue[i]), target]); queue.push(target);
  }
  const action = node.properties?.LaunchOnAction;
  if (!['None', 'Create', 'Update'].includes(action)) fail('launch_trigger_unread');
  const entity = node.propertyReferences?.LaunchOnEntity ?? null;
  if (action !== 'None' && !KEY.test(entity?.key ?? '')) fail('launch_entity_identity_unavailable');
  return { processKey: node.key, launchActionKey: launch.key, launchAction: signature,
    source: 'IProcess.LaunchProcessAction + IProcess.Nodes + IProcessNode.Targets/Connectors',
    trigger: action === 'None' ? { kind: 'explicit-launch' } : { kind: 'entity-event', action, entity,
      executable: false, missingCapability: 'native entity Create/Update action identity and process-event exposure' },
    activities: [...processNodes.values()].filter(n => n.kind === 'AutomaticActivityNode').map(n => ({ key: n.key, name: n.name,
      reachable: paths.has(n.key), flowPath: paths.get(n.key) ?? [],
      startNodeKey: n.children?.find(c => c.kind === 'StartNode')?.key ?? null,
      disabled: n.properties?.IsDisabled === 'True' })),
    applicationUserContext: false, executionCompleted: false, requestOwnershipProved: false };
}
