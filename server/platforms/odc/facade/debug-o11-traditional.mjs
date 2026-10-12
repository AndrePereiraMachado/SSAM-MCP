// Original Traditional screen requests. Preparation runs as part of server
// rendering; it is never called as an invented REST/Reactive action endpoint.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const fail = code => { throw new Error('debug_o11_native_traditional_' + code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const KEY = /^[A-Za-z0-9_+]{22}$/, NAME = /^[A-Za-z_][A-Za-z0-9_]{0,198}$/;
const walk = node => [node, ...(node.children ?? []).flatMap(walk)];
const tree = reading => reading?.tree ?? reading;
const one = values => { if (values.length !== 1) fail('model_ambiguous'); return values[0]; };
function checked(node, kind, moduleKey) {
  if (!node || node.kind !== kind || node.properties?.GlobalKey !== moduleKey + '*' + node.key ||
      Object.keys(node.propertyErrors ?? {}).length || Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length)
    fail('model_incomplete');
  return node;
}
function collection(node, name) {
  const value = node.propertyReferenceCollections?.[name];
  if (!value || value.omitted !== 0 || value.total !== value.items?.length) fail('model_incomplete');
  return value.items;
}
function route(raw, binding) {
  let url; try { url = new URL(raw); } catch { fail('route_invalid'); }
  if (url.origin !== new URL(binding.runtimeUrl).origin || url.username || url.password || url.hash ||
      !url.pathname.startsWith('/' + binding.module + '/') || !url.pathname.endsWith('.aspx') ||
      /%(?:2f|5c|2e)/i.test(url.pathname)) fail('route_invalid');
  return url.href;
}
export function compileTraditionalPreparation(contract) {
  const { binding, screen, preparation, login, loginAction, widgets, routes } = contract ?? {};
  if (contract?.schema !== 'ssam-o11-traditional-source/1' || binding?.lane !== 'o11' || !KEY.test(binding.moduleKey ?? '') ||
      !KEY.test(binding.applicationKey ?? '') || !NAME.test(binding.module ?? '') || !/^[a-f0-9]{64}$/.test(binding.sourceSha256 ?? '') ||
      !Number.isSafeInteger(binding.revision) || binding.revision < 1 || routes?.source !== 'DebuggerService.GetEntryPointUri') fail('contract_invalid');
  checked(screen, 'WebScreen', binding.moduleKey); checked(preparation, 'Preparation', binding.moduleKey);
  checked(login, 'WebScreen', binding.moduleKey); checked(loginAction, 'ScreenAction', binding.moduleKey);
  if (preparation.key !== screen.key + '.#Preparation' || screen.propertyReferences?.Preparation?.key !== preparation.key ||
      !loginAction.path.startsWith(login.path + '/') || !NAME.test(screen.name) || !NAME.test(login.name)) fail('model_binding_invalid');
  const start = one((preparation.children ?? []).filter(n => n.kind === 'StartNode'));
  const roles = collection(screen, 'Roles').map(r => ({ key: r.key, name: r.name }));
  const inputRefs = collection(screen, 'InputParameters');
  const inputs = inputRefs.map(ref => {
    const node = checked(one((screen.children ?? []).filter(n => n.key === ref.key)), 'InputParameter', binding.moduleKey);
    if (!NAME.test(node.name) || /password|credential|cookie|token|secret/i.test(node.name)) fail('input_unsupported');
    const type = node.properties.DataType;
    if (!['Integer', 'Long Integer', 'Text', 'Boolean', 'Decimal', 'Date', 'Date Time', 'Time'].includes(type)) fail('input_unsupported');
    return { name: node.name, type, mandatory: node.properties.IsMandatory === 'True' };
  });
  const calls = walk(loginAction).filter(n => n.kind === 'ExecuteServerActionNode' && n.propertyReferences?.Action?.name === 'User_Login' &&
    /^Reference:[^/]+\/ServerActionSignature:User_Login$/.test(n.propertyReferences.Action.path ?? ''));
  const call = one(calls), args = Object.fromEntries((call.children ?? []).filter(n => n.kind === 'Argument')
    .map(n => [n.propertyReferences?.Parameter?.name, n.properties?.Value]));
  if (Object.keys(args).sort().join(',') !== 'Password,RememberLogin,Username' ||
      !Object.values(args).every(value => NAME.test(value ?? '')) || loginAction.properties.IsCalledByAjax !== 'False' ||
      call.propertyReferences?.Target?.kind !== 'DestinationNode') fail('login_contract_unqualified');
  const controls = {};
  for (const [parameter, kind] of [['Username', 'InputWidget'], ['Password', 'InputPasswordWidget']]) {
    const control = one(widgets.filter(n => n.kind === kind && n.properties?.Variable === args[parameter]));
    checked(control, kind, binding.moduleKey);
    if (!NAME.test(control.name) || control.propertyReferences?.Owner?.key !== login.key) fail('login_contract_unqualified');
    controls[parameter] = { key: control.key, name: control.name };
  }
  const button = one(widgets.filter(n => n.kind === 'ButtonWidget' && (n.children ?? []).some(c => c.propertyReferences?.Destination?.key === loginAction.key)));
  checked(button, 'ButtonWidget', binding.moduleKey);
  const label = /^"((?:[^"]|"")*)"$/.exec(button.properties?.Label ?? '')?.[1]?.replaceAll('""', '"');
  if (!label || button.propertyReferences?.Owner?.key !== login.key) fail('login_contract_unqualified');
  return { schema: 'ssam-o11-traditional-entry/1', binding, entry: { key: preparation.key, screenKey: screen.key, screen: screen.name,
    startNodeKey: start.key, inputs, outputs: [], roles, method: 'GET', url: route(routes.urls[screen.name], binding) },
    preparations: [{ kind: 'screen', key: preparation.key, screenKey: screen.key, name: screen.name, startNodeKey: start.key }, ...traditionalBlockPreparations(contract)],
    login: { screenKey: login.key, actionKey: loginAction.key, provider: call.propertyReferences.Action.path.split('/')[0].slice(10),
      url: route(routes.urls[login.name], binding), controls, button: { key: button.key, label },
      nativeUserLogin: true, redirectsNotFollowed: true },
    effects: ['Original login page Preparation and login action', 'Original requested screen Preparation and server rendering, including nested blocks'],
    authentication: { requiredContext: 'app-user', appUserIdentityProved: false, rolesProved: false, propagationProved: false } };
}

