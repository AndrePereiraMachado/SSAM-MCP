// Local metadata only. Operation records never persist arguments, stdout, error text, model content or credentials.
// A manual report (ssam_friction {view:"report"}, A31 of the 2026-10-06 package) is the one exception: it keeps only the
// short fields the session writes on purpose (kind, tool, intent, attempted, workaround, cost, summary), each bounded;
// the user's words may appear only in summary.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const digest = value => createHash('sha256').update(value).digest('hex');
// The refusal table the ssam response shaper uses (platforms/odc/facade/refusal-codes.mjs, A20): a failure without a code
// whose text it knows (an SDK validation error, debug_<x>, a discovery index mismatch...) is recorded with that code, never
// OPERATION_FAILED. Loaded once; a layout without the facade (a copied launcher) classifies nothing and keeps the rest.
const REFUSALS = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'platforms', 'odc', 'facade', 'refusal-codes.mjs')).href).catch(() => null);
export const codeOfText = text => REFUSALS?.codeFromText?.(text) ?? null;
const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value) ? value.toLowerCase() : null;
// C33 (atritos 3): the session of an MCP transport that serves several (the hosted server's mcp-session-id) keys its
// operations; a UUID stays as it is, any other id becomes a UUID-shaped digest (never the id itself).
export function sessionKey(value) {
  if (id(value)) return id(value);
  if (typeof value !== 'string' || !value.trim() || value.length > 512) return null;
  const d = digest('session:' + value);
  return `${d.slice(0, 8)}-${d.slice(8, 12)}-${d.slice(12, 16)}-${d.slice(16, 20)}-${d.slice(20, 32)}`;
}
export const taskRef = value => typeof value === 'string' && value.length ? 'task-' + digest(value).slice(0, 32) : null;
// Operation names are the MCP tool names without the lane prefix (o11_studio -> studio) or the CLI verbs; anything else
// is recorded as `other`. The 2026-10-05 package adds grant (ssam_grant), close (ssam_task close) and warm (ssam warm),
// and the session tools that used to fold into `other` (discover, map, connect, evidence, reference, task, ...).
const allowed = new Set(('help version doctor inspect diagnostics delivery-status check-delivery deliver manifest build job apply publish create ' +
  'snapshot preview merge check-base authorize attach data data-insert data-update data-delete open close status assets ' +
  'context propose continue tenants apis search describe read write debug app app-url api check-job refresh-references ' +
  'grant warm discover map connect evidence reference task studio environment wait latest consumers command dismiss-dialog ' +
  'create-app debug-run debug-invoke service-center-read service-center-write access dependencies').split(' '));
export function operationName(value) {
  const name = String(value ?? '').replace(/^(ssam_|studio_|odc_|o11_|hybrid_)/, '').replaceAll('_', '-');
  return allowed.has(name) ? name : 'other';
}
export const laneName = value => ['o11', 'odc'].includes(value) ? value : 'unknown';
// The stages the producers name in `failed`, `stage` or `gate` (interface I9 of the 2026-10-05 package).
export const STEPS = ['snapshot', 'build', 'manifest', 'check-base', 'preview', 'merge', 'publish', 'validation', 'equivalence', 'preflight', 'apply',
  'verify', 'reconcile', 'refresh-references', 'relay', 'connect', 'data', 'debug', 'service-center'];
const stepName = value => STEPS.includes(value) ? value : null;
// A specific code the answer carries (UPPER_SNAKE) wins over the generic OPERATION_FAILED; `OK` is never a failure code.
const CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]{3,}$/;
const codeName = value => (typeof value === 'string' && CODE.test(value) && value !== 'OK' ? value : null);
// The stage a code implies when the answer names none (PREFLIGHT_REFUSED is refused at preflight).
const STEP_OF_CODE = [[/^PREFLIGHT_/, 'preflight'], [/^PUBLISH_/, 'publish'], [/^VERIFY_/, 'verify'], [/^VALIDATION_/, 'validation'], [/^MERGE_/, 'merge'], [/^DATA_/, 'data'], [/^DEBUG_/, 'debug']];
const stepOfCode = code => (code ? STEP_OF_CODE.find(([pattern]) => pattern.test(code))?.[1] ?? null : null);

