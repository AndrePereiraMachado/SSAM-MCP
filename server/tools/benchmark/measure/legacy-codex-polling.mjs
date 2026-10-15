// Source: esperas-rede/polls-codex.mjs; sha256: e2d3eec8d353fc102ef95365094ab11f78028defc4ee76201515c09c62271102.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
export function polling(rows) {
  let lastTok = null, lastOutAt = null; const res = { yields: 0, waits: 0, pollTurnInputTokens: 0, pollTurnOutputTokens: 0, modelGapSec: 0, waitSec: 0, examples: [] };
  const calls = new Map();
  let pendingPoll = null;
  for (const r of rows) {
    const p = r.payload ?? {};
    if (p.type === 'token_count' && p.info?.total_token_usage) {
      const t = p.info.total_token_usage;
      if (pendingPoll && lastTok) { res.pollTurnInputTokens += t.input_tokens - lastTok.input_tokens; res.pollTurnOutputTokens += t.output_tokens - lastTok.output_tokens; pendingPoll = null; }
      lastTok = t;
    }
    if (['function_call', 'custom_tool_call'].includes(p.type)) {
      calls.set(p.call_id, { name: p.name, at: r.timestamp });
      if (p.name === 'wait') { res.waits++; pendingPoll = true; if (lastOutAt) res.modelGapSec += (Date.parse(r.timestamp) - Date.parse(lastOutAt)) / 1000; }
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      const c = calls.get(p.call_id); const s = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
      if (c && /Script running with cell ID/.test(s)) { res.yields++; if (res.examples.length < 8) res.examples.push(`${c.at.slice(11, 19)} ${c.name} ${(Date.parse(r.timestamp) - Date.parse(c.at)) / 1000}s`); }
      if (c?.name === 'wait') res.waitSec += (Date.parse(r.timestamp) - Date.parse(c.at)) / 1000;
      lastOutAt = r.timestamp;
    }
  }
  res.modelGapSec = +res.modelGapSec.toFixed(1); res.waitSec = +res.waitSec.toFixed(1);
  res.inputTokensPerPoll = res.waits ? Math.round(res.pollTurnInputTokens / res.waits) : 0;

return res; }
