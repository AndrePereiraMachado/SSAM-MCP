// Source: esperas-rede/extrai-codex.mjs; sha256: 2b5642b0eb7a429162a7fb5ad9f3ccca4112596e78ffdac600d43dbe02f37b69.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
export function extractCodexCalls(sources) {
const subop = a => {
  if (!a || typeof a !== 'object') return '';
  return a.command ?? a.action ?? a.verb ?? a.view ?? a.kind ?? a.op ?? (a.intent ? 'intent' : a.job ? 'job' : '') ?? '';
};
function parseResult(res) {
  // returns {ok, code, outcome, problems[], timing{}} from structuredContent or text JSON
  let sc = res?.structuredContent;
  if (!sc) {
    const t = (res?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
    try { sc = JSON.parse(t); } catch { sc = null; }
  }
  const info = { ok: null, code: null, outcome: null, problems: [], timing: {} };
  if (!sc || typeof sc !== 'object') return info;
  info.ok = sc.ok ?? null; info.code = sc.code ?? sc.error?.code ?? null; info.outcome = sc.outcome ?? sc.result ?? null;
  const walk = (v, p, d) => {
    if (d > 8 || v == null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'number' && /(ms|Ms|Sec|seconds|elapsed|duration|wait)$/i.test(k)) info.timing[p + k] = x;
      else if (k === 'problems' && Array.isArray(x)) for (const pr of x) if (pr?.code) info.problems.push(pr.code);
      else if (typeof x === 'object') walk(x, p + k + '.', d + 1);
    }
  };
  walk(sc, '', 0);
  return info;
}

const calls = [], tools = [];
for (const o of sources) {
  const lines = (typeof o.rows === 'string' ? o.rows : o.rows.map(r=>JSON.stringify(r)).join('\n')).replace(/^\uFEFF/, '').split(/\r?\n/);
  const pending = new Map();
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    const p = r.payload ?? {};
    if (p.type === 'item_completed' && p.item?.type === 'McpToolCall') {
      if (p.thread_id && p.thread_id !== o.id) continue; // history copied from the parent
      const it = p.item;
      const dur = it.duration ? it.duration.secs + it.duration.nanos / 1e9 : (p.completed_at_ms - p.started_at_ms) / 1000;
      const info = parseResult(it.result);
      calls.push({
        thread: o.id.slice(0, 13), nick: o.nick ?? 'main', server: it.server, tool: it.tool, subop: String(subop(it.arguments)),
        start: new Date(p.started_at_ms).toISOString(), end: new Date(p.completed_at_ms).toISOString(), sec: dur,
        status: it.status, error: it.error ? String(it.error?.message ?? JSON.stringify(it.error)).slice(0, 300) : null,
        argBytes: Buffer.byteLength(JSON.stringify(it.arguments ?? {})), resBytes: Buffer.byteLength(JSON.stringify(it.result ?? '')),
        ...info, args: JSON.stringify(it.arguments ?? {}).slice(0, 300),
        text: (it.status !== 'completed' || info.ok === false || /REFUSED|"refused"/.test(JSON.stringify(it.result ?? ''))) ? JSON.stringify(it.result ?? it.error ?? '').slice(0, 400) : '',
      });
    }
    if (['function_call', 'custom_tool_call'].includes(p.type)) pending.set(p.call_id, { name: p.name, start: r.timestamp, input: String(p.arguments ?? p.input ?? '') });
    if (['function_call_output', 'custom_tool_call_output'].includes(p.type) && pending.has(p.call_id)) {
      const c = pending.get(p.call_id); pending.delete(p.call_id);
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
      const wall = /Wall time ([\d.]+) seconds/.exec(out);
      tools.push({ thread: o.id.slice(0, 13), nick: o.nick ?? 'main', name: c.name, start: c.start, end: r.timestamp,
        sec: (Date.parse(r.timestamp) - Date.parse(c.start)) / 1000, wallReported: wall ? Number(wall[1]) : null,
        inBytes: Buffer.byteLength(c.input), outBytes: Buffer.byteLength(out), input: c.input.slice(0, 300), output: out.slice(0, 300) });
    }
  }
}

return { calls, tools };
}
