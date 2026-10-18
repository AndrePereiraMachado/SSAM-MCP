// fix/unpublished-library (family OF; session b67c47db, 2026-10-15 19:52-20:03 UTC, 15 failed deliveries): a consumer job
// references public elements of a library that exist only in the library's open model, not yet published. The consumer
// session acquires the producer's PUBLISHED revision (ODC bridge ReferenceCommands.cs, RevisionRequestType.Latest; the O11
// server signature), so the delivery answered "Producer has no supported public elements" (REFERENCE_SNAPSHOT_FAILED, no
// continuation) or the kernel's REFERENCE_ELEMENT_MISSING, whose fix ("fix its name / remove it from the reference op")
// invites changing what the job means. Neither is the person's fix: the producer must be published.
//
// One rule, both lanes. The elements a job asks of a producer are checked against the published signature the delivery
// holds; a reused or given capture is acquired again first (it may predate a publication made by hand). The elements still
// missing are looked up in the producer's open model (the module open in an ODC Studio, or in a Service Studio tab). When
// every missing element is public there: ONE refusal PRODUCER_NOT_PUBLISHED with the whole sequence as one continuation:
// publish the producer (a write: the person's own words, never automatic), refresh the reference the consumer module
// already has of it (also a write the person confirms), then the same delivery. The job never changes, and "remove it" is
// never the fix of an element the open model has.
// Round 2 (review C:\t\revisoes\unpublished-lib, A1-A5): only an element of a kind the published signature can hold is ever
// "not published" (A1); only a module open in a Studio is an open model, never a module capture or a closed module's
// published OML (A2, A3); the open model is matched as the kernel matches the signature, ordinal, and a looser match is a
// spelling problem with the right spelling (A4); the job-alone check runs on that refusal and its problems are in it, and
// the job is never said to be right (A5).
//
// Pure functions and two readers that take their I/O as arguments. Every text this module emits is English.

import fs from 'node:fs';
import path from 'node:path';

export const NOT_PUBLISHED = 'PRODUCER_NOT_PUBLISHED';
export const ELEMENT_MISSING = 'REFERENCE_ELEMENT_MISSING';
export const WORDS = "<the user's own words>";
// The bridge's refusal of a producer whose published revision exports nothing it supports (ReferenceCommands.cs).
export const NO_PUBLIC_ELEMENTS = /Producer has no supported public elements/i;
export const noPublicElements = value => !!value && typeof value === 'object' && value.ok === false && NO_PUBLIC_ELEMENTS.test(String(value.error ?? ''));

// The reference families of a producer signature, as kernel/src/Anvil.Core/Kernel/NativeReferenceKinds.cs declares them
// (kind, interface and aliases: the test producer-publication.test.mjs reads that file and keeps the two equal), plus the
// kinds the ODC published signature writes (OdcPublicSignature: "block" for the block families) and the element kinds of a
// module digest (ModuleDigest.cs, reader KindOf) of the same family.
export const FAMILIES = Object.freeze([
  { kind: 'action', types: ['IServerActionSignature', 'IServerAction'], digest: ['ServerAction'] },
  { kind: 'entity', types: ['IEntitySignature', 'IServerEntity', 'IServerEntitySignature', 'IStaticEntity', 'IStaticEntitySignature', 'IClientEntity', 'IClientEntitySignature'],
    digest: ['Entity', 'ServerEntity', 'StaticEntity', 'ClientEntity'] },
  { kind: 'structure', types: ['IStructureSignature', 'IStructure'], digest: ['Structure'] },
  { kind: 'service-action', types: ['IServiceActionSignature', 'IServiceAction'], digest: ['ServiceAction'] },
  { kind: 'client-action', types: ['IClientActionSignature', 'IClientAction'], digest: ['ClientAction'] },
  { kind: 'role', types: ['IRoleSignature', 'IRole'], digest: ['Role'] },
  { kind: 'image', types: ['IImageSignature', 'IImage'], digest: ['Image'] },
  { kind: 'resource', types: ['IResourceSignature', 'IResource'], digest: ['Resource'] },
  { kind: 'script', types: ['IScriptSignature', 'IScript'], digest: ['Script'] },
  { kind: 'process', types: ['IProcessSignature', 'IProcess'], digest: ['Process'] },
  { kind: 'web-theme', types: ['IWebThemeSignature', 'IWebTheme'], digest: ['Theme', 'WebTheme'] },
  { kind: 'mobile-theme', types: ['IMobileThemeSignature', 'IMobileTheme'], digest: ['Theme', 'MobileTheme'] },
  { kind: 'web-flow', types: ['IWebFlowSignature', 'IWebFlow'], digest: ['WebFlow', 'Flow'] },
  { kind: 'mobile-flow', types: ['IMobileFlowSignature', 'IMobileFlow'], digest: ['MobileFlow', 'Flow'] },
  { kind: 'web-block', types: ['IWebBlockSignature', 'IWebBlock'], signature: ['block'], digest: ['WebBlock', 'Block'] },
  { kind: 'mobile-block', types: ['IMobileBlockSignature', 'IBlockSignature', 'IBlock', 'IMobileBlock'], signature: ['block'], digest: ['Block', 'MobileBlock', 'WebBlock'] },
  { kind: 'web-screen', types: ['IWebScreenSignature', 'IWebScreen'], digest: ['WebScreen', 'Screen'] },
  { kind: 'mobile-screen', types: ['IMobileScreenSignature', 'IScreenSignature', 'IScreen', 'IMobileScreen'], digest: ['Screen', 'MobileScreen', 'WebScreen'] },
]);
const exactFamily = type => FAMILIES.find(f => f.types.includes(type)) ?? null;
// NativeReferenceKinds.ForType: the interface or an alias, or the type written without its Model API "I" ("ClientAction").
// Ordinal and untrimmed, as the kernel reads it (round 2, A4): " ServerAction" is no family there, so none here.
export function familyOf(type) {
  const t = String(type ?? '');
  return exactFamily(t) ?? (t.length > 0 && /[A-Z]/.test(t[0]) && !(t.length > 1 && t[0] === 'I' && /[A-Z]/.test(t[1])) ? exactFamily('I' + t) : null);
}

