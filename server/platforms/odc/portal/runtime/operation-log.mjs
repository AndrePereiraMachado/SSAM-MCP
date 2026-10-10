// Publish errors of the ODC lane in ONE shape, for the Studio (bridge publish-log) and the Portal operations alike:
//   { type: 'error'|'warning'|'info', text, detail?, stage, element: {name, key?, kind?, source} | null, code?, at?, stepId? }
// plus counts, stages and a continuation that says what to fix. Pure: no I/O, no clock.
//
// Native sources. Studio (ODC Studio 1.7.27, decompiled read-only): the Publish command's BaseEspace1CPProcess calls
// PublishService.CheckPublish, which polls Deployments API v1 publish-operations/{key} and, once Finished or
// FinishedWithError, publish-operations/{key}/messages; every message lands in the server messages pane the bridge reads
// (studio/bridge/PublishLogCore.cs). Portal: the same publish-operations/{key}/messages and deployment-operations/{key}/
// messages (MessageDetailsV1TaskProgressMessage: timestamp, type, severity, message, additionalInfo{stepId, assetKey}) and
// build-operations/{key}/log-messages (BuildFeedbackDetails: timestamp, type, severity, message, stepId, assetKey,
// errorCode). No native message carries the element: its name comes from the quoted names of the text (the bridge also
// resolves it to a key in the open model).

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const clip = (text, max) => (text.length <= max ? text : text.slice(0, max - 1) + '…');

// stepId -> stage. The step identifiers are not documented: the known words map to the Studio's stages and any other id
// is kept as it is (lowercase), so nothing is lost.
const STAGE_WORDS = [[/upload/i, 'upload'], [/valid|verif|check/i, 'validation'], [/gener|codegen/i, 'generation'],
  [/compil|build|packag|bundl/i, 'compilation'], [/database|schema|migrat|\bdb\b|sql/i, 'database'], [/deploy|publish|provision|activat|apply|release/i, 'deploy']];
export function stageOf(stepId) {
  if (typeof stepId !== 'string' || !stepId.trim()) return 'unknown';
  for (const [re, stage] of STAGE_WORDS) if (re.test(stepId)) return stage;
  return stepId.trim().toLowerCase();
}

export function typeOf(severity) {
  const s = String(severity ?? '');
  if (/error|fatal|critical/i.test(s)) return 'error';
  if (/warn/i.test(s)) return 'warning';
  return 'info';
}

// The quoted identifiers of a message, in order (the rule of the bridge's PublishLogCore.Candidates): 'X', "X", ‘X’, “X”,
// no whitespace inside (an apostrophe never pairs with the next quote), identifier-like, at most 120 characters.
const QUOTED = /[‘'“"]([^\s‘’'“”"]{1,120})[’'”"]/gu;
const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_.-]{0,119}$/u;
export function elementCandidates(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(QUOTED)) {
    const name = m[1].replace(/[.,:;]+$/, '');
    if (IDENTIFIER.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
export const elementOf = text => { const [name] = elementCandidates(text); return name ? { name, key: null, kind: null, source: 'text' } : null; };

// One Portal message (publish/deployment messages or build log-messages) in the log shape.
export function normalizeMessage(raw) {
  if (!isObject(raw)) return null;
  const text = String(raw.message ?? raw.text ?? '').trim();
  if (!text) return null;
  const stepId = raw.additionalInfo?.stepId ?? raw.stepId ?? null;
  const assetKey = raw.additionalInfo?.assetKey ?? raw.assetKey ?? null;
  const type = typeOf(raw.severity ?? raw.type);
  const code = raw.errorCode ?? (typeof raw.type === 'string' && !/^(error|warning|info)$/i.test(raw.type) ? raw.type : null);
  return { type, text, stage: stageOf(stepId), element: type === 'info' ? null : elementOf(text),
    ...(code ? { code } : {}), ...(raw.timestamp ? { at: raw.timestamp } : {}), ...(stepId ? { stepId } : {}), ...(assetKey ? { assetKey } : {}) };
}

// A Portal answer (array, {results}, {items} or {data}) -> the messages, in the order the server gave them.
export function portalMessages(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : [];
  return list.map(normalizeMessage).filter(Boolean);
}

export function logOf(messages, state = null) {
  const count = type => messages.filter(m => m.type === type).length;
  const stages = [...new Set(messages.map(m => m.stage).filter(s => s && s !== 'unknown'))];
  const counts = { errors: count('error'), warnings: count('warning'), infos: count('info') };
  const first = messages.find(m => m.type === 'error');
  return { ...(state ? { state } : {}), summary: (state ?? 'messages') + ': ' + counts.errors + ' error(s), ' + counts.warnings + ' warning(s)' + (first ? '; first error: ' + clip(first.text, 200) : ''),
    stages, lastStage: stages.at(-1) ?? null, counts, messages };
}

// What to fix, from the first error (else the first warning of a failed operation): the element by key (studio_inspect),
// by name (ssam_map) or, without an element or a module, the intent (ssam_discover). Never a write: the fix is a new
// delivery and a new publication or deployment with the user's own words.
export function fixContinuation({ module = null, messages = [], failed = true, retry = 'publique de novo' } = {}) {
  const target = messages.find(m => m.type === 'error') ?? (failed ? messages.find(m => m.type === 'warning') : null);
  if (!target) return null;
  const where = target.stage && target.stage !== 'unknown' ? ' (' + target.stage + ')' : '';
  const then = `corrija com studio_deliver (patch sobre o job da recusa, quando houver) e ${retry} com as palavras do usuário; nunca repita sem mudança`;
  const quote = '"' + clip(target.text, 240) + '"';
  const el = target.element;
  if (el?.key && module) return { tool: 'studio_inspect', arguments: { target: module, path: '@' + el.key, depth: 3 },
    why: `falhou${where}: ${quote}. Leia ${el.name}${el.kind ? ' (' + el.kind + ')' : ''}, ${then}.` };
  if (el?.name && module) return { tool: 'ssam_map', arguments: { lane: 'odc', target: module, name: el.name },
    why: `falhou${where}: ${quote}. Ache ${el.name} no mapa (a @key leva ao studio_inspect), ${then}.` };
  return { tool: 'ssam_discover', arguments: { intent: 'corrigir erro de publicação ODC: ' + clip(target.text, 300), lane: 'odc' },
    why: `falhou${where}: ${quote}${el?.name ? ' (cita ' + el.name + ')' : ''}. Descubra a operação que corrige, ${then}.` };
}

// An operationStatus answer (portal/runtime/access.mjs) -> + log for publish, build and deployment; a failed one also
// carries the fix continuation (an answer still running keeps its own continuation).
export const LOG_KINDS = new Set(['publish', 'build', 'deployment']);
export function withOperationLog(value, { module = null } = {}) {
  if (!isObject(value) || value.ok !== true || !LOG_KINDS.has(value.kind) || value.messages === undefined || (isObject(value.messages) && value.messages.error)) return value;
  const log = logOf(portalMessages(value.messages), value.status ?? null);
  const out = { ...value, log };
  if (value.failed && !value.continuation) {
    const fix = fixContinuation({ module, messages: log.messages, failed: true, retry: value.kind === 'deployment' ? 'implante de novo' : 'publique de novo' });
    if (fix) out.continuation = fix;
  }
  return out;
}
