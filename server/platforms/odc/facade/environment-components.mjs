// What this environment offers for what the platform does not do by itself (PDF, Excel, e-mail, files, images, ZIP, QR
// codes, hashes...): the installed extensions and Forge components a module can reference, each with its public actions
// and their signatures, in ONE answer, cached per environment.
//
// The owner's re-test of 2026-10-12 (Codex, "crie as actions", a PDF of the monthly report): about 3 minutes of the 6 min 28 s
// went to finding what the environment has for a PDF: o11_dependencies producers (85 KB, paged into .local/answers and read
// in 5 ssam_evidence calls), list x3 (ForgePdfEngine, HtmlRenderer, a client PDF extension), inspect, o11_extension read
// (BinaryData), capture. This answer is those ten calls in one: the producers whose name or public actions say the need,
// each with its actions as one signature line, the reference op that binds them in a job and how a flow text calls them.
//
// Sources (deps, live through the Studio on the O11 lane; tests pass fakes): listProducers() the referenceable producers
// (dependencies producers: Name, Kind, Key, SignatureHash, IsSystem), listElements(name, kind) the public elements of one
// (dependencies list), readExtension(name) the XIF spec of an extension (o11_extension read: actions with inputs and
// outputs), producerDigest(name) the module digest of a published eSpace (ssam-digest/1: each action's signature).
// Cache: <root>/.local/components/<host>.json: the producer listing of the environment and the actions of each producer read
// so far, by name and signatureHash (a producer published again has another hash and is read again). Nothing else is kept.
// The answer is a function of the cache and the need: the same cache, the same bytes (the packet's rule).
import fs from 'node:fs';
import path from 'node:path';
import { normalize } from './catalog.mjs';
import { hostedContext } from './executor.mjs';

export const COMPONENTS_SCHEMA = 'ssam-components/1';
export const COMPONENTS_CACHE_SCHEMA = 'ssam-components-cache/1';
// servidor/fase4-25 (D4 of C:\t\vps-a5\PLANO.md, 3.2-C): the answer of the environment components on a hosted server.
export const hostedComponentsUnavailable = (needs = []) => ({ ok: false, code: 'HOSTED_UNAVAILABLE', cause: 'COMPONENTS_HOSTED_PENDING', schema: COMPONENTS_SCHEMA,
  needs: Array.isArray(needs) ? needs : [], error: 'The installed extensions and Forge components of the environment are not listed on a hosted SSAM server yet; nothing was read.',
  continuation: { tool: 'o11_dependencies', arguments: { action: 'producers' }, why: 'Lists the producers the module can reference, through the user\'s own Service Studio.' } });

// The needs, by the words that name them (accent-free) and the pattern a producer or action name shows. `platform`: what
// the platform itself has for it (a node or a system extension), said once.
export const NEEDS = [
  { id: 'pdf', words: ['pdf', 'pdfs'], name: /pdf|html ?to ?(pdf|image)|wkhtml|print/i },
  { id: 'excel', words: ['excel', 'xlsx', 'xls', 'planilha', 'planilhas', 'spreadsheet', 'spreadsheets', 'csv'], name: /excel|xlsx|\bxls|csv|spreadsheet|planilha/i,
    platform: 'O11 has the built-in server nodes Record List To Excel and Excel To Record List (one sheet, a record list).' },
  { id: 'email', words: ['email', 'emails', 'e-mail', 'smtp', 'mail'], name: /e-?mail|smtp|\bmail/i,
    platform: 'O11 sends an Email (a screen of the Emails flow) with the built-in Send Email node; attachments as Binary Data.' },
  { id: 'file', words: ['arquivo', 'arquivos', 'file', 'files', 'binary', 'binario', 'download', 'upload'], name: /binary|file|arquivo/i,
    platform: 'the system extension BinaryData (TextToBinaryData, BinaryDataToText, BinaryDataSize) is in every O11 environment.' },
  { id: 'zip', words: ['zip', 'compactar', 'compress', 'compressao', 'unzip'], name: /zip|compress/i },
  { id: 'image', words: ['imagem', 'imagens', 'image', 'images', 'foto', 'fotos', 'thumbnail', 'redimensionar', 'resize', 'png', 'jpg', 'jpeg'], name: /image|imagem|thumbnail|resize|png|jpe?g|photo/i },
  { id: 'barcode', words: ['qrcode', 'qr', 'barcode', 'barras'], name: /qr|barcode/i },
  { id: 'crypto', words: ['hash', 'hashes', 'sha256', 'md5', 'criptografia', 'criptografar', 'encrypt', 'decrypt', 'crypto', 'assinatura', 'signature'], name: /crypt|hash|sha\d|md5|sign/i },
  { id: 'word', words: ['word', 'docx'], name: /\bword|docx/i },
  { id: 'sms', words: ['sms', 'whatsapp'], name: /sms|whatsapp|twilio/i },
];
const NEED_OF_WORD = new Map(NEEDS.flatMap(n => n.words.map(w => [w, n.id])));

