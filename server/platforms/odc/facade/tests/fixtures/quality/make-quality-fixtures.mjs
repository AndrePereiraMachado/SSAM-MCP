#!/usr/bin/env node
// Fixtures of the ssam-quality/1 records for the CONSOLE lane (C:\t\qual\DESIGN-QUALIDADE.md section 6), written before
// the SERVER lane exists. Deterministic: the same files every run.
//
//   node make-quality-fixtures.mjs [--out <dir>]      (default: the folder of this script)
//
// Writes:
//   server-dir/quality-20261011.jsonl.gz   previous local day (gz, as rotate-logs.sh leaves a past day)
//   server-dir/quality-20261012.jsonl      the day under test: the owner's production test of 2026-10-11 (create-app and the
//                                          7 actions, retimed to 15:00 local), an ODC customer with a subagent in parallel,
//                                          and a customer whose agent was off (gate refusal, protocol error, 45 min pause)
//   server-dir/quality-20261013.jsonl      hostile lines (content where codes go, bad frames, oversized): the reader must
//                                          drop or clean them exactly as hostile-expected.jsonl says
//   hostile-expected.jsonl                 sanitizeQualityLine(line) of each hostile line (null = dropped), same order
//   expected-api-day-20261012.json         /api/quality?range=day&day=2026-10-12 (all customers) per reference-aggregate.mjs
//   expected-api-day-20261012-alfa.json    the same with token=tok_0000000a1fa0
// Every fixture line is checked: sanitizeQualityLine(line) deep-equals the line, and fitLine keeps it whole.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sanitizeQualityLine, fitLine, loadNativeIds, codeOf, SCHEMA } from './quality-line.mjs';
import { aggregate } from './reference-aggregate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : here;
// The native ids the fixtures use, as a kernel catalog the console test points CONSOLE_KERNEL_CATALOG at (catalog/).
const CATALOG = [{ id: 'ExpressionUnknownObject' }, { id: 'UnusedElement' }, { id: 'ExpressionRequiredExpression' }];
fs.mkdirSync(path.join(OUT, 'catalog', 'odc'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'catalog', 'verify-messages-0.0.1.json'), JSON.stringify(CATALOG.slice(0, 2), null, 1) + '\n');
fs.writeFileSync(path.join(OUT, 'catalog', 'odc', 'verify-messages-0.0.1.json'), JSON.stringify(CATALOG.slice(2), null, 1) + '\n');
const NATIVE_IDS = loadNativeIds(path.join(OUT, 'catalog'), { readDir: fs.readdirSync, readFile: fs.readFileSync, join: path.join });
assert.equal(NATIVE_IDS.size, 3);
const BASE = Date.parse('2026-10-12T18:00:00.000Z');      // 15:00 in America/Sao_Paulo
const NOW = Date.parse('2026-10-12T21:20:00.000Z');       // the reference "now" (the console's clock in the golden test)
const iso = ms => new Date(ms).toISOString();
const sessionKey = id => createHash('sha256').update('ssam-quality/1\n' + id).digest('hex').slice(0, 12);

const CUSTOMERS = { alfa: ['tok_0000000a1fa0', 'Cliente Alfa'], beta: ['tok_0000000b2fb1', 'Cliente Beta'], gama: ['tok_0000000c3fc2', 'Cliente Gama'] };
const sessions = [];
function session(who, client, uuid, openAtS) {
  const [token, customer] = CUSTOMERS[who];
  const s = { token, customer, client, key: sessionKey(uuid), openAt: BASE + openAtS * 1000, calls: [], closeAt: null, reason: null };
  sessions.push(s);
  return s;
}
// One call: at = arrival in seconds from BASE, ms = duration; the rest is the record's own fields.
const call = (s, atS, ms, tool, fields = {}) => { s.calls.push({ arrival: BASE + Math.round(atS * 1000), ms, tool, ...fields }); };
const close = (s, atS, reason = 'client-delete') => { s.closeAt = BASE + atS * 1000; s.reason = reason; };
const ok = (extra = {}) => ({ ok: true, class: 'ok', ...extra });
const delivered = (deliv = 'entregue', extra = {}) => ({ ok: true, class: 'delivered', deliv, ...extra });
const refused = (code, extra = {}) => ({ ok: false, class: 'refused', code, ...extra });
const failed = (code, extra = {}) => ({ ok: false, class: 'failed', code, ...extra });

