// responses.mjs: shell hints become MCP calls (text + continuation), studio_deliver answers `entregue` or the
// essentials of a refusal, and the whole pass is cheap enough to wrap every tool answer. Pure: no Studio, no I/O
// besides reading the kernel's stamped hint texts from this checkout.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rewriteHints, rewriteText, compactDelivery, shapeToolResult, formatCall, NOT_BUILT_WHY } from '../responses.mjs';

const SHELL = /python|cdp_pages|--click|dotnet build|build_odc|build\.py|anvil_worker|\.ps1|pwsh|\bssam (?:inspect|deliver|connect|discover|app|job|map)\b|\bodc (?:attach|deliver|inspect|portal)\b|anvil (?:functions|api|signature)|\bapi --(?:name|op) \w/;
const rewrite = (text, opts) => { const r = rewriteHints(text, opts); return { text: r.value, continuations: r.continuations }; };

// The kernel's dialog hints, read from the stamped sources so the test follows the real text.
const kernelFile = rel => fs.readFileSync(fileURLToPath(new URL('../../../../kernel/src/' + rel, import.meta.url)), 'utf8');
const csString = s => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
function dialogHints() {
  const policy = kernelFile('Anvil.Core/Kernel/DialogPolicy.cs');
  const hint = policy.slice(policy.indexOf('public static string Hint'));
  const fromPolicy = [...hint.matchAll(/=> "((?:[^"\\]|\\.)*)"/g)].map(m => csString(m[1]));
  const merge = kernelFile('Anvil.Bridge/MergeHandler.cs').match(/": apply or close it in the Studio \(see[^"]*"/)[0].slice(1, -1);
  return [...fromPolicy, "merge_from_oml: 'M' has a dialog or merge editor pending in the Studio (x)" + merge];
}

test('kernel dialog hints name the Studio person or o11_studio, never cdp_pages.py or --click', () => {
  const hints = dialogHints();
  assert.ok(hints.length >= 5, 'DialogPolicy.Hint and MergeHandler texts found');
  for (const hint of hints) {
    const { text, continuations } = rewrite(hint);
    assert.doesNotMatch(text, SHELL, text);
    if (/cdp_pages/.test(hint)) {
      assert.match(text, /in the Studio|o11_studio/, text);
      assert.deepEqual(continuations.map(c => [c.tool, c.arguments.command]), [['o11_studio', 'dismiss-dialog']]);
      assert.deepEqual(continuations[0].arguments.args, { title: '<dialog title>' });
      assert.ok(continuations[0].why);
    }
  }
  // A click outside the stamped sentences: the button stays, the command goes.
  const { text } = rewrite('then python scripts/cdp_pages.py --click "Manage Dependencies" and Apply');
  assert.equal(text, 'then ask the person to click "Manage Dependencies" in the Studio and Apply');
});

test('reference hints become ssam_reference; anvil signature becomes o11_job captureProducers', () => {
  let r = rewrite('unknown function Substrr; catalogo: docs/functions.md ou `anvil functions --find Substr` @ Flow');
  assert.equal(r.text, 'unknown function Substrr; catalogo: docs/functions.md ou ssam_reference {lane:"o11", kind:"functions", query:"Substr"} @ Flow');
  assert.deepEqual(r.continuations[0].arguments, { lane: 'o11', kind: 'functions', query: 'Substr' });
  r = rewrite("value 'x' invalid; allowed: a, b; see anvil api --name DeleteRule");
  assert.deepEqual(r.continuations.map(c => c.arguments), [{ lane: 'o11', kind: 'api', query: 'DeleteRule' }]);
  assert.match(r.text, /see ssam_reference \{lane:"o11", kind:"api", query:"DeleteRule"\}$/);
  r = rewrite('required: a; optional: b (api --op verbs)', { lane: 'odc' });
  assert.equal(r.text, 'required: a; optional: b (ssam_reference {lane:"odc", kind:"api", query:{op:"verbs"}})');
  assert.equal(rewrite('see api --name EntityAttribute').continuations[0].arguments.query, 'EntityAttribute');
  assert.equal(rewrite('use api --name with the short or full interface name').continuations[0].arguments.query, '<Interface>');
  // `api --op` named as the source of a contract, without an op, is a description: left as it is.
  const provenance = 'contract extracted from the lane CLI (`api --op`, the same table the dispatcher enforces)';
  assert.equal(rewrite(provenance).text, provenance);
  r = rewrite('capture it with `anvil signature` or deliver --capture-producer');
  assert.deepEqual(r.continuations[0], { tool: 'o11_job', arguments: { job: '<job.json>', captureProducers: ['<Producer>'] }, why: r.continuations[0].why });
  assert.doesNotMatch(r.text, /anvil signature/);
});

