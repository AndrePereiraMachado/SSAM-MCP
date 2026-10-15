export function measureColdStart(rows, calls, client = 'codex') {
  const first = calls.filter(c => c.ssam).sort((a,b)=>a.start-b.start)[0];
  const out = {sec:0,lostTurns:0,firstSsamCallSec:first?.sec ?? null,method:client === 'codex' ? 'not-recorded' : 'not-observed',intervals:[]};
  if (client === 'codex') return out;
  let began = null; const pending = new Map();
  for (const r of rows) {
    const t = Date.parse(r.timestamp);
    for (const c of Array.isArray(r.message?.content) ? r.message.content : []) {
      if (c.type === 'tool_use') pending.set(c.id,t);
      if (c.type === 'tool_result' && /still connecting/i.test(JSON.stringify(c.content)) && /ssam/i.test(JSON.stringify(c.content)+JSON.stringify(r.toolUseResult))) {
        began ??= pending.get(c.tool_use_id) ?? t; out.lostTurns++;
      }
    }
    const a = r.attachment;
    if (began !== null && a && /ssam/i.test(JSON.stringify(a.addedNames ?? a.servers ?? a.serverName ?? a.server ?? a.tools ?? a.instructions ?? '')) && !(a.pendingMcpServers ?? []).some(x=>/ssam/i.test(x))) {
      out.sec=(t-began)/1000; out.method='recorded';out.intervals=[{start:began,end:t}]; break;
    }
  }
  return out;
}
