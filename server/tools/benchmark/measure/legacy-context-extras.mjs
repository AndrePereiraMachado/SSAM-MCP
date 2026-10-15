// Source: contexto/extras.mjs; sha256: 39b5e38e6b8aed6cfdb6aa89d74744622ff91b04595d683ff7d0f1f19388b2ad.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
export function extras(rows) { const lines=rows.map(r=>JSON.stringify(r));
  const calls = {}; const spawn = []; let truncN = 0, truncOrig = 0, truncShown = 0; const truncBy = {};
  const callCode = new Map();
  for (const l of lines) {
    const o = JSON.parse(l); const p = o.payload || {}; if (o.type !== 'response_item') continue;
    if (p.type === 'custom_tool_call') { callCode.set(p.call_id, p.input); for (const m of (p.input || '').matchAll(/tools\.mcp__ssam[a-z_]*__([a-z0-9_]+)\s*\(/g)) calls[m[1]] = (calls[m[1]] || 0) + 1; if (/ALL_TOOLS/.test(p.input)) calls['(ALL_TOOLS)'] = (calls['(ALL_TOOLS)'] || 0) + 1; }
    if (p.type === 'function_call' && /spawn_agent|followup_task|send_message/.test(p.name)) spawn.push({ name: p.name, chars: (p.arguments || '').length });
    if (p.type === 'custom_tool_call_output') for (const part of p.output || []) { const t = part.text || ''; const m = t.match(/original token count: (\d+)/); if (m) { truncN++; truncOrig += +m[1]; truncShown += t.length; const code = callCode.get(p.call_id) || ''; const tool = (code.match(/tools\.mcp__ssam[a-z_]*__([a-z0-9_]+)/) || [])[1] || (/ALL_TOOLS/.test(code) ? '(ALL_TOOLS)' : 'outro'); truncBy[tool] = (truncBy[tool] || 0) + 1; } }
  }
  const result = { ssamCalls: calls, truncated: { n: truncN, originalTokens: truncOrig, shownChars: truncShown, by: truncBy }, subagentMessages: spawn };

return result; }