// Same-module blocks rendered by the screen: each runs its own '<block>.#Preparation' during
// the original GET. Producer blocks run in their own module and are never bound here.
export function traditionalBlockPreparations(contract) {
  const { binding, screen } = contract, blocks = contract.blocks ?? [];
  if (!Array.isArray(blocks) || blocks.length > 40) fail('model_incomplete');
  const owners = new Set([screen.key, ...blocks.map(b => b?.block?.key)]), found = new Map();
  for (const { instance, block, preparation } of blocks) {
    checked(instance, 'WebBlockInstanceWidget', binding.moduleKey); checked(block, 'WebBlock', binding.moduleKey); checked(preparation, 'Preparation', binding.moduleKey);
    if (instance.propertyReferences?.SourceBlock?.key !== block.key || !owners.has(instance.propertyReferences?.Owner?.key) ||
        preparation.key !== block.key + '.#Preparation' || block.propertyReferences?.Preparation && block.propertyReferences.Preparation.key !== preparation.key ||
        !preparation.path?.startsWith(block.path + '/') || !NAME.test(block.name)) fail('model_binding_invalid');
    const start = one((preparation.children ?? []).filter(n => n.kind === 'StartNode'));
    if (!found.has(block.key)) found.set(block.key, { kind: 'block', key: preparation.key, blockKey: block.key, name: block.name, startNodeKey: start.key });
  }
  return [...found.values()];
}