// Only inspect documented wrapper fields; do not walk arbitrary model/record properties.
export function outcomeOf(input, transport = {}) {
  // plain: the text blocks that are not JSON (an SDK "Input validation error ..." answer); only classified, never stored.
  const values = [], plain = []; const add = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    values.push(value);
    for (const key of ['result','structuredContent','refusal']) add(value[key], depth + 1);
    for (const block of (Array.isArray(value.content) ? value.content.slice(0, 4) : [])) {
      if (block.type === 'text' && typeof block.text === 'string') {
        // A text that is JSON but not an answer object (a ZodError's issue list) is classified as text too.
        try { const parsed = JSON.parse(block.text); add(parsed, depth + 1); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) plain.push(block.text); }
        catch { plain.push(block.text); }
      }
    }
  }; add(input);
  const transportFailed = (typeof transport.exitCode === 'number' && transport.exitCode !== 0) || transport.protocolError === true || transport.transportError === true;
  const failureValue = v => v.ok === false || v.isError === true || v.isValid === false || (typeof v.exitCode === 'number' && v.exitCode !== 0);
  // Informational/help text mentioning a timeout is not an execution failure.
  const errorTexts = values.flatMap(v => [v.error, ...(failureValue(v) || transportFailed || typeof v.error === 'string' ? [v.message] : [])].filter(s => typeof s === 'string'));
  const author = errorTexts.some(s => s.includes('No change carries the snapshot author'));
  const timeout = transport.timeout === true || errorTexts.some(s => /\b(timed?\s*out|timeout|ETIMEDOUT)\b/i.test(s));
  const failed = author || timeout || values.some(v => failureValue(v) || (typeof v.error === 'string' && v.error.length > 0)) || transportFailed;
  const interrupted = transport.interrupted === true;
  const declaredUncertain = values.some(v => v.outcome === 'uncertain');
  const equivalenceUncertain = declaredUncertain && values.some(v => v.gate === 'equivalence');
  const semanticKnown = values.some(v => typeof v.ok === 'boolean' || typeof v.isError === 'boolean' || typeof v.isValid === 'boolean');
  const packageId = values.map(v => v.packageId).find(v => typeof v === 'string' && /^readonly-[a-f0-9]{16,64}$/.test(v));
  // The code the answer itself states (top level first, then a JSON-RPC style {error:{code}}), only for a failure or an
  // uncertainty: 89 of 89 o11/job failures used to be recorded as OPERATION_FAILED with no step (C44).
  const explicit = values.map(v => codeName(v.code) ?? codeName(v.error?.code)).find(Boolean) ?? null;
  // Before the generic OPERATION_FAILED: the code the refusal table gives the answer's texts (A20).
  const classified = () => [...errorTexts, ...(failed ? plain : [])].map(codeOfText).find(Boolean) ?? null;
  const code = interrupted ? 'INTERRUPTED'
    : declaredUncertain ? (equivalenceUncertain ? 'EQUIVALENCE_UNCERTAIN' : explicit ?? 'OUTCOME_UNCERTAIN')
    : author ? 'SNAPSHOT_AUTHOR_MISSING'
    : timeout ? (explicit ?? 'TIMEOUT')
    : transport.transportError ? 'TRANSPORT_FAILED'
    : failed ? (explicit ?? classified() ?? 'OPERATION_FAILED')
    : semanticKnown ? 'OK' : 'RESULT_UNOBSERVED';
  const failing = interrupted || declaredUncertain || timeout || failed;
  return { outcome: interrupted || declaredUncertain ? 'uncertain' : timeout ? 'timeout' : failed ? 'failure' : semanticKnown ? 'success' : 'unknown',
    code,
    step: values.map(v => stepName(v.failed) ?? stepName(v.stage) ?? stepName(v.gate)).find(Boolean) ?? (failing ? stepOfCode(code) : null),
    lane: values.map(v => laneName(v.lane)).find(v => v !== 'unknown') ?? 'unknown',
    reportedPackageId: packageId ?? null,
    exitCode: Number.isInteger(transport.exitCode) ? transport.exitCode : null,
    transportSucceeded: transport.exitCode === 0,
  };
}

