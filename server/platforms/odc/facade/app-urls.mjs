// URL construction is local metadata, never proof of deployment or a browser request.
export const appUrlGuide = 'Use ssam_app_url {app, screen?, lane?, environment? | tenant?} to obtain app/home and screen links. Return these links to the user after app/screen work. appLinks in results contain the same URLs. Without a screen, appUrl opens the configured home screen. URL construction does not verify publication or browser behavior.';

// Decorates other answers (appLinks, doctor, status): the tool only, never a CLI line.
export const appUrlCapability = Object.freeze({ tool: 'ssam_app_url',
  arguments: '{app, screen?, lane?: "o11" | "odc", environment?: "https://runtime-host", tenant?}',
  pattern: '{environment}/{app}/{screen}', home: '{environment}/{app}/', traditional: '{environment}/{app}/{screen}.aspx (O11 Traditional Web)' });

const LANES = ['o11', 'odc'];
// The module kind of an O11 capture that is a Traditional Web module (ModuleDigest kind: WebResponsive; AppFactory
// "Traditional Web App"): its screens are served as <Screen>.aspx.
const TRADITIONAL = /webresponsive|traditional/i;

function origin(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A runtime environment origin is required.');
  const text = value.trim();
  const url = new URL(text.includes('://') ? text : 'https://' + text);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('environment must be an HTTP(S) origin, without credentials, app path, query or fragment.');
  return url.origin;
}

function segment(value, name) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\\/\u0000-\u001f]/.test(value) || ['.', '..'].includes(value))
    throw new Error(name + ' must be one non-empty route name, without slashes or surrounding whitespace.');
  return encodeURIComponent(value);
}

// The Development origin the platform gives a tenant named <name>.outsystems.dev: https://<name>-dev.outsystems.app. Any
// other stage or host: null (it must be configured or passed).
export function derivedStageOrigin(tenant, stage = 'Development') {
  const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.outsystems\.dev$/i.exec(String(tenant ?? ''));
  return match && String(stage).toLowerCase() === 'development' ? 'https://' + match[1].toLowerCase() + '-dev.outsystems.app' : null;
}

// lane and traditional (goal list of 2026-10-20, item 3; reports 365814c3, 3cf11056): an O11 Traditional Web screen is
// <Screen>.aspx; a Reactive screen of either lane is <Screen>. Without lane the shape is the Reactive one.
export function applicationUrls({ app, screen, environment, host, stage = 'Development', lane = null, traditional = null }, config = { tenants: {} }) {
  const appSegment = segment(app, 'app');
  const screenSegment = screen == null ? null : segment(screen, 'screen');
  if (typeof stage !== 'string' || !stage.trim()) throw new Error('stage must be non-empty.');
  if (lane != null && !LANES.includes(lane)) throw new Error('lane must be o11 or odc.');
  const tenant = host ? new URL(origin(host)).host : null;
  const entry = tenant ? config.tenants?.[tenant] : null;
  const match = Object.entries(entry?.stages ?? {}).find(([key]) => key.toLowerCase() === stage.toLowerCase());
  const selected = match?.[1];
  // C04: an ODC tenant <name>.outsystems.dev without a configured Development stage runs its Development apps on
  // <name>-dev.outsystems.app (the platform's own naming); the link says it is derived, not configured.
  const derived = !environment && !selected?.origin && !selected?.domain ? derivedStageOrigin(tenant, match?.[0] ?? stage) : null;
  const runtime = environment ?? selected?.origin ?? selected?.domain ?? derived;
  if (!runtime) throw new Error('No runtime origin for ' + (tenant ?? 'this app') + ' / ' + stage + '. Pass environment (the runtime origin), or configure the exact stage domain.');
  const environmentOrigin = origin(runtime);
  const appUrl = environmentOrigin + '/' + appSegment + '/';
  const aspx = lane === 'o11' && traditional === true;
  const screenUrl = screenSegment == null ? null : appUrl + screenSegment + (aspx ? '.aspx' : '');
  return { ok: true, tenant, app, screen: screen ?? null, stage: match?.[0] ?? stage, ...(lane ? { lane } : {}),
    environment: environmentOrigin, url: screenUrl ?? appUrl, appUrl, homeUrl: appUrl, screenUrl,
    source: environment ? 'explicit-environment' : derived ? 'derived-stage' : selected?.source === 'derived' ? 'derived-stage' : 'configured-stage',
    publicationVerified: false, browserVerified: false,
    note: 'The app URL opens its configured home screen. These links do not prove deployment or browser behavior.'
      + (aspx ? ' An O11 Traditional Web screen is served as <Screen>.aspx.' : '') };
}

