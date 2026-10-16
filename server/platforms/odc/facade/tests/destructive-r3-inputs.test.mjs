import './fixtures/isolated-profile.mjs';
// CX15 r3, family F1 (inputs outside the guard), BYPASS-1: the bridge trims its line with .NET String.Trim(), which
// removes every char.IsWhiteSpace, U+0085 included; JavaScript's trim() and \s keep U+0085. With "\u0085" before the
// command, data-delete, portal-call, portal-private-call and portal-api-client-fixture-cleanup reached the bridge through
// `.\odc studio` and studio_command. The family: every destructive bridge command x every .NET whitespace as prefix and as
// suffix x (one argument, separate arguments, command = the whitespace with the command in args) is refused by the
// function, by the MCP tool (a fake studio counts the lines) and by the CLI (a fake bridge pipe counts the lines): 0 lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { DESTRUCTIVE_BRIDGE_COMMANDS, bridgeCommandRefusal, destructivePhase } from '../destructive-operations.mjs';
import { createFacadeServer } from '../mcp.mjs';
import { pipeName } from '../odc-pipe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Every .NET char.IsWhiteSpace (String.Trim() removes them at both ends of the bridge line).
const NET_WHITESPACE = [0x9, 0xA, 0xB, 0xC, 0xD, 0x20, 0x85, 0xA0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000];
const label = cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
const REST = { 'data-delete': ['Orders', 'Customer', '--ids', '1', '--authorize', 'x'], 'portal-call': ['req-1.json'], 'portal-private-call': ['req-2.json'], 'portal-api-client-fixture-cleanup': ['--key', 'k-1'] };
// [command, args] shapes for one destructive command and one whitespace character.
function shapes(command, ws) {
  const rest = REST[command];
  return [
    ['prefix, one argument', ws + [command, ...rest].join(' '), []],
    ['prefix, separate arguments', ws + command, rest],
    ['command is the whitespace', ws, [command, ...rest]],
    ['suffix, one argument', [command + ws, ...rest].join(' '), []],
    ['suffix, separate arguments', command + ws, rest],
    ['suffix alone', command + ws, []],
  ];
}

test('BYPASS-1: bridgeCommandRefusal and destructivePhase refuse every destructive bridge command behind or before any .NET whitespace', () => {
  const leaks = [];
  for (const command of DESTRUCTIVE_BRIDGE_COMMANDS)
    for (const cp of NET_WHITESPACE)
      for (const [shape, c, args] of shapes(command, String.fromCodePoint(cp))) {
        const refused = bridgeCommandRefusal(c, args);
        if (refused?.ok !== false || refused.outcome !== 'not-sent') leaks.push(`${command} ${label(cp)} ${shape}`);
        if (destructivePhase('studio_command', { command: c, args }) !== 'refuse') leaks.push(`phase ${command} ${label(cp)} ${shape}`);
      }
  assert.deepEqual(leaks, []);
});

test('BYPASS-1: a line that starts with a non-ASCII whitespace or a control character is refused whatever the command; ASCII spaces and plain commands pass', () => {
  for (const cp of NET_WHITESPACE.filter(cp => cp !== 0x20)) {
    const refused = bridgeCommandRefusal(String.fromCodePoint(cp) + 'module-info', ['Orders']);
    assert.equal(refused?.code, 'BRIDGE_LINE_UNSAFE_START', label(cp));
    assert.equal(refused.outcome, 'not-sent');
    assert.match(refused.error, new RegExp(label(cp).replace('+', '\\+')));
  }
  // A destructive command behind an unsafe start: ONE refusal with both problems, the dedicated tool's code first.
  const both = bridgeCommandRefusal('\u0085data-delete', ['Orders']);
  assert.equal(both.code, 'DESTRUCTIVE_NEEDS_DEDICATED_TOOL');
  assert.deepEqual(both.problems.map(p => p.code), ['DESTRUCTIVE_NEEDS_DEDICATED_TOOL', 'BRIDGE_LINE_UNSAFE_START']);
  assert.equal(both.continuation.tool, 'studio_data_delete');
  for (const [c, args] of [['module-info', ['Orders']], [' module-info', []], ['', ['publish-status']], ['stop', []]])
    assert.equal(bridgeCommandRefusal(c, args), null, JSON.stringify([c, args]));
});

