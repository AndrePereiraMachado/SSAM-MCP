// ssam_render (fase4-28 r2-preview, DESENHO-PREVIEW-UPLOAD 2.1, 2.5, 2.8, 2.9 and 4): see screens without publishing. The
// hosted server builds a design document of each screen from the capture it already has (the kernel verb render-document,
// ssam-render-document/1: the runtime DOM with data-ssam-key, the platform and theme sheets, no script, no network, no
// runtime data), checks it with the agent's own rules (render-contract.mjs) and asks the user's SSAM agent to render it in
// its sandbox (kind screen.render, an Electron worker). The agent answers geometry and style facts per @key and viewport,
// never text; the server checks them again, keeps them in ws:<lane>/render/<sha256>.json (ssam_evidence reads it), and
// answers the layout problems and the verdict on each static warning of the kernel (its probes) within the answer budget.
//   - Served only hosted, and LISTED only when the three conditions hold together (renderAvailability): the switch
//     SSAM_SCREEN_RENDER=1, the lane's kernel answering render-document, and the Hello of the account's agent listing
//     screen.render. Unavailable, it is never named in the listing, ssam_discover or ssam_reference (availability.mjs).
//   - A read: no Studio write queue, nothing changes on the user's machine (every refusal says executed:false), and it
//     never publishes: without the agent or the kind it refuses with the static warnings and the "publish and open" step.
//   - Deps (tests): kernelHas(lane) -> boolean, renderDocument({lane, file, screens, viewports, probes, outDir}) -> package,
//     capture(target, {lane}) -> {file}; the defaults run the lane's kernel (anvil-cli.mjs createAnvilRunner).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as z from 'zod/v4';
import { RENDER_KIND, RENDER_PROPERTIES, RenderError, validateRenderRequest, validateRenderFacts, documentKeys, safeKey, KEY_FORM } from './render-contract.mjs';
import { ANSWER_BUDGETS } from '../answer-size.mjs';
import { answerText } from './render-text.mjs';

export const RENDER_TOOL = 'ssam_render';
export const RENDER_SWITCH = 'SSAM_SCREEN_RENDER';
export const RENDER_DOCUMENT_SCHEMA = 'ssam-render-document/1';
export const RENDER_VIEWPORTS = Object.freeze({
  desktop: { width: 1366, height: 768, bodyClasses: ['desktop'] },
  tablet: { width: 768, height: 1024, bodyClasses: ['tablet', 'portrait'] },
  phone: { width: 375, height: 812, bodyClasses: ['phone', 'portrait'] } });
// The server waits the request's own time plus 15 s for transport and the worker's start (2.6).
export const RENDER_SLACK_MS = 15000;
export const RENDER_TIMEOUT_MS = 60000;
// With image:true the answer carries at most 3 images; the others stay in the facts file.
export const IMAGES_IN_ANSWER = 3;
const IMAGE = { format: 'jpeg', quality: 70, maxEdge: 1568, fullPage: false };
// The answer stays within the budget of its kind (answer-size.mjs, "other"), so it is never paged.
export const RENDER_ANSWER_BYTES = ANSWER_BUDGETS.other;