// Never fall back to a default tenant while decorating a response from another operation.
export function linksFor(context, config) {
  try {
    if (!context?.app || (!context.host && !context.environment)) return { available: false, ...appUrlCapability };
    return { available: true, ...applicationUrls(context, config) };
  } catch (error) { return { available: false, error: error.message, ...appUrlCapability }; }
}

// Only screens observed by the reader are advertised; blocks/actions are not routes.
export function screenNames(data) {
  const found = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const entry of node) visit(entry); return; }
    if (['MobileScreen', 'IMobileScreen', 'Screen', 'IScreen', 'WebScreen', 'IWebScreen'].includes(node.kind) && typeof node.name === 'string') found.add(node.name);
    for (const flow of node.flows ?? []) for (const name of flow.screens ?? []) if (typeof name === 'string') found.add(name);
    for (const key of ['tree', 'children', 'entries', 'data']) visit(node[key]);
  }
  visit(data);
  return [...found];
}

export function withAppLinks(value, context, config, reading) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const appLinks = linksFor(context, config);
  if (appLinks.available && reading) {
    const names = screenNames(reading);
    appLinks.screens = names.slice(0, 32).map(screen => ({ screen, url: applicationUrls({ ...context, screen }, config).screenUrl }));
    appLinks.screensOmitted = Math.max(0, names.length - 32);
  }
  return { ...value, appLinks };
}