// Screen action reached through its published Button/Link: Destination = the action, Method Submit
// or Ajax Submit (Navigate and external destinations refused). The worker submits the rendered form.
const EVENTS = { ButtonWidget: 'BuiltinEvent', LinkWidget: 'LinkOnClick' };
export function compileTraditionalScreenAction(contract) {
  if (contract?.schema !== 'ssam-o11-traditional-action-source/1') fail('contract_invalid');
  const base = compileTraditionalPreparation({ ...contract, schema: 'ssam-o11-traditional-source/1' });
  const { binding, screen, action } = contract;
  checked(action, 'ScreenAction', binding.moduleKey);
  const ownerPath = action.path?.slice(0, action.path.lastIndexOf('/'));
  const owner = ownerPath === screen.path ? screen : (contract.blocks ?? []).map(b => b.block).find(b => b.path === ownerPath);
  if (!owner || !NAME.test(action.name) || !/\/ScreenAction:[^/]+$/.test(action.path)) fail('model_binding_invalid');
  const start = one((action.children ?? []).filter(n => n.kind === 'StartNode'));
  const widgets = contract.actionWidgets ?? [];
  if (!Array.isArray(widgets) || widgets.length > 200) fail('model_incomplete');
  const candidates = widgets.filter(w => EVENTS[w?.kind] && w.propertyReferences?.Owner?.key === owner.key &&
    (w.children ?? []).some(c => c.kind === EVENTS[w.kind] && c.propertyReferences?.Destination?.key === action.key));
  if (!candidates.length) fail('action_widget_unresolved');
  if (candidates.length > 1) fail('action_widget_ambiguous');
  const widget = checked(candidates[0], candidates[0].kind, binding.moduleKey);
  const event = one(widget.children.filter(c => c.kind === EVENTS[widget.kind] && c.propertyReferences?.Destination?.key === action.key));
  const destination = event.propertyReferences.Destination;
  if (destination.kind !== 'ScreenAction' || destination.path !== action.path) fail('action_destination_external');
  const ajax = action.properties?.IsCalledByAjax, raw = event.properties?.Method;
  if (!['True', 'False'].includes(ajax)) fail('model_incomplete');
  let method = raw === 'Submit' ? 'Submit' : ['Ajax', 'Ajax Submit'].includes(raw) ? 'Ajax Submit' : raw == null || raw === '' ? null : fail('action_method_unsupported');
  // Some native readings omit a default Method on the Button event; it is Submit only when no widget calls the action by Ajax.
  const methodSource = method ? 'event.Method' : 'ScreenAction.IsCalledByAjax=False';
  if (!method) { if (ajax !== 'False') fail('action_method_unread'); method = 'Submit'; }
  if (method === 'Ajax Submit' && ajax !== 'True') fail('action_method_inconsistent');
  const name = NAME.test(widget.properties?.Name ?? '') ? widget.properties.Name : null;
  const label = /^"((?:[^"]|"")*)"$/.exec(widget.properties?.Label ?? '')?.[1]?.replaceAll('""', '"') || null;
  if (!name && !label) fail('action_widget_unqualified');
  return { ...base, effects: [...base.effects, 'Original screen action ' + action.name + ' through one ' + method + ' of the rendered form'],
    screenAction: { key: action.key, name: action.name, ownerKey: owner.key, ownerKind: owner.kind, startNodeKey: start.key, method, methodSource,
      isCalledByAjax: ajax === 'True', widget: { kind: widget.kind, key: widget.key, name, label }, redirectsNotFollowed: true } };
}
export const compileTraditionalEntry = contract => contract?.schema === 'ssam-o11-traditional-action-source/1'
  ? compileTraditionalScreenAction(contract) : compileTraditionalPreparation(contract);