// The needs an intent names, in NEEDS order.
export function componentNeeds(intent) {
  const toks = normalize(String(intent ?? '')).split(/[^a-z0-9-]+/).filter(Boolean);
  const named = new Set(toks.map(t => NEED_OF_WORD.get(t)).filter(Boolean));
  return NEEDS.map(n => n.id).filter(id => named.has(id));
}

const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const field = (row, name) => row?.[name] ?? row?.[name[0].toLowerCase() + name.slice(1)];
// A producer row of the listing, in one shape.
export const producerOf = row => ({ name: String(field(row, 'Name') ?? ''), kind: String(field(row, 'Kind') ?? ''), key: field(row, 'Key') ?? null,
  signatureHash: field(row, 'SignatureHash') ?? null, system: field(row, 'IsSystem') === true });
const entryKey = p => p.name + '@' + (p.signatureHash ?? '');

// The signature line of an action: Name(In: Type, Opt?: Type) -> (Out: Type).
const param = p => (p?.name ?? '?') + (p?.mandatory === false || p?.isMandatory === false ? '?' : '') + ': ' + (p?.type ?? p?.dataType ?? '?');
export function signatureLine(action) {
  const ins = (action.inputs ?? []).map(param).join(', ');
  const outs = (action.outputs ?? []).map(param).join(', ');
  return action.name + '(' + ins + ')' + (outs ? ' -> (' + outs + ')' : '');
}
// The actions of an extension's XIF spec (o11_extension read: spec.actions[] {name, description, isFunction, inputs, outputs}).
export const actionsOfSpec = spec => (spec?.actions ?? []).filter(a => a?.name).map(a => ({ name: a.name, signature: signatureLine(a), ...(a.description ? { description: String(a.description).split(/\r?\n/)[0].slice(0, 160) } : {}) }));
// The public actions of an eSpace's module digest (ssam-digest/1 actions[] {name, kind, public, in, out}).
export const actionsOfDigest = digest => (digest?.actions ?? []).filter(a => a?.public && /ServerAction|ServiceAction/.test(a.kind ?? 'ServerAction'))
  .map(a => ({ name: a.name, signature: a.name + '(' + (a.in ?? '') + ')' + (a.out ? ' -> (' + a.out + ')' : '') }));
// The public actions of a listing of elements (dependencies list: names only).
export const actionsOfElements = elements => (elements ?? []).filter(e => /ActionSignature|ServerAction/.test(e?.type ?? e?.kind ?? '')).map(e => ({ name: e.name, signature: null }));

// ---- the cache
export const cacheFile = (root, host) => path.join(root, '.local', 'components', String(host || 'environment').replace(/[^\w.-]/g, '_') + '.json');
export function readCache(file) {
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); return c?.schema === COMPONENTS_CACHE_SCHEMA ? c : null; } catch { return null; }
}
function writeCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(cache), 'utf8'); fs.renameSync(temporary, file);
  // The environment of the last listing: an entry with no Studio attached answers from its cache, naming it.
  try { fs.writeFileSync(path.join(path.dirname(file), 'last.json'), JSON.stringify({ host: cache.host }), 'utf8'); } catch { /* the cache stands */ }
}
const lastHost = root => { try { return JSON.parse(fs.readFileSync(path.join(root, '.local', 'components', 'last.json'), 'utf8')).host ?? null; } catch { return null; } };

