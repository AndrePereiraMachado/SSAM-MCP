import './fixtures/isolated-profile.mjs';
// CX15 r2, family F3 (inputs outside the guard): .\odc studio reads the destructive bridge command from the whole line the
// pipe sends (R-A1), and `ssam data --lane o11` reads its request file as the kernel does (UTF-8, UTF-8 BOM, UTF-16LE/BE
// with BOM) and refuses one it cannot read (R-A2: fail closed). Offline: the CLI with SSAM_ODC_OFFLINE=1 (no Studio is
// listed, no pipe is opened), a fake send for the O11 data line, synthetic records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cliDataDelete, studioDataDelete } from '../data-delete-gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ---- R-A1
const cli = path.resolve(here, '..', 'odc.mjs');
const runCli = args => new Promise(resolve => execFile(process.execPath, [cli, 'studio', ...args], { env: { ...process.env, SSAM_ODC_OFFLINE: '1' }, windowsHide: true, timeout: 60000 },
  (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })));
const COMMANDS = { 'data-delete': ['Orders', 'Customer', '--ids', '1', '--authorize', 'x'], 'portal-call': ['req-1'], 'portal-private-call': ['req-2'], 'portal-api-client-fixture-cleanup': ['--key', 'k-1'] };

test('R-A1: .\\odc studio refuses the 4 destructive bridge commands however the line is split: one argument with spaces, "" or " " before, a leading space, another case or a tab', async () => {
  const cases = [];
  for (const [command, rest] of Object.entries(COMMANDS)) {
    cases.push([command, [command, ...rest]]);                          // the control
    cases.push([command, [[command, ...rest].join(' ')]]);              // one argument with spaces
    cases.push([command, ['', command, ...rest]]);                      // "" before
    cases.push([command, [' ', command, ...rest]]);                     // " " before
    cases.push([command, [' ' + command, ...rest]]);                    // a leading space
    cases.push([command, [command + ' ' + rest[0], ...rest.slice(1)]]); // the command and its first argument in one
    cases.push([command, [command.toUpperCase(), ...rest]]);            // another case (stricter than the bridge)
    cases.push([command, [command + '\t' + rest[0], ...rest.slice(1)]]);// a tab (stricter than the bridge)
  }
  const outs = await Promise.all(cases.map(([, args]) => runCli(args)));
  outs.forEach((out, i) => {
    const [command, args] = cases[i];
    assert.match(out.stdout, /DESTRUCTIVE_NEEDS_DEDICATED_TOOL/, command + ' ' + JSON.stringify(args) + ' -> ' + (out.stdout + out.stderr).slice(0, 200));
    assert.doesNotMatch(out.stderr, /ODC Studio is not running/, 'never reached the send to the Studio: ' + JSON.stringify(args));
  });
});

// ---- R-A2
const target = ['--studio', '--host', 'dev.example.test', '--module', 'Orders_CS', '--oml', 'C:\\captures\\Orders_CS.oml'];
const DELETE = { operation: 'delete', entity: 'Customer', ids: ['1', '2'], operationId: '7a1c4e1e-5555-4555-8555-555555555555', authorization: 'apaga os clientes' };
const encodings = {
  'UTF-8': json => Buffer.from(json, 'utf8'),
  'UTF-8 BOM': json => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, 'utf8')]),
  // Out-File and > in Windows PowerShell 5.1 ("Unicode"): UTF-16LE with BOM.
  'UTF-16LE BOM': json => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]),
  'UTF-16BE BOM': json => { const le = Buffer.from(json, 'utf16le'); const be = Buffer.alloc(le.length); for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; } return Buffer.concat([Buffer.from([0xfe, 0xff]), be]); },
};
function dataLine() {
  const table = new Map([1, 2].map(id => [String(id), { Id: String(id), Name: 'Customer ' + id }]));
  const sent = [];
  const send = async argv => {
    const request = JSON.parse(fs.readFileSync(argv[argv.indexOf('--request') + 1], 'utf8'));
    sent.push(request);
    const ops = Array.isArray(request.batch) ? request.batch : [request];
    const results = ops.map(op => (op.operation === 'read' ? { ok: true, records: op.ids.map(String).filter(id => table.has(id)).map(id => table.get(id)), operation: 'read', entity: op.entity }
      : (op.ids.forEach(id => table.delete(String(id))), { ok: true, reports: op.ids.map(id => ({ recordId: String(id), status: 'Success', error: null })), operation: 'delete', entity: op.entity })));
    return { ok: true, lane: 'o11', verb: 'data', exitCode: 0, result: { ok: true, command: 'data', data: { ok: true, host: 'dev.example.test', submitted: results.length, total: results.length, results } } };
  };
  return { table, sent, send, deletes: () => sent.flatMap(r => (Array.isArray(r.batch) ? r.batch : [r])).filter(op => op.operation === 'delete') };
}

test('R-A2: ssam data --lane o11 reads a delete request written as UTF-8, UTF-8 BOM, UTF-16LE or UTF-16BE with BOM and previews it; nothing is deleted', async () => {
  for (const [name, encode] of Object.entries(encodings)) {
    const cwd = tmp('cx15r2-ra2-'); const root = tmp('cx15r2-ra2-root-');
    try {
      const line = dataLine();
      const file = path.join(cwd, 'delete.json');
      fs.writeFileSync(file, encode(JSON.stringify(DELETE)));
      const answer = await cliDataDelete([...target, '--request', file], { send: line.send, cwd, now: Date.parse('2026-10-15T12:00:00Z'), root });
      assert.notEqual(answer, null, name + ': the gate must take the request (null sends it to the kernel as is)');
      assert.equal(answer.code, 'CONFIRMATION_REQUIRED', name + ': ' + JSON.stringify(answer).slice(0, 300));
      assert.equal(answer.count, 2, name);
      assert.deepEqual(line.deletes(), [], name + ': nothing deleted');
      assert.equal(line.table.size, 2, name);
    } finally { for (const d of [cwd, root]) fs.rmSync(d, { recursive: true, force: true }); }
  }
});