export function traditionalRequest(plan, inputs = {}) {
  if (plan?.schema !== 'ssam-o11-traditional-entry/1' || !inputs || Array.isArray(inputs) || typeof inputs !== 'object') fail('input_invalid');
  const url = new URL(plan.entry.url);
  for (const name of Object.keys(inputs)) if (!plan.entry.inputs.some(input => input.name === name)) fail('input_unknown');
  for (const input of plan.entry.inputs) {
    const value = inputs[input.name];
    if (value === undefined) { if (input.mandatory) fail('input_required'); continue; }
    if (value === null) fail('input_null_unsupported');
    const text = String(value);
    if (input.type === 'Text' ? typeof value !== 'string' || value.length > 100000
      : input.type === 'Boolean' ? typeof value !== 'boolean'
      : ['Integer', 'Long Integer'].includes(input.type) ? !/^-?(?:0|[1-9]\d{0,18})$/.test(text) ||
        (typeof value === 'number' && !Number.isSafeInteger(value)) ||
        BigInt(text) < (input.type === 'Integer' ? -2147483648n : -9223372036854775808n) || BigInt(text) > (input.type === 'Integer' ? 2147483647n : 9223372036854775807n)
      : input.type === 'Decimal' ? !/^-?\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))
      : input.type === 'Date' ? !/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text))
      : input.type === 'Time' ? !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(text)
      : !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) || !Number.isFinite(Date.parse(text.replace(' ', 'T') + 'Z'))) fail('input_type_invalid');
    if (url.searchParams.has(input.name)) fail('route_input_conflict');
    url.searchParams.set(input.name, text);
  }
  return { method: 'GET', url: url.href };
}

export async function acquireTraditionalPreparation({ owner, entry, directory, root }, services = {}) {
  const screenPath = /^(.*\/WebScreen:[^/]+)\/Preparation:$/.exec(entry.path ?? '')?.[1];
  if (!screenPath) fail('screen_owner_unavailable');
  const source = await acquireTraditionalSource({ owner, screenPath, preparationKey: entry.key, directory, root }, services);
  return { contract: source.contract, plan: compileTraditionalPreparation(source.contract) };
}

// Screen action of a WebScreen: the action, the screen's Button/Link widgets and its same-module
// blocks with their Preparations. Block-owned actions need the hosting screen, not resolved here.
export async function acquireTraditionalScreenAction({ owner, entry, directory, root }, services = {}) {
  const screenPath = /^(.*\/WebScreen:[^/]+)\/ScreenAction:[^/]+$/.exec(entry.path ?? '')?.[1];
  if (!screenPath) fail(/\/WebBlock:[^/]+\/ScreenAction:/.test(entry.path ?? '') ? 'block_action_host_unresolved' : 'screen_owner_unavailable');
  const source = await acquireTraditionalSource({ owner, screenPath, directory, root, screenAction: entry.key }, services);
  const contract = { ...source.contract, schema: 'ssam-o11-traditional-action-source/1' };
  return { contract, plan: compileTraditionalScreenAction(contract) };
}

