// URL construction is local metadata, never proof of deployment or a browser request.
export const appUrlGuide = 'Use ssam_app_url {app, screen?, environment? | tenant?} to obtain app/home and screen links. Return these links to the user after app/screen work. appLinks in results contain the same URLs. Without a screen, appUrl opens the configured home screen. URL construction does not verify publication or browser behavior.';

// Decorates other answers (appLinks, doctor, status): the tool only, never a CLI line.
export const appUrlCapability = Object.freeze({ tool: 'ssam_app_url',
  arguments: '{app, screen?, environment?: "https://runtime-host", tenant?}',
  pattern: '{environment}/{app}/{screen}', home: '{environment}/{app}/' });

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

export function applicationUrls({ app, screen, environment, host, stage = 'Development' }, config = { tenants: {} }) {
  const appSegment = segment(app, 'app');
  const screenSegment = screen == null ? null : segment(screen, 'screen');
  if (typeof stage !== 'string' || !stage.trim()) throw new Error('stage must be non-empty.');
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
  const screenUrl = screenSegment == null ? null : appUrl + screenSegment;
  return { ok: true, tenant, app, screen: screen ?? null, stage: match?.[0] ?? stage,
    environment: environmentOrigin, url: screenUrl ?? appUrl, appUrl, homeUrl: appUrl, screenUrl,
    source: environment ? 'explicit-environment' : derived ? 'derived-stage' : selected?.source === 'derived' ? 'derived-stage' : 'configured-stage',
    publicationVerified: false, browserVerified: false,
    note: 'The app URL opens its configured home screen. These links do not prove deployment or browser behavior.' };
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
  const names = { '--environment': 'environment', '--tenant': 'host', '--stage': 'stage', '--screen': 'screen', '--pid': 'pid' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (names[arg]) {
      if (values[names[arg]] != null || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing or duplicate ' + arg);
      values[names[arg]] = args[++i];
    } else if (arg.startsWith('-')) throw new Error('Unknown app option: ' + arg);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2 || (positional[1] != null && values.screen != null))
    throw new Error('Usage: ssam app <App> [Screen] --lane odc [--environment <origin>] [--tenant <host>] [--stage <stage>]');
  if (values.pid != null && (!/^\d+$/.test(values.pid) || Number(values.pid) < 1)) throw new Error('pid must be a positive integer.');
  return { ...values, app: positional[0], screen: values.screen ?? positional[1] };
}

export async function resolveApplicationUrls(input, { config, status }) {
  segment(input.app, 'app');
  if (input.screen != null) segment(input.screen, 'screen');
  if (input.host || input.environment) return applicationUrls(input, config);
  const live = await status(input.pid);
  if (live?.ok !== true) throw new Error('Cannot determine the connected environment. Pass environment or tenant explicitly.');
  const matches = (live.modules ?? []).filter(m => m.name === input.app);
  const candidates = matches.length ? matches : (live.sessions ?? []);
  const hosts = [...new Set(candidates.filter(s => s.loggedIn === true && s.host).map(s => s.host.toLowerCase()))];
  if (hosts.length !== 1 || (matches.length && matches.some(m => m.loggedIn !== true || !m.host)))
    throw new Error('The connected environment is missing or ambiguous. Pass environment or tenant explicitly; no default tenant was selected.');
  return { ...applicationUrls({ ...input, host: hosts[0] }, config), environmentSelection: matches.length ? 'connected-module' : 'connected-session' };
}