// ---- Cliente Alfa, session 0: the create-app of 2026-10-11 (environment calls cut by the lossy exit, then created)
const a0 = session('alfa', 'codex', '6f0c1e7a-0000-4000-8000-00000000a000', 0);
call(a0, 0, 2615, 'ssam_doctor', failed('DOCTOR_LANE_UNUSABLE', { t: { studio: 2100, rest: 515 }, agent: { n: 2, failed: 0, shared: false, top: [['o11.selected', 1, 1500], ['studio.processes', 1, 600]] } }));
call(a0, 8, 3767, 'ssam_connect', ok({ t: { studio: 3500, rest: 267 }, agent: { n: 3, failed: 0, shared: false, top: [['o11.connect', 1, 2900], ['studio.processes', 1, 400], ['o11.selected', 1, 200]] } }));
call(a0, 15, 3639, 'ssam_discover', ok({ lane: 'o11', t: { rest: 3639 } }));
call(a0, 33, 12114, 'o11_environment', ok({ op: 'inventory', lane: 'o11', t: { environment: 11200, rest: 914 }, agent: { n: 3, failed: 0, shared: false, top: [['o11.bridge:environment_session', 3, 11200]] } }));
call(a0, 48, 4450, 'o11_environment', ok({ op: 'templates', lane: 'o11', t: { environment: 4100, rest: 350 }, agent: { n: 2, failed: 0, shared: false, top: [['o11.bridge:environment_session', 2, 4100]] } }));
call(a0, 70, 119400, 'o11_environment', failed('CREATE_APP_FAILED', { op: 'create-app', lane: 'o11', step: 'publish',
  t: { environment: 105000, kernel: 9000, kernelOwn: 8000, studio: 1000, rest: 5400 }, kernel: { runs: 1, cold: 1, worker: 0, ms: 9000 },
  agent: { n: 22, failed: 3, shared: false, top: [['o11.bridge:environment_session', 21, 105000], ['o11.selected', 1, 1000]] } }));
call(a0, 250, 10800, 'o11_environment', ok({ op: 'inventory', lane: 'o11', t: { environment: 10000, rest: 800 }, agent: { n: 3, failed: 0, shared: false, top: [['o11.bridge:environment_session', 3, 10000]] } }));
call(a0, 290, 74800, 'o11_environment', delivered('criado', { op: 'create-app', lane: 'o11',
  t: { environment: 64000, kernel: 8000, kernelOwn: 7000, rest: 3800 }, kernel: { runs: 1, cold: 1, worker: 0, ms: 8000 },
  agent: { n: 23, failed: 1, shared: false, top: [['o11.bridge:environment_session', 22, 64000], ['o11.selected', 1, 1000]] } }));
call(a0, 372, 1300, 'o11_studio', failed('MODULE_NOT_FOUND', { op: 'open-module', lane: 'o11', t: { studio: 400, rest: 900 } }));
call(a0, 376, 10800, 'o11_environment', ok({ op: 'inventory', lane: 'o11', t: { environment: 10000, rest: 800 } }));
call(a0, 392, 13600, 'o11_studio', ok({ op: 'open-module', lane: 'o11', t: { studio: 13000, rest: 600 }, agent: { n: 4, failed: 0, shared: false, top: [['o11.bridge:open_module', 1, 12600], ['o11.bridge:list_open_modules', 3, 400]] } }));
close(a0, 900);