test('the FUNCTION_UNKNOWN fix of a refused job keeps its lookup: ssam_reference functions, with the continuation', () => {
  // The kernel's fix when no built-in is close to the name (JobRunner.cs; VerifyAnchorTests asserts the kernel side).
  const fix = 'no built-in, no function of the module or of its references and no action of this job is named like Zzqqxxw: '
    + 'write the built-in the expression means (ToLower, Substr, If, ...), or call an action of the module marked Function; the built-ins: `anvil functions --find Zzqqxxw`';
  const refusal = { ok: false, code: 'PREFLIGHT_REFUSED', error: 'the job was refused', problems: [
    { phase: 'base', op: 7, pointer: '/ops/7/data/actions/0/steps/0/assign/N', code: 'FUNCTION_UNKNOWN', severity: 'error', fix }] };
  const shaped = shapeToolResult('o11_deliver', { module: 'M' }, { content: [{ type: 'text', text: JSON.stringify(refusal) }], structuredContent: refusal, isError: true });
  const value = shaped.structuredContent;
  assert.match(value.problems[0].fix, /or call an action of the module marked Function; the built-ins: ssam_reference \{lane:"o11", kind:"functions", query:"Zzqqxxw"\}$/);
  assert.deepEqual(value.continuation, { tool: 'ssam_reference', arguments: { lane: 'o11', kind: 'functions', query: 'Zzqqxxw' }, why: value.continuation.why });
  assert.doesNotMatch(JSON.stringify(value), SHELL);
});

test('ssam and odc CLI lines become the tool with the same arguments', () => {
  const cases = [
    ['.\\ssam inspect --lane o11 --oml "C:\\c\\Q.oml" --path @K12 --expectedSourceSha256 ' + 'a'.repeat(64),
      'o11_inspect', { oml: 'C:\\c\\Q.oml', path: '@K12', expectedSourceSha256: 'a'.repeat(64) }],
    ['ssam inspect --lane o11 --oml Q.oml --kind MobileScreen --max 16 --offset 16 --properties Name --usages',
      'o11_inspect', { oml: 'Q.oml', kind: 'MobileScreen', max: 16, offset: 16, properties: 'Name', usages: true }],
    ['ssam deliver --lane o11 --module Orders_CS --job jobs/x.json --checks errors,warnings',
      'o11_deliver', { module: 'Orders_CS', job: 'jobs/x.json', checks: ['errors', 'warnings'], authorize: "<the user's own words>" }],
    ['Run ssam connect --lane odc first.', 'ssam_connect', { lane: 'odc' }],
    ["open it, sign in to the tenant and run 'odc attach'.", 'studio_attach', {}],
    ['ssam discover --expand data.structure:contract+example --lane o11', 'ssam_discover', { lane: 'o11', expand: 'data.structure:contract+example' }],
    ['odc deliver QuoteForm', 'studio_deliver', { feature: 'QuoteForm' }],
    ['.\\odc inspect "C:\\c\\Q.oml" "@<key>" --expectedSourceSha256 abc', 'studio_inspect', { target: 'C:\\c\\Q.oml', path: '@<key>', expectedSourceSha256: 'abc' }],
    ['odc portal internal-routes Orders', 'odc_portal_routes', { module: 'Orders' }],
    ['ssam app SSAMApp Home --lane odc --environment https://x.test', 'ssam_app_url', { app: 'SSAMApp', screen: 'Home', environment: 'https://x.test' }],
    ['ssam job --lane odc tests/jobs-odc/a.json', 'ssam_job', { lane: 'odc', job: 'tests/jobs-odc/a.json' }],
    ['.\\ssam map --lane odc "C:\\c\\Q.oml" --offset 4 --max 4 --budget 9000', 'ssam_map', { lane: 'odc', target: 'C:\\c\\Q.oml', offset: 4, max: 4, budgetBytes: 9000 }],
  ];
  for (const [line, tool, args] of cases) {
    const { text, continuations } = rewrite(line);
    assert.equal(continuations.length, 1, line);
    assert.equal(continuations[0].tool, tool, line);
    assert.deepEqual(continuations[0].arguments, args, line);
    assert.ok(text.includes(formatCall(tool, args)), text);
    assert.doesNotMatch(text, SHELL, text);
  }
  assert.equal(rewrite('The session is gone. Run ssam connect --lane o11 to select the current Studio.').text,
    'The session is gone. Call ssam_connect {lane:"o11"} to select the current Studio.');
  // The job runner line a lane answer prints (absolute, quoted interpreter) is the job tool.
  const runner = rewrite('"C:\\py\\python.exe" "C:\\k\\kernel\\scripts\\run_job.py" C:\\k\\jobs\\a.json --lane odc --base C:\\b.oml');
  assert.equal(runner.text, 'ssam_job {lane:"odc", job:"C:\\\\k\\\\jobs\\\\a.json", base:"C:\\\\b.oml"}');
  assert.equal(rewrite('python scripts/run_job.py tests/jobs/x.json').continuations[0].arguments.job, 'tests/jobs/x.json');
});