// The same request written by Windows PowerShell 5.1 itself: `>` and Out-File (UTF-16LE BOM + CRLF), Out-File -Encoding
// utf8 (UTF-8 BOM), Set-Content -Encoding BigEndianUnicode (UTF-16BE BOM). Only where powershell.exe exists.
const powershell = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';
test('R-A2: a delete request written by Windows PowerShell 5.1 (>, Out-File, Out-File -Encoding utf8, Set-Content BigEndianUnicode) is previewed; nothing is deleted', { skip: !powershell || !fs.existsSync(powershell) }, async () => {
  const cwd = tmp('cx15r2-ra2ps-'); const root = tmp('cx15r2-ra2ps-root-');
  try {
    const writers = { redirect: '$env:CX15R2_JSON > $env:CX15R2_FILE', 'Out-File': '$env:CX15R2_JSON | Out-File -FilePath $env:CX15R2_FILE',
      'Out-File utf8': '$env:CX15R2_JSON | Out-File -Encoding utf8 -FilePath $env:CX15R2_FILE', 'Set-Content BigEndianUnicode': 'Set-Content -Encoding BigEndianUnicode -Path $env:CX15R2_FILE -Value $env:CX15R2_JSON' };
    const boms = { redirect: 'fffe', 'Out-File': 'fffe', 'Out-File utf8': 'efbbbf', 'Set-Content BigEndianUnicode': 'feff' };
    for (const [name, script] of Object.entries(writers)) {
      const file = path.join(cwd, name.replace(/\W+/g, '-') + '.json');
      await new Promise((resolve, reject) => execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, CX15R2_JSON: JSON.stringify(DELETE), CX15R2_FILE: file }, windowsHide: true, timeout: 60000 }, error => (error ? reject(error) : resolve())));
      assert.equal(fs.readFileSync(file).subarray(0, boms[name].length / 2).toString('hex'), boms[name], name + ': written as PowerShell 5.1 writes it');
      const line = dataLine();
      const answer = await cliDataDelete([...target, '--request', file], { send: line.send, cwd, now: Date.parse('2026-10-15T12:00:00Z'), root });
      assert.notEqual(answer, null, name + ': the gate must take the request (null sends it to the kernel as is)');
      assert.equal(answer.code, 'CONFIRMATION_REQUIRED', name + ': ' + JSON.stringify(answer).slice(0, 300));
      assert.equal(answer.count, 2, name);
      assert.deepEqual(line.deletes(), [], name + ': nothing deleted');
    }
  } finally { for (const d of [cwd, root]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('R-A2: a request file the gate cannot read (not JSON in any of those encodings, missing, --request=<file>) is refused; nothing reaches the kernel', async () => {
  const cwd = tmp('cx15r2-ra2u-'); const root = tmp('cx15r2-ra2u-root-');
  try {
    const line = dataLine();
    const bad = path.join(cwd, 'bad.json');
    fs.writeFileSync(bad, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"operation":"delete",', 'utf16le')]));
    const equals = path.join(cwd, 'eq.json'); fs.writeFileSync(equals, JSON.stringify(DELETE));
    for (const args of [[...target, '--request', bad], [...target, '--request', path.join(cwd, 'missing.json')], [...target, '--request=' + equals], [...target, '--request']]) {
      const answer = await cliDataDelete(args, { send: line.send, cwd, now: Date.parse('2026-10-15T12:00:00Z'), root });
      assert.notEqual(answer, null, JSON.stringify(args.slice(-2)) + ': fail closed, never the kernel as is');
      assert.equal(answer.ok, false);
      assert.match(answer.code, /^DATA_REQUEST_(UNREADABLE|INVALID)$|^CONFIRMATION_REQUIRED$/, JSON.stringify(answer).slice(0, 300));
    }
    assert.deepEqual(line.deletes(), []);
  } finally { for (const d of [cwd, root]) fs.rmSync(d, { recursive: true, force: true }); }
});

// ---- K (the same family): the ids of studio_data_delete as the bridge reads them (one token of the line, split at commas).
test('K: studio_data_delete refuses, before any read, every id the bridge would read as other ids (a comma, a space, a leading "--")', async () => {
  const root = tmp('cx15r2-k-');
  try {
    const calls = [];
    const studioData = async args => { calls.push(args); return { ok: true, tenant: 'personal-k.outsystems.dev', module: 'Orders', entity: 'Region', records: [{ Code: 'A', Name: 'a' }, { Code: 'B', Name: 'b' }], more: false }; };
    const refused = await studioDataDelete({ module: 'Orders', entity: 'Region', ids: ['A,B', 'A B', '--authorize', ' A', 'C'] }, { studioData, now: Date.parse('2026-10-15T12:00:00Z'), root });
    assert.equal(refused.code, 'DATA_REQUEST_INVALID', JSON.stringify(refused).slice(0, 300));
    assert.deepEqual(refused.ids, ['A,B', 'A B', '--authorize', ' A'], 'every unsafe id in one refusal');
    assert.deepEqual(calls, [], 'nothing read, nothing deleted');
    const fine = await studioDataDelete({ module: 'Orders', entity: 'Region', ids: ['A', 'B'] }, { studioData, now: Date.parse('2026-10-15T12:00:00Z'), root });
    assert.equal(fine.state, 'previewed', JSON.stringify(fine).slice(0, 300));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});