async function acquireTraditionalSource({ owner, screenPath, preparationKey, screenAction, directory, root }, services = {}) {
  const { createO11Lifecycle } = await import('./debug-o11-lifecycle.mjs');
  const lifecycle = services.lifecycle ?? createO11Lifecycle({ root });
  const guard = () => { if (hash(fs.readFileSync(owner.snapshot.path)) !== owner.snapshot.sha256) fail('source_changed'); };
  guard();
  const read = async selector => tree(await lifecycle.readTree({ file: owner.snapshot.path, sha256: owner.snapshot.sha256 }, selector));
  const metadata = services.metadata ?? (async selector => {
    const { debugO11Reading } = await import('./debug-o11-reader.mjs');
    const reply = await debugO11Reading(['--oml', owner.snapshot.path, '--path', selector, '--depth', '0', '--max', '500',
      '--full', '--budget', '1000000', '--expectedSourceSha256', owner.snapshot.sha256]);
    if (!reply.ok) fail('owner_metadata_unavailable');
    const data = reply.data?.out ? JSON.parse(fs.readFileSync(reply.data.out, 'utf8')) : reply.data;
    if (data?.sourceSha256?.toLowerCase() !== owner.snapshot.sha256) fail('source_changed');
    return data.tree;
  });
  // The original request renders the layout. We need owner identity, roles and
  // parameters, not the full widget hierarchy (whose unrelated display getters
  // may be unavailable in the native SDK). Preserve omitted-child metadata.
  const readOwner = async (selector, kind = 'WebScreen') => {
    const value = await metadata(selector);
    checked(value, kind, owner.target.moduleKey);
    const refs = [...collection(value, 'InputParameters'), ...collection(value, 'LocalVariables')];
    value.children = []; for (const ref of refs) value.children.push(await read('@' + ref.key));
    value.childrenProjection = 'native-owner-input-and-local-parameters';
    return value;
  };
  const screen = await readOwner(screenPath);
  const preparation = await read('@' + (preparationKey ?? screen.propertyReferences?.Preparation?.key ?? fail('screen_owner_unavailable')));
  // Same-module blocks rendered by the screen, nested blocks included (breadth-first over the
  // Widgets of each read owner): only block instances, their blocks and Preparations; never the
  // layout. A block is read once; producer (Reference) blocks run in their own module.
  const blocks = [], owners = [screen];
  for (let i = 0; i < owners.length; i++) {
    const instances = collection(owners[i], 'Widgets').filter(n => n.kind === 'WebBlockInstanceWidget');
    if (instances.length > 40) fail('model_incomplete');
    for (const ref of instances) {
      const instance = await read('@' + ref.key), source = instance?.propertyReferences?.SourceBlock;
      if (!source?.key || /^Reference:/.test(source.path ?? '') || source.kind !== 'WebBlock' || blocks.some(b => b.block.key === source.key)) continue;
      if (blocks.length >= 40) fail('model_incomplete');
      const block = await readOwner(source.path, 'WebBlock');
      blocks.push({ instance, block, preparation: await read('@' + source.key + '.#Preparation') }); owners.push(block);
    }
  }
  let extra = { blocks };
  if (screenAction) {
    // Only Button/Link widgets (event Destination) are read for the action; never the layout.
    const clickable = collection(screen, 'Widgets').filter(n => ['ButtonWidget', 'LinkWidget'].includes(n.kind));
    if (clickable.length > 200) fail('action_contract_unqualified');
    const actionWidgets = []; for (const ref of clickable) actionWidgets.push(await read('@' + ref.key));
    extra = { action: await read('@' + screenAction), actionWidgets, blocks };
  }
  const candidates = owner.readings.map(tree).filter(n => n.kind === 'ScreenAction' && /\/WebScreen:[^/]+\/ScreenAction:/.test(n.path ?? '') &&
    walk(n).some(c => c.kind === 'ExecuteServerActionNode' && c.propertyReferences?.Action?.name === 'User_Login'));
  const loginAction = one(candidates), login = await readOwner(loginAction.path.slice(0, loginAction.path.lastIndexOf('/')));
  const refs = collection(login, 'Widgets').filter(n => ['InputWidget', 'InputPasswordWidget', 'ButtonWidget'].includes(n.kind));
  if (refs.length > 40) fail('login_contract_unqualified');
  const widgets = []; for (const ref of refs) widgets.push(await read('@' + ref.key));
  const publishedInventory = JSON.parse(fs.readFileSync(owner.inventoryProof.path, 'utf8'));
  if (hash(fs.readFileSync(owner.inventoryProof.path)) !== owner.inventoryProof.sha256) fail('publication_changed');
  const acquire = services.routes ?? (await import('./debug-o11-native-inventory.mjs')).acquireO11NativeInventory;
  const native = await acquire(owner.target, directory, { publishedInventory, screenRoutes: [screen.name, login.name] });
  guard();
  const contract = { schema: 'ssam-o11-traditional-source/1', sourceContract: owner.snapshot,
    binding: { lane: 'o11', ...owner.target, revision: owner.versionId, sourceSha256: owner.snapshot.sha256 },
    screen, preparation, login, loginAction, widgets, ...extra,
    routes: { source: native.screenRoutesSource, urls: native.screenRoutes, provenance: native.moduleIdentitySource } };
  return { contract };
}
