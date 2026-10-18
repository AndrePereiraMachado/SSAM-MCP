// F5, the family rule of producer signatures, on the facade's side. The rule itself is the kernel's
// (kernel/src/Anvil.Core/Delivery/ProducerLedger.cs, ProducerCache.cs and Delivery.Acquire); this module reads and writes
// the same files. The analysis of 2026-10-12 (VisitaCerta) measured 39% of the SSAM write time capturing and attesting
// again the same producer, same published version, on every round of o11_deliver. A producer signature is reused while its
// identity did not change: the environment, the producer and its published state (module or extension version; for a
// system producer the signature hash the referenceable catalog advertises). The workspace keeps, next to the captures:
//   <lane .local>/producer-cache/<key>.avsig + <key>.json     the captures (C27); the .json is the kernel's DurableJson
//                                                             envelope {format:1, sha256 of payload, payload}
//   <lane .local>/producer-cache/observed/<id>.json           the last server observation of a producer (kernel)
//   <lane .local>/producer-cache/published/<id>.json          the last publication SSAM started of a module and its end (here)
//   <lane .local>/producer-cache/publishing/<id>.<p>.json     a publication in flight (here)
// id = the first 40 hex of sha256("environment\nproducer"), both trimmed and lower case. A recent observation counts with no
// server call only when it was made after the end of every publication of that producer SSAM recorded (never inside one), so
// the facade:
//   - records every publication it starts, and its end (o11_publish, o11_extension, o11_environment refresh-refs publish and
//     set-user-provider, o11_service_center_write extension-publish and solution-publish, the debugger's publication; on
//     ODC studio_deliver publish, studio_publish and odc_external_library deploy): recordPublished, recordPublicationEnded;
//   - says in each o11_deliver answer what was reused and how each producer was observed (producerSignaturesOf);
//   - lists in the work packet the cached signatures of the producers the intent needs (packetProducers, F6);
//   - applies the same rule to the ODC lane's reference snapshots (reuseOdcReference, below; kernel-delivery.mjs).
// Every function here is a cache read or write: it never throws, and a missing or unreadable file only means a capture.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalKeyOf, sameProducer } from './producer-names.mjs';

export const PUBLISHED_SCHEMA = 'ssam-producer-published/1';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const lower = text => String(text ?? '').trim().toLowerCase();
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };

// ProducerCache.ForWork: the producer cache of a lane work folder (named "work") is <nearest ".local" above it>/producer-cache.
export function producerCacheDir(work) {
  if (typeof work !== 'string' || !work) return null;
  const full = path.resolve(work);
  if (path.basename(full).toLowerCase() !== 'work') return null;
  for (let dir = path.dirname(full); ; dir = path.dirname(dir)) {
    if (path.basename(dir).toLowerCase() === '.local') return path.join(dir, 'producer-cache');
    if (path.dirname(dir) === dir) return null;
  }
}

export const ledgerId = (environment, producer) => sha256(lower(environment) + '\n' + lower(producer)).slice(0, 40);

// ---- publications (ProducerLedger.Published / PublicationEnded / UnsafeUntil, the same files and the same rule).
// A publication changes the producer's published version at a moment SSAM does not see: between its start and its end. So
// an observation of the producer counts only when it was made after the end of every publication of it that SSAM knows:
//   published/<id>.json                {schema, environment, module, key, publishedAtUtc (start of the last one), source,
//                                       publicationId, endedAtUtc? (the latest end recorded)}
//   publishing/<id>.<publicationId>.json  one per publication in flight, from its start to its end (then deleted)
// A publication whose end is not recorded (in flight, a crash, a job that runs on the server after the call, such as a
// solution publish) counts as running for MAX_PUBLICATION_MS after its start. A publication whose modules are not known
// (solution publish, an extension publish without its name) is recorded under the producer "*" of its environment: it
// covers every producer there; a tenant that is not known is the environment "*".
export const PUBLISHING_SCHEMA = 'ssam-producer-publishing/1';
export const MAX_PUBLICATION_MS = 2 * 60 * 60 * 1000;
const safeId = text => String(text ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const writeWhole = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID().replace(/-/g, '') + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
};

