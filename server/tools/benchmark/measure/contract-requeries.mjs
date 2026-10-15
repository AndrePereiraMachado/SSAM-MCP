import { toolName, isDeliveryWrite, isPublication } from './lane-outcomes.mjs';
export { measureRepeats } from './answer-repetition.mjs';

// Parse the literal subset used in recorded exec calls. Never execute transcript code.
export function parseLiteral(source) {
  let index = 0;
  const space = () => { while (index < source.length) { if (/\s/.test(source[index])) index++; else if (source.slice(index, index + 2) === '//') { while (index < source.length && source[index] !== '\n') index++; } else if (source.slice(index, index + 2) === '/*') { const end = source.indexOf('*/', index + 2); if (end < 0) throw Error('comment'); index = end + 2; } else break; } };
  const string = () => {
    const quote = source[index++]; let result = '';
    while (index < source.length) {
      const char = source[index++]; if (char === quote) return result;
      if (char === '\\') {
        const next = source[index++];
        if (next === 'u' || next === 'x') { const n = next === 'u' ? 4 : 2; result += String.fromCharCode(parseInt(source.slice(index, index + n), 16)); index += n; }
        else result += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' })[next] ?? next;
      } else { if (quote === '`' && char === '$' && source[index] === '{') throw Error('expression'); result += char; }
    }
    throw Error('string');
  };
  const value = () => {
    space(); const char = source[index];
    if (/['"`]/.test(char ?? '')) return string();
    if (char === '{' || char === '[') {
      const object = char === '{', result = object ? {} : []; index++; space();
      while (source[index] !== (object ? '}' : ']')) {
        if (index >= source.length) throw Error('unterminated');
        if (object) {
          space(); let key;
          if (/['"`]/.test(source[index])) key = string();
          else { const match = source.slice(index).match(/^[A-Za-z_$][\w$-]*/); if (!match) throw Error('key'); key = match[0]; index += key.length; }
          space(); if (source[index++] !== ':') throw Error('colon');
          Object.defineProperty(result, key, { value: value(), enumerable: true, configurable: true, writable: true });
        } else result.push(value());
        space(); if (source[index] === ',') { index++; space(); } else if (source[index] !== (object ? '}' : ']')) throw Error('comma');
      }
      index++; return result;
    }
    const match = source.slice(index).match(/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw Error('expression'); index += match[0].length; return JSON.parse(match[0]);
  };
  try { const result = value(); return { value: result, length: index }; } catch { return null; }
}
export function innerExecCalls(source) {
  const result = []; let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    if (/^['"`]/.test(rest)) { const literal = parseLiteral(rest); if (literal) { index += literal.length; continue; } }
    if (rest.startsWith('//')) { const end = source.indexOf('\n', index); index = end < 0 ? source.length : end + 1; continue; }
    if (rest.startsWith('/*')) { const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 2; continue; }
    const match = rest.match(/^tools\.([\w]+)\s*\(/);
    if (match) {
      const argument = parseLiteral(rest.slice(match[0].length));
      if (argument) result.push({ name: match[1], args: argument.value });
      index += match[0].length + (argument?.length ?? 0); continue;
    }
    index++;
  }
  return result;
}
export const stableSignature = value => {
  if (Array.isArray(value)) return '[' + value.map(stableSignature).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableSignature(value[key])).join(',') + '}';
  return JSON.stringify(value);
};
const objectArgs = value => { if (typeof value !== 'string') return value ?? {}; try { return JSON.parse(value); } catch { return null; } };
export function transcriptCalls(rows, { client = 'codex', thread = '', rootThread = thread, preferEvents = true } = {}) {
  const calls = [];
  for (const row of rows) {
    const at = Date.parse(row.timestamp ?? row.ts ?? '') || 0;
    if (client === 'claude') {
      if (row.type === 'assistant') for (const item of row.message?.content ?? []) if (item.type === 'tool_use') calls.push({ name: item.name, args: item.input ?? {}, start: at, id: item.id, thread, rootThread });
    } else if (row.type === 'response_item') {
      const item = row.payload ?? {};
      if (item.type === 'custom_tool_call' && /(?:^|\.)exec$/.test(item.name ?? '')) for (const call of innerExecCalls(item.input ?? '')) calls.push({ ...call, start: at, id: item.call_id, thread, rootThread });
      else if (['function_call', 'custom_tool_call'].includes(item.type)) {
        const args = objectArgs(item.arguments ?? item.input); if (args) calls.push({ name: item.name, args, start: at, id: item.call_id, thread, rootThread });
      }
    }
  }
  if (client !== 'codex' || !preferEvents) return calls;
  const sessionId = rows.find(row => row.type === 'session_meta')?.payload?.id;
  const outputTimes = new Map(rows.filter(row => row.type === 'response_item' && /_output$/.test(row.payload?.type ?? '')).map(row => [row.payload.call_id, Date.parse(row.timestamp) || 0]));
  const authoritative = [];
  for (const row of rows) {
    const payload = row.payload ?? {}, item = payload.item;
    if (payload.type !== 'item_completed' || item?.type !== 'McpToolCall' || !/ssam/i.test(item.server ?? '')) continue;
    if (sessionId && payload.thread_id && sessionId !== payload.thread_id) continue;
    const args = objectArgs(item.arguments); if (!args) continue;
    authoritative.push({ name: item.tool, args, start: payload.started_at_ms ?? Date.parse(row.timestamp), id: item.id, thread, rootThread });
  }
  // The event records the actual evaluated arguments, including calls made with
  // variables. Replace its exec-literal counterpart; never count both copies.
  const fallback = calls.filter(call => !authoritative.some(event => toolName(event) === toolName(call) && stableSignature(event.args) === stableSignature(call.args) && event.start >= call.start - 1000 && event.start <= (outputTimes.get(call.id) ?? call.start + 1000)));
  return [...fallback, ...authoritative].sort((a, b) => a.start - b.start);
}
const contractKey = call => {
  const name = toolName(call), args = call.args ?? {};
  if (name === 'ssam_reference' && args.kind != null && args.query != null) return name + ':' + stableSignature([args.kind, args.query]);
  if (name === 'ssam_discover' && args.intent != null) return name + ':' + stableSignature([args.intent, args.lane ?? null]);
  return null;
};
export function isRead(call) {
  if (isDeliveryWrite(call) || isPublication(call)) return false;
  return /^(ssam_reference|ssam_discover|odc_describe_operation|odc_search_operations|odc_describe_capability|studio_manifest|ssam_friction|ssam_map|o11_inspect|studio_inspect|ssam_evidence|studio_snapshot|getServerAction|getDataModel|getActionNames|getValidationMessages|listApps|o11_data|studio_data|o11_dependencies|studio_consumers|studio_reference_snapshot|o11_studio|o11_environment|ssam_connect|ssam_doctor|studio_attach|studio_open|studio_status|ssam_app_url|createSessionToken|omlReset|o11_service_center_session|o11_service_center_read|ssam_preview|studio_build|studio_check_base|Read|Grep|Glob|PowerShell|Bash|exec_command|view_image)$/.test(toolName(call));
}
export function contractRequeries(calls, { from = -Infinity, to = Infinity } = {}) {
  from = typeof from === 'string' ? Date.parse(from) : from;
  to = typeof to === 'string' ? Date.parse(to) : to;
  const histories = new Map(), rootHistories = new Map(), reads = new Set();
  let contractQueries = 0, identicalReads = 0;
  const repeated = { sameContext: 0, sameThread: 0 };
  const byTool = {};
  for (const call of [...calls].sort((a, b) => a.start - b.start)) {
    if (call.start > to) continue;
    const active = call.start >= from, key = contractKey(call), thread = call.thread ?? '';
    const seen = histories.get(thread) ?? new Set(); histories.set(thread, seen);
    const root = call.rootThread ?? thread;
    const rootSeen = rootHistories.get(root) ?? new Set(); rootHistories.set(root, rootSeen);
    if (key) {
      if (active) { contractQueries++; if (seen.has(key)) repeated.sameContext++; if (rootSeen.has(key)) repeated.sameThread++; }
      seen.add(key); rootSeen.add(key);
    }
    if (active && isRead(call)) {
      const signature = thread + ':' + toolName(call) + ':' + stableSignature(call.args ?? {});
      if (reads.has(signature)) { identicalReads++; const name = toolName(call); byTool[name] = (byTool[name] ?? 0) + 1; }
      reads.add(signature);
    }
  }
  return { contractQueries, contractRequeries: repeated, identicalReads, identicalReadsByTool: byTool };
}