// Round 2 (review C:\t\revisoes\unpublished-lib, A1): the element kinds the ODC published signature holds. OdcPublicSignature.cs
// reads ReferenceStructure, NewRuntime.ReferenceWebBlock ("block"), ReferenceClientAction, ReferenceAction and
// ReferenceEntity only; NativeReferenceSnapshot.Select (ODC) maps the mobile block family to "block" and refuses any other
// kind ("Unsupported element kind for this frozen producer signature"). An External Library holds server actions and
// structures. Publishing a producer never adds another kind to its signature, so an element of another kind is never
// "not published": the kernel's own refusal answers it.
export const ODC_PUBLIC_KINDS = Object.freeze(['action', 'entity', 'structure', 'block', 'client-action']);
export const ODC_EXTERNAL_LIBRARY_KINDS = Object.freeze(['action', 'structure']);
export const odcKindOf = family => (family ? (family.kind === 'mobile-block' ? 'block' : family.kind) : null);
export const odcKindsOf = moduleKind => (String(moduleKind ?? '') === 'ExternalLibrary' ? ODC_EXTERNAL_LIBRARY_KINDS : ODC_PUBLIC_KINDS);
// Whether an ODC published signature (of a module or library; moduleKind 'ExternalLibrary' for an External Library) can hold
// the element a job asks.
export const odcExportable = (element, moduleKind = null) => { const kind = odcKindOf(element?.family); return !!kind && odcKindsOf(moduleKind).includes(kind); };
// The module digest kinds of those families (the open model's side of the same rule).
const ODC_DIGEST_KINDS = new Set(FAMILIES.filter(f => ODC_PUBLIC_KINDS.includes(odcKindOf(f))).flatMap(f => f.digest));
export const odcExportableSurface = item => ODC_DIGEST_KINDS.has(String(item?.kind ?? ''));
// The words of the refusal of a kind the ODC published signature cannot hold (the kernel's JobRunner says the same).
export const ODC_SIGNATURE_HOLDS = 'server actions, client actions, structures, entities and blocks (an External Library: server actions and structures)';

const lower = value => String(value ?? '').trim().toLowerCase();
const lastSegment = name => String(name).trim().split(/[\\/]/).pop();

// One element a reference op asks: "Type:Name" (Name may be a path Flow/Name or Flow\Name, or @originalKey). name is the
// text after the first ":" exactly as the kernel reads it (Split(':', 2)), never trimmed: the match is the kernel's (A4).
export function parseElement(text) {
  const at = String(text ?? '').indexOf(':');
  if (at <= 0) return null;
  const type = String(text).slice(0, at), name = String(text).slice(at + 1);
  return name.trim() ? { text: String(text), type, name, family: familyOf(type) } : null;
}