test('build and worker commands become ssam_doctor with the reason; credential scripts become the tool that opens the private prompt', () => {
  for (const [line, lane] of [['Bridge client is not built: dotnet build studio\\bridge\\client\\Client.csproj -c Release', 'odc'],
    ['ODC kernel CLI is not built: c; run scripts/build_odc.py in ANVIL_ROOT.', 'odc'], ['rebuild with kernel/scripts/build_odc.py before delivery.', 'odc'],
    ['stale CLI: python scripts/build.py --lane ss4', 'o11'], ['restart it: python scripts/anvil_worker.py restart', 'o11'],
    ['stale: C:\\Users\\u\\kernel\\scripts\\build_odc.py', 'odc']]) {
    const { text, continuations } = rewrite(line);
    assert.deepEqual(continuations, [{ tool: 'ssam_doctor', arguments: { lane }, why: NOT_BUILT_WHY }], line);
    assert.doesNotMatch(text, SHELL, text);
    assert.match(text, /ssam_doctor \{lane:"(odc|o11)"\} \(component not built: the integrator or the user builds it\)/);
  }
  let r = rewrite('store it with the private prompt (kernel\\scripts\\service_center\\windows-o11-credential.ps1 -Mode bootstrap), then repeat');
  assert.deepEqual(r.continuations.map(c => [c.tool, c.arguments]), [['o11_service_center_session', { action: 'sign-in' }]]);
  assert.doesNotMatch(r.text, SHELL);
  r = rewrite('No API Client credential for h. Store one locally: pwsh -File portal\\runtime\\windows-api-client-credential.ps1 -Mode bootstrap -Origin https://h.example.com');
  assert.deepEqual(r.continuations.map(c => [c.tool, c.arguments]), [['odc_read', { tenant: 'h.example.com', auth: 'api-client' }]]);
  assert.equal(r.text.startsWith('No API Client credential for h. Store one locally: odc_read {tenant:"h.example.com", auth:"api-client"}'), true, r.text);
  r = rewrite('& "C:\\PS\\pwsh.exe" -NoProfile -File "C:\\r\\portal\\runtime\\windows-api-client-credential.ps1" -Mode bootstrap -Origin https://t.test');
  assert.doesNotMatch(r.text, SHELL, r.text);
  assert.equal(r.continuations[0].arguments.tenant, 't.test');
});

test('values are walked without copying what did not change; continuations are deduplicated; no false positives', () => {
  const untouched = { ok: true, note: 'ssam_connect and ssam_doctor are tools; the ODC app opens; the ssam answers inspect itself', list: ['odc', 'anvil.dll', 42, null, true] };
  const same = rewriteHints(untouched);
  assert.equal(same.value, untouched); assert.deepEqual(same.continuations, []);
  const value = { ok: false, error: 'Run ssam connect --lane o11 to continue.', nested: { hints: ['see anvil api --name A', 'see anvil api --name A'], keep: { x: 1 } } };
  const r = rewriteHints(value);
  assert.notEqual(r.value, value); assert.equal(value.error, 'Run ssam connect --lane o11 to continue.', 'input not mutated');
  assert.equal(r.value.nested.keep, value.nested.keep, 'unchanged branches keep their identity');
  assert.deepEqual(r.continuations.map(c => c.tool), ['ssam_connect', 'ssam_reference']);
  const cyclic = { a: 'see anvil api --name B' }; cyclic.self = cyclic;
  assert.equal(rewriteHints(cyclic).value.a, 'see ssam_reference {lane:"o11", kind:"api", query:"B"}');
});