// The queue folder: an explicit directory, else SSAM_FRICTION_DIR (test runs and benches keep their records out of the
// shared queue), else <root>/.local/friction.
export function frictionDirectory({ root, directory, env = process.env } = {}) {
  return directory ?? (typeof env.SSAM_FRICTION_DIR === 'string' && env.SSAM_FRICTION_DIR.trim() ? path.resolve(env.SSAM_FRICTION_DIR) : path.join(root, '.local', 'friction'));
}
export function createStore({ root, directory, env = process.env, warning = code => process.stderr.write(`[ssam-friction] ${code}; operation result is unchanged.\n`), clock = () => Date.now() } = {}) {
  const dir = frictionDirectory({ root, directory, env });
  let losses = 0;
  const warn = code => { losses++; try { warning(code); } catch {} };
  function write(folder, name, value, immutable = false) {
    const target = path.join(dir, folder); let temp;
    try {
      fs.mkdirSync(target, { recursive: true });
      temp = path.join(target, '.' + randomUUID() + '.tmp');
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // Each final filename is unique. Readers never see half of a JSON record.
      if (immutable) {
        try { fs.linkSync(temp, path.join(target, name + '.json')); }
        catch (error) { if (error.code === 'EEXIST') return 'existing'; throw error; }
      } else fs.renameSync(temp, path.join(target, name + '.json'));
      return true;
    } catch { warn('RECORD_WRITE_FAILED'); return false; }
    finally { if (temp) { try { fs.unlinkSync(temp); } catch {} } }
  }
  function records(folder) {
    const items = []; let damaged = 0; let partial = 0;
    try {
      for (const name of fs.readdirSync(path.join(dir, folder))) {
        if (name.endsWith('.tmp')) { partial++; continue; }
        if (!name.endsWith('.json')) continue;
        try { const stat = fs.statSync(path.join(dir, folder, name)); if (stat.size > 65536) throw Error(); items.push(JSON.parse(fs.readFileSync(path.join(dir, folder, name), 'utf8'))); }
        catch { damaged++; }
      }
    } catch (error) { if (error.code !== 'ENOENT') damaged++; }
    return { items, damaged, partial };
  }
  // ---- the daily index (C33 of the atritos 3 package): issues() read every operation file on every call (6,000 records:
  // 1.45 s and 23.9 KB). Each start and end also appends one compact line to index/<yyyymmdd>.jsonl (the day of the start);
  // index/.complete says the index holds every operation. A store that had operations before the index (or an index write
  // that failed, which removes the mark) is rebuilt from the operation files once, by the next reader. Lines are only
  // appended, so a rebuild racing a writer makes duplicates, never losses; readers keep the first line of each kind.
  const indexDir = path.join(dir, 'index'), indexMark = path.join(indexDir, '.complete');
  const indexDay = iso => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).replace(/-/g, '') : 'undated');
  const INDEX_FIELDS = ['startedAt', 'operation', 'lane', 'profile', 'taskRef', 'sessionId', 'interface'];
  const END_FIELDS = ['endedAt', 'outcome', 'code', 'step', 'signal'];
  const indexLine = (event, end) => Object.fromEntries([['k', end ? 'e' : 's'], ['id', event.operationId],
    ...INDEX_FIELDS.map(k => [k, event[k] ?? null]), ...(end ? END_FIELDS.map(k => [k, event[k] ?? null]) : [])]);
  let markKnown = false;
  // quiet: the mark of an empty store (a folder that cannot be written loses the operation records too, and they warn).
  function markIndex(operations, quiet = false) {
    try { fs.mkdirSync(indexDir, { recursive: true }); fs.writeFileSync(indexMark, JSON.stringify({ schema: 'ssam-friction-index/1', at: new Date(clock()).toISOString(), operations })); markKnown = true; }
    catch { if (!quiet) warn('INDEX_WRITE_FAILED'); }
  }
  // A store without any operation yet starts with a complete (empty) index.
  function ensureIndexBase() {
    if (markKnown) return;
    if (fs.existsSync(indexMark)) { markKnown = true; return; }
    let names = [];
    try { names = fs.readdirSync(path.join(dir, 'operations')).filter(n => n.endsWith('.json')); } catch { names = []; }
    if (!names.length) markIndex(0, true);
  }
  function appendIndex(event, end) {
    try { fs.mkdirSync(indexDir, { recursive: true }); fs.appendFileSync(path.join(indexDir, indexDay(event.startedAt) + '.jsonl'), JSON.stringify(indexLine(event, end)) + '\n'); return true; }
    catch { warn('INDEX_WRITE_FAILED'); markKnown = false; try { fs.unlinkSync(indexMark); } catch {} return false; }
  }
  function rebuildIndex() {
    const data = snapshot();
    let whole = true;
    for (const event of data.operations) {
      whole = appendIndex(event, false) && whole;
      if (event.endedAt) whole = appendIndex(event, true) && whole;
    }
    if (whole) markIndex(data.operations.length);
  }
  // The operations as snapshot() gives them (ends, then starts without an end as incomplete), from the index.
  function indexed() {
    if (!fs.existsSync(indexMark)) rebuildIndex();
    const starts = new Map(), ends = new Map(); let damaged = 0;
    let names = [];
    try { names = fs.readdirSync(indexDir).filter(n => n.endsWith('.jsonl')); } catch { names = []; }
    for (const name of names) {
      let text = '';
      try { text = fs.readFileSync(path.join(indexDir, name), 'utf8'); } catch { damaged++; continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let entry; try { entry = JSON.parse(line); } catch { damaged++; continue; }
        if (!entry || !id(entry.id) || !Number.isFinite(Date.parse(entry.startedAt))) { damaged++; continue; }
        const map = entry.k === 'e' ? ends : starts;
        if (!map.has(entry.id)) map.set(entry.id, entry);
      }
    }
    const shape = (entry, start) => ({ operationId: entry.id, ...Object.fromEntries(INDEX_FIELDS.map(k => [k, entry[k] ?? start?.[k] ?? null])),
      ...Object.fromEntries(END_FIELDS.map(k => [k, entry[k] ?? null])) });
    const operations = [...[...ends.values()].map(e => shape(e, starts.get(e.id))),
      ...[...starts.values()].filter(s => !ends.has(s.id)).map(s => ({ ...shape(s), outcome: 'incomplete', code: 'NO_COMPLETION_RECEIPT' }))]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.operationId.localeCompare(b.operationId));
    return { operations, health: { damagedRecords: damaged, partialRecords: 0, localWriteLosses: losses, source: 'index' } };
  }
  function begin(meta = {}) {
    ensureIndexBase();
    const receiptKey = meta.interface === 'receipt-import' && /^[a-f0-9]{64}$/.test(meta.receiptSha256 ?? '') ? meta.receiptSha256 : null;
    const stable = receiptKey ? digest('receipt:' + receiptKey) : null;
    const operationId = stable ? `${stable.slice(0,8)}-${stable.slice(8,12)}-${stable.slice(12,16)}-${stable.slice(16,20)}-${stable.slice(20,32)}` : randomUUID(), start = performance.now();
    let event = { schema: 'ssam-friction-operation/1', operationId, sessionId: sessionKey(meta.sessionId), pid: process.pid,
      taskRef: taskRef(meta.taskId), correlation: taskRef(meta.taskId) ? meta.correlationSource === 'client-thread-environment' ? 'client-thread-environment' : 'explicit-task' : 'absent',
      interface: ['cli','mcp','receipt-import','api'].includes(meta.interface) ? meta.interface : 'unknown',
      operation: operationName(meta.operation), lane: laneName(meta.lane),
      profile: meta.profile === 'selected-readonly' ? 'selected-readonly' : 'operational',
      toolingSha256: /^[a-f0-9]{64}$/.test(meta.toolingSha256 ?? '') ? meta.toolingSha256 : null,
      selectedPackageId: /^readonly-[a-f0-9]{16,64}$/.test(meta.selectedPackageId ?? '') ? meta.selectedPackageId : null,
      selectedPackageSha256: /^[a-f0-9]{64}$/.test(meta.selectedPackageSha256 ?? '') ? meta.selectedPackageSha256 : null,
      versionScope: meta.profile === 'selected-readonly' ? 'selected-descriptor; admission remains owned by package router' : 'facade-source-fingerprint; native-binary identity not observed',
      startedAt: new Date(clock()).toISOString() };
    const recorded = write('operations', operationId + '.start', event, true); let done = false;
    if (recorded === 'existing') {
      try { event = JSON.parse(fs.readFileSync(path.join(dir,'operations',operationId+'.start.json'),'utf8')); }
      catch { warn('EXISTING_RECORD_UNREADABLE'); }
    } else if (recorded === true) appendIndex(event, false);
    return { operationId, finish(value, transport = {}) {
      if (done) return; done = true;
      const result = outcomeOf(value, transport);
      const evidence = transport.evidence && /^[a-f0-9]{64}$/.test(transport.evidence.sha256 ?? '')
        ? { sha256: transport.evidence.sha256, kind: 'receipt', locatorSha256: /^[a-f0-9]{64}$/.test(transport.evidence.locatorSha256 ?? '') ? transport.evidence.locatorSha256 : null } : null;
      const end = { ...event, ...result, lane: result.lane === 'unknown' ? event.lane : result.lane,
        endedAt: new Date(clock()).toISOString(), durationMs: Math.round((performance.now() - start) * 1000) / 1000,
        durationSource: 'observer-monotonic', startRecorded: !!recorded, evidence,
        ...(Number.isFinite(transport.receiptDurationMs) && transport.receiptDurationMs >= 0 ? { receiptDurationMs: transport.receiptDurationMs } : {}) };
      if (Number.isFinite(meta.slowThresholdMs) && meta.slowThresholdMs > 0 && end.durationMs > meta.slowThresholdMs && end.outcome === 'success') end.signal = 'SLOW_OPERATION';
      if (write('operations', operationId + '.end', end, true) === true) appendIndex(end, true);
    } };
  }
  function snapshot() {
    const all = records('operations'), starts = new Map(), ends = new Map(); let invalid = 0;
    for (const event of all.items) {
      if (event.schema !== 'ssam-friction-operation/1' || !id(event.operationId) || !Number.isFinite(Date.parse(event.startedAt))) { invalid++; continue; }
      const map = event.endedAt ? ends : starts;
      if (map.has(event.operationId)) { invalid++; continue; }
      map.set(event.operationId, event);
    }
    const operations = [...ends.values(), ...[...starts.values()].filter(s => !ends.has(s.operationId)).map(s => ({ ...s, outcome: 'incomplete', code: 'NO_COMPLETION_RECEIPT' }))].sort((a,b) => a.startedAt.localeCompare(b.startedAt) || a.operationId.localeCompare(b.operationId));
    return { operations, health: { damagedRecords: all.damaged + invalid, partialRecords: all.partial, localWriteLosses: losses } };
  }
  function issueKey(event) {
    return digest([event.profile,event.operation,event.lane,event.code,event.step ?? '',event.signal ?? ''].join('|')).slice(0,32);
  }
  // C33: from the index; each group says its counts, times, last step and the ids of its two last operations (the
  // operations themselves: snapshot() or task()). The state is read only for the issues of the page. source:'scan'
  // computes the same from the operation files (the proof that the index equals the scan).
  function issues({ taskId, offset = 0, limit = 50, max, source = 'index' } = {}) {
    if (Number.isInteger(max)) limit = max;
    const data = source === 'scan' ? snapshot() : indexed(), groups = new Map(); const wanted = taskRef(taskId);
    for (const event of data.operations) {
      if (!['failure','timeout','uncertain','incomplete'].includes(event.outcome) && !event.signal) continue;
      const key = issueKey(event);
      let group = groups.get(key);
      if (!group) groups.set(key, group = { id:key, operation:event.operation, lane:event.lane, profile:event.profile, code:event.signal ?? event.code, kind:event.signal ? 'signal' : event.outcome,
        count:0, firstSeen:event.startedAt, lastSeen:null, lastStep:null, lastOperationIds:[], tasks:new Set(), lastEnded:null });
      group.count++;
      group.lastSeen = event.endedAt ?? event.startedAt; group.lastStep = event.step ?? null;
      group.lastOperationIds = [...group.lastOperationIds, event.operationId].slice(-2);
      if (event.taskRef) group.tasks.add(event.taskRef);
      if (event.endedAt && (!group.lastEnded || event.endedAt > group.lastEnded)) group.lastEnded = event.endedAt;
    }
    const matching = [...groups.values()].filter(g => !wanted || g.tasks.has(wanted)).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.id.localeCompare(b.id));
    const page = matching.slice(offset, offset + limit).map(({ tasks, lastEnded, ...issue }) => {
      const state = stateOf(issue.id);
      const recurrence = state.status === 'verified' && lastEnded && lastEnded > state.updatedAt;
      return { ...issue, state: recurrence ? { ...state, status: 'new', reopened: true } : state };
    });
    const manual = reports({ taskId, limit: REPORTS_SHOWN });
    return { ok: true, issues:page, total:matching.length, offset, limit, health:data.health,
      ...(manual.total ? { reports: manual.reports, reportsTotal: manual.total } : {}),
      notificationDelivery:'queue-only; no notification consumer is installed' };
  }
  // ---- manual reports (A31): a gap, defect or slowness the session saw without a failed call (it fell back to native
  // verbs, used a workaround, waited). One immutable record per report under reports/, linked to the last operations of
  // the same MCP session (their ids, codes and receipt hashes). Never arguments or answers; the user's words only in summary.
  function report(input = {}, { sessionId, profile } = {}) {
    const problems = reportProblems(input);
    if (problems.length) return { ok: false, code: 'REPORT_INVALID', error: 'Invalid friction report: ' + problems.join('; '), problems,
      accepted: { kind: REPORT_KINDS, required: ['kind', 'tool', 'intent', 'attempted'], optional: ['workaround', 'cost', 'summary', 'taskId'], maxLength: REPORT_FIELDS } };
    const session = sessionKey(sessionId);
    const recent = session ? snapshot().operations.filter(e => e.sessionId === session).slice(-REPORT_LINKED).map(e => ({ operationId: e.operationId,
      operation: e.operation, lane: e.lane, outcome: e.outcome, code: e.code ?? null, step: e.step ?? null, startedAt: e.startedAt,
      ...(e.evidence?.sha256 ? { receiptSha256: e.evidence.sha256 } : {}) })) : [];
    const reportId = randomUUID();
    const text = key => (input[key] === undefined || input[key] === null ? undefined : String(input[key]).trim());
    const record = { schema: 'ssam-friction-report/1', reportId, kind: input.kind, tool: text('tool'), intent: text('intent'), attempted: text('attempted'),
      ...Object.fromEntries(['workaround', 'cost', 'summary'].filter(k => text(k)).map(k => [k, text(k)])),
      taskRef: taskRef(input.taskId), sessionId: session, profile: profile === 'selected-readonly' ? 'selected-readonly' : 'operational',
      reportedAt: new Date(clock()).toISOString(), recent };
    const written = write('reports', reportId, record, true);
    if (written !== true) return { ok: false, code: 'REPORT_NOT_RECORDED', error: 'The report could not be written to the local friction queue', directory: dir };
    return { ok: true, recorded: true, reportId, kind: record.kind, file: path.join(dir, 'reports', reportId + '.json'), linkedOperations: recent.length };
  }
  function reports({ taskId, offset = 0, limit = 50 } = {}) {
    const all = records('reports'); const wanted = taskRef(taskId);
    const items = all.items.filter(r => r?.schema === 'ssam-friction-report/1' && typeof r.reportedAt === 'string' && (!wanted || r.taskRef === wanted))
      .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt) || String(a.reportId).localeCompare(String(b.reportId)));
    return { reports: items.slice(offset, offset + limit), total: items.length, damaged: all.damaged };
  }
  function stateOf(issueId) {
    const all = records('states/' + issueId);
    const byParent = new Map();
    for (const record of all.items) { const key = record.previous ?? 'initial'; if (!byParent.has(key)) byParent.set(key,[]); byParent.get(key).push(record); }
    let state = { status:'new', revision:null, updatedAt:null };
    const seen = new Set();
    for (;;) {
      const next = byParent.get(state.revision ?? 'initial');
      if (!next) break;
      if (next.length !== 1 || seen.has(next[0].revision)) return { ...state, status:'conflict', needsAttention:true };
      state = next[0]; seen.add(state.revision);
    }
    if (all.damaged || all.partial || seen.size !== all.items.length) return {...state,status:'conflict',needsAttention:true};
    return state;
  }
  function transition({ issueId, status, expectedRevision = null, proof } = {}) {
    if (!/^[a-f0-9]{32}$/.test(issueId ?? '') || !['investigating','corrected','verified'].includes(status)) throw Error('Invalid issue or status');
    const issue = issues({limit:Number.MAX_SAFE_INTEGER}).issues.find(i=>i.id===issueId);
    if (!issue) throw Error('Issue does not exist');
    const state = issue.state;
    if (state.status === 'conflict' || state.revision !== expectedRevision) throw Error('State changed; reread the issue');
    const permitted = {new:['investigating'],investigating:['corrected'],corrected:['investigating','verified'],verified:['investigating']};
    if (!permitted[state.status]?.includes(status)) throw Error('Invalid state transition');
    let proofRef = null;
    if (status === 'corrected' || status === 'verified') {
      if (!proof || !/^[a-f0-9]{64}$/.test(proof.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(proof.versionSha256 ?? '')) throw Error('Correction requires evidence hash and version hash');
      proofRef = {sha256:proof.sha256,versionSha256:proof.versionSha256};
    }
    if (status === 'verified') {
      const event = snapshot().operations.find(e=>e.operationId===proof.operationId);
      if (!event || event.outcome !== 'success' || event.signal || event.operation !== issue.operation || event.lane !== issue.lane || event.profile !== issue.profile || event.startedAt < state.updatedAt) throw Error('Verification requires a later successful matching operation');
      const version = event.selectedPackageSha256 ?? event.toolingSha256;
      if (!version || version !== proof.versionSha256 || version !== state.proof?.versionSha256) throw Error('Verification version differs from corrected version');
      proofRef.operationId = event.operationId;
    }
    const revision = randomUUID();
    if (!write('states/' + issueId, revision, {revision,previous:state.revision,status,updatedAt:new Date(clock()).toISOString(),proof:proofRef})) throw Error('State persistence failed');
    const persisted = stateOf(issueId);
    if (persisted.status === 'conflict') throw Error('Concurrent state changes; manual reconciliation required');
    return {ok:true,issueId,state:persisted};
  }
  function task({taskId,offset=0,limit=100} = {}) {
    if (!taskId) throw Error('Explicit task ID required; unrelated calls cannot be treated as one task');
    const data = snapshot(), events = data.operations.filter(e=>e.taskRef===taskRef(taskId));
    const live = events.filter(e=>e.interface!=='receipt-import');
    const intervals = live.filter(e=>e.endedAt).map(e=>[Date.parse(e.startedAt),Date.parse(e.endedAt)]).sort((a,b)=>a[0]-b[0]);
    let coveredMs = 0, end = -Infinity;
    for (const [start,stop] of intervals) { coveredMs += Math.max(0,stop-Math.max(start,end)); end = Math.max(end,stop); }
    const observedSpanMs = intervals.length ? intervals.reduce((maximum,i)=>Math.max(maximum,i[1]),-Infinity) - live.reduce((minimum,e)=>Math.min(minimum,Date.parse(e.startedAt)),Infinity) : null;
    const manual = reports({ taskId, limit: REPORTS_SHOWN });
    return {ok:true,taskRef:taskRef(taskId),operationCount:events.length,incomplete:events.filter(e=>!e.endedAt).length,
      ...(manual.total ? { reports: manual.reports, reportsTotal: manual.total } : {}),
      toolDurationSumMs:live.reduce((sum,e)=>sum+(e.durationMs??0),0),toolCoveredWallMs:coveredMs,observedSpanMs,
      importedReceiptDurationsMs:events.filter(e=>e.interface==='receipt-import').map(e=>e.receiptDurationMs??null),
      intervalOutsideCompletedToolsMs:observedSpanMs===null?null:Math.max(0,observedSpanMs-coveredMs),
      intervalMeaning:'Observed interval only; not reasoning time or complete task duration. Overlapping tool durations are unioned.',
      operations:events.slice(offset,offset+limit),offset,limit,omittedOperations:Math.max(0,events.length-Math.min(limit,events.length-offset)),health:data.health};
  }
  return {begin,snapshot,issues,task,transition,report,reports,directory:dir,warn};
}

