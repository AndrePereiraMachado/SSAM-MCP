// CX10: one response-shape classifier shared by O11 and ODC. No schema defaults.
export function toolName(call) {
  const name = typeof call === 'string' ? call : call?.name ?? call?.tool ?? '';
  return name.replace(/^.*mcp__ssam[^.]*__/, '').replace(/^tools\./, '');
}
export function inferLane(call) {
  const args = call.args ?? call.arguments ?? call.input ?? {};
  if (args.lane === 'o11' || args.lane === 'odc') return args.lane;
  const name = toolName(call);
  if (/^(studio_|odc_|hybrid_)/.test(name)) return 'odc';
  if (/^o11_|^(context|propose|continue|status)$/.test(name)) return 'o11';
  return 'unknown';
}
export function isPublication(call) { return /^(o11_publish|studio_publish|odc_deploy)$/.test(toolName(call)); }
export function isDeliveryWrite(call) {
  const name = toolName(call), args = call.args ?? call.arguments ?? call.input ?? {};
  if (/^(o11_deliver|o11_job|propose|continue|studio_deliver|studio_merge|ssam_job)$/.test(name)) return true;
  if (name === 'ssam_code') return args.action === 'write';
  if (/^studio_data_(insert|update|delete|write|create|upsert)$/.test(name)) return true;
  return /^(o11_data|studio_data)$/.test(name) && /^(insert|update|delete|write|create|upsert|execute)$/.test(args.action ?? args.op ?? args.verb ?? '');
}
export function responseObject(value) {
  if (typeof value === 'string') {
    try { return responseObject(JSON.parse(value)); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  if (value.structuredContent && typeof value.structuredContent === 'object') return responseObject(value.structuredContent);
  if (Array.isArray(value)) {
    for (const part of value) { const object = responseObject(part.text ?? part); if (object) return object; }
    return null;
  }
  if (Array.isArray(value.content)) return responseObject(value.content);
  if (value.result && typeof value.result === 'object' && !('ok' in value)) return responseObject(value.result);
  return value;
}
// The delivery results (platforms/odc/facade/result-values.mjs): English since 16/10; the Portuguese values the sessions
// recorded before answered are kept, so old and new recordings classify alike.
const DELIVERED = new Set(['delivered', 'entregue']);
const DELIVERED_ANY = new Set([...DELIVERED, 'delivered and published', 'entregue e publicado']);
const refusalStages = new Set(['preflight', 'build', 'documents', 'apply', 'verify', 'check-base', 'preview']);
export function classifyOutcome(call) {
  const raw = call.output ?? call.result ?? call.response;
  const object = responseObject(raw);
  let code = object?.code ?? null;
  const outcome = object?.outcome;
  const write = isDeliveryWrite(call) || isPublication(call);
  const result = object?.result;
  const publishFailedAfterDelivery = object?.ok === false && DELIVERED.has(result) && object.failed === 'publish';
  const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  const clientError = call.isError || call.is_error || raw?.isError || raw?.is_error || call.status === 'failed';
  let classification;
  if (outcome === 'refused') classification = 'refused';
  else if (outcome === 'uncertain' || /_UNCERTAIN$/.test(code ?? '') || (write && /CANCELLED|TIMEOUT/.test(code ?? ''))) classification = 'uncertain';
  else if (!object && /InputValidationError\b/.test(rawText) && (clientError || /<tool_use_error>/.test(rawText))) { classification = 'refused'; code = 'CLIENT_INPUT_INVALID'; }
  else if (write && !object && (/Request timed out/i.test(rawText) || clientError)) classification = 'uncertain';
  else if (object?.ok === false && (refusalStages.has(object.failed) || /_REFUSED$/.test(code ?? ''))) classification = 'refused';
  else if (publishFailedAfterDelivery || (object?.ok === true && (DELIVERED_ANY.has(result) || outcome === 'delivered')) || (isPublication(call) && (outcome === 'published' || object?.status === 'succeeded'))) classification = 'accepted';
  else if (object?.ok === true && object.merged === false && object.publishInvoked === false && ['build', 'preview'].includes(object.until)) classification = 'staged';
  else if (object?.ok === false) classification = 'failed';
  else classification = 'unclassified';
  const problemCodes = [];
  const walk = value => { if (!value || typeof value !== 'object') return; if (typeof value.code === 'string') problemCodes.push(value.code); for (const [key, child] of Object.entries(value)) if (key !== 'code') { if (Array.isArray(child)) child.forEach(walk); else walk(child); } };
  for (const key of ['problems', 'errors', 'issues', 'refusals']) walk(object?.[key]);
  return { outcome: classification, code, problemCodes: [...new Set(problemCodes)], publishFailedAfterDelivery, shape: { keys: Object.keys(object ?? {}).sort(), code, failed: object?.failed ?? null, outcome: outcome ?? null } };
}
export function laneOutcomes(calls) {
  const empty = () => ({ writes: 0, accepted: 0, refused: 0, uncertain: 0, failed: 0, staged: 0, unclassified: 0, firstTimeRight: null, writesUntilAccepted: null, refusalCodes: {}, problemCodes: {}, publishFailedAfterDelivery: 0, publications: { writes: 0, accepted: 0, refused: 0, uncertain: 0, failed: 0, staged: 0, unclassified: 0 }, unclassifiedShapes: [] });
  const lanes = { o11: empty(), odc: empty(), unknown: empty() };
  for (const call of [...calls].sort((a, b) => (a.start ?? a.t ?? 0) - (b.start ?? b.t ?? 0))) {
    if (!isDeliveryWrite(call) && !isPublication(call)) continue;
    const lane = lanes[inferLane(call)], result = classifyOutcome(call);
    const counts = isPublication(call) ? lane.publications : lane;
    counts.writes++; counts[result.outcome]++;
    if (!isPublication(call)) {
      if (lane.writes === 1) lane.firstTimeRight = result.outcome === 'accepted';
      if (result.outcome === 'accepted' && lane.writesUntilAccepted == null) lane.writesUntilAccepted = lane.writes;
      if (result.publishFailedAfterDelivery) lane.publishFailedAfterDelivery++;
    }
    if (result.outcome === 'refused' && result.code) lane.refusalCodes[result.code] = (lane.refusalCodes[result.code] ?? 0) + 1;
    for (const code of result.problemCodes) lane.problemCodes[code] = (lane.problemCodes[code] ?? 0) + 1;
    if (result.outcome === 'unclassified') lane.unclassifiedShapes.push(result.shape);
  }
  return lanes;
}