// The producers of the listing that a need names by their name, then by the name of one of their cached actions; the
// system ones the platform note names first. At most `max`, in a fixed order (need, name match before action match, name).
export function candidates(cache, needs, { max = 6 } = {}) {
  const out = [];
  const producers = (cache?.producers ?? []).filter(p => p.name && /^(Extension|eSpace)$/i.test(p.kind));
  for (const id of needs) {
    const need = NEEDS.find(n => n.id === id); if (!need) continue;
    const byName = producers.filter(p => need.name.test(p.name)).sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name));
    const byAction = producers.filter(p => !need.name.test(p.name) && (cache.elements?.[entryKey(p)]?.actions ?? []).some(a => need.name.test(a.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const [p, how] of [...byName.map(p => [p, 'name']), ...byAction.map(p => [p, 'action'])])
      if (!out.some(o => o.producer.name === p.name)) out.push({ producer: p, need: id, matched: how });
  }
  return out.slice(0, max);
}

/**
 * The components of the environment for the needs of an intent.
 * input: {lane, intent | needs, host?, refresh?, maxLive?}; deps: {root, listProducers, listElements, readExtension,
 * producerDigest, now}. Without listProducers (no Studio attached) and no cache: the answer says which call lists them.
 */
export async function environmentComponents(input = {}, deps = {}) {
  const lane = input.lane ?? 'o11';
  const needs = input.needs?.length ? input.needs : componentNeeds(input.intent);
  const call = { tool: 'ssam_discover', arguments: { lane, intent: '<what the app needs: pdf, excel, email, zip, image...> in the environment' } };
  if (!needs.length) return { ok: false, schema: COMPONENTS_SCHEMA, lane, code: 'NO_NEED', error: 'the intent names no capability the platform lacks (pdf, excel, email, file, zip, image, barcode, crypto, word, sms)', call };
  if (lane !== 'o11') return { ok: false, schema: COMPONENTS_SCHEMA, lane, needs, code: 'LANE', error: 'the listing of installed components is O11 only (ODC: odc_external_library and the Forge of the tenant)', call };
  const root = deps.root;
  let host = input.host ?? (deps.listProducers || !root ? null : lastHost(root));
  let cache = host && root ? readCache(cacheFile(root, host)) : null;
  const live = [];
  if ((!cache || input.refresh) && deps.listProducers) {
    let listed;
    try { listed = await deps.listProducers(); } catch (error) { listed = { ok: false, error: String(error?.message ?? error) }; }
    if (listed?.ok !== false && Array.isArray(listed?.rows)) {
      host = host ?? listed.host ?? 'environment';
      const previous = root ? readCache(cacheFile(root, host)) : null;
      cache = { schema: COMPONENTS_CACHE_SCHEMA, host, producers: listed.rows.map(producerOf).filter(p => p.name).sort((a, b) => a.name.localeCompare(b.name)),
        elements: previous?.elements ?? {} };
      live.push('producers');
    } else if (!cache) return { ok: false, schema: COMPONENTS_SCHEMA, lane, needs, code: 'NO_LISTING', error: 'the producers of the environment could not be listed: ' + String(listed?.error ?? 'no Studio on the O11 lane').slice(0, 300),
      continuation: { tool: 'ssam_connect', arguments: { lane: 'o11' }, why: 'the listing goes through the Service Studio attached on the O11 lane' } };
  }
  if (!cache) return { ok: false, schema: COMPONENTS_SCHEMA, lane, needs, code: 'NO_LISTING', error: 'no listing of this environment yet: the Service Studio of the O11 lane lists it (once, then cached)',
    continuation: { tool: 'ssam_connect', arguments: { lane: 'o11' }, why: 'attach the Studio of the O11 lane, then ask again: ' + JSON.stringify(call.arguments) } };
  // The actions of each candidate: from the cache, else read now (at most maxLive producers per call).
  // At most maxLive producers read per call, and none started after deadlineMs (the packet waits for them).
  let budget = input.maxLive ?? 4;
  const started = (deps.now ?? Date.now)();
  const deadline = input.deadlineMs ?? 20000;
  let changed = live.length > 0;
  const found = candidates(cache, needs, { max: input.max ?? 6 });
  for (const c of found) {
    const key = entryKey(c.producer);
    if (cache.elements[key] || budget <= 0 || (deps.now ?? Date.now)() - started > deadline) continue;
    let actions = null; let source = null;
    try {
      if (/^Extension$/i.test(c.producer.kind) && deps.readExtension) {
        const read = await deps.readExtension(c.producer.name);
        if (read?.ok !== false && read?.spec) { actions = actionsOfSpec(read.spec); source = 'xif'; }
      }
      if (!actions && /^eSpace$/i.test(c.producer.kind) && deps.producerDigest) {
        const d = await deps.producerDigest(c.producer.name);
        if (d?.ok !== false && d?.digest) { actions = actionsOfDigest(d.digest); source = 'digest'; }
      }
      if (!actions && deps.listElements) {
        const listed = await deps.listElements(c.producer.name, c.producer.kind);
        if (listed?.ok !== false && Array.isArray(listed?.elements)) { actions = actionsOfElements(listed.elements); source = 'list'; }
      }
    } catch { actions = null; }
    budget--;
    if (actions) { cache.elements[key] = { kind: c.producer.kind, source, actions: actions.sort((a, b) => a.name.localeCompare(b.name)) }; changed = true; live.push(c.producer.name); }
  }
  if (changed && root) { try { writeCache(cacheFile(root, cache.host), cache); } catch { /* the answer stands without the cache */ } }
  // Producers an action match only now finds (their actions were read in this call) join the answer on the next call.
  const components = found.map(c => {
    const entry = cache.elements[entryKey(c.producer)] ?? null;
    const actions = entry?.actions ?? [];
    const selected = actions.filter(a => NEEDS.find(n => n.id === c.need).name.test(a.name));
    const shown = (selected.length ? [...selected, ...actions.filter(a => !selected.includes(a))] : actions).slice(0, 12);
    return { name: c.producer.name, kind: c.producer.kind, ...(c.producer.system ? { system: true } : {}), need: c.need, matched: c.matched,
      ...(entry ? { actions: shown.map(a => a.signature ?? a.name), ...(actions.length > shown.length ? { actionsTotal: actions.length } : {}), ...(entry.source === 'list' ? { signatures: 'names only (o11_dependencies list); the inputs and outputs: ssam_map {lane:"o11", target:"' + c.producer.name + '", view:"digest"}' } : {}) }
        : { actions: null, read: { tool: 'ssam_discover', arguments: { lane, intent: needs.join(' ') + ' in the environment' }, why: 'its actions are read on the next call (at most ' + (input.maxLive ?? 4) + ' producers per call)' } }),
      reference: { op: 'reference', producer: c.producer.name, elements: (shown.length ? shown : [{ name: '<Action>' }]).slice(0, 3).map(a => 'IServerActionSignature:' + a.name) } };
  });
  const platform = needs.map(id => NEEDS.find(n => n.id === id)).filter(n => n?.platform).map(n => ({ need: n.id, note: n.platform }));
  return {
    ok: true, schema: COMPONENTS_SCHEMA, lane, host: cache.host, needs, producers: cache.producers.length,
    components,
    ...(platform.length ? { platform } : {}),
    ...(components.length ? {} : { none: 'no installed extension or Forge component of ' + cache.host + ' names ' + needs.join(', ') + ' (producers: ' + cache.producers.length + '); install one from the Forge, or write an extension (o11_extension publish)' }),
    use: 'bind the actions in the same job: {"op":"reference","producer":"<Name>","elements":["IServerActionSignature:<Action>",...]} before the logic op, deliver with producers:"published"; a flow text calls one as <Node> = <Producer>.<Action>(<Param>=<value>, ...)',
    ...(input.withSource ? { source: { cache: root ? cacheFile(root, cache.host) : null, live } } : {}),
  };
}

