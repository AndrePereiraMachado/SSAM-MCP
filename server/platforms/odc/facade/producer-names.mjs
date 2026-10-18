// fix/system-reference (2026-10-15): one rule for the name of a producer in a job, on both lanes, the same as the kernel's
// (kernel/src/Anvil.Core/Kernel/JobSources.cs IsPathSpec, BindingKey, SameProducer, StudioName). The Studio lists the system
// producer as "(System)" (ODC Manage Dependencies and ReferencesService.ListReferenceable, the O11 referenceable catalog); a
// job may write it "(System)", "System" or any casing of them, and they are one producer. Its binding (the kernel's
// --producer Name=<file>, the producers map, the name of the capture file) is the bare name inside the parentheses: System.
// Any other producer the Studio lists in the same "(Name)" form follows the same rule. Pure: no file, no Studio.
//
// fix/system-reference round 2 (H1): a producer value is a PATH only when it ends in .oml or .avsig (any case) or starts with
// job:; everything else is a NAME and never touches the disk. A name is compared without its outer spaces and one pair of
// parentheses ("(System) " is "System"); its binding key is the name itself when it is an identifier ("Users",
// "My_Lib"), else its letters and digits ("OutSystems UI" -> OutSystemsUI, "Flood-Utils" -> FloodUtils), the rule
// studio-module.mjs compactName already uses for module names. A name with / or \ has no binding key: it is matched only by
// its exact text and never bound (its capture file would be named after it).
const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEPARATOR = /[\\/]/;
const textOf = name => (typeof name === 'string' ? name : name == null ? '' : String(name));

// A capture or job source: "<...>.oml", "<...>.avsig", "job:<name>". Anything else is a producer name.
export const isPathSpec = name => { const t = textOf(name); return /\.(oml|avsig)$/i.test(t) || t.startsWith('job:'); };
// The name without its outer spaces and one pair of parentheses ("(System) " -> "System"); null for a path or nothing.
export function normalizedNameOf(name) {
  const text = textOf(name);
  if (!text || isPathSpec(text)) return null;
  let t = text.trim();
  if (t.length >= 2 && t[0] === '(' && t[t.length - 1] === ')') t = t.slice(1, -1).trim();
  return t || null;
}
// The letters and digits of a name, accents dropped (studio-module.mjs compactName, case kept).
export const compactOf = name => textOf(name).normalize('NFD').replace(/[^A-Za-z0-9]/g, '');

