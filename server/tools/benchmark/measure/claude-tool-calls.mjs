// Source: esperas-rede/extrai-claude.mjs; sha256: 973ba9c152c8891852491f79d2bcdaaef719cb217217688f3c31c45c832d6289.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
function parse(content) {
  const text = typeof content === 'string' ? content : (content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
  let sc = null; try { sc = JSON.parse(text); } catch {}
  return { text, ok: sc?.ok ?? null, code: sc?.code ?? null, outcome: sc?.outcome ?? sc?.result ?? null,
    problems: Array.isArray(sc?.problems) ? sc.problems.map(p => p?.code).filter(Boolean) : [] };
}

export function extractClaudeCalls(sources) { const calls=[]; for (const source of sources) {
    const pending = new Map();
    for (const r of source.rows) {
      if (r.type === 'assistant') for (const c of r.message?.content ?? []) if (c.type === 'tool_use') pending.set(c.id, { name: c.name, start: r.timestamp, input: c.input });
      if (r.type === 'user' && Array.isArray(r.message?.content)) for (const c of r.message.content) if (c.type === 'tool_result' && pending.has(c.tool_use_id)) {
        const u = pending.get(c.tool_use_id); pending.delete(c.tool_use_id);
        const info = parse(c.content);
        const tool = u.name.replace(/^mcp__ssam[^_]*__/, '');
        const a = u.input ?? {};
        calls.push({ session: source.label, agent: source.agent ?? 'main', name: u.name, tool,
          subop: String(a.command ?? a.action ?? a.verb ?? a.view ?? a.kind ?? (a.intent ? 'intent' : '') ?? ''),
          start: u.start, end: r.timestamp, sec: (Date.parse(r.timestamp) - Date.parse(u.start)) / 1000, isError: !!c.is_error,
          ok: info.ok, code: info.code, outcome: info.outcome, problems: info.problems,
          argBytes: Buffer.byteLength(JSON.stringify(a)), resBytes: Buffer.byteLength(info.text),
          sleep: !u.name.startsWith('mcp__') && /Start-Sleep|\bsleep\s+\d/.test(JSON.stringify(a)), args: JSON.stringify(a).slice(0, 200), text: (c.is_error || info.ok === false) ? info.text.slice(0, 200) : '' });
      }
    }

} return calls; }