// ---- Cliente Alfa, session 1: the 7 actions (one at a time, then the batch; two refusals the engine could have fixed)
const a1 = session('alfa', 'codex', '6f0c1e7a-0000-4000-8000-00000000a001', 1000);
const T1 = 1000;
call(a1, T1 + 0, 1568, 'ssam_map', ok({ op: 'digest', lane: 'o11', t: { capture: 900, transfer: 300, rest: 368 }, agent: { n: 2, failed: 0, bytes: 75221, shared: false, top: [['o11.bridge:snapshot_module', 1, 900], ['file.get', 1, 300]] }, answer: { chars: 7400, paged: false, scan: 'full' } }));
call(a1, T1 + 0.03, 1599, 'ssam_discover', ok({ lane: 'o11', t: { rest: 1599 }, answer: { chars: 28500, paged: false, scan: 'full' } }));
call(a1, T1 + 7.2, 407, 'ssam_discover', ok({ lane: 'o11', t: { rest: 407 }, answer: { chars: 21800, paged: false, scan: 'full' } }));
call(a1, T1 + 25.5, 386, 'ssam_reference', ok({ op: 'api', lane: 'o11', t: { rest: 386 } }));
call(a1, T1 + 25.52, 408, 'ssam_reference', ok({ op: 'functions', lane: 'o11', t: { rest: 408 } }));
call(a1, T1 + 25.55, 488, 'ssam_discover', failed('INTENT_REQUIRED', { lane: 'o11', t: { rest: 488 }, answer: { chars: 11600, paged: false, scan: 'full' } }));
[334, 341, 421, 622, 673, 748].forEach((ms, i) => call(a1, T1 + 37.3 + i * 0.01, ms, 'ssam_reference', ok({ op: 'functions', lane: 'o11', t: { rest: ms } })));
call(a1, T1 + 43.0, 269, 'ssam_reference', ok({ op: 'functions', lane: 'o11', t: { rest: 269 } }));
call(a1, T1 + 43.1, 194, 'o11_inspect', ok({ lane: 'o11', t: { rest: 194 } }));
call(a1, T1 + 58.5, 57, 'ssam_reference', ok({ op: 'example', lane: 'o11', t: { rest: 57 } }));
call(a1, T1 + 58.6, 152, 'o11_inspect', ok({ lane: 'o11', t: { rest: 152 } }));
call(a1, T1 + 78.5, 8184, 'o11_deliver', refused('PREFLIGHT_REFUSED', { lane: 'o11', step: 'preflight',
  problems: { n: 1, err: 1, warn: 0, byCode: { PROPERTY_NOT_WRITABLE: 1 }, byPhase: { preflight: 1 }, cut: false },
  t: { capture: 300, transfer: 2500, kernel: 4700, kernelOwn: 4700, studio: 400, rest: 284 }, kernel: { runs: 1, cold: 1, worker: 0, ms: 4700 },
  agent: { n: 4, failed: 0, bytes: 75221, shared: false, top: [['file.get', 1, 2500], ['o11.bridge:list_open_modules', 1, 400], ['o11.bridge:snapshot_module', 1, 300]] },
  args: { job: 'inline', bytes: 5200 }, answer: { chars: 3400, paged: false, scan: 'full' } }));
call(a1, T1 + 90.5, 22822, 'o11_deliver', delivered('entregue', { lane: 'o11',
  t: { capture: 1500, transfer: 4700, kernel: 9400, kernelOwn: 7900, studio: 8700, rest: 22 }, kernel: { runs: 2, cold: 2, worker: 0, ms: 9400 },
  agent: { n: 13, failed: 0, bytes: 151000, shared: false, top: [['o11.bridge:open_module', 1, 4100], ['file.get', 2, 3600], ['o11.bridge:merge_from_oml', 1, 2600], ['o11.bridge:snapshot_module', 2, 1500], ['o11.selected', 1, 1500], ['file.put', 1, 1100]] },
  args: { job: 'inline', basedOn: true, patch: 1, bytes: 900 }, answer: { chars: 1200, paged: false, scan: 'full' } }));
call(a1, T1 + 129.3, 16797, 'o11_deliver', delivered('entregue', { lane: 'o11', warn: { n: 1, high: 1 },
  t: { capture: 1200, transfer: 900, kernel: 9000, kernelOwn: 8000, studio: 6400, rest: 297 }, kernel: { runs: 2, cold: 2, worker: 0, ms: 9000 },
  agent: { n: 11, failed: 0, bytes: 98000, shared: false, top: [['o11.bridge:open_module', 1, 3400], ['o11.bridge:merge_from_oml', 1, 2000], ['o11.bridge:snapshot_module', 2, 1200], ['file.get', 2, 900]] },
  args: { job: 'inline', bytes: 4400 }, answer: { chars: 4100, paged: false, scan: 'full' } }));