test('fast enough to wrap every answer: big strings and big objects', () => {
  const plain = 'x'.repeat(5_000_000);
  let t = performance.now(); assert.equal(rewriteText(plain), plain); const plainMs = performance.now() - t;
  // Near misses everywhere: every trigger word without a command after it.
  const near = ('anvil ssam odc api --x dotnet built cdp build.pyx '.repeat(20000));
  t = performance.now(); rewriteText(near); const nearMs = performance.now() - t;
  const hints = Array.from({ length: 2000 }, (_, i) => ({ id: i, hint: 'see anvil api --name T' + i, path: 'C:\\x\\' + i + '.oml', n: i }));
  t = performance.now(); const r = rewriteHints({ rows: hints }); const objectMs = performance.now() - t;
  assert.equal(r.continuations.length, 2000);
  const long = 'a'.repeat(200000) + ' `python scripts/cdp_pages.py --click Discard` ' + 'b'.repeat(200000);
  t = performance.now(); assert.match(rewriteText(long), /click "Discard" in the Studio/); const longMs = performance.now() - t;
  console.log(`responses timing: plain 5MB ${plainMs.toFixed(1)} ms, near-miss ${(near.length / 1e6).toFixed(1)}MB ${nearMs.toFixed(1)} ms, 2000 hints ${objectMs.toFixed(1)} ms, 400KB hint ${longMs.toFixed(1)} ms`);
  assert.ok(plainMs < 500 && nearMs < 1500 && objectMs < 1500 && longMs < 500, JSON.stringify({ plainMs, nearMs, objectMs, longMs }));
});

test('studio_deliver: a delivered integration job keeps its integration reports (contract I7)', () => {
  const integration = [{ op: 'rest', client: { name: 'ViaCepApi', key: 'k1', created: true }, imported: ['IRestAction:GetAddressByCep'], skipped: [], updated: [], removed: [], consumersBroken: [], warnings: [] }];
  const answer = { ok: true, merged: true, strictlyEqual: true, steps: [{ step: 'merge' }], totalSeconds: 3, integration, integrationTotal: 12 };
  assert.deepEqual(compactDelivery('studio_deliver', {}, answer), { ok: true, result: 'delivered', integration, integrationTotal: 12 });
  // A refused delivery that was delivered before the publish failed keeps it too; a plain refusal has none to keep.
  assert.deepEqual(compactDelivery('studio_deliver', {}, { ok: false, result: 'delivered', failed: 'publish', error: 'p', integration }).integration, integration);
});