test('BYPASS-1: studio_command (the MCP tool) refuses every shape and sends 0 lines to the studio', async () => {
  const lines = [];
  const studio = async (args, pid) => { lines.push(args.map(String).join(' ')); return { ok: true, fakeStudio: true }; };
  const server = await createFacadeServer({ deps: { studio } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r3-bypass1', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);
    const leaks = [];
    for (const command of DESTRUCTIVE_BRIDGE_COMMANDS)
      for (const cp of NET_WHITESPACE)
        for (const [shape, c, args] of shapes(command, String.fromCodePoint(cp))) {
          const value = valueOf(await client.callTool({ name: 'studio_command', arguments: { command: c, args, pid: 999999 } }));
          if (value.ok !== false || !['DESTRUCTIVE_NEEDS_DEDICATED_TOOL', 'BRIDGE_LINE_UNSAFE_START'].includes(value.code)) leaks.push(`${command} ${label(cp)} ${shape}: ${value.code ?? value.ok}`);
        }
    assert.deepEqual(leaks, []);
    assert.equal(lines.length, 0, 'no line reached the studio');
    // The control: a plain command still goes through.
    await client.callTool({ name: 'studio_command', arguments: { command: 'publish-status', args: [], pid: 999999 } });
    assert.equal(lines.length, 1);
  } finally { await client.close(); await server.close(); }
});

// ---- the CLI, a real child process whose real pipe client meets a fake bridge pipe served here.
const cli = path.resolve(here, '..', 'odc.mjs');
const preload = pathToFileURL(path.join(here, 'fixtures', 'r3-p-fake-bridge-preload.mjs')).href;
const version = /const string Version = "(v\d+)"/.exec(fs.readFileSync(path.resolve(here, '..', '..', 'studio', 'bridge', 'client', 'Program.cs'), 'utf8'))[1];
async function fakeBridge() {
  const lines = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (let i; (i = buffer.indexOf('\n')) >= 0;) { lines.push(buffer.slice(0, i)); buffer = buffer.slice(i + 1); socket.end(JSON.stringify({ ok: true, fakeBridge: true }) + '\n'); }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipeName(version, process.pid), resolve); });
  return { lines, close: () => new Promise(resolve => server.close(resolve)) };
}
const runCli = args => new Promise(resolve => execFile(process.execPath, ['--import', preload, cli, 'studio', '--pid', String(process.pid), ...args],
  { env: { ...process.env, SSAM_ODC_OFFLINE: '1' }, windowsHide: true, timeout: 60000 },
  (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })));
async function pool(items, size, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

test('BYPASS-1: .\\odc studio refuses every shape before the pipe: 0 lines reach the fake bridge (the control reaches it)', { timeout: 600000 }, async () => {
  const bridge = await fakeBridge();
  try {
    const control = await runCli(['publish-status']);
    assert.ok(bridge.lines.includes('publish-status'), 'the harness is armed: a plain command reaches the fake bridge (' + (control.stdout + control.stderr).slice(0, 300) + ')');
    bridge.lines.length = 0;
    const cases = [];
    for (const command of DESTRUCTIVE_BRIDGE_COMMANDS)
      for (const cp of NET_WHITESPACE)
        for (const [shape, c, args] of shapes(command, String.fromCodePoint(cp)))
          // The CLI takes its arguments as separate argv entries: the shapes become [command, ...args].
          if (command === 'data-delete' || ['prefix, separate arguments', 'prefix, one argument'].includes(shape)) cases.push({ command, cp, shape, argv: [c, ...args] });
    const outs = await pool(cases, 12, k => runCli(k.argv));
    const leaks = outs.map((out, i) => [out, cases[i]]).filter(([out]) => out.code === 0 || !/"code": "(DESTRUCTIVE_NEEDS_DEDICATED_TOOL|BRIDGE_LINE_UNSAFE_START)"/.test(out.stdout))
      .map(([out, k]) => `${k.command} ${label(k.cp)} ${k.shape}: ${(out.stdout + out.stderr).slice(0, 120)}`);
    assert.deepEqual(leaks, []);
    assert.deepEqual(bridge.lines, [], 'no line of a destructive command reached the bridge pipe');
  } finally { await bridge.close(); }
});
