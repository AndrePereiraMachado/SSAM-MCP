// Interactive server inspection (ssam_debug_server) for O11 Traditional entries: the screen
// Preparation, same-module block Preparations and, for a screen-action entry, the action itself.
// Order per run: bind the runner-derived scopes (prepareServerInspection) before any request, then
// per scenario report the submission (beforeServerInvocation) and send the original GET/postback
// once through the private worker, whose request deadline is pause-aware and bounded by the
// fixed native lease. Login, post markers and uncertainty stay with the worker; nothing is resent.
import { actionModel, scopeRoots } from './debug-wrapper.mjs'; // pure model helpers only

const fail = code => { throw new Error(code); };
const parameters = node => (node?.children ?? []).filter(c => ['InputParameter', 'LocalVariable'].includes(c.kind));

// One scope per function the original request can run, with the variable roots the trace path uses.
export function traditionalInspectionScopes(source, plan) {
  const moduleKey = plan.binding.moduleKey, screenParameters = parameters(source.screen);
  const scope = (role, functionKey, startNodeKey, tree, extra = []) => ({ role, moduleKey, functionKey, nodeKeys: [startNodeKey],
    roots: scopeRoots(actionModel({ ...tree, children: [...(tree.children ?? []), ...extra] })) });
  const blocks = new Map((source.blocks ?? []).map(b => [b.block.key, b]));
  const scopes = plan.preparations.map(p => p.kind === 'screen'
    ? scope('screen-preparation', p.key, p.startNodeKey, source.preparation, screenParameters)
    : scope('block-preparation', p.key, p.startNodeKey, blocks.get(p.blockKey).preparation, parameters(blocks.get(p.blockKey).block)));
  if (plan.screenAction) {
    const owner = plan.screenAction.ownerKind === 'WebBlock' ? parameters(blocks.get(plan.screenAction.ownerKey)?.block) : screenParameters;
    scopes.push(scope('screen-action', plan.screenAction.key, plan.screenAction.startNodeKey, source.action, owner));
  }
  if (scopes.length > 20 || new Set(scopes.map(s => s.functionKey)).size !== scopes.length) fail('debug_o11_native_traditional_scope_limit');
  return scopes;
}

// contract: { input, trace, source, plan, owner, captures, root, directory, operationId }
export async function prepareTraditionalInteractive(contract, services = {}) {
  const { input = {}, trace, source, plan, owner, captures = [owner], root, directory, operationId } = contract ?? {};
  if (typeof services.prepareServerInspection !== 'function' || typeof services.beforeServerInvocation !== 'function' ||
      typeof services.invokeTraditional !== 'function') fail('debug_o11_native_traditional_interactive_services_required');
  if (input.contextMode && input.contextMode !== 'app-user') fail('debug_o11_native_context_mode_unsupported');
  if (input.context !== undefined || input.scenarios?.some(s => s.context !== undefined)) fail('debug_o11_native_traditional_owner_state_unsupported');
  if (!trace?.server?.allowed) fail('debug_o11_native_server_inspection_trace_required');
  if (!owner?.snapshot || owner.target?.moduleKey !== plan?.binding?.moduleKey || trace.server.moduleKey !== plan.binding.moduleKey ||
      source?.sourceContract?.sha256 !== owner.snapshot.sha256) fail('debug_o11_native_traditional_entry_module_mismatch');
  // The target function (trace.server.functionKey) may be deeper on the path; these scopes are added to it.
  const scopes = traditionalInspectionScopes(source, plan);
  await services.prepareServerInspection({ lane: 'o11', moduleKey: plan.binding.moduleKey, source: owner.snapshot,
    functionKey: trace.server.functionKey, models: captures.map(c => ({ moduleKey: c.target.moduleKey, source: c.snapshot })),
    derivedScopes: scopes.map(({ role, moduleKey, functionKey, nodeKeys }) => ({ moduleKey, functionKey, nodeKeys: [...nodeKeys], role, source: 'runner-derived' })) });
  return { interactive: true, scopes, traceScopes: Object.fromEntries(scopes.map(s => [s.functionKey, s.roots])),
    async invoke({ index, scenario, descriptor, requestDeadline }) {
      const requestId = 'scenario-' + index;
      await services.beforeServerInvocation({ requestId, nativeDeadlineAt: Date.parse(requestDeadline) });
      try {
        return await services.invokeTraditional({ root, directory, operationId, scenarioId: requestId, timeoutSeconds: input.timeoutSeconds,
          contract: source, inputs: scenario.values ?? {}, context: 'app-user', descriptor, inspectionExpiresAt: requestDeadline },
        { inspection: services.inspectionEvents });
      } catch { return { ok: false, uncertain: true, error: 'debug_o11_native_traditional_worker_unavailable' }; }
      finally { services.afterServerInvocation?.({ requestId }); }
    } };
}