// The levels of the answer, richest first, for a section with a byte cap: whole; at most 4 actions per component; names only.
export function componentLevels(answer) {
  if (!answer?.ok) return [answer];
  const cut = n => ({ ...answer, components: answer.components.map(c => (Array.isArray(c.actions) && c.actions.length > n ? { ...c, actions: c.actions.slice(0, n), actionsTotal: c.actionsTotal ?? c.actions.length } : c)) });
  const names = { ...answer, components: answer.components.map(({ name, kind, need, matched, system }) => ({ name, kind, ...(system ? { system } : {}), need, matched })), use: answer.use };
  return [answer, cut(4), names];
}
export const fitComponents = (answer, cap) => componentLevels(answer).find(l => bytes(l) <= cap) ?? null;

// A direct question about the environment ("o que tenho no ambiente para gerar PDF", "which extensions can I use for
// Excel"): a need and a word of availability. The packet asks for the need alone.
const AVAILABILITY = /\b(ambiente|environment|instalad[ao]s?|installed|disponive(?:l|is)|available|extens(?:ao|oes)|extensions?|componentes?|components?|forge|bibliotecas?|librar(?:y|ies)|posso usar|can i use|tenho|temos|existe|existem|have)\b/;
export const asksEnvironment = intent => componentNeeds(intent).length > 0 && AVAILABILITY.test(normalize(String(intent ?? '')));