// Records that SSAM starts a publication of the module in the environment: from now until its end (recordPublicationEnded)
// no observation of it as a producer counts, nor any made before. Answers the handle of the publication, or false.
export function recordPublished(dir, { environment, module, key = null, source = 'o11_publish', at = new Date(), id = null } = {}) {
  try {
    if (!dir || !String(environment ?? '').trim() || !String(module ?? '').trim()) return false;
    const publicationId = safeId(id) || randomUUID().replace(/-/g, '');
    const lid = ledgerId(environment, module);
    writeWhole(path.join(dir, 'publishing', lid + '.' + publicationId + '.json'),
      { schema: PUBLISHING_SCHEMA, environment, module, publicationId, startedAtUtc: at.toISOString(), source });
    writeWhole(path.join(dir, 'published', lid + '.json'),
      { schema: PUBLISHED_SCHEMA, environment, module, key, publishedAtUtc: at.toISOString(), source, publicationId });
    return { dir, environment, module, publicationId };
  } catch { return false; }
}

// Records the end of a publication recordPublished started (whatever its outcome): its marker goes and the record keeps the
// latest end. Never throws; an end that cannot be written only keeps the producer observed on the server longer.
export function recordPublicationEnded(handle, { at = new Date() } = {}) {
  try {
    if (!handle?.dir || !handle.environment || !handle.module || !handle.publicationId) return false;
    const lid = ledgerId(handle.environment, handle.module);
    const file = path.join(handle.dir, 'published', lid + '.json');
    const record = readJson(file);
    if (record?.schema === PUBLISHED_SCHEMA) {
      const before = Date.parse(record.endedAtUtc);
      if (!(Number.isFinite(before) && before >= at.getTime())) writeWhole(file, { ...record, endedAtUtc: at.toISOString() });
    }
    fs.rmSync(path.join(handle.dir, 'publishing', lid + '.' + safeId(handle.publicationId) + '.json'), { force: true });
    return true;
  } catch { return false; }
}

// An answer that does not prove the publication over (uncertain, still running, a job left on the server): its end is not
// recorded, so it counts as running for MAX_PUBLICATION_MS after its start.
export function publicationOpen(value) {
  if (!value || typeof value !== 'object') return true;
  return value.outcome === 'uncertain' || ['uncertain', 'preparing', 'running', 'accepted-unverified'].includes(value.state) || value.executionCompleted === false
    || /UNCERTAIN|TIMEOUT|RUNNING/.test(String(value.code ?? '')) || value.publish?.outcome === 'uncertain';
}

// The publication of `body` from its start to its end, recorded around it (the outcome of body is returned as it is); an
// answer that does not prove it over (publicationOpen) or a throw leaves it running.
export async function duringPublication(dir, options, body) {
  const handle = recordPublished(dir, options);
  const value = await body();
  if (!publicationOpen(value)) recordPublicationEnded(handle, { at: options?.now ? options.now() : new Date() });
  return value;
}

// Until when no observation of the producer in the environment counts (ms since the epoch; -Infinity when SSAM recorded no
// publication of it): the latest end of a finished publication, the start plus MAX_PUBLICATION_MS of one without an end.
export function unsafeUntil(dir, { environment, producer } = {}) {
  let until = -Infinity;
  const ids = new Set([[environment, producer], ['*', producer], [environment, '*'], ['*', '*']].map(([e, p]) => ledgerId(e, p)));
  for (const lid of ids) {
    const record = readJson(path.join(dir, 'published', lid + '.json'));
    if (record?.schema !== PUBLISHED_SCHEMA) continue;
    const start = Date.parse(record.publishedAtUtc), end = Date.parse(record.endedAtUtc);
    if (!Number.isFinite(start)) continue;
    until = Math.max(until, Number.isFinite(end) && end >= start ? end : start + MAX_PUBLICATION_MS);
  }
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'publishing')); } catch { names = []; }
  for (const name of names) {
    if (!ids.has(name.slice(0, 40)) || name[40] !== '.' || !name.endsWith('.json')) continue;
    const marker = readJson(path.join(dir, 'publishing', name));
    const start = Date.parse(marker?.startedAtUtc);
    if (marker?.schema === PUBLISHING_SCHEMA && Number.isFinite(start)) until = Math.max(until, start + MAX_PUBLICATION_MS);
  }
  return until;
}

