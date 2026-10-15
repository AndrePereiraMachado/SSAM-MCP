// Recorded counters take precedence; the two legacy estimators remain available for comparison.
import { responses } from './legacy-claude-responses.mjs';
const calibrationCache = new WeakMap();
const epoch = value => typeof value === 'number' ? value : Date.parse(value);

export function ownedRows(rows) {
  const id = rows.find(r => r.type === 'session_meta')?.payload?.id;
  return rows.filter(r => !id || !(r.thread_id || r.payload?.thread_id) || (r.thread_id || r.payload.thread_id) === id);
}

export function measureReasoning(sources, {client, from, to} = {}) {
  const start = from != null ? epoch(from) : -Infinity, end = to != null ? epoch(to) : Infinity;
  const windowFrom=Number.isFinite(start)?new Date(start).toISOString():undefined, windowTo=Number.isFinite(end)?new Date(end).toISOString():undefined;
  const inWindow = r => Date.parse(r.timestamp) >= start && Date.parse(r.timestamp) <= end;
  let tokens = 0, recorded = 0, chars = 0, time = 0, missing = 0;
  for (const source of sources) {
    let rows = ownedRows(source.rows);
    if(client==='claude' && source.main===false) rows=rows.map(r=>r.isSidechain?{...r,isSidechain:false}:r);
    if (client === 'codex') {
      for (const row of rows) if (row.type === 'token_usage_record' && inWindow(row)) {
        tokens += row.payload?.usage?.output_tokens || 0;
        recorded += row.payload?.usage?.reasoning_output_tokens || 0;
      }
      continue;
    }
    let cpt=calibrationCache.get(source.rows);
    if(cpt==null) {cpt=responses([{rows}]).cpt;calibrationCache.set(source.rows,cpt);}
    const estimates = responses([{rows, from:windowFrom, to:windowTo}],cpt).responses;
    const usage = new Map();
    for (const row of rows) if (row.type === 'assistant' && !row.isSidechain && inWindow(row)) {
      const m = row.message || {}, u = m.usage || {}, id = m.id || row.uuid;
      const old = usage.get(id) || {out:0, think:0, hasThinking:false,at:row.timestamp};
      old.out = Math.max(old.out, u.output_tokens || 0);
      if (u.output_tokens_details?.thinking_tokens != null) {old.hasThinking = true; old.think = Math.max(old.think, u.output_tokens_details.thinking_tokens);}
      usage.set(id, old);
    }
    for (const u of usage.values()) {tokens += u.out; recorded += u.think; if (!u.hasThinking) {missing++; recorded+=estimates.find(r=>r.ts===u.at)?.reas||0;}}
    for (const r of estimates) {chars += r.reas; time += r.reasT;}
  }
  const reasoningTokens = recorded;
  return {tokens, reasoningTokens, visibleTokens:Math.max(0,tokens-reasoningTokens), reasoningMethod:client === 'codex' || !missing ? 'recorded' : 'estimated-chars',
    ...(client !== 'codex' ? {estimators:{chars:{reasoningTokens:chars,method:'estimated-chars'},time:{reasoningTokens:time,method:'estimated-time'}}, missingThinkingCounters:missing} : {})};
}