// The manual report (A31): kind and its fields, each a short text. The limits keep a record small (the queue reads
// records up to 64 KB) and keep it a description, never a transcript.
export const REPORT_KINDS = ['gap', 'defect', 'slow'];
export const REPORT_FIELDS = Object.freeze({ tool: 120, intent: 500, attempted: 1500, workaround: 1500, cost: 200, summary: 1500, taskId: 512 });
const REPORT_LINKED = 5, REPORTS_SHOWN = 20;
export function reportProblems(input) {
  const problems = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['the report is an object'];
  if (!REPORT_KINDS.includes(input.kind)) problems.push('kind is one of ' + REPORT_KINDS.join(', '));
  for (const key of ['tool', 'intent', 'attempted']) if (typeof input[key] !== 'string' || !input[key].trim()) problems.push(key + ' is required text');
  for (const [key, max] of Object.entries(REPORT_FIELDS)) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (key === 'cost' ? !['string', 'number'].includes(typeof value) : typeof value !== 'string') problems.push(key + ' is text');
    else if (String(value).length > max) problems.push(key + ' has ' + String(value).length + ' characters; at most ' + max);
  }
  return problems;
}

// C33 (atritos 3): the outcome of one tool result for an audit line (the hosted http-server.mjs of the server line): a
// structuredContent.ok false is a failure even without isError (a doctor's ok:false used to count as success), and its
// code is the answer's own, else the one its text gives (refusal-codes.mjs), else TOOL_ERROR.
export function auditOutcome(result) {
  const texts = (Array.isArray(result?.content) ? result.content : []).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text);
  let value = result?.structuredContent;
  if (!value || typeof value !== 'object') { for (const text of texts) { try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { value = parsed; break; } } catch { /* plain text */ } } }
  const failed = result?.isError === true || value?.ok === false;
  if (!failed) return { ok: true, code: null };
  const code = codeName(value?.code) ?? codeName(value?.error?.code)
    ?? [typeof value?.error === 'string' ? value.error : null, ...texts].filter(Boolean).map(codeOfText).find(Boolean) ?? 'TOOL_ERROR';
  return { ok: false, code };
}