test('studio_deliver: merged and strictly equal answers entregue; a refusal keeps only what the model acts on', () => {
  const merged = { ok: true, source: 'kernel-job', module: 'M', steps: [{ step: 'snapshot', seconds: 1.2 }], merged: true, strictlyEqual: true, merge: { merged: true, strictlyEqual: true, receipt: 'r' }, manifest: 'm', appLinks: { url: 'u' }, totalSeconds: 40 };
  // The manifest stays and, not published, the publication is named (atritos-a-publish.test.mjs).
  const delivered = compactDelivery('studio_deliver', {}, merged);
  assert.deepEqual({ ...delivered, continuation: delivered.continuation.tool + ' ' + JSON.stringify(delivered.continuation.arguments) },
    { ok: true, result: 'delivered', manifest: 'm', continuation: 'studio_publish {"module":"M"}' });
  assert.deepEqual(compactDelivery('studio_deliver', { until: 'merge' }, { ok: true, feature: 'F', merge: { merged: true, strictlyEqual: true } }), { ok: true, result: 'delivered' });
  // Not strictly equal is not `entregue` (the kernel path already refuses it; a C# feature answer passes as it is, without timings).
  const loose = compactDelivery('studio_deliver', {}, { ok: true, feature: 'F', merge: { merged: true, strictlyEqual: false }, steps: [], totalSeconds: 3 });
  assert.equal(loose.result, undefined); assert.equal(loose.steps, undefined); assert.equal(loose.totalSeconds, undefined); assert.equal(loose.merge.strictlyEqual, false);
  // until != merge: the value as it is, without the timing fields.
  const preview = { ok: true, until: 'preview', steps: [{ step: 'build', seconds: 3 }], totalSeconds: 9, manifest: 'm', preview: { conflicts: 0 } };
  assert.deepEqual(compactDelivery('studio_deliver', { until: 'preview' }, preview), { ok: true, until: 'preview', manifest: 'm', preview: { conflicts: 0 } });
  // Refusal of the kernel build: error, diagnostics, validation errors and discovery; never the raw refusal or the steps.
  const refused = { ok: false, source: 'kernel-job', module: 'M', steps: [{ step: 'build', seconds: 2 }], failed: 'build', error: 'Kernel candidate must be accepted and valid before delivery.',
    refusal: { ok: false, error: 'e', diagnostics: ['TrueChange: Invalid Expression'], validation: { errors: ['E1'], warnings: ['W1'] }, receipt: 'r.json' }, discovery: { op: 'set' }, evidence: 'lab/01', totalSeconds: 5, appLinks: {} };
  assert.deepEqual(compactDelivery('studio_deliver', {}, refused), { ok: false, failed: 'build', error: 'Kernel candidate must be accepted and valid before delivery.',
    diagnostics: ['TrueChange: Invalid Expression'], validationErrors: ['E1'], discovery: { op: 'set' } });
  // A gate refusal and an uncertain merge keep gate/outcome; the uncertain one keeps the folder of its receipts.
  assert.deepEqual(compactDelivery('studio_deliver', {}, { ok: false, failed: 'check-base', gate: 'base_drift', error: 'drift', steps: [] }), { ok: false, failed: 'check-base', error: 'drift', gate: 'base_drift' });
  assert.deepEqual(compactDelivery('studio_deliver', {}, { ok: false, failed: 'merge', outcome: 'uncertain', error: 'unknown', evidence: 'lab/02', steps: [] }),
    { ok: false, failed: 'merge', error: 'unknown', outcome: 'uncertain', evidence: 'lab/02' });
  // An incomplete merge (merge order: merged, known losses only) keeps each lost element and the repair job it needs.
  const repair = { ops: [{ op: 'set', target: '@k1', prop: 'DefaultValue', value: 'Entities.Dificuldade.Medio' }] };
  assert.deepEqual(compactDelivery('studio_deliver', {}, { ok: false, failed: 'merge', outcome: 'incomplete', gate: 'equivalence', error: 'kept except', merged: true,
    missing: [{ element: 'Quiz.DificuldadeId' }], repair, forcedDeleteRules: [], declare: { ops: [] }, afterSnapshot: 'a.oml', evidence: 'lab/24', steps: [] }),
  { ok: false, failed: 'merge', error: 'kept except', outcome: 'incomplete', gate: 'equivalence', merged: true, missing: [{ element: 'Quiz.DificuldadeId' }], repair,
    forcedDeleteRules: [], declare: { ops: [] }, evidence: 'lab/24' });
  // The C# feature path: the builder receipt's added errors.
  assert.deepEqual(compactDelivery('studio_deliver', {}, { ok: false, failed: 'preview', error: 'validation delta', receipt: { addedErrors: ['X'], addedWarnings: [] } }).validationErrors, ['X']);
  const other = { ok: true, steps: [1] };
  assert.equal(compactDelivery('o11_job', {}, other), other);
});

test('shapeToolResult: structured answers, JSON text answers and plain text answers', () => {
  const structured = { ok: false, error: 'The selected Studio session is no longer connected. Run ssam connect --lane o11 to select the current Studio.' };
  const result = { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: true };
  const shaped = shapeToolResult('o11_job', {}, result);
  assert.equal(shaped.isError, true);
  assert.deepEqual(shaped.structuredContent.continuation, { tool: 'ssam_connect', arguments: { lane: 'o11' } });
  assert.deepEqual(JSON.parse(shaped.content[0].text), shaped.structuredContent);
  assert.doesNotMatch(shaped.content[0].text, SHELL);
  // Nothing to change: the same object back.
  const clean = { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } };
  assert.equal(shapeToolResult('ssam_doctor', {}, clean), clean);
  // A delivery: entregue, in both the structured value and the text.
  const delivered = { content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true, merged: true, strictlyEqual: true, steps: [] } };
  const d = shapeToolResult('studio_deliver', { feature: 'F' }, delivered);
  assert.deepEqual(d.structuredContent, { ok: true, result: 'delivered' }); assert.equal(d.content[0].text, '{"ok":true,"result":"delivered"}');
  // A proxied answer with JSON only in its text (the O11 server): parsed, shaped, written back as text.
  const proxied = { content: [{ type: 'text', text: JSON.stringify({ ok: true, hint: 'see anvil api --name X' }) }] };
  const p = shapeToolResult('propose', {}, proxied);
  assert.equal(p.structuredContent, undefined);
  assert.deepEqual(JSON.parse(p.content[0].text), { ok: true, hint: 'see ssam_reference {lane:"o11", kind:"api", query:"X"}',
    nextCalls: [{ tool: 'ssam_reference', arguments: { lane: 'o11', kind: 'api', query: 'X' }, why: 'contract of the Model API / of the kernel ops of the lane' }] });
  // Plain text: the text itself.
  const text = shapeToolResult('context', {}, { content: [{ type: 'text', text: 'blocked: run odc attach' }] });
  assert.equal(text.content[0].text, 'blocked: call studio_attach {}');
});