// The binding key of a producer name ("Users" -> "Users", "(System)" -> "System", "OutSystems UI" -> "OutSystemsUI"), or
// null (a path, job:<name>, a name with / or \, nothing).
export function bindingKeyOf(name) {
  const normalized = normalizedNameOf(name);
  if (normalized == null || SEPARATOR.test(normalized)) return null;
  if (BARE.test(normalized)) return normalized;
  return compactOf(normalized) || null;
}
export const isProducerName = name => bindingKeyOf(name) != null;
// Round 3 (H1-R): the key of a producer a listing names, a name with / or \ included ("Acme/Core Lib" -> AcmeCoreLib).
// Such a name is resolved against the listing ONLY by its exact text (resolveListedName) and then bound by this key, which
// the kernel accepts for it only with a capture whose envelope names exactly that producer (JobSources.Resolve): its letters
// alone never bind it ("..\System" never binds the System capture). The capture file is named by the key, never by the name.
export function listedKeyOf(name) {
  const normalized = normalizedNameOf(name);
  if (normalized == null) return null;
  return SEPARATOR.test(normalized) ? compactOf(normalized) || null : bindingKeyOf(name);
}
export const hasSeparator = name => SEPARATOR.test(normalizedNameOf(name) ?? '');
// A name the job writes that is no path and has no key at all (only punctuation, "()"): it never binds; the delivery answers
// for it with the producers the session offers.
export const isUnbindableName = name => !isPathSpec(name) && textOf(name).trim() !== '' && listedKeyOf(name) == null;
// The binding key a delivery uses: the system producer binds as System however the job writes it (the O11 convention
// System=(System)); any other by its key (null for a name with / or \: listedKeyOf binds it once it is resolved exactly).
export function canonicalKeyOf(name) {
  const key = bindingKeyOf(name);
  return key == null ? null : key.toLowerCase() === 'system' ? 'System' : key;
}
// The key of the slot a producer name takes, a name with / or \ included (System for "(System)", AcmeCoreLib).
export function slotKeyOf(name) {
  const key = listedKeyOf(name);
  return key == null ? null : key.toLowerCase() === 'system' ? 'System' : key;
}
// One slot by key, case-insensitive: "(System)", "System" and "system" are the same. Whether two names of one slot are one
// LISTED producer is the listing's to say (round 3, M5: producersNamed spellings, the delivery's resolution).
export function sameProducer(a, b) {
  const x = listedKeyOf(a), y = listedKeyOf(b);
  return x != null && y != null && x.toLowerCase() === y.toLowerCase();
}
// The name the Studio is asked for first: "(System)" for the system producer when the name IS System (without outer spaces
// and parentheses: "System", "(system)"; never a name that only shares its letters, "System." or "Sys tem": round 3, M5),
// "(Name)" for another wrapped name, else the name without its outer spaces (a name with / or \ as written).
export function studioNameOf(name) {
  const key = listedKeyOf(name);
  if (key == null) return null;
  const trimmed = textOf(name).trim(), normalized = normalizedNameOf(name);
  if (normalized.toLowerCase() === 'system') return '(System)';
  return trimmed.startsWith('(') && trimmed.endsWith(')') ? '(' + normalized + ')' : normalized;
}
// The binding key as the kernel writes it in --capture-producer (O11): "System=(System)", "Users",
// "OutSystemsUI=OutSystems UI", "AcmeCoreLib=Acme/Core Lib".
export function captureEntryOf(name) {
  const key = slotKeyOf(name);
  if (key == null) return null;
  const studio = studioNameOf(name);
  return studio === key ? key : key + '=' + studio;
}

// The note of a receipt when the Studio's name differs from the job's: never a silent rewrite.
export const nameNote = (written, studio) => written === studio ? null
  : `the job names "${written}"; the Studio lists this producer as "${studio}", so it was captured as "${studio}" and bound as ${slotKeyOf(written)}`;

// The producers a job names, one per slot key, in job order: {key, studio, written:[names as the job writes them],
// spellings:[the distinct names without outer spaces and parentheses, any case]}. Two spellings in one slot may be one
// listed producer ("OutSystems UI", "OutSystemsUI") or two that share their letters ("Flood Utils", "Flood-Utils"): only
// the listing tells (round 3, M5). names: the producer field of the job's reference ops (and of a prototype op's data.bind).
export function producersNamed(names) {
  const out = [];
  for (const name of names) {
    const key = slotKeyOf(name);
    if (key == null) continue;
    const spelling = normalizedNameOf(name).toLowerCase();
    const found = out.find(p => p.key.toLowerCase() === key.toLowerCase());
    if (found) { if (!found.written.includes(name)) found.written.push(name); if (!found.spellings.includes(spelling)) found.spellings.push(spelling); continue; }
    out.push({ key, studio: studioNameOf(name), written: [name], spellings: [spelling] });
  }
  return out;
}