// Every intact capture of the cache (ProducerCache.EntriesIn), optionally of one environment:
// {path, receipt, elements, environment, producer, storedAtUtc}.
export function cacheEntries(dir, { environment = null } = {}) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.json')); } catch { return out; }
  for (const name of names) {
    const envelope = readJson(path.join(dir, name));
    if (envelope?.format !== 1 || typeof envelope.payload !== 'string' || envelope.sha256 !== sha256(envelope.payload)) continue;
    let recorded;
    try { recorded = JSON.parse(envelope.payload); } catch { continue; }
    if (!recorded?.producer || (environment && lower(recorded.environment) !== lower(environment))) continue;
    const avsig = path.join(dir, name.replace(/\.json$/i, '.avsig'));
    try { if (!isFile(avsig) || recorded.sha256 !== sha256(fs.readFileSync(avsig))) continue; } catch { continue; }
    out.push({ path: avsig, receipt: recorded.receipt ?? {}, elements: Array.isArray(recorded.elements) ? recorded.elements.map(String) : [],
      environment: recorded.environment, producer: recorded.producer, storedAtUtc: recorded.storedAtUtc ?? null });
  }
  return out;
}

// ---- the ODC lane (kernel-delivery.mjs): the same rule over the public signature `studio reference-snapshot` acquires
// from the consumer session ({environment, producerKey, revision, sha256}). The lane has no server observation before
// the merge of its own, so the reference snapshot a delivery reuses for its build is acquired again right before the merge
// and must have the same bytes (PRODUCER_CHANGED otherwise, nothing merged): a round refused at the build makes no
// acquisition, a round that merges makes one, as before.
//   <cache>/odc/<id>.json + <id>.avsig   {schema, environment, producer, producerKey, revision, sha256, observedAtUtc}
export const ODC_SCHEMA = 'ssam-odc-reference/1';
export const WINDOW_VARIABLE = 'ANVIL_PRODUCER_TRUST_SECONDS';
export const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const SKEW_MS = 60 * 1000;
export function windowMs(env = process.env) {
  const text = String(env?.[WINDOW_VARIABLE] ?? '').trim();
  return /^\d+$/.test(text) ? Number(text) * 1000 : DEFAULT_WINDOW_MS;
}
const odcFiles = (dir, environment, producer) => { const base = path.join(dir, 'odc', ledgerId(environment, producer)); return { json: base + '.json', avsig: base + '.avsig' }; };
// An observation made at `at` that a publication SSAM recorded may have outdated (before its end, or while it runs).
const publishedSince = (dir, environment, producer, at) => at <= unsafeUntil(dir, { environment, producer });

// The reference snapshot of the producer in this environment that the workspace acquired lately, copied to target, when the
// window holds and no publication of it was recorded since: {sha256, producerKey, revision, observedAtUtc}; else null.
// Round 3 (M5): accept({studioName, producerKey, resolvedFrom}) says whether the observation is of the producer the job needs
// (the listed producer its text resolves to): a capture of a twin that shares the key is never taken.
export function reuseOdcReference(dir, { environment, producer, target, now = new Date(), window = windowMs(), accept = null } = {}) {
  try {
    if (!dir || !environment || !producer || !(window > 0)) return null;
    const files = odcFiles(dir, environment, producer);
    const record = readJson(files.json);
    if (record?.schema !== ODC_SCHEMA || lower(record.environment) !== lower(environment) || lower(record.producer) !== lower(producer)) return null;
    const at = Date.parse(record.observedAtUtc);
    if (!Number.isFinite(at) || at > now.getTime() + SKEW_MS || now.getTime() - at > window || publishedSince(dir, environment, producer, at)) return null;
    if (!isFile(files.avsig) || sha256(fs.readFileSync(files.avsig)) !== record.sha256) return null;
    const studioName = typeof record.studioName === 'string' && record.studioName ? record.studioName : record.producer;
    const resolvedFrom = Array.isArray(record.resolvedFrom) ? record.resolvedFrom.filter(n => typeof n === 'string') : [];
    if (accept && !accept({ studioName, producerKey: record.producerKey ?? null, resolvedFrom })) return null;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(files.avsig, target);
    return { sha256: record.sha256, producerKey: record.producerKey ?? null, revision: record.revision ?? null, observedAtUtc: new Date(at).toISOString(),
      studioName, ...(resolvedFrom.length ? { resolvedFrom } : {}), source: 'ledger' };
  } catch { return null; }
}