// The elements the job's reference ops ask of the producer `matches` names (matches: written name -> boolean), each with
// its op, index and pointer: [{op, k, pointer, text, type, name, family}].
export function requestedElements(jobDocument, matches) {
  const ops = Array.isArray(jobDocument) ? jobDocument : Array.isArray(jobDocument?.ops) ? jobDocument.ops : [];
  const prefix = Array.isArray(jobDocument) ? '' : '/ops';
  const out = [];
  ops.forEach((op, i) => {
    if (op?.op !== 'reference' || !matches(op.producer)) return;
    (Array.isArray(op.elements) ? op.elements : []).forEach((text, k) => {
      const element = parseElement(text);
      if (element) out.push({ op: i, k, pointer: prefix + '/' + i + '/elements/' + k, ...element });
    });
  });
  return out;
}
// The ops that name the producer (reference ops and a prototype op's data.bind), for a producer the job asks nothing
// element by element of: [{op, pointer}].
export function namingOps(jobDocument, matches) {
  const ops = Array.isArray(jobDocument) ? jobDocument : Array.isArray(jobDocument?.ops) ? jobDocument.ops : [];
  const prefix = Array.isArray(jobDocument) ? '' : '/ops';
  return ops.map((op, i) => ({ op, i })).filter(({ op }) => (op?.op === 'reference' && matches(op.producer)) || (op?.op === 'prototype' && matches(op?.data?.bind?.producer)))
    .map(({ op, i }) => ({ op: i, pointer: prefix + '/' + i + (op.op === 'prototype' ? '/data/bind/producer' : '/producer') }));
}

// The elements of a published signature capture (.avsig: the ODC envelope, Elements [{Kind, Name, Path?, Key}]); null for a
// file that is no readable capture (an .oml binding is not judged here).
export function signatureElements(file) {
  if (typeof file !== 'string' || !/\.avsig$/i.test(file)) return null;
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(document?.Elements) ? document.Elements : null;
  } catch { return null; }
}
// The revision a capture names (Revision of the envelope), or null.
export function signatureRevision(file) {
  try { const r = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))?.Revision; return r == null || r === '' ? null : String(r); } catch { return null; }
}
// The ModuleKind a capture names ('eSpace', 'ExternalLibrary', ...), or null.
export function signatureModuleKind(file) {
  try { const k = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))?.ModuleKind; return k == null || k === '' ? null : String(k); } catch { return null; }
}
// The ModuleKey a capture names (the producer's key; round 3, N1), or null.
export function signatureModuleKey(file) {
  try { const k = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))?.ModuleKey; return k == null || k === '' ? null : String(k); } catch { return null; }
}
// Round 3 (review C:\t\revisoes\unpublished-lib-2, N2): the first step of the chain when studio_publish {module} would refuse
// the library (publishPrecheck: no SSAM merge of it, a merge made in another Studio, the module changed since, ...): the
// person publishes it in that Studio. No tool call, so no words are asked; then the same refresh and the same delivery.
export function personPublishStep(producer, { pid = null, host = null, refused = null } = {}) {
  return { by: 'person', action: 'publish', module: producer, ...(Number.isInteger(pid) ? { pid } : {}), ...(host ? { host } : {}),
    ...(refused?.code ? { publishRefusal: { code: refused.code, error: refused.error ?? null } } : {}),
    why: 'The person publishes ' + producer + ' in the ODC Studio' + (Number.isInteger(pid) ? ' of pid ' + pid : '') + (host ? ' (' + host + ')' : '')
      + ': its open model there has what this job references, and studio_publish {module} cannot publish it'
      + (refused?.code ? ' (' + refused.code + (refused.error ? ': ' + refused.error : '') + ')' : '')
      + '. This step is no tool call; once the person says it is published, go on with then.' };
}
// Round 4 (review C:\t\revisoes\unpublished-lib-3, N4): the refusals of studio_publish {module} that only say "this open module
// is no SSAM-verified merge": SSAM cannot publish it from here, the person can. Every other refusal is a safety gate of the
// handler (a last merge incomplete with known losses or uncertain, a publication already requested, a Studio whose status
// cannot be read, ...): it passes on as the handler answers it.
export const PERSON_PUBLISHES = Object.freeze(['NO_DELIVERY_TO_PUBLISH', 'DELIVERY_IN_OTHER_STUDIO', 'MODULE_CHANGED_SINCE_DELIVERY', 'ALREADY_PUBLISHED']);
// The step a safety refusal of studio_publish gives as step 1: the handler's own continuation (else the Studio's status),
// named in why; the publication is not proposed until it is read (gate: true, so the chain stops there).
export function publicationGateStep(producer, { pid = null, host = null, refused = null } = {}) {
  const own = refused?.continuation && typeof refused.continuation === 'object' && typeof refused.continuation.tool === 'string' ? refused.continuation
    : { tool: 'studio_status', arguments: { view: 'brief', ...(Number.isInteger(pid) ? { pid } : {}) }, why: 'which modules are open in that ODC Studio and what it is doing' };
  return { ...own, gate: true, publishRefusal: { code: refused?.code ?? null, error: refused?.error ?? null },
    why: 'Before anything: studio_publish {module: ' + producer + '} in the ODC Studio' + (Number.isInteger(pid) ? ' of pid ' + pid : '') + (host ? ' (' + host + ')' : '')
      + ' refuses now (' + (refused?.code ?? 'refused') + (refused?.error ? ': ' + refused.error : '') + '). ' + (own.why ? own.why.replace(/\.?\s*$/, '. ') : '')
      + 'The publication of ' + producer + ' is not proposed until this is read: never publish or merge again blindly. Once it is settled, the same delivery can be asked again.' };
}
// Whether a published signature has the element, exactly as NativeReferenceSnapshot.Select (ODC) selects it (round 2, A4):
// the ODC kind of its family (mobile block = "block"; a kind the signature cannot hold has nothing), then the name, the path
// or @key, ordinal. A spelling that only matches by letter case is another element there, so it is another one here.
export function signatureHas(elements, element, { moduleKind = null } = {}) {
  const kind = odcKindOf(element?.family);
  if (!kind || !odcKindsOf(moduleKind).includes(kind)) return false;
  const name = String(element.name);
  return (elements ?? []).some(e => String(e?.Kind ?? e?.kind ?? '') === kind
    && ((e?.Name ?? e?.name) === name || ((e?.Path ?? e?.path) != null && (e?.Path ?? e?.path) === name) || ((e?.Key ?? e?.key) != null && '@' + (e?.Key ?? e?.key) === name)));
}