// The direct API (interface I9) for what does not pass through the MCP or CLI boundary (a background index warm-up, a
// worker of the facade): one event with its outcome, code and step, metadata only. Never throws and never changes the
// caller's result: `{ok:false}` when nothing could be recorded. Callers import it with optional chaining
// (`friction.recordEvent?.(...)`), so a checkout without it records nothing.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function recordEvent({ operation, lane, code, step, outcome, taskId } = {}, { root = ROOT, directory, env = process.env, clock, warning = () => {} } = {}) {
  try {
    const store = createStore({ root, directory, env, warning, ...(clock ? { clock } : {}) });
    const op = store.begin({ interface: 'api', operation, lane, taskId, correlationSource: taskId ? 'explicit-task' : 'absent' });
    const wanted = ['success', 'failure', 'timeout', 'uncertain'].includes(outcome) ? outcome : 'failure';
    const value = wanted === 'success' ? { ok: true } : { ok: false, ...(wanted === 'uncertain' ? { outcome: 'uncertain' } : {}), ...(codeName(code) ? { code } : {}), ...(stepName(step) ? { failed: step } : {}) };
    op.finish(value, wanted === 'timeout' ? { timeout: true } : {});
    return { ok: true, operationId: op.operationId, directory: store.directory };
  } catch { return { ok: false }; }
}
