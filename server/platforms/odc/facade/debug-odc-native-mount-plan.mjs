// Discovery for native mounting. This never authorizes execution: the original
// model closures for every root still need effect and identity qualification.
import { createHash } from 'node:crypto';
import { odcMountRenderTargets } from './debug-odc-view-render.mjs';
import { nativeInteractionRequests } from './debug-native-browser-interaction.mjs';
const fail = code => { throw new Error('debug_odc_native_mount_' + code); };
// One onClick target of the mounted screen or its blocks, from the published
// render inspection only: the widget id the view's idService produces (with
// its block namespace) and the single controller action the callback calls,
// matched by method name inside the same view chunk and controller factory.
export function resolveOdcInteractionTarget(index, views, moduleKey, { name, viewKey } = {}) {
  const list = (Array.isArray(views) ? views : []).map(v => ({ ...v, blockComponents: v.blockComponents ?? index.views?.[v.key]?.[0]?.blockComponents }));
  const targets = odcMountRenderTargets(list, { moduleKey });
  if (!targets.complete) fail('interaction_targets_incomplete');
  const matches = targets.instances.flatMap(i => (i.interactions ?? []).filter(t => t.name === name && (viewKey === undefined || i.key === viewKey)).map(t => ({ i, t })));
  if (matches.length !== 1 || matches[0].i.ambiguous) fail('interaction_target_unresolved');
  const { i: instance, t: target } = matches[0], view = index.views?.[instance.key]?.[0];
  const keys = new Set(Object.values(index.functions ?? {}).flat().filter(r => view && r.chunk === view.chunk && r.controllerFactory === view.controllerFactory &&
    r.holder?.name === target.method).map(r => r.key));
  if (keys.size !== 1) fail('interaction_handler_unresolved');
  return { name, viewKey: instance.key, domId: target.id, method: target.method, actionKey: [...keys][0] };
}
// Wiring for prepareNativeEntry (run.interactions, lifecycle mounted): resolve
// each target ('@<widgetKey>' through the published model, or a widget name),
// read the onClick handler closures and add their roots and effects.
export async function prepareOdcMountInteractions({ index, mount, moduleKey, interactions, resolveWidget, readClosure, classifyEffects }) {
  const requests = nativeInteractionRequests(interactions);
  if (!mount?.screenKey || typeof readClosure !== 'function' || typeof classifyEffects !== 'function') fail('model_closure_unavailable');
  const resolved = [];
  for (const request of requests) {
    let name = request.target;
    if (name.startsWith('@')) {
      const widget = typeof resolveWidget === 'function' ? await resolveWidget(request.target) : null;
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(widget?.name ?? '')) fail('interaction_widget_unresolved');
      name = widget.name;
    }
    const target = resolveOdcInteractionTarget(index, mount.views, moduleKey, { name });
    resolved.push({ target: request.target, event: 'click', name, viewKey: target.viewKey, actionKey: target.actionKey });
  }
  const roots = [...(mount.requiredModelRoots ?? [])], effects = new Set(mount.effects ?? []), requestKeys = new Set(mount.runtimeRequestKeys ?? []), closures = [];
  for (const actionKey of [...new Set(resolved.map(r => r.actionKey))].filter(k => !roots.includes(k))) {
    const calls = await readClosure('@' + actionKey);
    if (!Array.isArray(calls)) fail('model_closure_unavailable');
    const classes = classifyEffects(calls);
    classes.forEach(effect => effects.add(effect)); requestKeys.add(actionKey); roots.push(actionKey);
    calls.forEach(call => { if (call.actionKey) requestKeys.add(call.actionKey); });
    closures.push({ actionKey, effects: classes, calls: calls.map(({ kind, actionKey, actionKind, external, bodyRead, bodyUnavailable }) =>
      ({ kind, actionKey, actionKind, external, bodyRead, bodyUnavailable })) });
  }
  return { mount: { ...mount, interactions: resolved, interactionClosures: closures, requiredModelRoots: roots, effects: [...effects], runtimeRequestKeys: [...requestKeys] } };
}
export async function prepareOdcMountClosures(index, screenKey, readClosure, classifyEffects) {
  const plan = planOdcNativeMount(index, screenKey);
  if (typeof readClosure !== 'function') fail('model_closure_unavailable');
  const closures = [], effects = new Set(), requests = new Set(plan.requiredModelRoots);
  for (const actionKey of plan.requiredModelRoots) {
    const calls = await readClosure('@' + actionKey);
    if (!Array.isArray(calls)) fail('model_closure_unavailable');
    const classes = classifyEffects(calls);
    classes.forEach(effect => effects.add(effect));
    calls.forEach(call => { if (call.actionKey) requests.add(call.actionKey); });
    closures.push({ actionKey, effects: classes, calls: calls.map(({ kind, actionKey, actionKind, external, bodyRead, bodyUnavailable }) =>
      ({ kind, actionKey, actionKind, external, bodyRead, bodyUnavailable })) });
  }
  return { ...plan, modelClosuresRead: true, closures, effects: [...effects], runtimeRequestKeys: [...requests],
    pending: plan.pending.filter(item => item !== 'model-effect-closures') };
}
// The owned browser opens the application root, so the original router mounts
// the default screen. Another screen is mounted only at its qualified named
// route (deep link, `route:{segment}`); a navigation target adds its own plan.
export function planOdcAuthorizedMount(index, screenKey, { route, navigation } = {}) {
  const plan = planOdcNativeMount(index, screenKey);
  const name = index.views[screenKey][0].displayName;
  let initial;
  if (route !== undefined) initial = { screenName: name, default: false, segment: namedRoute(index, name, route?.segment).segment };
  else {
    // The app root resolves to the single default route. The same screen may also
    // keep its named route; only the default one decides what the root mounts.
    const defaults = (Array.isArray(index.bootstrap?.routes) ? index.bootstrap.routes : []).filter(r => r.default === true);
    if (defaults.length !== 1 || defaults[0].screenName !== name || defaults[0].chunk !== index.screens?.[name]) fail('route_not_default');
    initial = { screenName: name, default: true };
  }
  if (navigation === undefined) return { ...plan, route: initial };
  const target = planOdcNavigationTarget(index, navigation?.screenKey, navigation?.segment, navigation?.inputs ?? []);
  return { ...plan, route: initial, navigation: target, requiredModelRoots: [...new Set([...plan.requiredModelRoots, ...target.requiredModelRoots])] };
}
// Only routes whose expressions qualifyOdcBootstrapRoutes proved (the view loader index).
function namedRoute(index, screenName, segment) {
  const qualified = index.bootstrap?.viewLoader?.routeQualification;
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment) || qualified?.routeExpressionsQualified !== true || !Array.isArray(qualified.routes)) fail('route_unqualified');
  const matches = qualified.routes.filter(r => r.defaultPath === false && r.segment === segment);
  if (matches.length !== 1 || matches[0].screenName !== screenName || !index.screens?.[screenName] || matches[0].chunk !== index.screens[screenName]) fail('route_unqualified');
  return matches[0];
}
// A screen reached by original in-app navigation: its qualified route, its
// views/handlers/blocks, and the generated setInputs copies of exactly the
// requested inputs (internal data-fetch status copies are not inputs).
export function planOdcNavigationTarget(index, screenKey, segment, inputNames = []) {
  if (!/^[A-Za-z0-9_+]{22}$|^[A-Za-z0-9_]+$/.test(screenKey ?? '')) fail('navigation_target_invalid');
  const plan = planOdcNativeMount(index, screenKey), view = index.views[screenKey][0];
  const route = namedRoute(index, view.displayName, segment);
  const setInputs = view.modelConstruction?.inputs;
  if (setInputs?.setInputsQualified !== true || !Array.isArray(setInputs.copies)) fail('screen_inputs_unqualified');
  if (!Array.isArray(inputNames) || new Set(inputNames).size !== inputNames.length) fail('screen_input_unqualified');
  const copies = setInputs.copies.filter(c => !c.input.startsWith('_') && !c.attribute.startsWith('_'));
  for (const name of inputNames) if (copies.filter(c => c.input === name).length !== 1) fail('screen_input_unqualified');
  return { screenKey, segment: route.segment, screenName: view.displayName, back: true, views: plan.views, requiredModelRoots: plan.requiredModelRoots,
    inputs: copies.filter(c => inputNames.includes(c.input)).map(({ input, attribute }) => ({ input, attribute })),
    availableInputs: copies.map(({ input, attribute }) => ({ input, attribute })),
    setInputsSha256: setInputs.sourceSha256, executionAuthorized: false };
}
// Wiring for prepareNativeEntry: canonicalize screen inputs against the target's
// InputParameters, read the target closures and add their effects. Without
// `navigate`, inputs on a non-default screen make an initial deep link.
// Only Text, Integer and LongInteger travel in the URL today.
export async function prepareOdcMountNavigation({ index, mount, navigate, targetInputs = [], scenarios = [], readClosure, classifyEffects }) {
  if (!mount?.screenKey || typeof readClosure !== 'function' || typeof classifyEffects !== 'function') fail('model_closure_unavailable');
  const screenInputs = s => {
    const context = s.context;
    if (context === undefined) return {};
    if (Object.keys(context).some(k => k !== 'screen') || Object.keys(context.screen ?? {}).some(k => k !== 'inputs')) fail('screen_context_unsupported');
    return context.screen?.inputs ?? {};
  };
  const canonical = inputs => {
    const known = new Map(targetInputs.map(p => [p.name, p]));
    for (const name of Object.keys(inputs)) if (!known.has(name)) fail('screen_input_unknown');
    const pairs = [];
    for (const p of targetInputs) {
      if (!Object.hasOwn(inputs, p.name)) { if (p.mandatory !== false) fail('screen_input_missing'); continue; }
      const value = inputs[p.name];
      if (p.dataType === 'Text') { if (typeof value !== 'string' || !value) fail('screen_input_type'); pairs.push([p.name, value]); }
      else if (['Integer', 'LongInteger'].includes(p.dataType)) {
        const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' && /^-?(0|[1-9][0-9]{0,18})$/.test(value) ? value : null;
        if (text === null) fail('screen_input_type'); pairs.push([p.name, text]);
      } else fail('screen_input_type_unsupported');
    }
    const query = pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    return { inputs: pairs, query, querySha256: createHash('sha256').update(query).digest('hex') };
  };
  if (scenarios.some(s => Object.keys(s.inputs ?? {}).length)) fail('screen_context_unsupported');
  if (!navigate) {
    const given = scenarios.map(screenInputs), name = index.views?.[mount.screenKey]?.[0]?.displayName;
    if (!given.some(i => Object.keys(i).length)) {
      try { return { mount: { ...mount, route: planOdcAuthorizedMount(index, mount.screenKey).route }, scenarios }; }
      catch (error) { if (error?.message !== 'debug_odc_native_mount_route_not_default' || scenarios.length > 1) throw error; }
    }
    if (scenarios.length !== 1) fail('deep_link_single_scenario');
    const routes = (index.bootstrap?.viewLoader?.routeQualification?.routes ?? []).filter(r => r.defaultPath === false && r.screenName === name);
    if (routes.length !== 1) fail('route_unqualified');
    const plan = planOdcAuthorizedMount(index, mount.screenKey, { route: { segment: routes[0].segment } });
    const query = canonical(given[0]);
    planOdcNavigationTarget(index, mount.screenKey, routes[0].segment, query.inputs.map(p => p[0]));
    return { mount: { ...mount, route: { ...plan.route, query: query.query, querySha256: query.querySha256 } }, scenarios };
  }
  if (navigate.back !== true) fail('navigation_back_required');
  const screenKey = String(navigate.screen ?? '').replace(/^@/, '');
  const name = index.views?.[screenKey]?.[0]?.displayName;
  const routes = (index.bootstrap?.viewLoader?.routeQualification?.routes ?? []).filter(r => r.defaultPath === false && r.screenName === name);
  if (!name || routes.length !== 1) fail('route_unqualified');
  const queries = scenarios.map(s => canonical(screenInputs(s)));
  const names = [...new Set(queries.flatMap(q => q.inputs.map(p => p[0])))];
  const plan = planOdcAuthorizedMount(index, mount.screenKey, { navigation: { screenKey, segment: routes[0].segment, inputs: names } });
  const target = plan.navigation, closures = [], effects = new Set(mount.effects ?? []), requests = new Set(mount.runtimeRequestKeys ?? []);
  for (const actionKey of target.requiredModelRoots.filter(k => !(mount.requiredModelRoots ?? []).includes(k))) {
    const calls = await readClosure('@' + actionKey);
    if (!Array.isArray(calls)) fail('model_closure_unavailable');
    const classes = classifyEffects(calls);
    classes.forEach(effect => effects.add(effect)); requests.add(actionKey);
    calls.forEach(call => { if (call.actionKey) requests.add(call.actionKey); });
    closures.push({ actionKey, effects: classes, calls: calls.map(({ kind, actionKey, actionKind, external, bodyRead, bodyUnavailable }) =>
      ({ kind, actionKey, actionKind, external, bodyRead, bodyUnavailable })) });
  }
  return { mount: { ...mount, route: plan.route, navigation: { ...target, closures }, effects: [...effects], runtimeRequestKeys: [...requests],
    requiredModelRoots: plan.requiredModelRoots },
    scenarios: scenarios.map((s, i) => ({ ...s, navigation: queries[i] })) };
}
export function planOdcNativeMount(index, screenKey) {
  const visited = new Set(), active = new Set(), views = [], roots = new Set();
  function visit(key, screen = false) {
    if (active.has(key)) fail('recursive_block_graph');
    if (visited.has(key)) return;
    const matches = index.views?.[key];
    if (!Array.isArray(matches) || matches.length !== 1) fail('view_ambiguous');
    const view = matches[0];
    if (screen && index.screens?.[view.displayName] !== view.chunk) fail('screen_route_unbound');
    if (!view.componentLocal || view.controllerSurface?.resolved !== true) fail('controller_unresolved');
    if (!Array.isArray(view.blockKeys) || !Array.isArray(view.unresolvedBlockComponents) || view.unresolvedBlockComponents.length) fail('block_graph_unresolved');
    const declarations = view.controllerSurface.lifecycleHandlers;
    if (!Array.isArray(declarations)) fail('lifecycle_unresolved');
    const absentHandlers = declarations.filter(h => h.absentByDefault === true && h.actionKeys?.length === 0).map(h => h.handler);
    const handlers = declarations.filter(h => !absentHandlers.includes(h.handler)).map(h => {
      if (!Array.isArray(h.actionKeys) || h.actionKeys.length !== 1) fail('lifecycle_unresolved');
      const actionKey = h.actionKeys[0];
      const records = (index.functions?.[actionKey] ?? []).filter(r => r.chunk === view.chunk &&
        r.controllerFactory === view.controllerFactory && r.lifecycleBindings?.some(b => b.handler === h.handler &&
          b.binding?.contextPreserved === true && (b.binding.kind === 'direct' || b.helper?.sourceBindingOnly === true)));
      if (records.length !== 1) fail('lifecycle_binding_unqualified');
      roots.add(actionKey);return { handler: h.handler, actionKey };
    });
    const dataActionKeys = [...new Set(Object.values(index.functions ?? {}).flat().filter(r =>
      r.chunk === view.chunk && r.controllerFactory === view.controllerFactory && r.call?.kind === 'data-action').map(r => r.key))];
    dataActionKeys.forEach(k => roots.add(k));
    active.add(key);
    views.push({ key, chunk: view.chunk, componentLocal: view.componentLocal, handlers, absentHandlers,
      blockKeys: [...view.blockKeys], dataActionKeys, factoryConstruction: view.factoryConstruction,
      recordInitialization: view.recordInitialization, modelConstruction: view.modelConstruction,
      permissionDeclaration: view.permissionDeclaration, resourceDependencies: view.resourceDependencies,
      componentRegistration: view.componentRegistration, embeddedWidgets: view.embeddedWidgets, renderExpressions: view.renderExpressions });
    for (const child of view.blockKeys) visit(child);
    active.delete(key);visited.add(key);
  }
  visit(screenKey, true);
  // The original final bootstrap callback also imports the global error
  // controller. Its model actions are separate from screen/block lifecycle.
  // Discover them without treating SDK initialization or transitive dynamic
  // loading as qualified merely because all static imports are present.
  const startupChunks = new Set();
  function visitStartup(specifier) {
    if (typeof specifier !== 'string' || !/^\.\/_os(?:chunk|bundle)-[A-Za-z0-9_.+]+\.js$/.test(specifier)) fail('startup_import_unresolved');
    const file = specifier.slice(2);
    if (startupChunks.has(file)) return;
    const chunk = index.chunks?.[file];
    if (!chunk || !Array.isArray(chunk.imports)) fail('startup_import_unresolved');
    startupChunks.add(file);
    for (const dependency of chunk.imports) visitStartup(dependency.specifier);
  }
  if (!Array.isArray(index.bootstrap?.mountImports)) fail('startup_import_unresolved');
  for (const specifier of index.bootstrap.mountImports) visitStartup(specifier);
  const application = index.bootstrap.applicationStartup;
  if (!application || !Array.isArray(application.importers) || application.importers.length !== 2 ||
      new Set(application.importers.map(i => i.name)).size !== 2 ||
      application.importers.some(i => !['homeModuleControllerImporter', 'homeModuleLanguageResourcesImporter'].includes(i.name) ||
        i.resolved !== true || !Array.isArray(i.imports) || i.imports.length !== 1)) fail('application_import_unresolved');
  for (const importer of application.importers) for (const specifier of importer.imports) visitStartup(specifier);
  const startupActions = Object.values(index.functions ?? {}).flat().filter(r => startupChunks.has(r.chunk));
  for (const action of startupActions) roots.add(action.key);
  return { screenKey, views, startup: { chunks: [...startupChunks], actionKeys: [...new Set(startupActions.map(r => r.key))],
    application,viewLoader:index.bootstrap.viewLoader,finalStage:index.bootstrap.finalStage, qualified: false }, requiredModelRoots: [...roots], executionAuthorized: false,
    mounted: false, pending: ['model-effect-closures', 'application-startup-closure',
      ...(views.some(v=>v.resourceDependencies?.resolved!==true)?['view-resource-dependencies']:[]),
      ...(views.some(v=>v.resourceDependencies?.css?.length||v.resourceDependencies?.js?.length)?['view-resource-pins']:[]),
      'authenticated-native-mount', 'native-hook-completion-and-cleanup'] };
}