// A reference snapshot just acquired (its bytes verified by the caller) becomes the workspace's observation of the producer.
// fix/system-reference: producer is the binding key (System); studioName the name the Studio lists it by ((System)).
// Round 3 (M5): resolvedFrom, the texts a job wrote that the listing resolved to studioName ("OutSystemsUI" for "OutSystems UI").
export function rememberOdcReference(dir, { environment, producer, studioName = null, file, sha256: digest, producerKey = null, revision = null, resolvedFrom = null, now = new Date() } = {}) {
  try {
    if (!dir || !environment || !producer || !isFile(file)) return false;
    const files = odcFiles(dir, environment, producer);
    fs.mkdirSync(path.dirname(files.json), { recursive: true });
    fs.copyFileSync(file, files.avsig + '.tmp'); fs.renameSync(files.avsig + '.tmp', files.avsig);
    const temporary = files.json + '.' + randomUUID().replace(/-/g, '') + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ schema: ODC_SCHEMA, environment, producer, ...(studioName && studioName !== producer ? { studioName } : {}),
      ...(Array.isArray(resolvedFrom) && resolvedFrom.length ? { resolvedFrom: [...new Set(resolvedFrom.map(String))] } : {}), producerKey, revision,
      sha256: digest ?? sha256(fs.readFileSync(file)), observedAtUtc: now.toISOString() }));
    fs.renameSync(temporary, files.json);
    return true;
  } catch { return false; }
}

// ---- fix/system-reference (b, d): the captures of a producer the ODC lane already has, found by the producer's name.
// The capture folder of the lane is <odcRoot>/snapshots (kernel JobSources.IsCapturePath): studio_reference_snapshot writes
// its .avsig there (an envelope {FormatVersion, Environment, ModuleKey, Name, SignatureHash, Revision, ...}). Its identity
// is the envelope's; the name matches by binding key ("(System)" is the producer System).
// Round 2 (H1): the one rule of producer names (producer-names.mjs): "OutSystems UI" is the producer OutSystemsUI.
const keyOfName = name => canonicalKeyOf(name);
const sameName = (a, b) => sameProducer(a, b);
export function odcSignatureIdentity(file) {
  const envelope = readJson(file);
  if (!envelope || typeof envelope !== 'object' || typeof envelope.Name !== 'string' || typeof envelope.ModuleKey !== 'string') return null;
  return { environment: envelope.Environment ?? null, producer: envelope.Name, producerKey: envelope.ModuleKey, signatureHash: envelope.SignatureHash ?? null,
    revision: envelope.Revision == null || envelope.Revision === '' ? null : String(envelope.Revision) };
}
// One published signature: the same environment, producer key, signature hash and revision.
export const sameOdcIdentity = (a, b) => !!a && !!b && lower(a.environment) === lower(b.environment) && a.producerKey === b.producerKey
  && lower(a.signatureHash) === lower(b.signatureHash) && (a.revision ?? null) === (b.revision ?? null);
