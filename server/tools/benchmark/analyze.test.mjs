import { originalProfile } from '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseJsonl, analyzeCodex, analyzeClaude, analyzeFiles, formatMarkdown, formatLegacyMarkdown, category, main as analyzeMain } from './analyze.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => path.join(here, 'fixtures', name);
test('new CLI publishes turns, skips injected prompts and retains first Markdown table',()=>{const input=rows('codex.jsonl'),user=input.find(r=>r.payload?.type==='message'&&r.payload.role==='user');user.payload.content.unshift({type:'input_text',text:'# AGENTS.md instructions for injected folder'});const requests=analyzeCodex(input);assert.ok(!requests[0].prompt.startsWith('# AGENTS'));assert.ok(formatMarkdown(requests).startsWith(formatLegacyMarkdown(requests)));const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cx10-turns-'));try{const [request]=analyzeMain(['--codex',fixture('codex.jsonl'),'--turns','--json',path.join(temp,'out.json')]);assert.ok(Array.isArray(request.context.turns));assert.throws(()=>analyzeMain(['--bad','--window','bad']),e=>e.message.includes('Unknown flag')&&e.message.includes('Invalid window')&&e.message.includes('Provide --codex'));}finally{const resolved=path.resolve(temp);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});}});
const rows = name => parseJsonl(fs.readFileSync(fixture(name), 'utf8'));
const bytes = text => Buffer.byteLength(text, 'utf8') / 1024;
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual}, expected ${expected} ± ${tolerance}`);
const kbNear = (actual, expected, label) => near(actual, expected, expected * .03, label);
const child = (name, file) => ({ file: file ?? fixture(name), rows: rows(name) });

test('all synthetic fixtures stay at or below forty JSONL records', () => {
  for (const name of fs.readdirSync(path.join(here, 'fixtures'))) {
    if (!name.endsWith('.jsonl')) continue;
    const lines = fs.readFileSync(fixture(name), 'utf8').trim().split(/\r?\n/);
    assert.ok(lines.length <= 40, `${name}: ${lines.length}`);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  }
});

test('Codex merges an aborted turn, measures UTF-8 inputs and list outputs, and parses only structured SSAM refusal', () => {
  const input = rows('codex.jsonl');
  const requests = analyzeCodex(input, { file: fixture('codex.jsonl') });
  assert.equal(requests.length, 2);
  const request = requests[0];
  assert.equal(request.model, 'test-model');
  assert.match(request.prompt, /^\[BenchSSAM/);
  near(request.wallMin, 16 / 60, 1e-8, 'wall');
  assert.equal(request.rounds, 4);
  assert.equal(request.outputTokens, 15);
  assert.equal(request.toolSecSum, 7);
  assert.equal(request.toolSecUnion, 7);
  assert.equal(request.ssamSec, 6);
  const calls = input.filter(r => ['function_call', 'custom_tool_call'].includes(r.payload?.type));
  near(request.writtenKB, calls.reduce((n, r) => n + bytes(r.payload.arguments ?? r.payload.input), 0), 1e-10, 'UTF-8 input bytes');
  const outputs = input.filter(r => ['function_call_output', 'custom_tool_call_output'].includes(r.payload?.type));
  near(request.readKB, outputs.reduce((n, r) => n + bytes(typeof r.payload.output === 'string' ? r.payload.output : JSON.stringify(r.payload.output)), 0), 1e-10, 'list output bytes');
  assert.equal(request.refusals.length, 1);
  assert.equal(request.refusals[0].code, 'PREFLIGHT_REFUSED');
  assert.deepEqual([...request.refusals[0].problems].sort(), ['GRAMMAR', 'SHAPE']);
  assert.equal(request.refusalsByCode.PREFLIGHT_REFUSED, 1);
  assert.equal(request.accepted, true);
  assert.equal(Date.parse(request.acceptedAt), Date.parse('2026-01-01T12:00:11Z'));
  assert.match(request.start, /-03:00$/);
  assert.match(request.end, /-03:00$/);
  near(request.modelPct, 100 - 100 * 7 / 16, 1e-8, 'model percent');
});

test('Codex ignores copied parent history and aggregates two attributed child turns', () => {
  const [request] = analyzeCodex(rows('codex.jsonl'), { file: fixture('codex.jsonl'), subagents: [child('codex-child.jsonl')] });
  assert.equal(request.subagents.length, 1);
  const sub = request.subagents[0];
  assert.equal(sub.name, 'Helper');
  assert.equal(sub.rounds, 2);
  assert.equal(sub.outputTokens, 30);
  near(sub.writtenKB, 4 / 1024, 1e-10, 'child excludes copied call');
  near(sub.readKB, 5 / 1024, 1e-10, 'child reads');
  assert.equal(request.roundsTotal, 6);
  near(request.writtenKBTotal, request.writtenKB + sub.writtenKB, 1e-10, 'total writes');
});

test('tag filtering is based on the first prompt line', () => {
  assert.equal(analyzeCodex(rows('codex.jsonl'), { tag: 'BenchSSAM' }).length, 1);
  assert.equal(analyzeClaude(rows('claude.jsonl'), { tag: 'BenchSSAM' }).length, 1);
  assert.equal(analyzeCodex(rows('codex.jsonl'), { tag: 'DifferentTag' }).length, 0);
  const input = rows('codex.jsonl');
  input.find(r => r.payload?.content?.[0]?.text?.startsWith('[BenchSSAM')).payload.content[0].text = 'Ordinary first line\n[BenchSSAM round=01]';
  assert.equal(analyzeCodex(input, { tag: 'BenchSSAM' }).length, 0);
});

test('Codex selects the first non-context input_text part inside a multipart user message', () => {
  const input = rows('codex.jsonl');
  const context = input.find(r => r.payload?.content?.[0]?.text?.startsWith('<context>'));
  const prompt = input.find(r => r.payload?.content?.[0]?.text?.startsWith('[BenchSSAM'));
  context.payload.content.push(prompt.payload.content[0]);
  input.splice(input.indexOf(prompt), 1);
  const requests = analyzeCodex(input, { tag: 'BenchSSAM' });
  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /^\[BenchSSAM/);
});

test('Claude accepts isMeta prompt, unions overlapping calls, deduplicates usage and distinguishes refusal from prose', () => {
  const requests = analyzeClaude(rows('claude.jsonl'), { file: fixture('claude.jsonl'), subagents: [child('claude-child.jsonl')] });
  assert.equal(requests.length, 2);
  const request = requests[0];
  assert.match(request.prompt, /^\[BenchSSAM/);
  assert.equal(request.model, 'claude-test');
  assert.equal(request.rounds, 3);
  assert.equal(request.outputTokens, 30);
  assert.equal(request.toolSecSum, 8);
  assert.equal(request.toolSecUnion, 6);
  assert.equal(request.ssamSec, 8);
  near(request.writtenKB, bytes(JSON.stringify({ text: 'ação' })) + 4 / 1024, 1e-10, 'Claude writes');
  assert.equal(request.refusals.length, 1);
  assert.deepEqual(request.refusals[0].problems, ['GRAMMAR']);
  assert.equal(request.refusedOrError, 2);
  assert.equal(request.accepted, true);
  assert.equal(request.subagents.length, 1);
  assert.equal(request.subagents[0].rounds, 1);
  assert.equal(request.subagents[0].outputTokens, 5);
});

test('explicit Claude window joins prompts and ends at the last selected record', () => {
  const [request] = analyzeClaude(rows('claude.jsonl'), { windows: [{ name: 'joined', start: '2026-01-01T12:00:00Z', end: '2026-01-01T12:01:00Z' }] });
  near(request.wallMin, 14 / 60, 1e-8, 'selected-record span');
  assert.equal(request.rounds, 3);
});

test('explicit Codex window uses the cumulative token baseline before its start', () => {
  const [request] = analyzeCodex(rows('codex.jsonl'), { windows: [{ name: 'first', start: '2026-01-01T12:00:01Z', end: '2026-01-01T12:00:17Z' }] });
  assert.equal(request.outputTokens, 15);
});

test('SSAM classification covers nested code and historical shell commands without including unrelated MCPs', () => {
  assert.equal(category('mcp__ssam_novo__ssam_code', '{}'), 'ssam');
  assert.equal(category('functions.exec', 'tools.mcp__ssam__o11_deliver({})'), 'ssam');
  assert.equal(category('functions.exec_command', '{"cmd":"ssam.cmd run_job job.json"}'), 'ssam');
  assert.equal(category('Bash', 'dotnet Anvil.dll inspect'), 'ssam');
  assert.equal(category('mcp__outsystems__apply', '{}'), 'other-mcp');
  assert.equal(category('functions.exec_command', '{"cmd":"echo unrelated"}'), 'other');
});

test('Codex discovery attaches attributed child turns from the following day', () => {
  const temp = fs.mkdtempSync(path.join(here, '.test-next-day-'));
  try {
    const first = path.join(temp, '2026', '01', '01');
    const next = path.join(temp, '2026', '01', '02');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(next, { recursive: true });
    const session = path.join(first, 'principal.jsonl');
    fs.copyFileSync(fixture('codex.jsonl'), session);
    const input = rows('codex-child.jsonl');
    for (const row of input) row.timestamp = row.timestamp.replace('2026-01-01', '2026-01-02');
    fs.writeFileSync(path.join(next, 'child.jsonl'), input.map(row => JSON.stringify(row)).join('\n'));
    const requests = analyzeFiles({ codex: [session], tag: 'BenchSSAM' });
    assert.equal(requests[0].subagents.length, 1);
    assert.equal(requests[0].subagents[0].rounds, 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('file discovery finds Claude sibling subagents and CLI writes valid Markdown and JSON', () => {
  const temp = fs.mkdtempSync(path.join(here, '.test-discovery-'));
  try {
    const session = path.join(temp, 'neutral.jsonl');
    fs.copyFileSync(fixture('claude.jsonl'), session);
    fs.mkdirSync(path.join(temp, 'neutral', 'subagents'), { recursive: true });
    fs.copyFileSync(fixture('claude-child.jsonl'), path.join(temp, 'neutral', 'subagents', 'helper.jsonl'));
    const requests = analyzeFiles({ claudeDirs: [temp], tag: 'BenchSSAM' });
    assert.equal(requests.length, 1, 'sidechain must not become a principal request');
    assert.equal(requests[0].subagents.length, 1);
    const md = path.join(temp, 'report.md');
    const json = path.join(temp, 'report.json');
    execFileSync(process.execPath, [path.join(here, 'analyze.mjs'), '--claude', session, '--tag', 'BenchSSAM', '--md', md, '--json', json]);
    assert.ok(fs.readFileSync(md, 'utf8').includes('|'));
    const report = JSON.parse(fs.readFileSync(json, 'utf8'));
    assert.equal((Array.isArray(report) ? report : report.requests).length, 1);
    assert.ok(formatMarkdown(requests).includes('claude'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

const realEnabled = process.env.BENCH_REAL_TRANSCRIPTS === '1';
const realDir = path.join(originalProfile.home, '.codex', 'sessions', '2026', '10', '13');
const realMainName = 'rollout-2026-10-13T11-57-13-01a135c4-8333-7190-b72c-bb2c32460f1d.jsonl';
const realMain = [path.join(realDir,realMainName),path.join(originalProfile.home,'.codex','archived_sessions',realMainName)].find(f=>fs.existsSync(f)) ?? path.join(realDir,realMainName);
const realOther = path.join(realDir, 'rollout-2026-10-13T12-00-43-01a135c7-b752-7dc2-9d59-d5ad9229fd1b.jsonl');
const realClaude = path.join(originalProfile.home, '.claude', 'projects', 'C--Users-'+path.basename(originalProfile.home)+'-SSAM-Hybrid-proto', '7427c081-1701-4dd3-a1a7-c966a91e7d8d.jsonl');
const gated = file => !realEnabled ? 'set BENCH_REAL_TRANSCRIPTS=1 to read local transcripts' : !fs.existsSync(file) ? 'local transcript not present' : false;
const window = (name, start, end) => ({ name, start: `2026-10-13T${start}Z`, end: `2026-10-13T${end}Z` });

test('real Codex delivery and three subagents match reference measurements', { skip: gated(realMain) }, () => {
  const [request] = analyzeFiles({ codex: [realMain], windows: [window('delivery', '15:32:03.137', '15:42:22.336')] });
  near(request.wallMin, 10.3, .1, 'wall');
  kbNear(request.writtenKB, 47.3, 'written');
  kbNear(request.readKB, 85.9, 'read');
  assert.equal(request.rounds, 21);
  near(request.toolSecSum, 25.1, .1, 'tool seconds');
  near(request.ssamSec, 22.9, .1, 'SSAM seconds');
  assert.equal(request.refusals.length, 3);
  assert.equal(request.refusalsByCode.PREFLIGHT_REFUSED, 3);
  assert.equal(request.accepted, true);
  assert.equal(new Date(request.acceptedAt).toISOString().slice(11, 19), '15:41:33');
  for (const expected of [{ name: 'Galileo', wall: 2.88, kb: 4, rounds: 13, tokens: 4713 }, { name: 'Popper', wall: 3, kb: 4.1, rounds: 11, tokens: 3734 }, { name: 'Fermat', wall: 2.09, kb: 3.8, rounds: 10, tokens: 3126 }]) {
    const sub = request.subagents.find(s => s.name === expected.name);
    assert.ok(sub, expected.name);
    near(sub.wallMin, expected.wall, .1, `${expected.name} wall`);
    kbNear(sub.writtenKB, expected.kb, `${expected.name} written`);
    assert.equal(sub.rounds, expected.rounds);
    assert.equal(sub.outputTokens, expected.tokens);
  }
});

test('real Codex aborted delivery retains both parent turns and six child turns', { skip: gated(realMain) }, () => {
  const [request] = analyzeFiles({ codex: [realMain], windows: [window('continued', '15:48:31.955', '16:06:49.887')] });
  near(request.wallMin, 18.3, .1, 'wall');
  kbNear(request.writtenKB, 40.1, 'written');
  assert.equal(request.refusals.length, 4);
  assert.equal(request.refusalsByCode.PREFLIGHT_REFUSED, 3);
  assert.equal(request.refusalsByCode.VALIDATION_REFUSED, 1);
  assert.equal(request.accepted, true);
  assert.equal(new Date(request.acceptedAt).toISOString().slice(11, 19), '16:06:12');
  assert.equal(request.subagentTurns, 6);
  kbNear(request.writtenKBTotal - request.writtenKB, 63.2, 'child written');
});

test('real other MCP is never classified as SSAM', { skip: gated(realOther) }, t => {
  const [request] = analyzeFiles({ codex: [realOther], windows: [window('other', '15:37:14.568', '15:44:23.449')] });
  near(request.wallMin, 7.15, .1, 'wall');
  kbNear(request.writtenKB, 15.2, 'written');
  assert.equal(request.ssamSec, 0);
  kbNear(request.writtenKBTotal - request.writtenKB, 15.9, 'child written');
  assert.equal(request.subagents.find(s => s.name === 'Meitner')?.turns, 2);
  assert.ok(request.subagents.some(s => s.name === 'James'));
  assert.ok(request.subagents.some(s => s.name === 'Epicurus'));
  t.diagnostic(`principal writes=${request.writtenKB}; assistant text=${request.assistantTextKB}; child writes=${request.writtenKBTotal - request.writtenKB}`);
});

for (const expected of [
  { name: 'P1', start: '14:09:25', end: '14:14:51', wall: 5.4, tool: 2.3, kb: 2.902, calls: 9, errors: 1 },
  { name: 'P2', start: '14:14:59', end: '14:19:23', wall: 4.4, tool: .9, kb: 40, calls: 10, errors: 1 },
  { name: 'P3', start: '14:19:31', end: '14:25:44', wall: 6.2, tool: .8, kb: 41, calls: 23, errors: 6 },
  { name: 'P4', start: '14:25:53', end: '15:00:00', wall: 20.9, tool: 1.2, kb: 159, calls: 13, errors: 4 },
]) {
  test(`real Claude ${expected.name} matches explicit reference window`, { skip: gated(realClaude) }, t => {
    const [request] = analyzeFiles({ claude: [realClaude], windows: [window(expected.name, expected.start, expected.end)] });
    t.diagnostic(JSON.stringify({ wallMin: request.wallMin, toolSecSum: request.toolSecSum, writtenKB: request.writtenKB, rounds: request.rounds, refusedOrError: request.refusedOrError, modelPct: request.modelPct }));
    near(request.wallMin, expected.wall, .1, 'wall');
    near(request.toolSecSum / 60, expected.tool, .1, 'tool minutes');
    kbNear(request.writtenKB, expected.kb, 'written');
    assert.equal(request.rounds, expected.calls);
    assert.equal(request.refusedOrError, expected.errors);
    if (expected.name === 'P4') near(request.modelPct, 94, 1, 'model percent');
  });
}