// The words a digest block's head line carries before its description: "structure CoverageAmounts @key public "..."".
const headFlags = text => new Set(String(text ?? '').split('\n')[0].split('"')[0].trim().split(/\s+/));
// The path of a block of the digest's "ui" section, from its head line ("block MainFlow/Header @key public ..."): the
// qualified name the O11 signature knows it by (NativeDependencyReader QualifiedName, Flow/Name).
const uiPathOf = text => { const m = /^(?:block|screen|email)\s+(\S+\/\S+)\s+@/.exec(String(text ?? '').split('\n')[0]); return m ? m[1] : null; };
// The public surface of a producer's model from its module digest (ssam-digest/1, module-map.mjs moduleDigest): every
// action of the action index with its Public flag, and every top-level block of the other sections with the public flag of
// its head line (a block of the "ui" section with its Flow/Name path). [{kind, name, key, public, path?}]
export function surfaceOf(digest) {
  const out = [], seen = new Set();
  for (const a of Array.isArray(digest?.actions) ? digest.actions : []) {
    if (!a?.name) continue;
    out.push({ kind: String(a.kind ?? ''), name: String(a.name), key: a.key ?? null, public: a.public === true }); if (a.key) seen.add(a.key);
  }
  for (const section of Array.isArray(digest?.sections) ? digest.sections : []) {
    if (['module', 'coverage', 'actions'].includes(section?.id)) continue;
    for (const b of Array.isArray(section?.blocks) ? section.blocks : []) {
      if (!b?.name || (b.key && seen.has(b.key))) continue;
      const at = section.id === 'ui' ? uiPathOf(b.text) : null;
      out.push({ kind: String(b.kind ?? ''), name: String(b.name), key: b.key ?? null, public: headFlags(b.text).has('public'), ...(at ? { path: at } : {}) }); if (b.key) seen.add(b.key);
    }
  }
  return out;
}
// Round 2 (A4): the element of the open model the job's element names, matched as the kernel will match it once the
// producer is published: the same family (by the digest kinds), then the name or @key, ordinal; on O11 also the qualified
// Flow/Name (NativeDependencyReader.FindTop). The ODC published signature names an element without its flow
// (OdcPublicSignature.cs: Kind, Name, Key), so on ODC a path is never the kernel's match. null when none.
const sameKind = (element, item) => { const kinds = element.family?.digest ?? null; return !kinds || kinds.includes(item.kind); };
export function surfaceFind(surface, element, { lane = 'odc' } = {}) {
  const name = String(element.name);
  return (surface ?? []).find(e => sameKind(element, e) && (e.name === name || (e.key && '@' + e.key === name) || (lane === 'o11' && e.path != null && e.path === name))) ?? null;
}
// The elements of the open model the job's element names only by a looser spelling than the kernel's (other letter case,
// spaces around it, or only the last segment of a path): a spelling problem, never an unpublished element. Each with the
// spelling the kernel takes ("Type:Name"; on O11 a path keeps its Flow/Name). [] when none.
export function surfaceSpelling(surface, element, { lane = 'odc' } = {}) {
  const name = lower(element.name), last = /[\\/]/.test(String(element.name)) ? lower(lastSegment(element.name)) : null;
  const pathWritten = last != null;
  return (surface ?? []).filter(e => sameKind(element, e) && (lower(e.name) === name || (e.path != null && lower(e.path) === name) || (last != null && lower(e.name) === last)))
    .map(e => ({ item: e, spelling: element.type + ':' + (lane === 'o11' && pathWritten && e.path ? e.path : e.name) }));
}
// Each missing element with what the open model says of it: open 'public' | 'private' | 'absent' | 'spelling' (then
// spellings: the right ones, public: whether that element is Public). options.lane: 'odc' (default) or 'o11'.
export const classify = (missing, surface, { lane = 'odc' } = {}) => missing.map(m => {
  const found = surfaceFind(surface, m, { lane });
  if (found) return { ...m, open: found.public ? 'public' : 'private' };
  const near = surfaceSpelling(surface, m, { lane });
  return near.length ? { ...m, open: 'spelling', spellings: [...new Set(near.map(n => n.spelling))], spellingPublic: near.some(n => n.item.public) } : { ...m, open: 'absent' };
});