// ---- the live sources of the O11 lane (the Studio attached on it)
export function liveComponentSources({ root, lane = 'o11', run, readExtension, producerDigest } = {}) {
  const runLane = run ?? (async (verb, args) => (await import('./lanes.mjs')).run(lane, verb, args));
  const hostOf = value => (value?.stderr ?? []).map(String).map(l => / to ([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/i.exec(l)?.[1]).find(Boolean) ?? null;
  let host = null;
  return {
    root,
    listProducers: async () => {
      const value = await runLane('dependencies', ['producers']);
      const rows = value?.result?.data;
      host = hostOf(value);
      return value?.ok === false || !Array.isArray(rows) ? { ok: false, error: value?.error ?? 'no listing' } : { ok: true, rows, host };
    },
    listElements: async (name, kind) => {
      const value = await runLane('dependencies', ['list', '--producer', name, ...(kind ? ['--kind', kind] : []), '--limit', '500']);
      const elements = value?.result?.data?.elements;
      return value?.ok === false || !Array.isArray(elements) ? { ok: false } : { ok: true, elements };
    },
    // The XIF of an extension, read by the kernel through the Studio's own session (o11_extension read).
    readExtension: readExtension ?? (async name => {
      if (!host) return { ok: false };
      const { createO11Extension } = await import('./o11-extension.mjs');
      const { createWorkerFirstRunner } = await import('./anvil-worker.mjs');
      return createO11Extension({ root, runAnvil: createWorkerFirstRunner() })({ action: 'read', host, extension: name });
    }),
    ...(producerDigest ? { producerDigest } : {}),
  };
}

// The components answer of an entry (ssam_discover: the packet and the direct intent): live when a Studio is attached on
// the O11 lane (its connection record), else from the cache of the last listing. `digest`: the lane's module digest
// reader (the published OML of an eSpace producer).
export async function laneComponents({ lane = 'o11', intent, needs, refresh = false }, { root, digest = null } = {}) {
  // servidor/fase4-25: hosted, the components stay off until they have a root per account: the cache and its last.json are
  // one per server root, the connection record read here is the server's own, and the extension read would call
  // o11_extension around the gate. Nothing is read or written.
  if (hostedContext()) return hostedComponentsUnavailable(needs);
  let attached = null;
  try { const { LANES } = await import('./lanes.mjs'); const { readConnection } = await import('./studio-session.mjs'); attached = readConnection(LANES.o11.root, LANES.o11.lane); } catch { attached = null; }
  const sources = attached ? liveComponentSources({ root, lane, ...(digest ? { producerDigest: digest } : {}) }) : { root };
  return environmentComponents({ lane, intent, needs, refresh }, sources);
}