const avsigsUnder = (dir, depth = 3) => {
  const out = [];
  const walk = (d, left) => { let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const p = path.join(d, e.name); if (e.isDirectory() && left > 0) walk(p, left - 1); else if (e.isFile() && /\.avsig$/i.test(e.name)) out.push(p); } };
  walk(dir, depth); return out;
};
// Every intact capture of the producer, newest first: the delivery cache's (<cache>/odc, source "ledger") and the
// .avsig files of <odcRoot>/snapshots (source "snapshots"), optionally of one environment:
// [{path, sha256, environment, producer (the name the Studio lists), producerKey, revision, observedAtUtc, source}].
export function odcCaptures(odcRoot, { producer, environment = null, cache = odcRoot ? path.join(odcRoot, '.local', 'producer-cache') : null } = {}) {
  const out = [];
  if (!producer) return out;
  let names = [];
  try { names = cache ? fs.readdirSync(path.join(cache, 'odc')).filter(n => /\.json$/i.test(n)) : []; } catch { names = []; }
  for (const name of names) {
    const record = readJson(path.join(cache, 'odc', name)), file = path.join(cache, 'odc', name.replace(/\.json$/i, '.avsig'));
    if (!record?.producer || !(sameName(record.producer, producer) || sameName(record.studioName, producer))) continue;
    if (environment && lower(record.environment) !== lower(environment)) continue;
    try { if (!isFile(file) || sha256(fs.readFileSync(file)) !== record.sha256) continue; } catch { continue; }
    out.push({ path: file, sha256: record.sha256, environment: record.environment, producer: record.studioName ?? record.producer, producerKey: record.producerKey ?? null,
      revision: record.revision ?? null, observedAtUtc: record.observedAtUtc ?? null, source: 'ledger' });
  }
  for (const file of odcRoot ? avsigsUnder(path.join(odcRoot, 'snapshots')) : []) {
    const identity = odcSignatureIdentity(file);
    if (!identity || !sameName(identity.producer, producer)) continue;
    if (environment && lower(identity.environment) !== lower(environment)) continue;
    let stat, digest;
    try { stat = fs.statSync(file); digest = sha256(fs.readFileSync(file)); } catch { continue; }
    out.push({ path: path.resolve(file), sha256: digest, environment: identity.environment, producer: identity.producer, producerKey: identity.producerKey,
      revision: identity.revision, observedAtUtc: stat.mtime.toISOString(), source: 'snapshots' });
  }
  return out.sort((a, b) => (Date.parse(b.observedAtUtc) || 0) - (Date.parse(a.observedAtUtc) || 0) || a.path.localeCompare(b.path));
}
// A studio_reference_snapshot answer {ok, path, sha256, environment, producer, producerKey, revision} becomes the
// workspace's observation of the producer, by its binding key, when the file still has the bytes the bridge reported:
// the next delivery (and the offline check) finds it by the producer's name. Never throws; false when nothing was kept.
export function rememberOdcCaptureAnswer(dir, answer, { now = new Date() } = {}) {
  try {
    if (!dir || answer?.ok !== true || typeof answer.path !== 'string' || typeof answer.sha256 !== 'string') return false;
    const key = keyOfName(answer.producer);
    if (!key || !isFile(answer.path) || sha256(fs.readFileSync(answer.path)) !== answer.sha256.toLowerCase()) return false;
    return rememberOdcReference(dir, { environment: answer.environment, producer: key, studioName: answer.producer, file: answer.path, sha256: answer.sha256.toLowerCase(),
      producerKey: answer.producerKey ?? null, revision: answer.revision ?? null, now });
  } catch { return false; }
}

// The delivery cache's observation of the producer: {at, identity} of its intact capture, or null.
function supersededBy(dir, environment, producer) {
  try {
    if (!dir) return null;
    const files = odcFiles(dir, environment, producer);
    const record = readJson(files.json);
    const at = Date.parse(record?.observedAtUtc);
    if (record?.schema !== ODC_SCHEMA || !Number.isFinite(at) || !isFile(files.avsig) || sha256(fs.readFileSync(files.avsig)) !== record.sha256) return null;
    const identity = odcSignatureIdentity(files.avsig);
    return identity ? { at, identity } : null;
  } catch { return null; }
}

