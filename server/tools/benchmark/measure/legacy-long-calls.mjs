// Source: esperas-rede/longas-1213.mjs; sha256: 001a675a15506f5d96fe3e1722f930a7d7a618dfccae27319a6b1f467bb01e50.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
export function longCalls(sources) { const out=[],allGaps=[]; for (const source of sources) { const rows=source.rows;
  const meta = rows.find(r => r.type === 'session_meta')?.payload ?? {};
  const calls = []; let yields = 0, waits = 0, pollTokens = 0, lastTok = null, pending = false, lastOut = null; const gaps = [];
  for (const r of rows) {
    const pl = r.payload ?? {};
    if (pl.type === 'item_completed' && pl.item?.type === 'McpToolCall' && /^ssam-/.test(pl.item.server) && (!pl.thread_id || pl.thread_id === meta.id)) {
      const it = pl.item, a = it.arguments ?? {};
      let sc = it.result?.structuredContent; if (!sc) { try { sc = JSON.parse((it.result?.content ?? []).map(c => c.text ?? '').join('')); } catch { sc = null; } }
      calls.push({ at: new Date(pl.started_at_ms).toISOString(), tool: it.tool, subop: String(a.command ?? a.action ?? a.view ?? a.kind ?? ''), sec: it.duration ? it.duration.secs + it.duration.nanos / 1e9 : 0, ok: it.status === 'completed' && sc?.ok !== false, code: sc?.code ?? null });
    }
    if (pl.type === 'token_count' && pl.info?.total_token_usage) { if (pending && lastTok) { pollTokens += pl.info.total_token_usage.input_tokens - lastTok.input_tokens; pending = false; } lastTok = pl.info.total_token_usage; }
    if (pl.type === 'message' && pl.role === 'user') lastOut = null; // a new user turn: the gap is not model latency
    if (pl.type === 'function_call' && pl.name === 'wait') { waits++; pending = true; if (lastOut) gaps.push((Date.parse(r.timestamp) - Date.parse(lastOut)) / 1000); }
    if (pl.type === 'function_call_output') lastOut = r.timestamp;
    if (pl.type === 'function_call_output' && /Script running with cell ID/.test(typeof pl.output === 'string' ? pl.output : JSON.stringify(pl.output))) yields++;
  }
  if (!calls.length) continue;
  allGaps.push(...gaps);
  const long = calls.filter(c => c.sec > 28);
  const byTool = {}; for (const c of long) { const k = c.tool + (c.subop ? ':' + c.subop : ''); (byTool[k] ??= { n: 0, sec: 0 }); byTool[k].n++; byTool[k].sec = +(byTool[k].sec + c.sec).toFixed(1); }
  out.push({ file: source.name, parent: meta.parent_thread_id ? meta.parent_thread_id.slice(0, 8) : null, cwd: meta.cwd, first: calls[0].at, calls: calls.length, sec: +calls.reduce((n, c) => n + c.sec, 0).toFixed(1),
    over28: long.length, over28Sec: +long.reduce((n, c) => n + c.sec, 0).toFixed(1), over28ByTool: byTool, yields, waits, pollInputTokens: pollTokens, gaps });
}

const sorted = allGaps.slice().sort((a, b) => a - b);
const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
const under60 = sorted.filter(g => g <= 60);
const tot = k => out.reduce((n, o) => n + o[k], 0);
const agg = {}; for (const o of out) for (const [k, v] of Object.entries(o.over28ByTool)) { (agg[k] ??= { n: 0, sec: 0 }); agg[k].n += v.n; agg[k].sec = +(agg[k].sec + v.sec).toFixed(1); }
const summary = { sessions: out.length, calls: tot('calls'), sec: +tot('sec').toFixed(0), over28: tot('over28'), over28Sec: +tot('over28Sec').toFixed(0), yields: tot('yields'), waits: tot('waits'),
  pollInputTokens: tot('pollInputTokens'), pollGapMedianSec: +median.toFixed(1), pollGapSumUnder60Sec: +under60.reduce((n, g) => n + g, 0).toFixed(1), pollGapsCounted: sorted.length, over28ByTool: agg };

return {summary,sessions:out}; }