const listedNames = listed => (Array.isArray(listed) ? listed : []).map(p => (typeof p === 'string' ? p : p?.name)).filter(n => typeof n === 'string' && n);
// The producer a listing of the consumer session (reference-producers, the O11 referenceable catalog) has for the name the
// job wrote, in this order, the first step with exactly one producer winning: the same text (any case), the same name
// without outer spaces and one pair of parentheses ("Tools" and "(Tools)"), then the same letters and digits ("OutSystemsUI"
// and "OutSystems UI"); a name with / or \ only by the first two. -> {listed, how:"exact"|"compact"} | {ambiguous:[names]}
// (two producers at the first step that matches: never guessed) | {listed:null}.
export function resolveListedName(name, listed) {
  const names = listedNames(listed);
  const text = textOf(name).trim().toLowerCase(), normalized = normalizedNameOf(name);
  if (!text || normalized == null) return { listed: null };
  const pick = (found, how) => (found.length === 1 ? { listed: found[0], how } : found.length > 1 ? { ambiguous: found } : null);
  const exact = pick(names.filter(n => n.trim().toLowerCase() === text), 'exact')
    ?? pick(names.filter(n => (normalizedNameOf(n) ?? '').toLowerCase() === normalized.toLowerCase()), 'exact');
  if (exact) return exact;
  const compact = compactOf(normalized).toLowerCase();
  if (SEPARATOR.test(normalized) || !compact) return { listed: null };
  return pick(names.filter(n => compactOf(normalizedNameOf(n) ?? n).toLowerCase() === compact), 'compact') ?? { listed: null };
}
// The listed name alone (null when none, or when two listed producers match).
export const listedNameOf = (name, listed) => resolveListedName(name, listed).listed ?? null;

// Round 2 (M4): the O11 kernel's coded refusal of a producer the referenceable catalog does not list (PRODUCER_UNKNOWN) or
// lists twice for the name (PRODUCER_AMBIGUOUS), in the shape of the ODC lane's: available (or candidates), the problem, and
// the exact corrected call: the same call with that capture entry bound to a listed name ("Sistema=<a name of available>":
// the job keeps its op, the binding names the producer as the catalog lists it). problems: the kernel's (problem.producer,
// problem.available); call: {tool, arguments} of the refused call; captures: the capture entries it ran (explicit and
// automatic). -> {code, producer, available, candidates?, problems, continuation} | null.
export function o11UnknownProducer(problems, { call, captures = [] } = {}) {
  const problem = (Array.isArray(problems) ? problems : []).find(p => p?.code === 'PRODUCER_UNKNOWN' || p?.code === 'PRODUCER_AMBIGUOUS');
  if (!problem || typeof problem.producer !== 'string') return null;
  const requested = problem.producer, ambiguous = problem.code === 'PRODUCER_AMBIGUOUS';
  const names = Array.isArray(problem.available) ? problem.available.filter(n => typeof n === 'string') : [];
  const entry = captures.map(String).find(e => { const [b, p] = e.split(/=(.*)/s); return (p || b).trim() === requested || (!p && sameProducer(b, requested)); }) ?? null;
  // fix/a5-lows (B9): the slot's key, a name with / or \ included ("Acme/Core Lib" -> AcmeCoreLib), the form
  // captureProducers "Key=Name" takes; the name as written would be refused as an entry ("Acme/Core Lib=...").
  const binding = entry ? (slotKeyOf(entry.split('=')[0]) ?? entry.split('=')[0]) : slotKeyOf(requested) ?? requested;
  const placeholder = ambiguous ? '<a name of candidates>' : '<a name of available>';
  const args = { ...(call?.arguments ?? {}) };
  const kept = (Array.isArray(args.captureProducers) ? args.captureProducers.map(String) : []).filter(e => e !== entry && !sameProducer(e.split('=')[0], binding));
  args.captureProducers = [...kept, binding + '=' + placeholder];
  if (args.producers && typeof args.producers === 'object') {
    const rest = Object.fromEntries(Object.entries(args.producers).filter(([k]) => !sameProducer(k, binding)));
    if (Object.keys(rest).length) args.producers = rest; else delete args.producers;
  }
  return { code: problem.code, producer: requested, ...(ambiguous ? { candidates: names } : {}), available: names.slice(0, 200),
    ...(names.length > 200 ? { availableTotal: names.length } : {}), problems: [problem],
    ...(call?.tool ? { continuation: { tool: call.tool, arguments: args,
      why: 'Bind ' + binding + ' to one of the names in ' + (ambiguous ? 'candidates' : 'available') + ' (as the referenceable catalog lists it); the same call then captures that producer read-only. Nothing was applied.' } } : {}) };
}