// The newest module capture of a producer in a lane's capture folder (<Name>-<sha256>.oml with its .json), as a data hint
// only: {file, capturedAt} | null. Round 2 (A2): a capture is no open model (it may predate a rename that was published,
// and studio_publish needs the module open in a Studio), so it never proves an unpublished element.
export function newestModuleCapture(producer, captureDir) {
  if (!captureDir || typeof producer !== 'string' || !producer) return null;
  try {
    const pattern = new RegExp('^' + producer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-([0-9A-Fa-f]{64})\\.oml$');
    const found = fs.readdirSync(captureDir).filter(n => pattern.test(n)).map(n => {
      const full = path.join(captureDir, n);
      let at = null; try { at = JSON.parse(fs.readFileSync(full + '.json', 'utf8').replace(/^﻿/, ''))?.capturedAt ?? null; } catch { at = null; }
      return { file: full, capturedAt: at, time: Date.parse(at ?? '') || fs.statSync(full).mtimeMs };
    }).sort((a, b) => b.time - a.time);
    return found.length ? { file: found[0].file, capturedAt: found[0].capturedAt } : null;
  } catch { return null; }
}

// The producer's open model (ODC). Round 2 (A2): only a module open in an ODC Studio is an open model: the one this call
// reaches (pid), else, when the call names its Studio (pid), another ODC Studio whose open modules list it (otherPids: the
// ODC Studio processes; the bridge's snapshot resolves the name against that Studio's own status). The answer says which
// Studio (pid), so the publication step goes to it. A module capture of the capture folder is only a data hint (capture).
// Round 3 (review C:\t\revisoes\unpublished-lib-2, N1): a module of the same name is the producer's open model only when it is
// the same asset the consumer references: its snapshot host is the consumer's tenant (host; a Studio holds sessions on several
// tenants, and another ODC Studio may be signed into another one), and, when the published signature is held (moduleKey: its
// ModuleKey; null in form A, where nothing is published), its key is that key. A namesake on another tenant or with another
// key is never evidence: the answer names the difference (elsewhere), and the search goes on in the other Studios.
// -> {ok:true, source:'open-model', pid?, host, moduleKey?, file, sha256, capturedAt, modified, surface}
//  | {ok:false, reason, capture?, elsewhere?: [{pid?, host, moduleKey?, differs: 'host'|'key'}]}.
// deps: studio (the bridge), digestOf(file) -> {ok, digest} (module-map.mjs moduleDigest), captureDir, otherPids.
export async function odcProducerModel({ producer, pid, host = null, moduleKey = null }, { studio, digestOf, captureDir = null, otherPids = null }) {
  if (typeof producer !== 'string' || !producer.trim() || /^\(.*\)$/.test(producer.trim())) return { ok: false, reason: 'a system producer has no open model' };
  const consumerHost = typeof host === 'string' && host.trim() ? host.trim() : null;
  const elsewhere = [];
  const openIn = async at => {
    let snap;
    try { snap = await studio(['snapshot', producer], at); } catch { return null; }
    if (!(snap?.ok === true && typeof snap.path === 'string' && String(snap.module ?? producer).toLowerCase() === producer.toLowerCase())) return null;
    const seen = { ...(Number.isInteger(at) ? { pid: at } : {}), host: typeof snap.host === 'string' && snap.host ? snap.host : null, ...(snap.moduleKey ? { moduleKey: String(snap.moduleKey) } : {}) };
    if (!consumerHost || !seen.host || seen.host.toLowerCase() !== consumerHost.toLowerCase()) { elsewhere.push({ ...seen, differs: 'host' }); return null; }
    if (moduleKey && seen.moduleKey !== String(moduleKey)) { elsewhere.push({ ...seen, differs: 'key' }); return null; }
    return snap;
  };
  let snap = await openIn(pid), at = pid;
  if (!snap && Number.isInteger(pid) && typeof otherPids === 'function') {
    let pids = [];
    try { pids = await otherPids(); } catch { pids = []; }
    for (const other of Array.isArray(pids) ? pids : []) {
      if (!Number.isInteger(other) || other === pid) continue;
      if ((snap = await openIn(other))) { at = other; break; }
    }
  }
  if (!snap) {
    const capture = newestModuleCapture(producer, captureDir);
    const where = s => (Number.isInteger(s.pid) ? 'the ODC Studio of pid ' + s.pid : 'this ODC Studio');
    const differences = elsewhere.map(s => (s.differs === 'host'
      ? producer + ' is open in ' + where(s) + ' on ' + (s.host ? 'tenant ' + s.host : 'an unknown tenant') + ', not on the consumer\'s tenant ' + (consumerHost ?? '(unknown)')
      : producer + ' open in ' + where(s) + ' has the key ' + (s.moduleKey ?? '(unknown)') + ', not the key ' + moduleKey + ' of its published signature'));
    return { ok: false, reason: (differences.length
      ? differences.join('; ') + ': another asset of the same name, so it proves nothing about the producer this consumer references, and publishing it never changes that producer'
      : producer + ' is not open in ' + (Number.isInteger(pid) && typeof otherPids === 'function' ? 'any ODC Studio' : 'this ODC Studio'))
      + (capture ? ' (its module capture of ' + (capture.capturedAt ?? 'an unknown time') + ' is data, not the open model)' : ''), ...(capture ? { capture } : {}), ...(elsewhere.length ? { elsewhere } : {}) };
  }
  let read;
  try { read = await digestOf(snap.path); } catch (error) { read = { ok: false, error: error.message }; }
  if (read?.ok !== true || !read.digest) return { ok: false, reason: 'the module digest of ' + producer + ' could not be read (' + (read?.error ?? 'no digest') + ')' };
  return { ok: true, source: 'open-model', ...(Number.isInteger(at) ? { pid: at } : {}), host: snap.host, ...(snap.moduleKey ? { moduleKey: String(snap.moduleKey) } : {}),
    file: snap.path, sha256: snap.sha256 ?? read.sourceSha256 ?? null,
    capturedAt: snap.capturedAt ?? null, ...(snap.modified != null ? { modified: snap.modified } : {}), surface: surfaceOf(read.digest) };
}

// The O11 producer's open model: the module open in a Service Studio tab (module-map.mjs moduleDigest of the module name,
// which says how it captured it: capturedBy). Round 2 (A3): a closed module is never an open model; its published OML is no
// evidence of an unpublished change (o11-cycle.mjs reads without downloading it).
export async function o11ProducerModel({ producer }, { digestOf }) {
  if (typeof producer !== 'string' || !producer.trim()) return { ok: false, reason: 'no producer name' };
  let read;
  try { read = await digestOf(producer); } catch (error) { read = { ok: false, error: error.message }; }
  if (read?.capturedBy === 'published-oml') return { ok: false, reason: producer + ' is not open in Service Studio (only its published OML was read)' };
  if (read?.ok !== true || !read.digest) return { ok: false, reason: 'the open model of ' + producer + ' could not be read (' + (read?.error ?? 'no digest') + ')' };
  return { ok: true, source: 'open-model', file: read.file ?? null, sha256: read.sourceSha256 ?? null, capturedAt: null, surface: surfaceOf(read.digest) };
}

const publishTool = lane => (lane === 'o11' ? 'o11_publish' : 'studio_publish');
const spellingsOf = item => (item.spellings ?? []).join(' or ');
const fixOf = (lane, item, producer) => item.open === 'public'
  ? 'publish ' + producer + ' (' + publishTool(lane) + ' with the person\'s own words, or the person publishes it in the Studio): its open model has ' + item.text
    + ' public, its published revision does not; then deliver again (this reference needs no change)'
  : item.open === 'private'
    ? 'make ' + item.name + ' Public in ' + producer + ' (its open model has it, not Public), publish ' + producer + ', then deliver again'
    : item.open === 'spelling'
      ? 'write ' + spellingsOf(item) + ' in place of ' + item.text + ': the open model of ' + producer + ' names it so, and a reference matches names exactly (letter case included'
        + (lane === 'odc' ? '; an ODC signature names an element without its flow' : '') + ')'
        + (item.publishedHas === true ? '' : item.spellingPublic
          ? '; its published revision lacks it too, so publish ' + producer + ' (' + publishTool(lane) + ', the person\'s own words) before delivering the corrected job'
          : '; it is not Public there: make it Public in ' + producer + ' and publish it before delivering the corrected job')
      : item.open === 'absent'
        ? producer + ' has no ' + item.text + ', neither published nor in its open model: write the kind and name of an element it has'
        : 'the published signature of ' + producer + ' has no ' + item.text + ': write the kind and name of an element it publishes; if ' + producer
          + ' has it in a model not published yet, publish ' + producer + ' first';
// The fix of one classified element (o11-cycle.mjs gives the O11 kernel's problem of a spelling this fix).
export const elementFix = fixOf;
// Round 2 (A1): an element of a kind the ODC published signature cannot hold (a service action, a role, ...). Publishing never
// adds it: the job's reference op cannot take it.
const unsupportedProblem = (producer, item) => ({ op: item.op ?? null, pointer: item.pointer ?? null, code: ELEMENT_MISSING, severity: 'error', phase: 'reference',
  message: 'The kind of ' + item.text + ' cannot be referenced through the published signature of ' + producer + ': an ODC signature holds ' + ODC_SIGNATURE_HOLDS,
  fix: 'publishing ' + producer + ' does not change this: reference an element of one of those kinds, or add this reference in the Studio (Manage Dependencies)',
  patch: null, producer, element: item.text, cause: 'unsupported-kind' });

// One problem per element the published revision lacks (or one per naming op, when the job asks the producer nothing by
// element and its published revision exports nothing), with its own code, cause and fix; then one per element of a kind
// the published signature cannot hold (entry.unsupported).
export function unpublishedProblems(lane, entry) {
  const producer = entry.producer;
  const items = entry.missing.length || entry.unsupported?.length ? entry.missing
    : (entry.ops ?? []).map(o => ({ ...o, text: 'its public elements', name: producer, open: entry.surfacePublic ? 'public' : entry.evidence ? 'absent' : null, whole: true }));
  return [...items.map(item => {
    const code = item.open === 'public' ? NOT_PUBLISHED : entry.noPublicElements && !entry.evidence ? 'REFERENCE_SNAPSHOT_FAILED' : ELEMENT_MISSING;
    const message = item.whole
      ? 'The published revision of ' + producer + ' exports no public element' + (item.open === 'public' ? '; its open model has public elements that are not published yet' : '')
      : 'The published revision of ' + producer + (entry.revision ? ' (revision ' + entry.revision + ')' : '') + ' has no ' + item.text
        + (item.open === 'public' ? '; its open model has it, public, not published yet' : item.open === 'private' ? '; its open model has it, not Public'
          : item.open === 'spelling' ? '; its open model has ' + spellingsOf(item) : '');
    const fix = item.whole && item.open !== 'public'
      ? (entry.evidence ? producer + ' has no public element in its open model either: make the elements the job uses Public in ' + producer + ', publish it, then deliver again'
        : 'publish ' + producer + ' if its open model has public elements that are not published yet (' + publishTool(lane) + ', the person\'s own words), or make the elements the job uses Public in it first; then deliver again')
      : fixOf(lane, item, producer);
    return { op: item.op ?? null, pointer: item.pointer ?? null, code, severity: 'error', phase: 'reference', message, fix, patch: null,
      producer, ...(item.whole ? {} : { element: item.text }), cause: item.open === 'public' ? 'unpublished' : item.open ?? 'unknown' };
  }), ...(entry.unsupported ?? []).map(item => unsupportedProblem(producer, item))];
}

// Steps chained by `then`, the first one outermost.
const chain = steps => steps.reduceRight((next, step) => (next ? { ...step, then: next } : step), null);

// ONE refusal for the producers whose published revision lacks what the job references. entries: [{producer (as the Studio
// lists it), key, revision, missing (classified), unsupported (elements of a kind the signature cannot hold), ops,
// noPublicElements, evidence {source, pid?, file, sha256, capturedAt}, capture (a data hint), referenced (the consumer module
// already references it)}]; deliver: {tool, arguments} of the same delivery; refresh(entry): the refresh step of a referenced
// producer; publish(entry): its publication step. jobCheck (round 2, A5): the job-alone check of this call ({ok:true} passed,
// {ok:false, problems} refused, {skipped} or null: not run); its problems are this refusal's too, and the job is never said
// to be right (that check is not the build). -> {code, error, problems, producers, jobCheck?, sequence, continuation?}
export function unpublishedRefusal({ lane = 'odc', module, entries, deliver, publish, refresh, jobCheck = null }) {
  const producerProblems = entries.flatMap(entry => unpublishedProblems(lane, entry));
  const jobProblems = jobCheck?.ok === false && Array.isArray(jobCheck.problems) ? jobCheck.problems : [];
  const problems = [...producerProblems, ...jobProblems];
  const publishable = producerProblems.length > 0 && producerProblems.every(p => p.code === NOT_PUBLISHED);
  const codes = [...new Set(producerProblems.map(p => p.code))];
  const code = publishable ? NOT_PUBLISHED : codes.length === 1 ? codes[0] : ELEMENT_MISSING;
  const names = entries.map(e => e.producer);
  const evidence = entries.map(e => ({ producer: e.producer, ...(e.revision ? { publishedRevision: e.revision } : {}), ...(e.noPublicElements ? { publishedElements: 0 } : {}),
    missing: [...e.missing.map(m => ({ element: m.text, open: m.open ?? 'unknown', ...(m.spellings ? { spellings: m.spellings } : {}) })),
      ...(e.unsupported ?? []).map(m => ({ element: m.text, open: 'unsupported-kind' }))],
    openModel: e.evidence ? { source: e.evidence.source, ...(Number.isInteger(e.evidence.pid) ? { pid: e.evidence.pid } : {}), ...(e.evidence.host ? { host: e.evidence.host } : {}),
      file: e.evidence.file ?? null, sha256: e.evidence.sha256 ?? null, ...(e.evidence.capturedAt ? { capturedAt: e.evidence.capturedAt } : {}) }
      : { read: false, reason: e.reason ?? null, ...(e.capture ? { capture: { file: e.capture.file, capturedAt: e.capture.capturedAt ?? null, note: 'a module capture is data, not the open model' } } : {}) },
    referencedByModule: e.referenced ?? null }));
  const shown = entries.map(e => e.producer + ' (' + (e.noPublicElements ? 'its published revision exports no public element' + (e.missing.length || e.unsupported?.length ? '; the job references ' : '') : '')
    + [...e.missing, ...(e.unsupported ?? [])].map(m => m.text).join(', ') + ')').join('; ');
  const checked = jobProblems.length
    ? ' The job-alone check also refused ' + jobProblems.length + ' problem(s) of the job itself, listed with their fixes: correct the job first (that writes nothing).'
    : jobCheck?.ok === true && !jobCheck.skipped ? ' The job-alone check passed (it reads the job without the module; the build checks more).' : '';
  // Round 4 (N4): a safety refusal of studio_publish (gate) stops the chain at its own reading step: nothing is published,
  // refreshed or delivered again before it is read (still ONE refusal, never a chain of refusals).
  const publishing = publishable ? entries.map(publish) : [];
  const gates = publishing.filter(s => s?.gate === true).map(({ gate: _gate, ...s }) => s);
  const gated = gates.length ? ' studio_publish refuses now (' + gates.map(g => g.publishRefusal?.code ?? 'refused').join(', ')
    + '): read what the continuation names before any publication.' : '';
  const error = publishable
    ? 'The published revision of ' + names.join(', ') + ' lacks what this job references; the open model of ' + (names.length > 1 ? 'each' : 'it') + ' has it, public, not published yet: '
      + shown + '. Nothing was built or merged. Publish ' + names.join(', ') + ' first (the person\'s own words), then deliver again; these references need no change.' + gated + checked
    : 'The published signature of ' + names.join(', ') + ' lacks what this job references: ' + shown + '. Nothing was built or merged. Each problem says its fix.' + checked;
  const again = jobProblems.length ? { ...deliver, why: 'The same delivery once the job is corrected as its problems say: it acquires the published producer again from the consumer session and builds on it.' } : deliver;
  const steps = !publishable ? [] : gates.length ? gates : [
    ...publishing,
    ...(refresh ? entries.filter(e => e.referenced === true).map(refresh) : []),
    again,
  ];
  const sequence = steps.map(s => {
    // Round 3 (N2): a step no tool takes (the person publishes the library in the Studio).
    if (s.by === 'person') return 'the person ' + s.action + 'es ' + s.module + ' in the Studio' + (Number.isInteger(s.pid) ? ' (pid ' + s.pid + (s.host ? ', ' + s.host : '') + ')' : '');
    const target = s.arguments?.module ?? s.arguments?.args?.module, producer = s.arguments?.producer ?? (Array.isArray(s.arguments?.args?.producers) ? s.arguments.args.producers.join(', ') : null);
    return s.tool + (s.arguments?.command ? ' ' + s.arguments.command : '') + (target ? ' ' + target : '') + (producer ? ' (' + producer + ')' : '');
  });
  const jobCheckField = jobCheck ? { jobCheck: jobCheck.ok === false ? { ran: true, ok: false, problems: jobProblems.length } : jobCheck.skipped ? { ran: false, reason: String(jobCheck.skipped) } : { ran: true, ok: true } } : {};
  return { code, error, problems, producers: evidence, ...jobCheckField, ...(publishable ? { sequence, continuation: chain(steps) } : {}) };
}