// ---- the listed tool (DESENHO 4.1, the measured text; candidateRef joins with the R2 integration)
export function renderToolConfig() {
  const viewport = z.enum(['desktop', 'tablet', 'phone']);
  return {
    title: 'Render screens on the user agent',
    description: 'Renders screens of a capture, open module or checked candidate in a sandbox on the SSAM agent of the user: no publish, no network, no app data. Returns layout problems per @key and viewport; facts via ssam_evidence. image:true adds a JPEG per screen and viewport.',
    inputSchema: z.object({
      lane: z.enum(['o11', 'odc']),
      target: z.string().min(1).max(500).optional(),
      screens: z.array(z.string().min(1).max(200)).min(1).max(8),
      viewports: z.array(viewport).max(3).optional(),
      keys: z.array(z.string().max(80)).max(200).optional(),
      properties: z.array(z.string().max(40)).max(16).optional(),
      image: z.boolean().optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

// ---- availability (4.2): the switch, the agent's Hello, the kernel; each reason in plain words.
const switchOn = env => env?.[RENDER_SWITCH] === '1';
const kernelProbes = new Map();
// The lane's kernel answers `render-document --capabilities` with {ok:true, data:{schema:"ssam-render-document/1"}} (the
// contract of piece C). Read once per process and lane: a kernel changes only with a new release, which restarts the server.
// The probe is a question to the kernel binary only (no customer data, no Studio, no hosted context): a plain process with the
// runtime's own variables. Only an answer of the process is kept; a start that failed (no dotnet yet) is asked again.
const PROBE_ENV = ['PATH', 'Path', 'SystemRoot', 'windir', 'DOTNET_ROOT', 'DOTNET_CLI_HOME', 'DOTNET_NOLOGO', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR',
  'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramData'];
function probeProcess(cli) {
  return new Promise((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => {
      const env = Object.fromEntries(PROBE_ENV.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
      execFile('dotnet', [cli, 'render-document', '--capabilities'], { env, windowsHide: true, timeout: 30000, maxBuffer: 1048576, encoding: 'utf8' }, (error, stdout) => {
        if (error && typeof error.code !== 'number') return reject(error);
        let envelope = null;
        try { envelope = JSON.parse(String(stdout ?? '').trim()); } catch { envelope = null; }
        resolve({ ok: !error && envelope?.ok === true, envelope });
      });
    }, reject);
  });
}
export function kernelRendersDocuments(lane, { runAnvil = null, cli = null } = {}) {
  const key = lane + '\u0000' + (cli ?? '');
  if (!kernelProbes.has(key)) {
    const probe = (async () => {
      const result = runAnvil ? await runAnvil(['render-document', '--capabilities'], { timeoutMs: 30000, ...(cli ? { cli } : {}) }) : await probeProcess(cli);
      // R3-A F6 (fase4-28/r3-runtime-dom 7cfb8fe9): the kernel says its key form; only the safe form matches this server's keys.
      return result.ok === true && result.envelope?.data?.schema === RENDER_DOCUMENT_SCHEMA && result.envelope.data.keyForm === KEY_FORM;
    })();
    kernelProbes.set(key, probe);
    probe.catch(() => kernelProbes.delete(key));
  }
  return kernelProbes.get(key).catch(() => false);
}
async function kernelCli(lane) {
  const { anvilRoot, o11Lane } = await import('../workspace.mjs');
  if (lane === 'odc') return path.join(anvilRoot, '.local', 'lane-odc', 'cli', 'anvil-odc.dll');
  const { o11LaneOf } = await import('../o11-lane.mjs');
  return o11LaneOf(o11Lane.lane, { root: anvilRoot }).cli;
}
const defaultKernelHas = async lane => kernelRendersDocuments(lane, { cli: await kernelCli(lane) });

const agentState = link => {
  let connected = false, kind = false;
  try { connected = link?.connected?.() === true; kind = connected && link?.supports?.(RENDER_KIND) === true; } catch { /* no agent */ }
  return { connected, kind };
};

// {available, code?, reason?, lanes}: lanes are the served lanes whose kernel renders. The kernel is probed only when the
// switch is on and the agent can render (an agent without the kind never costs a kernel start).
export async function renderAvailability({ env = process.env, link = null, lanes = ['o11', 'odc'], kernelHas = defaultKernelHas } = {}) {
  if (!switchOn(env)) return { available: false, code: 'RENDER_SWITCH_OFF', reason: 'screen rendering is off on this server (' + RENDER_SWITCH + ')', lanes: [] };
  const agent = agentState(link);
  if (!agent.connected) return { available: false, code: 'AGENT_NOT_CONNECTED', reason: 'the SSAM agent of this account is not connected', lanes: [] };
  if (!agent.kind) return { available: false, code: 'AGENT_KIND_MISSING', reason: 'update the SSAM Agent to render screens', lanes: [] };
  const served = [];
  for (const lane of lanes) if (await kernelHas(lane).catch(() => false)) served.push(lane);
  if (!served.length) return { available: false, code: 'RENDER_KERNEL_MISSING', reason: 'the kernel of this server has no render-document', lanes: [] };
  return { available: true, lanes: served };
}

// ---- the discover route (4.2): only in the answer, only while the tool is available.
const RENDER_INTENT = /\b(?:preview|render(?:ing)?|without publish(?:ing)?|before publish(?:ing)?|sem publicar|antes de publicar|ver a tela|veja a tela|see the screen|look at the screen|how (?:the|a) screen looks)\b/i;
export const rendersIntent = intent => typeof intent === 'string' && RENDER_INTENT.test(intent);
export function withRenderRoute(result, args = {}) {
  const value = result?.structuredContent;
  if (!value || typeof value !== 'object' || !rendersIntent(args.intent)) return result;
  const lane = args.lane === 'o11' ? 'o11' : 'odc';
  const route = { tool: RENDER_TOOL, arguments: { lane, target: typeof args.app === 'string' ? args.app : '<capture or open module>', screens: ['<Screen>'] },
    why: 'see the screens without publishing: the SSAM agent renders them in a sandbox and answers layout problems per @key and viewport' };
  const next = { ...value, tools: [route, ...(Array.isArray(value.tools) ? value.tools.filter(tool => tool?.tool !== RENDER_TOOL) : [])] };
  return { ...result, structuredContent: next, content: (result.content ?? []).map((item, i) => (i === 0 && item?.type === 'text' ? { ...item, text: JSON.stringify(next) } : item)) };
}

// ---- the package of the kernel -> the request of the agent
const unique = list => [...new Set(list)];
function requestOf(pkg, { viewports, keys, properties, image }) {
  if (!pkg || typeof pkg !== 'object' || pkg.schema !== RENDER_DOCUMENT_SCHEMA || !Array.isArray(pkg.documents))
    throw new RenderError('RENDER_DOCUMENT_REFUSED', 'The render package of the kernel is refused: it is not ' + RENDER_DOCUMENT_SCHEMA);
  const probes = Array.isArray(pkg.probes) ? pkg.probes : [];
  const probeProperties = probes.map(probe => probe?.property).filter(name => RENDER_PROPERTIES.includes(name));
  // Every key in the one form of the kernel (keyForm "safe", render-contract.mjs safeKey): the @key of ssam_map with + and / as
  // the renderer reads it.
  const asked = keys?.length ? unique([...keys.map(safeKey), ...probes.map(probe => safeKey(String(probe?.key ?? '')))].filter(Boolean)) : 'all';
  return {
    schema: 'ssam-render-request/1',
    styles: (pkg.styles ?? []).map(style => ({ id: style?.id, sha256: style?.sha256, css: style?.css })),
    documents: pkg.documents.map(document => ({ id: document?.id, sha256: document?.sha256, html: document?.html, styles: document?.styles ?? [] })),
    viewports: viewports.map(name => ({ name, width: RENDER_VIEWPORTS[name].width, height: RENDER_VIEWPORTS[name].height,
      bodyClasses: pkg.documents.find(document => Array.isArray(document?.bodyClasses?.[name]))?.bodyClasses[name] ?? RENDER_VIEWPORTS[name].bodyClasses })),
    probes: { keys: asked === 'all' ? 'all' : asked.slice(0, 400), properties: unique([...(properties ?? []), ...probeProperties, 'white-space']).slice(0, 24), maxElements: 1500 },
    image: image ? { ...IMAGE } : null,
    timeoutMs: RENDER_TIMEOUT_MS,
  };
}

// ---- problems and verdicts (2.5, 2.9). Review round 3 (fase4-28 r2-preview): the answer carries no free text of the agent
// or the kernel. Every word it shows is the server's own or a token of the documents the server sent (docs): an @key the
// documents carry, a tag or class written in them, a font family named in them, a CSS value of a closed grammar or written
// in them; anything else is shown as a placeholder. The facts file keeps what was measured.
const CSS_KEYWORDS = new Set(['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces', 'auto', 'none', 'block', 'inline', 'inline-block', 'flex',
  'inline-flex', 'grid', 'inline-grid', 'contents', 'hidden', 'visible', 'scroll', 'clip', 'ellipsis', 'absolute', 'relative', 'fixed', 'sticky', 'static',
  'center', 'start', 'end', 'left', 'right', 'flex-start', 'flex-end', 'space-between', 'space-around', 'space-evenly', 'stretch', 'baseline', 'row',
  'row-reverse', 'column', 'column-reverse', 'wrap', 'wrap-reverse', 'border-box', 'content-box', 'transparent', 'collapse', 'inherit', 'initial']);
const CSS_NUMBERS = /^(?:[-+]?\d+(?:\.\d+)?(?:px|em|rem|vh|vw|pt|%|fr)?|rgba?\(\s*[\d.]+(?:\s*,\s*[\d.]+){2,3}\s*\)|#[0-9a-fA-F]{3,8})(?:\s+(?:[-+]?\d+(?:\.\d+)?(?:px|em|rem|vh|vw|pt|%|fr)?))*$/;
const PROBE_KEY = /^@?[A-Za-z0-9_-]{1,80}$/;
const WARNING = /^[A-Z][A-Z0-9_]{1,63}$/;
// The server's view of what it sent, as CLOSED SETS of tokens that cannot carry free text (review rounds 4 and 5):
//   - keys: the data-ssam-key of the documents;  tags: the tag names of their opening tags;
//   - classes: the class names of the selectors of the request's style sheets (request.styles);
//   - fonts: the unquoted family names of font-family / font declarations (@font-face included) of those sheets, matching
//     ^[A-Za-z][A-Za-z0-9 _-]{0,63}$;
//   - values: the values of declarations of those sheets whose property is in RENDER_PROPERTIES, made only of identifiers,
//     numbers with units and colors (no quote, url(, attr(, counter(, backslash; never content, quotes or a --custom one).
// Nothing comes from a style="" attribute, a <style> of the documents, a class="" attribute or the text of the screen.
// A value of the agent is shown only when it EQUALS one element of its set.
const cssWithoutComments = css => String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ');
const FONT_NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/;
const VALUE_TOKEN = /^(?:-?[A-Za-z][\w-]*|[-+]?\d+(?:\.\d+)?(?:px|em|rem|vh|vw|pt|%|fr|s|ms|deg)?|#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\(\s*[\d.%]+(?:\s*,\s*[\d.%]+){2,3}\s*\))$/;
const typedValue = value => !/["'\\]|url\(|attr\(|counter/i.test(value)
  && value.split(/\s*,\s*|\s+(?![^(]*\))/).every(token => VALUE_TOKEN.test(token));
function readSheet(css, sets) {
  let text = cssWithoutComments(css);
  for (const block of text.matchAll(/\{([^{}]*)\}/g)) readDeclarations(block[1], sets);
  // The innermost blocks are dropped one level at a time; the selectors left at each level (rules inside @media included)
  // give the class names.
  for (let i = 0; i < 8 && /\{[^{}]*\}/.test(text); i++) {
    text = text.replace(/\{[^{}]*\}/g, ';');
    for (const m of text.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) sets.classes.add(m[1]);
  }
}
function readDeclarations(body, sets) {
  for (const declaration of String(body).split(';')) {
    const at = declaration.indexOf(':');
    if (at < 0) continue;
    const property = declaration.slice(0, at).trim().toLowerCase();
    const value = declaration.slice(at + 1).replace(/!important\s*$/i, '').trim();
    if (!value || property.startsWith('--') || !/^[a-z][a-z0-9-]*$/.test(property)) continue;
    if (property === 'font-family' || property === 'font') {
      for (const family of value.split(',')) { const name = family.trim(); if (FONT_NAME.test(name)) sets.fonts.add(name); }
    }
    if (RENDER_PROPERTIES.includes(property) && typedValue(value)) sets.values.add(value);
  }
}
export function documentsView(request) {
  const keys = new Set(request.documents.flatMap(document => [...documentKeys(document.html)]));
  const sets = { tags: new Set(), classes: new Set(), fonts: new Set(), values: new Set() };
  for (const style of request.styles) readSheet(style.css, sets);
  for (const document of request.documents)
    for (const m of String(document.html ?? '').matchAll(/<([a-zA-Z][a-zA-Z0-9-]{0,40})[\s/>]/g)) sets.tags.add(m[1].toLowerCase());
  const member = set => token => typeof token === 'string' && set.has(token);
  return { keys, tag: member(sets.tags), cls: member(sets.classes), font: member(sets.fonts), value: member(sets.values) };
}
const OPEN_VIEW = { keys: { has: () => true }, tag: () => true, cls: () => true, font: () => true, value: () => true };
const shownValue = (value, docs) => {
  const v = typeof value === 'string' ? value.trim() : '';
  return v && (CSS_KEYWORDS.has(v) || CSS_NUMBERS.test(v) || docs.value(v)) ? v.slice(0, 120) : '<value>';
};
const whoOf = (other, docs = OPEN_VIEW) => {
  if (!other) return null;
  if (other.k && docs.keys.has(other.k)) return '@' + other.k;
  const tag = docs.tag(other.tag) ? other.tag : 'element';
  const classes = (other.classes ?? []).filter(name => docs.cls(name));
  return tag + (classes.length ? '.' + classes.join('.') : '');
};
export function problemsOf(facts, screenOf, docs = OPEN_VIEW) {
  const problems = [];
  for (const document of facts.documents) for (const view of document.viewports) {
    const at = { screen: screenOf(document.id), viewport: view.name };
    if (view.page.overflowX) problems.push({ code: 'RENDER_PAGE_OVERFLOW_X', ...at, key: null, detail: 'the page is ' + view.page.scrollWidth + ' px wide in a ' + view.width + ' px viewport' });
    if (view.fonts.missing.length) {
      const named = view.fonts.missing.filter(name => docs.font(name)).slice(0, 5);
      problems.push({ code: 'RENDER_FONT_MISSING', ...at, key: null, detail: view.fonts.missing.length + ' font famil' + (view.fonts.missing.length === 1 ? 'y' : 'ies') + ' not loaded'
        + (named.length ? ': ' + named.join(', ') : '') + ' (line breaks may differ)' });
    }
    for (const element of view.elements) {
      const key = '@' + element.k;
      if (element.visible && element.coveredBy) problems.push({ code: 'RENDER_COVERED', ...at, key, by: whoOf(element.coveredBy, docs), detail: 'covered at its center' });
      if (element.visible && element.clippedBy) problems.push({ code: 'RENDER_CLIPPED', ...at, key, by: whoOf(element.clippedBy, docs), detail: 'cut by an ancestor with overflow' });
      if (element.visible && (element.box[2] <= 0 || element.box[3] <= 0)) problems.push({ code: 'RENDER_ZERO_SIZE', ...at, key, detail: 'rendered ' + element.box[2] + 'x' + element.box[3] + ' px' });
      if (element.lines > 1 && element.textLength > 0 && element.textLength <= 40) problems.push({ code: 'RENDER_TEXT_WRAPPED', ...at, key, detail: element.textLength + ' characters on ' + element.lines + ' lines' });
    }
  }
  return problems;
}
// The kernel's probes as the answer may show them: a valid @key, a viewport of the server, a property of the closed list
// (or coveredBy), a warning code; its expect and its patch stay in the facts file (hasPatch says there is one).
export function typedProbes(probes) {
  return (Array.isArray(probes) ? probes : []).filter(probe => typeof probe?.key === 'string' && PROBE_KEY.test(safeKey(probe.key))
    && (probe.property === 'coveredBy' || RENDER_PROPERTIES.includes(probe.property)));
}
const probeBase = probe => ({ key: '@' + safeKey(probe.key), viewport: Object.hasOwn(RENDER_VIEWPORTS, probe.viewport) ? probe.viewport : null,
  property: probe.property, warning: typeof probe.warning === 'string' && WARNING.test(probe.warning) ? probe.warning : null,
  ...(probe.patch !== undefined && probe.patch !== null ? { hasPatch: true } : {}) });
const VERDICT_ORDER = { confirmed: 0, 'not-observed': 1, 'not-rendered': 2 };
export function verdictsOf(facts, probes, screenOf, docs = OPEN_VIEW) {
  const out = [];
  for (const probe of typedProbes(probes)) {
    const key = safeKey(probe.key);
    const found = [];
    for (const document of facts.documents) for (const view of document.viewports)
      if (!probe.viewport || view.name === probe.viewport) for (const element of view.elements) if (element.k === key) found.push({ document, view, element });
    const base = probeBase(probe);
    const visible = found.filter(f => f.element.visible);
    if (!visible.length) { out.push({ verdict: 'not-rendered', ...base }); continue; }
    const hit = visible.find(({ element }) => {
      const computed = element.styles?.[probe.property];
      if (probe.property === 'coveredBy') return Boolean(element.coveredBy);
      if (probe.property === 'white-space') return element.lines > 1 && /^pre/.test(String(computed ?? ''));
      // R3-A F5: expect (the value the author meant) and expectNot (the platform's value that must not show), both in the
      // form getComputedStyle answers; either one observed confirms the warning.
      if (computed === undefined) return false;
      return (probe.expect !== undefined && probe.expect !== null && String(computed) !== String(probe.expect))
        || (probe.expectNot !== undefined && probe.expectNot !== null && String(computed) === String(probe.expectNot));
    });
    out.push(hit ? { verdict: 'confirmed', ...base, screen: screenOf(hit.document.id),
      observed: probe.property === 'coveredBy' ? whoOf(hit.element.coveredBy, docs) : shownValue(hit.element.styles?.[probe.property], docs) }
      : { verdict: 'not-observed', ...base });
  }
  return out.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]);
}
// The static warnings a refusal shows (the typed fields of the probes only).
const staticWarnings = probes => typedProbes(probes).slice(0, 20).map(probeBase);

// The answer within its budget: problems and verdicts are cut from the end (the confirmed come first) and counted.
function fitted(value) {
  const size = v => Buffer.byteLength(JSON.stringify(v));
  const out = { ...value, problems: [...value.problems], verifier: [...value.verifier] };
  while (size(out) > RENDER_ANSWER_BYTES && (out.problems.length || out.verifier.length)) {
    if (out.verifier.length > out.problems.length || (out.verifier.length && out.verifier.at(-1).verdict !== 'confirmed')) out.verifier.pop(); else out.problems.pop();
  }
  if (out.problems.length < value.problems.length) out.problemsShown = out.problems.length;
  if (out.verifier.length < value.verifier.length) out.verifierShown = out.verifier.length;
  return out;
}

// Review round 3 (fase4-28 r2-preview): a refusal is a fixed English sentence chosen by its code, with a closed set of
// typed fields, built only from this server's strings. The words of the agent, the kernel or a capture never reach the
// answer: when there are some, they go scrubbed (render-text.mjs answerText) to the account's own evidence,
// ws:<lane>/render/errors/<sha256>.json, which the answer names as `diagnosis` (ssam_evidence reads it).
const refusal = (code, error, extra = {}) => ({ ok: false, code, error, executed: false, ...extra });
const publishAndOpen = (lane, app, screen) => ({ tool: 'ssam_app_url', arguments: { app: app ?? '<app>', ...(screen ? { screen } : {}), lane },
  why: 'without a render, publish the change once and open the screen at this URL' });
const NOTHING_RAN = ' Nothing changed on the user\'s machine.';
export const AGENT_SENTENCES = Object.freeze({
  AGENT_TIMEOUT: 'The SSAM agent did not answer the render before the deadline.',
  RENDER_BUSY: 'The SSAM agent is already rendering and has two renders waiting.',
  RENDER_TIMEOUT: 'The render did not finish in time on the SSAM agent; its worker was stopped.',
  RENDER_FAILED: 'The render worker of the SSAM agent failed.',
  RENDER_UNAVAILABLE: 'The SSAM agent of this account cannot render screens: update the SSAM Agent to render screens.',
  RENDER_REQUEST_INVALID: 'The SSAM agent refused the render request.',
  RENDER_DOCUMENT_REFUSED: 'The SSAM agent refused a render document.',
  VALUE_TOO_LARGE: 'The render facts of the SSAM agent were larger than this server accepts.',
  AGENT_NOT_CONNECTED: 'The SSAM agent of this account is not connected.',
  AGENT_RECONNECTING: 'The SSAM agent of this account is reconnecting by itself.',
  AGENT_DISCONNECTED: 'The SSAM agent of this account disconnected during the render.',
  AGENT_BUSY: 'The SSAM agent of this account has too many calls pending.',
  KIND_NOT_ALLOWED: 'The SSAM agent of this account does not render screens.',
  BLOB_TRANSFER_FAILED: 'The render facts of the SSAM agent did not arrive whole.',
  AGENT_ERROR: 'The SSAM agent did not render the screens.' });
const CAPTURE_CODES = new Set(['STUDIO_NOT_CONNECTED', 'STUDIO_NOT_INSTALLED', 'MODULE_NOT_OPEN', 'MODULE_NOT_FOUND', 'SNAPSHOT_FAILED',
  'AGENT_NOT_CONNECTED', 'AGENT_RECONNECTING', 'BRIDGE_NOT_ATTACHED', 'O11_NOT_CONNECTED', 'SYSTEM_MODULE_NOT_OPENABLE']);
// The account's private evidence of a refusal: the source, the code and the scrubbed words, never in the answer.
function diagnosis(context, lane, source, code, words, more = {}) {
  const text = answerText(words, 2000);
  if (!text && !Object.keys(more).length) return {};
  try {
    const body = JSON.stringify({ schema: 'ssam-render-diagnosis/1', at: new Date().toISOString(), source, code, ...(text ? { text } : {}), ...more });
    const sha256 = createHash('sha256').update(body).digest('hex');
    const dir = path.join(context.workspace, lane, 'render', 'errors');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, sha256 + '.json');
    fs.writeFileSync(file, body);
    return { diagnosis: { file, read: { tool: 'ssam_evidence', arguments: { file } } } };
  } catch { return {}; }
}
const exitCodeOf = value => (Number.isSafeInteger(value) ? value : null);

// The default kernel run: render-document over the capture, the package read from --out.
// runAnvil (tests): the runner of anvil-cli.mjs createAnvilRunner. A refusal of the kernel is a fixed sentence with its exit
// code; its words (envelope.error) go to the diagnosis evidence only, and stderr never.
export async function kernelRenderDocument({ lane, file, screens, viewports, probes, outDir }, { runAnvil = null } = {}) {
  const cli = await kernelCli(lane);
  const run = runAnvil ?? (await import('../anvil-cli.mjs')).createAnvilRunner({});
  const args = ['render-document', '--lane', lane, '--oml', file, ...screens.flatMap(screen => ['--screen', screen]), '--viewports', viewports.join(','),
    ...(probes ? ['--probes', JSON.stringify(probes)] : []), '--out', outDir];
  const result = await run(args, { timeoutMs: 180000, ...(cli ? { cli } : {}) });
  if (!result.ok) throw Object.assign(new RenderError('RENDER_KERNEL_FAILED', 'The kernel did not build the render documents.'),
    { exitCode: exitCodeOf(result.exitCode), words: typeof result.envelope?.error === 'string' ? result.envelope.error : '' });
  return JSON.parse(fs.readFileSync(path.join(outDir, 'render-document.json'), 'utf8'));
}

// The tool. input: the arguments the gate resolved (target a workspace path or a module name). context: the hosted
// context ({workspace, agent}); link: the account's AgentLink.
export async function renderScreens(input, { context, link = context?.agent, env = process.env, deps = {} } = {}) {
  const lane = input.lane === 'odc' ? 'odc' : 'o11';
  const viewports = unique(input.viewports?.length ? input.viewports : Object.keys(RENDER_VIEWPORTS));
  const badProperty = (input.properties ?? []).find(name => !RENDER_PROPERTIES.includes(name));
  // Every argument the kernel or the agent would refuse for its shape is refused here first, with the exact rule.
  // A key is an @key of ssam_map (base64: + / and = padding included) or its safe form; the kernel's rule must keep something.
  const badKey = (input.keys ?? []).find(key => typeof key !== 'string' || !/^@?[A-Za-z0-9+\/=_-]{1,120}$/.test(key) || !safeKey(key));
  if (badKey !== undefined) return refusal('BAD_ARGS', 'keys takes @keys matching ^@?[A-Za-z0-9+/=_-]{1,120}$; not ' + JSON.stringify(badKey).slice(0, 60) + '.');
  if (badProperty) return refusal('BAD_ARGS', 'properties takes names of the computed styles the render reads; not ' + JSON.stringify(badProperty).slice(0, 60) + '.',
    { allowed: RENDER_PROPERTIES });
  if (typeof input.target !== 'string' || !input.target) return refusal('BAD_ARGS', 'target is the capture (ws:<lane>/...oml) or the module open in the Studio of the lane.',
    { continuation: { tool: 'ssam_map', arguments: { lane, target: '<module>' }, why: 'captures the open module; its file is the target' } });
  if (!switchOn(env)) return refusal('RENDER_UNAVAILABLE', 'Screen rendering is off on this server; nothing ran.', { continuation: publishAndOpen(lane, input.target, input.screens[0]) });
  const kernelHas = deps.kernelHas ?? defaultKernelHas;
  if (!(await kernelHas(lane).catch(() => false))) return refusal('RENDER_KERNEL_MISSING', 'The ' + lane + ' kernel of this server has no render-document; nothing ran.',
    { continuation: publishAndOpen(lane, input.target, input.screens[0]) });

  // The capture: a workspace .oml as it is (the gate resolved it), a module name captured through the agent (as ssam_map).
  let file = input.target, module = null;
  if (!/\.oml$/i.test(file)) {
    module = input.target;
    const captured = deps.capture ? await deps.capture(input.target, { lane })
      : await (await import('../module-map.mjs')).captureModuleTarget(input.target, { lane }, deps.captureDeps ?? {});
    if (!captured?.ok || !captured.file) {
      // Only a code of the closed set passes; every text of the capture's refusal goes to the diagnosis evidence.
      const raw = captured?.refusal && typeof captured.refusal === 'object' ? captured.refusal : {};
      const code = CAPTURE_CODES.has(raw.code) ? raw.code : 'CAPTURE_FAILED';
      const words = Object.entries(raw).filter(([key, item]) => key !== 'code' && typeof item === 'string').map(([key, item]) => key + ': ' + item).join(' | ');
      return refusal(code, 'The module could not be captured through the SSAM agent; nothing was rendered.', { lane, target: input.target,
        ...diagnosis(context, lane, 'capture', code, words),
        continuation: { tool: 'ssam_map', arguments: { lane, target: input.target }, why: 'captures the open module and says why it cannot when it cannot' } });
    }
    file = captured.file;
  }
  if (!fs.existsSync(file)) return refusal('CAPTURE_NOT_FOUND', 'The capture is not in the workspace.', { target: input.target });
  module ??= path.basename(file).replace(/\.oml$/i, '');

  const work = path.join(context.workspace, lane, 'render', 'work-' + randomBytes(8).toString('hex'));
  let pkg;
  try {
    fs.mkdirSync(work, { recursive: true });
    pkg = await (deps.renderDocument ?? (request => kernelRenderDocument(request, { runAnvil: deps.runAnvil ?? null })))({ lane, file, screens: input.screens, viewports,
      probes: input.keys?.length ? { keys: input.keys } : null, outDir: work });
  } catch (error) {
    // A refusal of the kernel run, or an exception reading its package: one fixed sentence, the exit code, the stage.
    const kernelRun = error instanceof RenderError && error.code === 'RENDER_KERNEL_FAILED';
    return refusal('RENDER_KERNEL_FAILED', 'The kernel did not build the render documents.', { stage: kernelRun ? 'render-document' : 'read-package',
      ...(kernelRun && error.exitCode !== null && error.exitCode !== undefined ? { exitCode: error.exitCode } : {}),
      ...diagnosis(context, lane, 'kernel', 'RENDER_KERNEL_FAILED', kernelRun ? error.words : error?.message ?? String(error)),
      continuation: publishAndOpen(lane, module, input.screens[0]) });
  } finally { fs.rmSync(work, { recursive: true, force: true }); }

  let request;
  try { request = validateRenderRequest(requestOf(pkg, { viewports, keys: input.keys, properties: input.properties, image: input.image === true })); }
  catch (error) {
    if (!(error instanceof RenderError)) throw error;
    return refusal(error.code, error.message, { sent: false, continuation: publishAndOpen(lane, module, input.screens[0]) });
  }
  // The screens are named as the call named them; versions only as version numbers (the kernel's words never pass).
  const screenOf = id => { const screen = pkg.documents.find(document => document.id === id)?.screen; return input.screens.includes(screen) ? screen : id; };
  const version = value => (typeof value === 'string' && /^\d{1,4}(?:\.\d{1,6}){0,3}$/.test(value) ? value : null);
  const platform = { sheets: ['present', 'partial'].includes(pkg.platform?.sheets) ? pkg.platform.sheets : 'missing', ...(version(pkg.platform?.osui) ? { osui: pkg.platform.osui } : {}),
    ...(version(pkg.platform?.runtime) ? { runtime: pkg.platform.runtime } : {}) };

  // The agent: connected and listing the kind in its Hello, else the static warnings and the publish-and-open step.
  const agent = agentState(link);
  if (!agent.connected || !agent.kind) {
    return refusal(agent.connected ? 'AGENT_KIND_MISSING' : 'AGENT_NOT_CONNECTED',
      agent.connected ? 'The SSAM agent of this account cannot render screens: update the SSAM Agent to render screens. Nothing ran on the user\'s machine.'
        : 'The SSAM agent of this account is not connected, so nothing ran on the user\'s machine.',
      { sent: false, staticWarnings: staticWarnings(pkg.probes), continuation: publishAndOpen(lane, module, input.screens[0]) });
  }
  let value;
  try { value = await link.call(RENDER_KIND, request, { timeoutMs: request.timeoutMs + RENDER_SLACK_MS }); }
  catch (error) {
    const code = typeof error?.code === 'string' && Object.hasOwn(AGENT_SENTENCES, error.code) ? error.code : 'AGENT_ERROR';
    const retry = { tool: RENDER_TOOL, arguments: { lane, target: input.target, screens: input.screens, ...(input.viewports ? { viewports: input.viewports } : {}),
      ...(input.keys ? { keys: input.keys } : {}), ...(input.properties ? { properties: input.properties } : {}), ...(input.image !== undefined ? { image: input.image } : {}) },
      why: 'the render did not finish; repeat it once with fewer screens or viewports, else publish and open (ssam_app_url)' };
    const executed = error?.executed === null ? null : false;
    return refusal(code, AGENT_SENTENCES[code] + (executed === false ? NOTHING_RAN : ''),
      { executed, ...(Number.isSafeInteger(error?.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        ...diagnosis(context, lane, 'agent', code, error?.message ?? '', { agentCode: typeof error?.code === 'string' ? error.code.slice(0, 64) : null }), staticWarnings: staticWarnings(pkg.probes), continuation: code === 'AGENT_TIMEOUT' || code === 'RENDER_BUSY' ? retry : publishAndOpen(lane, module, input.screens[0]) });
  }
  let facts;
  try { facts = validateRenderFacts(value, request); }
  catch (error) {
    if (!(error instanceof RenderError)) throw error;
    return refusal('AGENT_PROTOCOL_VIOLATION', error.message, { continuation: publishAndOpen(lane, module, input.screens[0]) });
  }

  // The facts file: what the agent measured, checked, with the screens, the kernel's probes and the platform.
  const kept = { schema: 'ssam-render-evidence/1', lane, module, sourceSha256: typeof pkg.sourceSha256 === 'string' ? pkg.sourceSha256 : null, platform,
    screens: pkg.documents.map(document => ({ id: document.id, screen: document.screen ?? document.id, key: document.key ?? null,
      sampleData: document.sampleData ?? null, unexpanded: Array.isArray(document.unexpanded) ? document.unexpanded.slice(0, 50) : [] })),
    viewports: request.viewports, probes: Array.isArray(pkg.probes) ? pkg.probes : [], facts };
  const text = JSON.stringify(kept);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const dir = path.join(context.workspace, lane, 'render');
  fs.mkdirSync(dir, { recursive: true });
  const factsFile = path.join(dir, sha256 + '.json');
  fs.writeFileSync(factsFile, text);

  const docs = documentsView(request);
  const problems = problemsOf(facts, screenOf, docs);
  const verifier = verdictsOf(facts, pkg.probes, screenOf, docs);
  const images = facts.images.slice(0, input.image === true ? IMAGES_IN_ANSWER : 0);
  const answer = fitted({ ok: true, lane, module,
    rendered: { screens: pkg.documents.map(document => screenOf(document.id)), viewports, ms: facts.documents.reduce((sum, d) => sum + d.viewports.reduce((s, v) => s + v.ms, 0), 0),
      engine: { name: facts.engine.name === 'electron' ? 'electron' : 'other', version: version(facts.engine.version) }, platform },
    ...(platform.sheets !== 'present' ? { warning: 'The platform style sheets are ' + platform.sheets + ' on this server: the result does not hold for the platform cascade.' } : {}),
    problemsTotal: problems.length, problems,
    verdicts: { confirmed: verifier.filter(v => v.verdict === 'confirmed').length, notObserved: verifier.filter(v => v.verdict === 'not-observed').length,
      notRendered: verifier.filter(v => v.verdict === 'not-rendered').length },
    verifier,
    ...(input.image === true ? { images: { shown: images.length, total: facts.images.length, omitted: facts.imagesOmitted?.length ?? 0 } } : {}),
    facts: { file: factsFile, sha256 },
    continuation: { tool: 'ssam_evidence', arguments: { file: factsFile }, why: 'every measured element: box, visibility, who covers or clips it, lines and the asked styles' } });
  return { answer, images: images.map(image => ({ type: 'image', mimeType: 'image/jpeg', data: image.base64 })) };
}

// The MCP handler: the answer as text and structured content, the images after it.
export function renderHandler({ context, link, env = process.env, deps = {} }) {
  return async input => {
    const out = await renderScreens(input, { context, link, env, deps });
    const value = out.answer ?? out;
    return { content: [{ type: 'text', text: JSON.stringify(value) }, ...(out.images ?? [])], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) };
  };
}