call(a1, T1 + 162.4, 1748, 'o11_inspect', ok({ lane: 'o11', t: { capture: 1200, transfer: 300, rest: 248 }, agent: { n: 3, failed: 0, bytes: 76000, shared: false } }));
[245, 519, 528, 578, 764].forEach((ms, i) => call(a1, T1 + 162.45 + i * 0.01, ms, 'ssam_reference', ok({ op: 'functions', lane: 'o11', t: { rest: ms } })));
call(a1, T1 + 348.0, 82245, 'o11_deliver', refused('PREFLIGHT_REFUSED', { lane: 'o11', step: 'preflight',
  problems: { n: 19, err: 19, warn: 0, byCode: { EXPR_UNKNOWN_IDENTIFIER: 12, EXPRESSION_SYNTAX: 3, ExpressionUnknownObject: 2, FUNCTION_UNKNOWN: 2 },
    withPatch: { EXPR_UNKNOWN_IDENTIFIER: 12, FUNCTION_UNKNOWN: 1 }, byPhase: { preflight: 17, verify: 2 }, cut: false },
  t: { transfer: 75300, kernel: 6000, kernelOwn: 6000, studio: 700, rest: 245 }, kernel: { runs: 1, cold: 1, worker: 0, ms: 6000 },
  agent: { n: 4, failed: 0, bytes: 135852, shared: false, top: [['file.get', 2, 75300], ['o11.bridge:list_open_modules', 1, 400], ['o11.bridge:snapshot_module', 1, 300]] },
  args: { job: 'agent', bytes: 600 }, answer: { chars: 21900, paged: false, scan: 'full' } }));
call(a1, T1 + 443.8, 18347, 'o11_deliver', delivered('entregue', { lane: 'o11',
  t: { capture: 1100, transfer: 900, kernel: 10800, kernelOwn: 10000, studio: 6000, rest: 347 }, kernel: { runs: 2, cold: 2, worker: 0, ms: 10800 },
  agent: { n: 12, failed: 0, bytes: 99000, shared: false, top: [['o11.bridge:open_module', 1, 4000], ['o11.bridge:merge_from_oml', 1, 1600], ['o11.bridge:snapshot_module', 2, 1100], ['file.get', 2, 900]] },
  args: { job: 'inline', basedOn: true, patch: 38, bytes: 7400 }, answer: { chars: 1500, paged: false, scan: 'full' } }));
call(a1, T1 + 476.5, 1298, 'ssam_map', ok({ op: 'digest', lane: 'o11', t: { capture: 800, transfer: 200, rest: 298 }, answer: { chars: 31400, paged: false, scan: 'full' } }));
call(a1, T1 + 476.6, 200, 'o11_studio', ok({ op: 'errors', lane: 'o11', t: { studio: 150, rest: 50 } }));
close(a1, T1 + 600);

// ---- Cliente Beta: ODC, a refusal fixed by patch with normalizations, a published delivery; a subagent in parallel
const b2 = session('beta', 'claude-code', '6f0c1e7a-0000-4000-8000-00000000b002', 5000);
const T2 = 5000;
call(b2, T2 + 0, 900, 'ssam_doctor', ok({ t: { studio: 600, rest: 300 }, agent: { n: 2, failed: 0, shared: false } }));
call(b2, T2 + 6, 2200, 'ssam_discover', ok({ lane: 'odc', t: { rest: 2200 } }));
call(b2, T2 + 20, 3400, 'ssam_map', ok({ op: 'digest', lane: 'odc', t: { capture: 2100, transfer: 700, rest: 600 }, agent: { n: 2, failed: 0, bytes: 2900000, shared: false, top: [['odc.pipe:snapshot', 1, 2100], ['file.get', 1, 700]] } }));
call(b2, T2 + 65, 7400, 'studio_deliver', refused('PREFLIGHT_REFUSED', { lane: 'odc', step: 'preflight',
  problems: { n: 2, err: 2, warn: 0, byCode: { EXPR_UNKNOWN_IDENTIFIER: 2 }, withPatch: { EXPR_UNKNOWN_IDENTIFIER: 2 }, byPhase: { preflight: 2 }, cut: false },
  norm: { n: 3, byRule: { SORT_KEYS_SPLIT: 3 } },
  t: { capture: 2100, transfer: 800, kernel: 3900, kernelOwn: 3900, studio: 200, rest: 400 }, kernel: { runs: 1, cold: 0, worker: 1, ms: 3900 },
  agent: { n: 3, failed: 0, bytes: 2950000, shared: false, top: [['odc.pipe:snapshot', 1, 2100], ['file.get', 1, 800], ['odc.pipe:module-info', 1, 200]] },
  args: { job: 'inline', bytes: 9100 } }));