test('studio_deliver refusal keeps what the corrected job is built from: job, jobSha256, failedOp, basedOn', () => {
  const sha = 'c'.repeat(64);
  const refused = { ok: false, failed: 'build', error: 'op 3 refused', job: 'C:\\odc\\.local\\jobs\\inline\\j.json', jobSha256: sha, failedOp: { index: 3, op: 'set' },
    basedOn: 'd'.repeat(64), steps: [{ step: 'build' }], totalSeconds: 4, evidence: 'lab/03' };
  assert.deepEqual(compactDelivery('studio_deliver', {}, refused), { ok: false, failed: 'build', error: 'op 3 refused', job: refused.job, jobSha256: sha,
    failedOp: { index: 3, op: 'set' }, basedOn: 'd'.repeat(64) });
  // From the raw refusal when the top level lacks them; absent fields stay absent.
  const nested = compactDelivery('studio_deliver', {}, { ok: false, failed: 'build', error: 'e', refusal: { error: 'e', failedOp: { index: 0 }, jobSha256: sha } });
  assert.deepEqual(nested.failedOp, { index: 0 }); assert.equal(nested.jobSha256, sha); assert.equal('job' in nested, false); assert.equal('basedOn' in nested, false);
  // Through the shaper: preserved in the structured value and in the text.
  const r = shapeToolResult('studio_deliver', { feature: 'F' }, { content: [{ type: 'text', text: '{}' }], structuredContent: refused, isError: true });
  assert.equal(JSON.parse(r.content[0].text).failedOp.index, 3); assert.equal(r.structuredContent.basedOn, 'd'.repeat(64));
});

test('shapeToolResult adds the next read of a capture and keeps the exact texts', () => {
  const sha = 'e'.repeat(64);
  const shot = { ok: true, module: 'Orders', sha256: sha, path: 'C:\\odc\\snapshots\\Orders-' + sha + '.oml' };
  const r = shapeToolResult('studio_snapshot', { module: 'Orders' }, { content: [{ type: 'text', text: JSON.stringify(shot) }], structuredContent: shot });
  assert.deepEqual(r.structuredContent.next.map(c => c.tool), ['ssam_map', 'studio_inspect']);
  assert.deepEqual(r.structuredContent.next[1].arguments, { target: shot.path, expectedSourceSha256: sha });
  for (const [tool, word] of [['o11_deliver', 'delivered'], ['o11_publish', 'published'], ['o11_deliver', 'closed']]) {
    const reply = { content: [{ type: 'text', text: word }], structuredContent: { ok: true, result: word } };
    assert.equal(shapeToolResult(tool, { authorize: 'pode, sim' }, reply), reply);
  }
});

test('ssam_evidence passes untouched: the evidence says what its file says, and file text never becomes suggested calls', () => {
  const value = { ok: true, total: 1, items: [{ msg: 'ran dotnet build kernel/src/X.csproj then ssam deliver --module M --job j.json' }] };
  const reply = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  assert.equal(shapeToolResult('ssam_evidence', { file: 'C:\\x\\diario.jsonl' }, reply, { lane: 'o11' }), reply);
  // the same text in another tool's answer is still rewritten
  assert.match(JSON.stringify(shapeToolResult('o11_job', {}, reply, { lane: 'o11' }).structuredContent), /o11_deliver/);
});

// 2026-10-12: "delivered" carries what the job created (job-summary.mjs), so no ssam_map follows the delivery.
test('a delivered studio_deliver keeps the summary of the job beside "delivered"; a refusal never carries one', () => {
  const summary = { ops: 2, actions: ['Pedido_Get(PedidoId: Pedido Identifier) -> (Pedido: Pedido)'], entities: [{ name: 'Pedido', attributes: 3 }] };
  const delivered = compactDelivery('studio_deliver', {}, { ok: true, feature: 'F', merge: { merged: true, strictlyEqual: true }, summary, steps: [], totalSeconds: 4 });
  assert.deepEqual(delivered, { ok: true, result: 'delivered', summary });
  const refused = compactDelivery('studio_deliver', {}, { ok: false, failed: 'build', error: 'x', summary });
  assert.equal(refused.summary, undefined);
});
