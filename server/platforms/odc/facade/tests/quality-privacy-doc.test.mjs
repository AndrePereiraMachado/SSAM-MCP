// The customer's privacy section (docs/AGENTE-CLIENTE.md "Privacy", English since 2026-10-15; privacy review of 2026-10-12, finding 2) states
// exactly what the server records: every field a quality line can carry has its words there (a field added to the contract
// without them fails here), retention as the owner configures it, who sees it (the owner only), the closed list of codes
// and the server.log facts of the agent's connection and of the first machine. In the SSAM-MCP server box the guide lives in
// the agent box (../agent/docs); without either copy the test skips.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeQualityLine, T_KEYS, CODE_UNLISTED } from '../quality-line.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GUIDE = [path.join(ROOT, 'docs', 'AGENTE-CLIENTE.md'), path.join(ROOT, '..', 'agent', 'docs', 'AGENTE-CLIENTE.md')].find(f => fs.existsSync(f));
const sectionOf = text => {
  const t = text.replace(/\r\n/g, '\n');
  const start = t.indexOf('## Privacy: what the server records about your access\n');
  const end = t.indexOf('\n## ', start + 1);
  assert.ok(start >= 0, 'the privacy section');
  return t.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
};

// The words of each field of a quality line in the section (format fields of the line itself excluded).
const FORMAT = new Set(['schema', 'kind', 'trunc']);
const WORDS = {
  time: /On every line:\*\* the time/, token: /identifier of your access/, customer: /the name the owner gave it/, session: /digest of the MCP session that does not allow recovering it/,
  call: /the order in the session/, tool: /The call:\*\* the tool/, op: /the action chosen in it \(from the tool's list\)/, lane: /the platform \(O11 or ODC\)/,
  ms: /the duration/, gapMs: /the interval since the previous answer/, inFlight: /how many calls were running together/,
  ok: /whether it succeeded/, class: /was refused, was left uncertain or failed/, code: /the code; the step/, step: /the step where it stopped/,
  deliv: /`entregue` \(delivered\), `entregue e publicado` \(delivered and published\) or `criado` \(created\)/,
  'problems.n': /how many problems of each code/, 'problems.err': /how many problems of each code/, 'problems.byCode': /how many problems of each code/,
  'problems.warn': /how many were warnings/, 'problems.withPatch': /how many came with a ready fix/, 'problems.byPhase': /\(by phase/, 'problems.cut': /whether the list was cut/,
  'norm.n': /how many automatic fixes of each rule/, 'norm.byRule': /how many automatic fixes of each rule/,
  'warn.n': /how many warnings/, 'warn.high': /and how many severe/,
  t: /how long each phase took \(queue, capture, compilation, Studio, verification, publication, environment, transfer, network and the server itself\)/,
  'agent.n': /how many calls to the agent/, 'agent.top': /of which kind and command/, 'agent.bytes': /with how many bytes/, 'agent.failed': /how many failures/,
  'agent.shared': /how much time and how many failures/, 'agent.approx': /how much time and how many failures/,
  'kernel.runs': /how many times the engine ran/, 'kernel.cold': /how many times the engine ran/, 'kernel.worker': /how many times the engine ran/, 'kernel.ms': /the engine ran and how long it took/,
  'args.job': /how the job came/, 'args.basedOn': /`basedOn`/, 'args.partial': /`partial`/, 'args.closePrevious': /`closePrevious`/, 'args.publish': /`publish`/,
  'args.until': /`until`/, 'args.patch': /how many patches/, 'args.bytes': /the size in bytes/,
  'answer.chars': /the size, whether it came in pages/, 'answer.paged': /whether it came in pages/, 'answer.scan': /how the server read it/,
  event: /when it opened and closed/, client: /the family of the MCP client/, reason: /when it opened and closed, the reason/, calls: /how many calls it had/, openMs: /when it opened and closed/,
};
// Every field the contract keeps, from a line that fills them all (and the session lines).
function fieldsOfContract() {
  const frame = { schema: 'ssam-quality/1', time: '2026-10-12T18:00:00.000Z', token: 'tok_0000000a1fa0', customer: 'Cliente', session: 'abcdef012345' };
  const call = sanitizeQualityLine({ ...frame, kind: 'call', call: 1, tool: 'o11_deliver', op: 'close', lane: 'o11', ms: 9, gapMs: 1, inFlight: 1, ok: false, code: 'PREFLIGHT_REFUSED',
    class: 'refused', step: 'preflight', deliv: 'entregue', problems: { n: 1, err: 1, warn: 0, byCode: { PREFLIGHT_REFUSED: 1 }, withPatch: { PREFLIGHT_REFUSED: 1 }, byPhase: { preflight: 1 }, cut: true },
    norm: { n: 1, byRule: { SORT_KEYS_SPLIT: 1 } }, warn: { n: 1, high: 1 }, t: Object.fromEntries(T_KEYS.map(k => [k, 1])),
    agent: { n: 1, failed: 1, bytes: 1, shared: true, approx: true, top: [['file.get', 1, 1]] }, kernel: { runs: 1, cold: 1, worker: 1, ms: 1 },
    args: { job: 'inline', basedOn: true, partial: true, closePrevious: true, publish: true, patch: 1, until: 'merge', bytes: 1 }, answer: { chars: 1, paged: true, scan: 'full' } });
  const closed = sanitizeQualityLine({ ...frame, kind: 'session', event: 'closed', client: 'codex', reason: 'idle', calls: 1, openMs: 1 });
  const out = new Set();
  for (const line of [call, closed]) for (const [k, v] of Object.entries(line)) {
    if (FORMAT.has(k)) continue;
    if (k === 't') out.add('t');
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const sub of Object.keys(v)) out.add(k + '.' + sub);
    else out.add(k);
  }
  return [...out];
}

test('the privacy section names every field of the quality record, by category', { skip: !GUIDE && 'docs/AGENTE-CLIENTE.md is in the agent box' }, () => {
  const section = sectionOf(fs.readFileSync(GUIDE, 'utf8'));
  for (const field of fieldsOfContract()) {
    assert.ok(Object.hasOwn(WORDS, field), 'a field of the contract the privacy section does not describe yet: ' + field);
    assert.match(section, WORDS[field], field);
  }
  assert.match(section, new RegExp('A value outside the list becomes a fixed marker, such as `' + CODE_UNLISTED + '`, and is only counted'));
  assert.match(section, /Nothing of your work goes into the audit or the quality record: no name of a module, screen, action or entity, no job, expression, message, file path, environment address or text of yours/);
});

test('the privacy section says who sees the records, how long they stay and the server.log facts of the agent', { skip: !GUIDE && 'docs/AGENTE-CLIENTE.md is in the agent box' }, () => {
  const section = sectionOf(fs.readFileSync(GUIDE, 'utf8'));
  assert.match(section, /Only the server owner sees the log, the audit and the quality record/);
  // retention as configured (rotate-logs.sh: LOG_KEEP_DAYS 56, AUDIT_KEEP_DAYS and QUALITY_KEEP_DAYS 0 = keep all), never "the same as the audit"
  assert.match(section, /The owner chooses for how many days each of these records is kept\. The default keeps the log for 56 days and the audit and the quality record with no time limit\./);
  assert.doesNotMatch(section, /same retention as the audit/);
  // agent-connected and agent-machine-pinned (agent-hub.mjs hello): the machine name, the Windows user and the IP, plainly
  assert.match(section, /When the agent connects:\*\* the IP, the agent version, the computer name, your Windows user and a machine identifier/);
  assert.match(section, /On the agent's first connection, the server keeps the computer name, your Windows user, the identifier, the time and the IP/);
  assert.match(section, /When your MCP client opens a session:\*\* the name the owner gave your access, the MCP session number, the IP you connect from, the name and version of the MCP client/);
  // what the customer's workspace keeps, including the free text of ssam_friction reports
  assert.match(section, /the text of the reports your MCP client writes with `ssam_friction`/);
});