call(b2, T2 + 85, 16100, 'studio_deliver', delivered('entregue', { lane: 'odc',
  norm: { n: 4, byRule: { SORT_KEYS_SPLIT: 3, NULL_FUNCTION_REWRITTEN: 1 } },
  t: { capture: 2000, transfer: 900, kernel: 7600, kernelOwn: 7600, studio: 5200, rest: 400 }, kernel: { runs: 2, cold: 0, worker: 2, ms: 7600 },
  agent: { n: 5, failed: 0, bytes: 3000000, shared: true, top: [['odc.pipe:merge', 1, 5200], ['odc.pipe:snapshot', 1, 2000], ['file.get', 1, 600], ['file.put', 1, 300]] },
  args: { job: 'inline', basedOn: true, patch: 2, bytes: 700 } }));
call(b2, T2 + 140, 21000, 'studio_deliver', delivered('entregue-publicado', { lane: 'odc',
  t: { capture: 2000, transfer: 1000, kernel: 7000, kernelOwn: 7000, studio: 5000, publish: 5600, rest: 400 }, kernel: { runs: 2, cold: 0, worker: 2, ms: 7000 },
  agent: { n: 7, failed: 0, bytes: 3100000, shared: false, top: [['odc.pipe:publish', 1, 5600], ['odc.pipe:merge', 1, 5000], ['odc.pipe:snapshot', 1, 2000], ['file.get', 1, 700], ['file.put', 1, 300]] },
  args: { job: 'inline', publish: true, bytes: 8800 } }));
close(b2, T2 + 400);
const b3 = session('beta', 'claude-code', '6f0c1e7a-0000-4000-8000-00000000b003', 5080);
call(b3, T2 + 82, 15000, 'studio_deliver', delivered('entregue', { lane: 'odc',
  t: { capture: 1900, transfer: 800, kernel: 6800, kernelOwn: 6800, studio: 5100, rest: 400 }, kernel: { runs: 2, cold: 0, worker: 2, ms: 6800 },
  agent: { n: 5, failed: 0, bytes: 2900000, shared: true }, args: { job: 'inline', bytes: 6000 } }));
call(b3, T2 + 104, 9000, 'studio_deliver', refused('VALIDATION_REFUSED', { lane: 'odc', step: 'verify',
  problems: { n: 1, err: 1, warn: 0, byCode: { ExpressionUnknownObject: 1 }, byPhase: { verify: 1 }, cut: false },
  t: { capture: 1800, transfer: 700, kernel: 6000, kernelOwn: 6000, studio: 300, rest: 200 }, kernel: { runs: 1, cold: 0, worker: 1, ms: 6000 },
  agent: { n: 3, failed: 0, bytes: 2900000, shared: false }, args: { job: 'inline', bytes: 5000 } }));
// b3 stays open: its refused delivery is a pending chain on the reference clock (NOW - last line < 2 h).

// ---- Cliente Gama: the agent was off (gate refusal), a protocol error, a 45 min pause, then delivered
const g4 = session('gama', 'cursor', '6f0c1e7a-0000-4000-8000-00000000c004', 9000);
const T4 = 9000;
call(g4, T4 + 0, 700, 'ssam_doctor', ok({ t: { rest: 700 } }));
call(g4, T4 + 10, 900, 'ssam_map', ok({ op: 'digest', lane: 'o11', t: { rest: 900 } }));
call(g4, T4 + 40, 300, 'o11_deliver', failed('AGENT_NOT_CONNECTED', { lane: 'o11', answer: { chars: 900, paged: false, scan: 'wire' } }));
call(g4, T4 + 41, 2, '?', { ok: false, class: 'protocol', code: 'RPC_32602', answer: { chars: 0, paged: false, scan: 'wire' } });
call(g4, T4 + 41 + 2700, 800, 'ssam_doctor', ok({ t: { studio: 500, rest: 300 }, agent: { n: 2, failed: 0, shared: false } }));
call(g4, T4 + 2760, 25000, 'o11_deliver', delivered('entregue', { lane: 'o11',
  t: { capture: 1000, transfer: 600, kernel: 9500, kernelOwn: 9000, studio: 14000, rest: 400 }, kernel: { runs: 2, cold: 0, worker: 2, ms: 9500 },
  agent: { n: 10, failed: 0, bytes: 90000, shared: false, top: [['o11.bridge:open_module', 1, 6000], ['o11.bridge:merge_from_oml', 1, 5000], ['o11.bridge:get_errors', 1, 2400], ['o11.bridge:snapshot_module', 2, 1000], ['file.get', 2, 600]] },
  args: { job: 'inline', bytes: 3000 } }));