// F5 over the capture folder: the newest studio_reference_snapshot capture of the producer in this environment, copied to
// target, when it is recent (the same window as the delivery cache) and no publication of it was recorded since; the
// delivery acquires it again before the merge and compares the identity. {sha256, producerKey, revision, observedAtUtc,
// studioName, source:"snapshots", from} or null.
export function reuseOdcCapture(odcRoot, dir, { environment, producer, target, now = new Date(), window = windowMs(), accept = null } = {}) {
  try {
    if (!odcRoot || !environment || !producer || !(window > 0)) return null;
    // Round 2 (M1): a capture the workspace already proved out of date is never reused: the delivery cache holds a later
    // observation of the producer (a PRODUCER_CHANGED keeps the version it acquired) with another identity.
    const superseded = supersededBy(dir, environment, producer);
    const found = odcCaptures(odcRoot, { producer, environment, cache: null })
      .find(c => { const at = Date.parse(c.observedAtUtc); return Number.isFinite(at) && at <= now.getTime() + SKEW_MS && now.getTime() - at <= window && !(dir && publishedSince(dir, environment, producer, at))
        && !(superseded && superseded.at >= at && !sameOdcIdentity(superseded.identity, odcSignatureIdentity(c.path)))
        && (!accept || accept({ studioName: c.producer, producerKey: c.producerKey, resolvedFrom: [] })); });
    if (!found) return null;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(found.path, target);
    return { sha256: found.sha256, producerKey: found.producerKey, revision: found.revision, observedAtUtc: found.observedAtUtc, studioName: found.producer, source: 'snapshots', from: found.path };
  } catch { return null; }
}

// The producer changed: its observation goes, the next delivery acquires it again.
export function forgetOdcReference(dir, { environment, producer } = {}) {
  try { if (dir && environment && producer) { const files = odcFiles(dir, environment, producer); for (const f of [files.json, files.avsig]) fs.rmSync(f, { force: true }); } }
  catch { /* the next acquisition replaces it */ }
}

// ---- answers: what an o11_deliver task reused and how each producer was observed, short. {} without producers.
// producers: [{binding, producer, versionId|advertisedSignatureHash, signature: reused|captured|bound,
//   observed: ledger (no server call) | server | capture, observedAtUtc?, owner?: the producer whose foreign types it owns,
//   beforeMerge?: server}], producersNote: one sentence.
export function producerSignaturesOf(state) {
  const captured = state?.capturedProducers && typeof state.capturedProducers === 'object' && !Array.isArray(state.capturedProducers) ? state.capturedProducers : {};
  const key = file => (typeof file === 'string' && file ? path.resolve(file).toLowerCase() : null);
  const byPath = list => new Map((Array.isArray(list) ? list : []).filter(a => key(a?.path)).map(a => [key(a.path), a]));
  const before = byPath(state?.producerAttestation), merge = byPath(state?.producerAttestationBeforeMerge);
  const rows = [], seen = new Set();
  for (const [binding, entry] of Object.entries(captured)) {
    if (!entry || typeof entry !== 'object') continue;
    const file = key(entry.path); if (file) seen.add(file);
    rows.push({ binding, producer: entry.producer ?? binding,
      ...(Number.isInteger(entry.versionId) ? { versionId: entry.versionId } : entry.advertisedSignatureHash ? { advertisedSignatureHash: entry.advertisedSignatureHash } : {}),
      signature: entry.reusedFromCache ? 'reused' : 'captured', observed: entry.observed?.by ?? (file && before.get(file)?.by) ?? (entry.reusedFromCache ? 'server' : 'capture'),
      ...(entry.observed?.observedAtUtc ? { observedAtUtc: entry.observed.observedAtUtc } : {}),
      ...(typeof entry.reason === 'string' && entry.reason.startsWith('foreign-owner-of:') ? { owner: entry.reason.slice('foreign-owner-of:'.length) } : {}),
      ...(file && merge.has(file) ? { beforeMerge: merge.get(file).by ?? 'server' } : {}) });
  }
  // A bound .avsig (producers {Name: path}) is observed too: how, before the apply and before the merge.
  for (const [file, a] of before) {
    if (seen.has(file)) continue;
    rows.push({ producer: a.producer ?? null, ...(Number.isInteger(a.versionId) ? { versionId: a.versionId } : {}), signature: 'bound', observed: a.by ?? 'server',
      ...(merge.has(file) ? { beforeMerge: merge.get(file).by ?? 'server' } : {}) });
  }
  if (!rows.length) return {};
  const reused = rows.filter(r => r.signature === 'reused').length, serverless = rows.filter(r => r.observed === 'ledger').length;
  return { producers: rows.slice(0, 12), ...(rows.length > 12 ? { producersTotal: rows.length } : {}),
    producersNote: 'producer signatures: ' + reused + ' of ' + rows.length + ' reused from the cache, ' + serverless
      + ' without a call to the server (the same published version seen a moment ago, no publication since); before writing, the merge checks the version of each producer on the server' };
}