export function parseAppArguments(args) {
  const values = {}, positional = [];
  const names = { '--environment': 'environment', '--tenant': 'host', '--stage': 'stage', '--screen': 'screen', '--pid': 'pid', '--lane': 'lane' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (names[arg]) {
      if (values[names[arg]] != null || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing or duplicate ' + arg);
      values[names[arg]] = args[++i];
    } else if (arg.startsWith('-')) throw new Error('Unknown app option: ' + arg);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2 || (positional[1] != null && values.screen != null))
    throw new Error('Usage: ssam app <App> [Screen] [--lane o11|odc] [--environment <origin>] [--tenant <host>] [--stage <stage>]');
  if (values.pid != null && (!/^\d+$/.test(values.pid) || Number(values.pid) < 1)) throw new Error('pid must be a positive integer.');
  if (values.lane != null && !LANES.includes(values.lane)) throw new Error('lane must be o11 or odc.');
  return { ...values, app: positional[0], screen: values.screen ?? positional[1] };
}

// deps: status(pid) the ODC Studio status ({modules:[{name, host, loggedIn}], sessions}); o11Status(pid) the Service Studio
// status ({openModules:[{name, environment}], environments}); o11ModuleKind(app, pid) the module kind of the O11 capture
// (WebResponsive = Traditional Web). Each Studio that does not answer is simply absent: never a refusal of the other lane.
//   lane given: that Studio only. lane absent: the Studio where the app is open; open in both, a refusal that names
//   both (never the ODC stage of an O11 task, report 3cf11056); open in neither, the signed-in ODC session (as before
//   the O11 lane), else the Service Studio.
// environment/tenant explicit: no Studio is read, except the O11 capture for the .aspx of a Traditional screen when
// lane is o11 (unknown kind: the Reactive shape, said in screenKind).
export async function resolveApplicationUrls(input, { config, status, o11Status = null, o11ModuleKind = null }) {
  segment(input.app, 'app');
  if (input.screen != null) segment(input.screen, 'screen');
  const lane = input.lane ?? null;
  if (lane != null && !LANES.includes(lane)) throw new Error('lane must be o11 or odc.');
  const screenKind = async chosen => {
    if (chosen !== 'o11' || input.screen == null) return {};
    if (typeof o11ModuleKind !== 'function') return { screenKind: 'unknown', note: 'the kind of the O11 module was not read; a Traditional Web screen ends in .aspx' };
    let kind = null;
    try { kind = await o11ModuleKind(input.app, input.pid); } catch { kind = null; }
    if (typeof kind !== 'string' || !kind) return { screenKind: 'unknown', note: 'the kind of the O11 module could not be read; a Traditional Web screen ends in .aspx' };
    return { moduleKind: kind, screenKind: TRADITIONAL.test(kind) ? 'traditional' : 'reactive' };
  };
  const build = async (chosen, fields, extra = {}) => {
    const kind = await screenKind(chosen);
    const urls = applicationUrls({ ...input, ...fields, lane: chosen, traditional: kind.screenKind === 'traditional' }, config);
    return { ...urls, ...(kind.note ? { note: urls.note + ' ' + kind.note } : {}), ...(kind.moduleKind ? { moduleKind: kind.moduleKind } : {}), ...(kind.screenKind ? { screenKind: kind.screenKind } : {}), ...extra };
  };
  if (input.host || input.environment) return lane ? build(lane, {}, { laneSelection: 'explicit' }) : applicationUrls(input, config);
  const probe = async fn => { if (typeof fn !== 'function') return null; try { const v = await fn(input.pid); return v?.ok === true ? v : null; } catch { return null; } };
  const [odc, o11] = await Promise.all([lane === 'o11' ? null : probe(status), lane === 'odc' ? null : probe(o11Status)]);
  const odcModules = (odc?.modules ?? []).filter(m => m?.name === input.app);
  const o11Modules = (o11?.openModules ?? []).filter(m => m?.name === input.app && typeof m.environment === 'string' && m.environment);
  const found = [...(odcModules.length ? ['odc'] : []), ...(o11Modules.length ? ['o11'] : [])];
  if (!lane && found.length > 1) throw new Error(input.app + ' is open in both Studios (ODC and O11). Pass lane: "o11" or "odc".');
  // Open in neither: the signed-in ODC session as before (the ODC answer of the base), else the one Service Studio.
  const chosen = lane ?? found[0] ?? (odc ? 'odc' : o11 ? 'o11' : null);
  if (!chosen) throw new Error('Cannot determine the connected environment: no Studio answered. Pass environment or tenant explicitly.');
  const laneSelection = lane ? 'explicit' : found.length ? 'connected-module' : 'connected-studio';
  if (chosen === 'o11') {
    if (!o11) throw new Error('Cannot determine the connected O11 environment: the Service Studio did not answer. Pass environment or tenant explicitly.');
    const hosts = [...new Set((o11Modules.length ? o11Modules.map(m => m.environment) : (o11.environments ?? []).filter(h => typeof h === 'string' && h)).map(h => h.toLowerCase()))];
    // Live on 20/10/2026 (meta item 3): the Service Studio listed nine open modules with environment null and no
    // environments at all; the lane is known, the host is not, and the answer says which.
    if (hosts.length !== 1) throw new Error(hosts.length
      ? 'The connected O11 environment is ambiguous (' + hosts.join(', ') + '). Pass environment or tenant explicitly.'
      : input.app + (o11Modules.length ? ' is open in the Service Studio, but the Studio reports no environment for it' : ' is not open in the Service Studio, and the Studio reports no environment')
        + ' (not signed in to an environment?). Pass environment (the runtime origin, e.g. https://<host>) or tenant explicitly.');
    const built = await build('o11', { host: hosts[0], environment: 'https://' + hosts[0] }, { environmentSelection: o11Modules.length ? 'connected-module' : 'connected-session', laneSelection });
    return { ...built, source: 'connected-environment' };
  }
  if (!odc) throw new Error('Cannot determine the connected environment. Pass environment or tenant explicitly.');
  const candidates = odcModules.length ? odcModules : (odc.sessions ?? []);
  const hosts = [...new Set(candidates.filter(s => s.loggedIn === true && s.host).map(s => s.host.toLowerCase()))];
  if (hosts.length !== 1 || (odcModules.length && odcModules.some(m => m.loggedIn !== true || !m.host)))
    throw new Error('The connected environment is missing or ambiguous. Pass environment or tenant explicitly; no default tenant was selected.');
  return { ...applicationUrls({ ...input, host: hosts[0], lane: 'odc' }, config), environmentSelection: odcModules.length ? 'connected-module' : 'connected-session', laneSelection };
}