close(g4, T4 + 2800);

// ---- the previous local day (2026-10-11): one short chain of Cliente Alfa
const prev = { token: CUSTOMERS.alfa[0], customer: CUSTOMERS.alfa[1], client: 'codex', key: sessionKey('6f0c1e7a-0000-4000-8000-00000000a0ff'),
  openAt: BASE - 86400_000, calls: [], closeAt: BASE - 86400_000 + 120_000, reason: 'client-delete' };
call(prev, -86400 + 2, 1600, 'ssam_discover', ok({ lane: 'o11', t: { rest: 1600 } }));
call(prev, -86400 + 30, 21000, 'o11_deliver', delivered('entregue', { lane: 'o11', t: { capture: 1400, transfer: 900, kernel: 9000, kernelOwn: 9000, studio: 9500, rest: 200 },
  kernel: { runs: 2, cold: 2, worker: 0, ms: 9000 }, agent: { n: 10, failed: 0, bytes: 90000, shared: false }, args: { job: 'inline', bytes: 3000 } }));

// ---- lines: gap and inFlight from each session's own timeline, then every line in send order
function linesOf(s) {
  const out = [{ schema: SCHEMA, kind: 'session', time: iso(s.openAt), token: s.token, customer: s.customer, session: s.key, event: 'opened', client: s.client }];
  const calls = [...s.calls].sort((a, b) => a.arrival - b.arrival);
  calls.forEach((c, i) => {
    const end = c.arrival + c.ms;
    const before = calls.slice(0, i);
    const answered = before.map(p => p.arrival + p.ms).filter(e => e <= c.arrival);
    const inFlight = before.filter(p => p.arrival + p.ms > c.arrival).length;
    const { arrival, ms, tool, ...fields } = c;
    out.push({ schema: SCHEMA, kind: 'call', time: iso(end), token: s.token, customer: s.customer, session: s.key, call: i + 1, tool,
      op: fields.op ?? null, lane: fields.lane ?? null, ms, gapMs: i === 0 ? null : answered.length ? arrival - Math.max(...answered) : null, inFlight,
      ok: fields.ok, code: fields.ok ? null : fields.code, class: fields.class, step: fields.step ?? null, deliv: fields.deliv ?? null,
      ...Object.fromEntries(['problems', 'norm', 'warn', 't', 'agent', 'kernel', 'args', 'answer'].filter(k => fields[k]).map(k => [k, fields[k]])) });
  });
  if (s.closeAt) out.push({ schema: SCHEMA, kind: 'session', time: iso(s.closeAt), token: s.token, customer: s.customer, session: s.key, event: 'closed',
    client: s.client, reason: s.reason, calls: s.calls.length, openMs: s.closeAt - s.openAt });
  return out;
}
const byTime = (a, b) => a.time.localeCompare(b.time) || (a.kind === 'session' && a.event === 'opened' ? -1 : 0);
const normalize = line => {
  const clean = sanitizeQualityLine(line, { nativeIds: NATIVE_IDS });
  assert.ok(clean, 'fixture line rejected: ' + JSON.stringify(line).slice(0, 200));
  // The fixture is written in the sanitizer's own key order, so a byte comparison of a reader's output is meaningful.
  assert.deepEqual(clean, Object.fromEntries(Object.entries(clean)), 'not stable');
  for (const k of Object.keys(line)) if (!(k in clean) && line[k] !== null && line[k] !== undefined) assert.fail('field dropped by the contract: ' + k);
  const text = fitLine(clean, { nativeIds: NATIVE_IDS });
  assert.equal(text, JSON.stringify(clean), 'a fixture line must fit whole: ' + text.length);
  return clean;
};
const day12 = sessions.flatMap(linesOf).sort(byTime).map(normalize);
const day11 = linesOf(prev).sort(byTime).map(normalize);

