// Source: esperas-rede/resumo.mjs; sha256: 69d2c55ad72cce2ecb4bac65da3b474f683d7e4c43e670347c81244a64a75ffe.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
export function cat(tool, subop) {
  if (tool === 'o11_studio' && /^(status|wait|windows|errors|publish-log)$/.test(subop)) return 'poll';
  if (/^(studio_status|studio_wait|odc_operation_status|status|ssam_task|odc_status|continue)$/.test(tool)) return 'poll';
  if (/^(o11_publish|studio_publish|odc_deploy)$/.test(tool) || (tool === 'o11_extension' && subop === 'publish')) return 'publish';
  if (tool === 'o11_environment' && subop === 'refresh-refs') return 'publish';
  if (tool === 'o11_studio' || /^(studio_open|studio_close|studio_attach|studio_refresh_references|studio_snapshot|studio_dismiss_dialog|studio_command)$/.test(tool)) return 'studio';
  if (/^(o11_environment|o11_dependencies|o11_service_center_read|o11_service_center_write|o11_service_center_session|o11_access|o11_extension|odc_portal_read|odc_portal_write)$/.test(tool)) return 'environment';
  if (/^(o11_deliver|studio_deliver|ssam_job|o11_job|o11_data|studio_data|studio_data_insert|studio_data_update|studio_data_delete)$/.test(tool) || (tool === 'ssam_code' && subop === 'write')) return 'deliver';
  if (/^(ssam_doctor|ssam_connect)$/.test(tool)) return 'connect';
  return 'read';
}
const failed = c => c.status === 'failed' || c.isError || c.ok === false;

export function summarize(calls, label, window) {
  const sel = calls.filter(c => !window || (Date.parse(c.start) >= Date.parse(window[0]) && Date.parse(c.start) <= Date.parse(window[1])));
  const cats = {};
  for (const c of sel) { const k = cat(c.tool, c.subop); (cats[k] ??= { n: 0, sec: 0, fail: 0, failSec: 0 }); cats[k].n++; cats[k].sec += c.sec; if (failed(c)) { cats[k].fail++; cats[k].failSec += c.sec; } }
  for (const v of Object.values(cats)) { v.sec = +v.sec.toFixed(1); v.failSec = +v.failSec.toFixed(1); }
  const codes = {};
  for (const c of sel.filter(failed)) { const k = c.code ?? (c.isError ? 'IS_ERROR' : 'FAILED'); codes[k] = (codes[k] ?? 0) + 1; }
  // retries: same agent, same tool+subop, after a failure, within 180 s
  let retries = 0, retrySec = 0;
  const byAgent = {};
  for (const c of sel) (byAgent[(c.thread ?? c.session) + (c.nick ?? c.agent)] ??= []).push(c);
  for (const list of Object.values(byAgent)) {
    list.sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < list.length; i++) {
      const prev = list.slice(0, i).reverse().find(p => p.tool === list[i].tool && p.subop === list[i].subop);
      if (prev && failed(prev) && Date.parse(list[i].start) - Date.parse(prev.end) < 180000) { retries++; retrySec += list[i].sec; }
    }
  }
  const total = sel.reduce((n, c) => n + c.sec, 0);
  const fails = sel.filter(failed);
  return { label, calls: sel.length, sec: +total.toFixed(1), byCategory: cats, failed: fails.length, failedShare: +(fails.length / Math.max(1, sel.length)).toFixed(3),
    failedSec: +fails.reduce((n, c) => n + c.sec, 0).toFixed(1), failedByCode: codes, retriesAfterFailure: retries, retrySec: +retrySec.toFixed(1),
    resBytes: sel.reduce((n, c) => n + (c.resBytes ?? 0), 0), argBytes: sel.reduce((n, c) => n + (c.argBytes ?? 0), 0) };
}
