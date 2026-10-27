// The precision of ssam_discover over a labelled kind corpus (discover-kind-corpus.json, discover-kind-adversarial.json;
// family F4). Each item is judged ONLY with the labels written in its corpus file, never with the kind declarations the
// filter uses (app-kinds.mjs): the answer as the entry gives it (discoverAll); the relevant first answer (expect.top among
// the first three direct matches, or a "no proven recipe" native call that opens one of expect.native); a request the kind
// cannot hold (expect.none: the note, the native call, and no forbidden direct match); a question about SSAM records
// (expect.tools: the read tools first, no capability) or a build worded like one (expect.build: never answered as a
// question); a migration's source (expect.source); and the negative labels: no forbidden capability or text route in any
// tier, no OutSystems UI app type outside item.osui, no proven example for a forbidden capability.
//
//   scoreCorpus({ items, sets, discoverAll, sourcesOf }) -> { total, precise, precision, relevant, top1, forbidden, byKind, rows }
//
// A capture item (from: capture) names its module type: the module map answers the flow probe as the real map does (an
// element counts for every interface it carries: a Reactive or Mobile module's MobileFlow rows also come back under WebFlow).
export function fakeMap(moduleType) {
  const mobile = ['CrossDevice', 'Mobile', 'ReactiveLibrary', 'MobileLibrary'].includes(moduleType) ? 3 : 0;
  const flows = { WebFlow: (moduleType === 'WebResponsive' ? 3 : 0) + mobile, MobileFlow: mobile };
  return async request => ({ ok: true, file: 'Fixture.oml', sourceSha256: '0'.repeat(64), count: flows[request.kind] ?? 0, returned: 0, entries: [] });
}
export function inputOf(item, sources) {
  return { lane: item.lane, intent: item.intent, ...(sources ? { sources } : {}), ...(item.from === 'capture' ? { app: 'Fixture.oml', map: fakeMap(item.moduleType) } : {}) };
}
const forbiddenOf = (item, sets) => new Set((item.forbid ?? []).flatMap(x => sets?.[x] ?? [x]));
// What of the item's forbidden labels the answer carries.
export function forbiddenIn(answer, item, sets) {
  const forbid = forbiddenOf(item, sets); const out = [];
  for (const m of answer.matches ?? []) if (forbid.has(m.id)) out.push(`match ${m.id} (${m.via})`);
  for (const id of [answer.textRoute?.id].filter(Boolean)) if (forbid.has(id)) out.push(`textRoute ${id}`);
  if (Array.isArray(item.osui)) for (const t of answer.outsystemsUi?.appTypes ?? []) if (!item.osui.includes(t)) out.push(`outsystemsUi ${t}`);
  if (answer.provenExample?.for && forbid.has(answer.provenExample.for)) out.push(`provenExample for ${answer.provenExample.for}`);
  return out;
}
export function judge(answer, item, sets) {
  const direct = (answer.matches ?? []).filter(m => m.via === 'match').map(m => m.id);
  const call = answer.kind?.native?.call ?? null;
  const via = String(call?.arguments?.expand ?? '').split(':')[0] || null;
  const note = answer.kind?.noRecipe ? 'no proven recipe' + (via ? ' -> ' + via : '') : null;
  const got = [direct.join(',') || '-', note, answer.question ? 'question:' + answer.question.class : null, answer.tools?.length ? 'tools:' + answer.tools.map(t => t.tool).join(',') : null].filter(Boolean).join(' | ');
  const e = item.expect;
  if (e.tools) { const ok = e.tools.includes(answer.tools?.[0]?.tool) && direct.length === 0; return { ok, top1: ok, got }; }
  if (e.build && !e.top) { const ok = !answer.question; return { ok, top1: ok, got }; }
  if (e.build && answer.question) return { ok: false, top1: false, got };
  if (e.source && !(answer.kind?.source?.for ?? []).includes(e.source)) return { ok: false, top1: false, got };
  const forbid = forbiddenOf(item, sets);
  if (e.none) { const ok = !!note && !!call && !direct.some(id => forbid.has(id)) && (!e.native || e.native.includes(via)); return { ok, top1: ok, got }; }
  const top3 = direct.slice(0, 3).some(id => e.top.includes(id));
  const native = !!note && (e.native ?? []).includes(via);
  return { ok: top3 || native, top1: e.top.includes(direct[0]) || (direct.length === 0 && native), got };
}
export async function scoreCorpus({ items, sets = {}, discoverAll, sourcesOf = () => null }) {
  const rows = []; const byKind = {};
  for (const item of items) {
    const answer = JSON.parse(JSON.stringify(await discoverAll(inputOf(item, sourcesOf(item.lane)))));
    const verdict = judge(answer, item, sets);
    const bad = forbiddenIn(answer, item, sets);
    const precise = verdict.ok && bad.length === 0;
    const k = item.expect.tools ? 'question' : item.expect.build && !item.expect.top ? 'build-worded-as-question' : item.kind ?? 'none';
    byKind[k] ??= { total: 0, precise: 0 }; byKind[k].total++; if (precise) byKind[k].precise++;
    rows.push({ id: item.id, kind: item.kind, precise, relevant: verdict.ok, top1: verdict.top1 && bad.length === 0, got: verdict.got, forbidden: bad });
  }
  const precise = rows.filter(r => r.precise).length;
  return { total: rows.length, precise, precision: precise / rows.length, relevant: rows.filter(r => r.relevant).length, top1: rows.filter(r => r.top1).length,
    forbidden: rows.filter(r => r.forbidden.length).length, byKind, rows };
}