// ---- hostile lines (2026-10-13): what a broken or tampered writer could leave; the reader keeps only the contract
const H = '2026-10-13T12:00:00.000Z';
// 40 codes of the registry (the html op's and the importer's refusals and warnings, then six of the kernel and the hub).
const LISTED_40 = ['HTML_INVALID', 'HTML_ARGUMENT_INVALID', 'HTML_ATTRIBUTE_SCRIPT', 'HTML_BINDING_INVALID', 'HTML_BINDING_ORPHAN', 'HTML_CALL_ORDER',
  'HTML_CALL_OTHER_SCREEN', 'HTML_CONTENT_EMPTY', 'HTML_CONTROL_DEAD', 'HTML_CSS_ID_SELECTOR', 'HTML_CSS_INVALID', 'HTML_ID_DUPLICATE', 'HTML_KEY_UNBOUND',
  'HTML_KIND_TAG', 'HTML_LIST_TEMPLATE', 'HTML_REFERENCE_UNRESOLVED', 'HTML_TAG_NOT_ALLOWED', 'CSS_RULES_DROPPED', 'CSS_IMPORT_HOISTED', 'CSS_REWRITTEN',
  'CSS_VAR_UNDEFINED', 'HTML_ATTRIBUTE_EXTENDED', 'HTML_CLICKABLE_ELEMENT', 'HTML_CONTROL_LABELLED', 'HTML_KEY_SHARED', 'HTML_LABEL_CHILDREN',
  'HTML_SCREEN_ACTION_SAME_JOB', 'HTML_TABLE_STATIC', 'HTML_VISIBLE_IF', 'PROTOTYPE_SOURCE_INVALID', 'PROTOTYPE_RENDER_FAILED', 'PROTOTYPE_AMBIGUOUS',
  'PROTOTYPE_NAME_COLLISION', 'PROTOTYPE_IR_INVALID', 'PREFLIGHT_REFUSED', 'EXPR_UNKNOWN_IDENTIFIER', 'EXPRESSION_SYNTAX', 'FUNCTION_UNKNOWN',
  'PROPERTY_NOT_WRITABLE', 'AGENT_NOT_CONNECTED'];
for (const c of LISTED_40) assert.equal(codeOf(c), c, 'not in the registry: ' + c);
const frame = { schema: SCHEMA, kind: 'call', time: H, token: 'tok_0000000a1fa0', customer: 'Cliente Alfa', session: 'abcdef012345', call: 1, tool: 'o11_deliver', op: null, lane: 'o11', ms: 1000, gapMs: null, inFlight: 0 };
const hostile = [
  { ...frame, ok: false, code: 'GetColaboradorAtual', class: 'refused', problems: { n: 2, byCode: { 'Batidas.Current.BatidaPonto.X': 1, GetColaboradorAtual: 1, EXPRESSION_SYNTAX: 1 } } },
  { ...frame, ok: false, code: 'expression: Batidas.Current', class: 'refused', expression: 'Batidas.Current.BatidaPonto.Entrada', job: { ops: [{ op: 'set' }] }, message: 'texto do cliente' },
  { ...frame, ok: true, class: 'ok', problems: { n: 1, byCode: JSON.parse('{"__proto__":5,"constructor":1,"OK_CODE":1}') } },
  { ...frame, tool: '../../etc/passwd', op: 'Abrir Modulo', ok: true, class: 'ok' },
  { ...frame, customer: 'Cliente\u0007 Alfa\nlinha 2', ok: true, class: 'ok', t: { capture: -5, studio: 1e12, transfer: '900', rest: 10 } },
  { ...frame, token: 'tok_XYZ', ok: true, class: 'ok' },
  { ...frame, time: 'ontem', ok: true, class: 'ok' },
  { ...frame, ms: -1, ok: true, class: 'ok' },
  { ...frame, schema: 'ssam-quality/2', ok: true, class: 'ok' },
  { ...frame, kind: 'session', event: 'opened', client: 'Claude Code 2.1.281 (máquina do João)' },
  // Verb-shaped words outside the agent's closed lists (a studio_command whose command was the model's own text) never pass.
  { ...frame, ok: false, code: 'PREFLIGHT_REFUSED', class: 'refused', agent: { n: 1, top: [['o11.bridge:Snapshot Module', 1, 10], ['file.get:/home/joao/x', 1, 5], ['o11.bridge:open_module', 1, 7],
    ['odc.pipe:acme-folha-sntl', 1, 4], ['o11.bridge:sntl_method', 1, 3], ['file.put:sntl', 1, 2]] },
    args: { job: 'C:\\Users\\joao\\job.json', patch: [1, 2], until: 'merge', basedOn: 'sim' } },
  // 40 UPPER_SNAKE words outside the registry: one CODE_UNLISTED with their sum (privacy review of 2026-10-12).
  { ...frame, ok: false, code: 'PREFLIGHT_REFUSED', class: 'refused',
    problems: { n: 60, byCode: Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['CODE_' + String(i).padStart(2, '0'), 40 - i])) } },
  // 40 listed codes: the 31 biggest stay, the rest folds into OTHER_CODES.
  { ...frame, ok: false, code: 'PREFLIGHT_REFUSED', class: 'refused',
    problems: { n: 820, byCode: Object.fromEntries(LISTED_40.map((c, i) => [c, 40 - i])) } },
  // The review's probe: a table name and a debug_-shaped object name of the customer in code fields, a rule key of the
  // customer, two rules joined by "+" (a writer splits them; the reader drops the joined key) and a free op word.
  { ...frame, op: 'folha-pagamento', ok: false, code: 'OSUSR_K3X_FOLHA_SNTL', class: 'refused',
    problems: { n: 4, byCode: { OSUSR_K3X_FOLHA_SNTL: 1, DEBUG_FOLHA_PAGAMENTO_SNTL: 2, EXPRESSION_SYNTAX: 1 }, withPatch: { CLIENTE_ACME_SNTL: 1 } },
    norm: { n: 3, byRule: { CLIENTE_ACME_SNTL: 1, SORT_KEYS_SPLIT: 2, 'LIST_ENTITY_SEGMENT_DROPPED+NULL_FUNCTION_REWRITTEN': 1 } } },
];
const hostileExpected = hostile.map(h => sanitizeQualityLine(h, { nativeIds: NATIVE_IDS }));
const oversized = JSON.stringify({ ...frame, ok: true, class: 'ok', pad: 'x'.repeat(5000) });