// ---- F6, the work packet: the cached signatures of the producers the intent needs. Deterministic: the same cache gives the
// same bytes (no dates, no cache times), sorted. A producer is needed when the intent names it, or names one of its cached
// elements, or it shares the app prefix of the module the packet reads (App_CS, App_IS, App_UI); never the module itself
// nor an owner cached by key. Each: the producer, its environment and published state, the cached elements and the
// reference op ready for the job; at most `max` producers and `elementsMax` elements each.
export function packetProducers(dir, { intent = '', module = null, environment = null, max = 3, elementsMax = 16 } = {}) {
  if (!dir) return null;
  const said = lower(intent);
  const words = [...new Set(said.split(/[^a-z0-9_]+/).filter(w => w.length >= 4))];
  const prefix = module && /_/.test(module) ? lower(module).slice(0, lower(module).lastIndexOf('_') + 1) : null;
  const latest = new Map();
  for (const e of cacheEntries(dir, environment ? { environment } : {})) {
    const name = e.receipt?.producer ?? e.producer;
    if (!name || String(e.producer).startsWith('@') || (module && lower(name) === lower(module))) continue;
    const k = lower(e.environment) + '\n' + lower(name);
    const held = latest.get(k);
    // The capture with the most elements of a producer; equal ones by their sorted elements, so the choice never depends on time.
    if (!held || e.elements.length > held.elements.length || (e.elements.length === held.elements.length && [...e.elements].sort().join('\n') < [...held.elements].sort().join('\n')))
      latest.set(k, { ...e, name });
  }
  const scored = [...latest.values()].map(e => {
    const names = e.elements.map(x => lower(String(x).split(':').pop()));
    const score = (said.includes(lower(e.name)) ? 100 : 0) + (prefix && lower(e.name).startsWith(prefix) ? 30 : 0)
      + names.filter(n => words.some(w => n.includes(w))).length * 5;
    return { e, score };
  }).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || lower(a.e.name).localeCompare(lower(b.e.name)) || lower(a.e.environment).localeCompare(lower(b.e.environment)));
  if (!scored.length) return null;
  const producers = scored.slice(0, max).map(({ e }) => {
    const r = e.receipt ?? {};
    const elements = [...e.elements].sort();
    const binding = /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name) ? e.name : e.name.replace(/[^A-Za-z0-9_]/g, '') || 'Producer';
    return { producer: e.name, environment: e.environment,
      ...(Number.isInteger(r.versionIdBefore) ? { versionId: r.versionIdBefore } : r.advertisedSignatureHash ? { advertisedSignatureHash: r.advertisedSignatureHash } : {}),
      op: { op: 'reference', producer: binding, elements: elements.slice(0, elementsMax) }, ...(elements.length > elementsMax ? { elementsTotal: elements.length } : {}) };
  });
  return { rule: 'signatures of the producers this request uses, already captured in this workspace: o11_deliver reuses them while this published version stays (no capture and no server call before the merge); put the reference op in the job and call the actions as Producer.Action', producers,
    ...(scored.length > max ? { more: scored.length - max } : {}) };
}
