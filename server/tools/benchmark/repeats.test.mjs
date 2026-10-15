import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { innerExecCalls, contractRequeries, measureRepeats, stableSignature, transcriptCalls } from './measure/contract-requeries.mjs';
import { repetition, measureAnswerRepetition, transcriptAnswers } from './measure/answer-repetition.mjs';
import { codexEntries } from './measure/answer-anatomy.mjs';
import { enrichRequest } from './measure/request-metrics.mjs';
const claudeQueryRows = (id, agentId, sidechain = false) => [
  { type: 'assistant', sessionId: 'session-root', agentId, isSidechain: sidechain, timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'tool_use', id, name: 'mcp__ssam__ssam_reference', input: { kind: 'rules', query: 'all' } }] } },
  { type: 'user', sessionId: 'session-root', agentId, isSidechain: sidechain, timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'same response'.repeat(40) }] } },
];
test('Claude resumed history uses the file session root in both main and subagent files', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-resume-'));
  try {
    const principal = path.join(temporary, 'current-session.jsonl');
    const subagent = path.join(temporary, 'current-session', 'subagents', 'agent-a1.jsonl');
    const main = claudeQueryRows('main-before').map(row => ({ ...row, sessionId: 'old-session' }));
    const before = claudeQueryRows('child-before', 'a1', true).map(row => ({ ...row, sessionId: 'old-session' }));
    const resumed = claudeQueryRows('child-after', 'a1', true).map(row => ({ ...row, sessionId: 'current-session', timestamp: '2026-01-01T00:00:03Z' }));
    for (const row of main) if (row.message.content[0].input) row.message.content[0].input.query = 'different-main-query';
    fs.mkdirSync(path.dirname(subagent), { recursive: true });
    fs.writeFileSync(principal, main.map(JSON.stringify).join('\n'));
    fs.writeFileSync(subagent, [...before, ...resumed].map(JSON.stringify).join('\n'));
    const sources = [principal, subagent].map(file => ({ file, rows: fs.readFileSync(file, 'utf8').split('\n').map(JSON.parse) }));
    // Follow production: the primary source is constructed by enrichRequest;
    // only options.file carries its path into that construction.
    const result = enrichRequest({ id: 'resume', client: 'claude', start: '2026-01-01T00:00:03Z', end: '2026-01-01T00:00:04Z', wallMin: 1 / 60 }, sources[0].rows, sources.slice(1), { file: principal, windows: [{}] }).repeats;
    const baseline = measureRepeats(sources.map(source => ({ ...source, rows: source.rows.map(row => ({ ...row, sessionId: 'current-session' })) })), { client: 'claude', from: Date.parse('2026-01-01T00:00:03Z') });
    assert.deepEqual(result.contractRequeries, { sameContext: 1, sameThread: 1 });
    assert.equal(result.repeatedChars, 'same response'.repeat(40).length);
    assert.deepEqual(result, baseline);
    const resumedMain = claudeQueryRows('main-after').map(row => ({ ...row, sessionId: 'current-session', timestamp: '2026-01-01T00:00:03Z' }));
    for (const row of resumedMain) if (row.message.content[0].input) row.message.content[0].input.query = 'different-main-query';
    const mainOnly = measureRepeats([{ file: principal, rows: [...main, ...resumedMain] }], { client: 'claude', from: Date.parse('2026-01-01T00:00:03Z') });
    assert.deepEqual(mainOnly.contractRequeries, { sameContext: 1, sameThread: 1 });
    assert.equal(mainOnly.repeatedChars, 'same response'.repeat(40).length);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
test('Claude main and subagent files share session root while keeping separate agent contexts', () => {
  const result = measureRepeats([{ file: 'session.jsonl', rows: claudeQueryRows('main-call') }, { file: 'subagents/agent-a1.jsonl', rows: claudeQueryRows('child-call', 'a1', true) }], { client: 'claude' });
  assert.equal(result.contractQueries, 2);
  assert.deepEqual(result.contractRequeries, { sameContext: 0, sameThread: 1 });
  assert.equal(result.repeatedChars, 0);
});
test('Claude inline sidechain copies are counted once and never share the main context', () => {
  const main = claudeQueryRows('main-call'), child = claudeQueryRows('child-call', 'a1', true);
  const result = measureRepeats([{ file: 'session.jsonl', rows: [...main, ...child] }, { file: 'subagents/agent-a1.jsonl', rows: child }, { rows: child }], { client: 'claude' });
  assert.equal(result.contractQueries, 2);
  assert.deepEqual(result.contractRequeries, { sameContext: 0, sameThread: 1 });
  assert.equal(result.repeatedChars, 0); assert.equal(result.answerChars, 2 * 'same response'.repeat(40).length);
});
test('Claude uses the subagent filename when agentId is absent and keeps different sessions independent', () => {
  const rootRows = claudeQueryRows('main-call'), childRows = claudeQueryRows('child-call', undefined, true);
  const result = measureRepeats([{ file: 'session.jsonl', rows: [...rootRows, ...childRows] }, { file: 'subagents/agent-a1.jsonl', rows: childRows }], { client: 'claude' });
  assert.equal(result.contractQueries, 2); assert.deepEqual(result.contractRequeries, { sameContext: 0, sameThread: 1 });
  assert.equal(result.repeatedChars, 0);
  const anotherSession = claudeQueryRows('main-call').map(row => ({ ...row, sessionId: 'another-session' }));
  const separate = measureRepeats([{ rows: rootRows }, { rows: anotherSession }], { client: 'claude' });
  assert.equal(separate.contractQueries, 2); assert.deepEqual(separate.contractRequeries, { sameContext: 0, sameThread: 0 });
});
test('exec literal parsing handles nested objects, escaped strings, multiple calls without eval', () => {
  const calls = innerExecCalls(`// tools.mcp__ssam__ssam_map({target:'ignored'})\ntext('tools.mcp__ssam__ssam_map({target:"ignored"})');\nawait Promise.all([tools.mcp__ssam__ssam_reference({lane:'odc',kind:"rules",query:{name:'a}b',parts:[1,true,null]},}), tools.mcp__ssam__ssam_discover({intent:'it\\\'s a screen',lane:'o11'})]);`);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].args.query, { name: 'a}b', parts: [1, true, null] });
  assert.equal(calls[1].args.intent, "it's a screen");
  assert.deepEqual(innerExecCalls('tools.mcp__ssam__ssam_map(process.exit())'), []);
});
test('contracts use full kind/query or intent/lane and include history before request', () => {
  const call = (name, args, start, thread = 'main') => ({ name, args, start, thread });
  const counts = contractRequeries([
    call('ssam_reference', { kind: 'rules', query: { a: 1, b: 2 } }, 1),
    call('ssam_reference', { query: { b: 2, a: 1 }, kind: 'rules' }, 3),
    call('ssam_reference', { kind: 'rules', query: { a: 1, b: 2 } }, 4),
    call('ssam_reference', { kind: 'rules', query: { a: 1, b: 2 } }, 5, 'child'),
    call('ssam_discover', { intent: 'screen', lane: 'odc' }, 2),
    call('ssam_discover', { intent: 'screen', lane: 'o11' }, 6),
    call('ssam_discover', { intent: 'screen', lane: 'odc' }, 7),
  ], { from: 3, to: 7 });
  assert.equal(counts.contractQueries, 5); assert.deepEqual(counts.contractRequeries, { sameContext: 3, sameThread: 3 }); assert.equal(counts.identicalReads, 1);
  assert.equal(stableSignature({ z: 1, a: 2 }), stableSignature({ a: 2, z: 1 }));
});
test('answer repetition sees previous context, resets at compaction, isolates threads', () => {
  const text = JSON.stringify({ contract: 'a'.repeat(400) });
  const entries = [{ tool: 'ssam_map', text, start: 1 }, { tool: 'ssam_map', text, start: 3 }, { reset: true, start: 4 }, { tool: 'ssam_map', text, start: 5 }, { tool: 'ssam_map', text, start: 6, thread: 'child' }];
  const result = measureAnswerRepetition(entries, { from: 3 });
  assert.equal(result.answerChars, 3 * text.length); assert.equal(result.repeatedChars, text.length);
  assert.equal(repetition([{ tool: 'ssam_map', text }, { tool: 'ssam_map', text }]).per.ssam_map.repeated, text.length);
});
test('long signatures are not truncated to 200 chars; writes never become identical reads', () => {
  const args = { target: 'a'.repeat(240) };
  const result = contractRequeries([{ name: 'ssam_map', args, start: 1 }, { name: 'ssam_map', args: { target: args.target + 'b' }, start: 2 }, { name: 'studio_deliver', args: {}, start: 3 }, { name: 'studio_deliver', args: {}, start: 4 }]);
  assert.equal(result.identicalReads, 0);
});
test('Claude wrapper measures repeated answers and contract calls from recorded row shapes', () => {
  const text = JSON.stringify({ rules: 'z'.repeat(320) });
  const rows = [1, 2].flatMap(n => [{ timestamp: `2026-01-01T00:00:0${n}Z`, type: 'assistant', message: { content: [{ type: 'tool_use', id: String(n), name: 'mcp__ssam__ssam_reference', input: { kind: 'rules', query: 'all' } }] } }, { timestamp: `2026-01-01T00:00:0${n}Z`, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: String(n), content: text }] } }]);
  const result = measureRepeats([{ rows }], { client: 'claude' });
  assert.equal(result.answerChars, 2 * text.length); assert.equal(result.repeatedChars, text.length);
  assert.equal(result.contractQueries, 2); assert.deepEqual(result.contractRequeries, { sameContext: 1, sameThread: 1 }); assert.equal(result.identicalReads, 1);
});
test('recorded exec-yield/wait headers do not count as repeated SSAM answers', () => {
  const rows = fs.readFileSync(new URL('./fixtures/recorded/exec-yield-wait.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
  const answers = transcriptAnswers(rows);
  assert.deepEqual(answers, []);
});
test('Codex exec yielding and wait completion carry the original SSAM attribution', () => {
  const rows = [
    { timestamp: '2026-01-01T00:00:01Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a', input: 'text(await tools.mcp__ssam__ssam_map({lane:"odc",target:"Module"}));' } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a', output: 'Script running with cell ID 42' } },
    { timestamp: '2026-01-01T00:00:03Z', type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: 'b', arguments: '{"cell_id":"42"}' } },
    { timestamp: '2026-01-01T00:00:04Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'b', output: JSON.stringify({ ok: true, data: 'x'.repeat(350) }) } },
  ];
  const answers = transcriptAnswers(rows); assert.equal(answers.length, 1); assert.equal(answers[0].tool, 'ssam:ssam_map');
  assert.equal(measureRepeats([{ rows }]).answerChars, answers[0].text.length);
});
test('authoritative MCP events cover variable arguments and do not duplicate exec calls or copied parent history', () => {
  const args = { lane: 'o11', kind: 'api', query: { op: 'logic' } };
  const event = (id, start, thread_id = 'main') => ({ type: 'event_msg', timestamp: new Date(start + 1000).toISOString(), payload: { type: 'item_completed', thread_id, started_at_ms: start, completed_at_ms: start + 1000, item: { type: 'McpToolCall', id, server: 'ssam-proto', tool: 'ssam_reference', arguments: args } } });
  const rows = [
    { type: 'session_meta', payload: { id: 'main' } },
    { timestamp: new Date(1000).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'literal', input: 'await tools.mcp__ssam_proto__ssam_reference({lane:"o11",kind:"api",query:{op:"logic"}})' } },
    { timestamp: new Date(3000).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'literal', output: '{"ok":true}' } },
    event('first', 1100),
    { timestamp: new Date(4000).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'variable', input: 'const args={lane:"o11",kind:"api",query:{op:"logic"}}; await tools.mcp__ssam_proto__ssam_reference(args)' } },
    event('second', 4100), event('copied', 5000, 'parent'),
  ];
  const calls = transcriptCalls(rows); assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.args), [args, args]);
  assert.deepEqual(measureRepeats([{ rows }]).contractRequeries, { sameContext: 1, sameThread: 1 });
});
test('known query pair across siblings gives sameContext zero and sameThread one, with complete first metadata IDs', () => {
  const root = '01a135c4-8333-7190-b72c-bb2c32460f1d';
  const children = ['01a135e5-0c3a-7f00-8449-ee61552717cc', '01a135e5-4985-7972-915e-944230ba9c6c'];
  const sources = children.map((id, index) => ({ rows: [
    { type: 'session_meta', payload: { id, parent_thread_id: root } },
    { type: 'session_meta', payload: { id: root } }, // Copied parent metadata must not replace the first record.
    { type: 'event_msg', timestamp: new Date(index * 1000 + 1000).toISOString(), payload: { type: 'item_completed', thread_id: id, started_at_ms: index * 1000 + 1000, item: { type: 'McpToolCall', id: 'call-' + index, server: 'ssam-proto', tool: 'ssam_reference', arguments: { lane: 'o11', kind: 'api', query: { op: 'logic' } } } } },
  ] }));
  assert.deepEqual(measureRepeats(sources).contractRequeries, { sameContext: 0, sameThread: 1 });
  assert.deepEqual(measureRepeats(sources, { from: 2000 }).contractRequeries, { sameContext: 0, sameThread: 1 });
});
test('sameThread counts every actual repeat across contexts, not only one known query pair', () => {
  const calls = [
    { name: 'ssam_reference', args: { kind: 'rules', query: 'all' }, start: 1, thread: 'root', rootThread: 'root' },
    { name: 'ssam_reference', args: { kind: 'rules', query: 'all' }, start: 2, thread: 'child-A', rootThread: 'root' },
    { name: 'ssam_reference', args: { kind: 'rules', query: 'all' }, start: 3, thread: 'child-B', rootThread: 'root' },
    { name: 'ssam_reference', args: { kind: 'api', query: { op: 'logic' } }, start: 4, thread: 'child-A', rootThread: 'root' },
    { name: 'ssam_reference', args: { kind: 'api', query: { op: 'logic' } }, start: 5, thread: 'child-B', rootThread: 'root' },
  ];
  assert.deepEqual(contractRequeries(calls, { from: 2 }).contractRequeries, { sameContext: 0, sameThread: 3 });
  assert.deepEqual(contractRequeries(calls.map(call => ({ ...call, rootThread: call.thread }))).contractRequeries, { sameContext: 0, sameThread: 0 });
});
test('string exec output cannot shift the tool labels of later array outputs', () => {
  const rows = [
    { timestamp: '2026-01-01T00:00:01Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'a', name: 'exec', input: 'text(await tools.mcp__ssam__ssam_map({lane:"odc"}))' } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a', output: '{"map":"first"}' } },
    { timestamp: '2026-01-01T00:00:03Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'b', name: 'exec', input: 'text(await tools.mcp__ssam__ssam_reference({lane:"odc",kind:"api",query:"all"}))' } },
    { timestamp: '2026-01-01T00:00:04Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'b', output: [{ type: 'input_text', text: '{"reference":"second"}' }] } },
  ];
  // W1 stays faithful: the original positional join mislabels this second answer.
  assert.equal(codexEntries(rows)[0].tool, 'ssam:ssam_map');
  assert.deepEqual(transcriptAnswers(rows).map(answer => answer.tool), ['ssam:ssam_map', 'ssam:ssam_reference']);
});
test('legacy refusal and schema groups remain visible in repetition byTool', () => {
  const rows = [
    { timestamp: '2026-01-01T00:00:01Z', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__ssam__o11_deliver', input: {} }] } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: '{"outcome":"refused","code":"PREFLIGHT_REFUSED"}' }] } },
  ];
  assert.ok(measureRepeats([{ rows }], { client: 'claude' }).byTool['ssam:recusas']);
});