// ---- expected payloads (reference rules)
const nameOf = t => Object.values(CUSTOMERS).find(([tok]) => tok === t)?.[1] ?? t;
const allLines = [...day11, ...day12];
const expectedAll = aggregate(allLines, { days: ['2026-10-12'], now: NOW, nameOf, nativeIds: NATIVE_IDS });
const expectedAlfa = aggregate(allLines, { days: ['2026-10-12'], token: CUSTOMERS.alfa[0], now: NOW, nameOf, nativeIds: NATIVE_IDS });
const envelope = (payload, token) => ({ ok: true, now: iso(NOW), range: { kind: 'day', from: '2026-10-12', to: '2026-10-12', days: 1, timeZone: 'America/Sao_Paulo' },
  indexing: { state: 'ready', progress: 1, detail: null }, available: true, firstDay: '2026-10-11', ...(token ? { token } : {}), ...payload });

// ---- write
const dir = path.join(OUT, 'server-dir');
fs.mkdirSync(dir, { recursive: true });
const jsonl = list => list.map(l => JSON.stringify(l)).join('\n') + '\n';
fs.writeFileSync(path.join(dir, 'quality-20261012.jsonl'), jsonl(day12));
fs.writeFileSync(path.join(dir, 'quality-20261011.jsonl.gz'), zlib.gzipSync(Buffer.from(jsonl(day11)), { mtime: 0 }));
fs.writeFileSync(path.join(dir, 'quality-20261013.jsonl'), hostile.map(h => JSON.stringify(h)).join('\n') + '\n' + oversized + '\n' + '{"schema":"ssam-quality/1","kind":"call"\n' + 'não é json\n');
fs.writeFileSync(path.join(OUT, 'hostile-expected.jsonl'), hostileExpected.map(h => JSON.stringify(h)).join('\n') + '\nnull\nnull\nnull\n');
fs.writeFileSync(path.join(OUT, 'expected-api-day-20261012.json'), JSON.stringify(envelope(expectedAll), null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'expected-api-day-20261012-alfa.json'), JSON.stringify(envelope(expectedAlfa, CUSTOMERS.alfa[0]), null, 2) + '\n');
const sizes = day12.map(l => Buffer.byteLength(JSON.stringify(l)) + 1);
console.log(JSON.stringify({ day12: day12.length, day11: day11.length, hostile: hostile.length + 3, maxLineBytes: Math.max(...sizes),
  avgLineBytes: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length), totals: expectedAll.totals }, null, 1));