// The producer names a job writes, as written and in job order: the producer of each reference op and the data.bind.producer
// of each prototype op (docs/PROTOTIPO-NATIVO.md 2.12). document: the job ({ops} or an array of ops).
export function producerTextsOf(document) {
  const ops = Array.isArray(document) ? document : Array.isArray(document?.ops) ? document.ops : [];
  return ops.map(op => (op?.op === 'reference' ? op.producer : op?.op === 'prototype' ? op?.data?.bind?.producer : null)).filter(n => typeof n === 'string' && n.trim());
}

// fix/a5-lows (B10, review system-ref-3): a binding name with / or \ (a key of the producers map) is matched only by its exact
// text, the rule a job's own name with / or \ follows (round 3, H1-R): it binds the slot of its letters only when the job
// writes that producer with exactly that text (case and one pair of outer parentheses aside) and no op of the slot is
// written otherwise. "..\System" never binds the op "(System)"; a capture is never re-read as the producer of its letters.
// keys: the binding names given (producers map keys); names: the job's producer names (producerTextsOf); without them (no job
// to match against) every such key is refused. -> problems, one per such key, [] when every key binds as written.
export function separatorKeyProblems(keys, names) {
  const known = Array.isArray(names);
  const written = (known ? names : []).filter(n => typeof n === 'string' && slotKeyOf(n) != null);
  const problems = [];
  for (const key of keys ?? []) {
    if (!hasSeparator(key)) continue;
    const slot = slotKeyOf(key);
    if (slot == null) continue;
    const exact = normalizedNameOf(key).toLowerCase();
    const inSlot = [...new Set(written.filter(n => slotKeyOf(n).toLowerCase() === slot.toLowerCase()))];
    const other = inSlot.filter(n => normalizedNameOf(n).toLowerCase() !== exact);
    if (inSlot.length && !other.length) continue;
    const named = [...new Set(written)];
    const lead = 'Producer binding "' + key + '": a name with / or \\ binds only the reference ops whose producer is exactly that text, and ';
    problems.push({ at: 'producers/' + key, key, ...(other.length ? { ops: other } : {}),
      error: lead + (!known ? 'no job was given to match it against'
        : other.length < inSlot.length
        // some ops write the exact text and others write the slot another way: one binding would take both
        ? 'the job also names its slot ' + slot + ' as "' + other.join('", "') + '". Write the producer of those ops one way, exactly as the Studio lists it'
        : 'no op of the job names "' + key.trim() + '" (' + (named.length ? 'it names "' + named.join('", "') + '"' : 'it names no producer') + '). Bind each producer under the name the job writes')
        + '; "' + key.trim() + '" was not read as the producer of its letters (' + slot + ').' });
  }
  return problems;
}

// A normalized producers map {Name: file} keyed by binding key; {problems} for a name that is not a producer name, two
// names of one producer, or a name with / or \ that no op of the job (names) writes exactly (B10; names: null only where
// the caller checks it against the job itself).
export function producerBindings(map, { names } = {}) {
  const bindings = {}, problems = [];
  if (map == null) return { bindings, problems };
  if (typeof map !== 'object' || Array.isArray(map)) return { bindings, problems: [{ at: 'producers', error: 'producers is {Name: absolute path of a capture .avsig or .oml}' }] };
  const separated = names === null ? [] : separatorKeyProblems(Object.keys(map), names);
  for (const [name, file] of Object.entries(map)) {
    const key = slotKeyOf(name);
    if (key == null) { problems.push({ at: 'producers/' + name, error: 'Invalid producer binding name: ' + name + ' (a producer name as the Studio lists it, such as Users, OutSystems UI or (System); never a path)' }); continue; }
    const apart = separated.find(p => p.key === name);
    if (apart) { problems.push({ at: apart.at, error: apart.error }); continue; }
    const taken = Object.keys(bindings).find(k => k.toLowerCase() === key.toLowerCase());
    if (taken) { problems.push({ at: 'producers/' + name, error: 'Producer ' + key + ' is bound twice' }); continue; }
    bindings[key] = file;
  }
  return { bindings, problems };
}
