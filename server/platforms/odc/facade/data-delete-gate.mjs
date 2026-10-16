// Data deletes in two calls (CX15, after the incident of 2026-10-14; destructive-operations.mjs has the rules).
//   o11_data (an op `delete`, alone or in a batch), the CLI `ssam data --lane o11` and studio_data_delete:
//   1. A delete op WITHOUT confirmationToken is a PREVIEW: the records of its ids are read (O11: one kernel `read` by ids
//      through the same runner; ODC: pages of the Studio data service, which does not filter by id, until every id is found,
//      the table ends or DATA_PREVIEW_MAX_ROWS rows were read). Each record found is one item; an id the read proves missing
//      is `absent`, one beyond the rows read is `unverified`; neither is ever deleted. The preview keeps no row (CX15 r2,
//      C6). Nothing is written: in a batch the inserts and updates do not run either.
//   2. The EXECUTION is the same call with only confirmationToken (no ids: they come from the token) and the owner's words,
//      given after the preview, that name the entity and state the exact number of records (the owner's own reply: never a
//      phrase the server wrote). The ids are read again (a record gone or come back is PREVIEW_STALE with a new preview), the rows read are
//      the backup, then today's request goes to the kernel or the bridge: the token's ids, the operationId of the preview
//      (O11), the sha256 of the owner's words (O11: the kernel needs a nonempty authorization only), the host of the preview. In a batch only the delete ops need a token, each its own with its own count.
//   The record (operations\<operationId>.json) says per record: deleted, uncertain, refused or not-started. The kernel and
//   the bridge delete all the ids of an op in ONE call: there is no stop between ids (a limit of the platform call).
// Passthroughs: studio_command never runs a destructive bridge command (bridgeCommandRefusal, DESTRUCTIVE_BRIDGE_COMMANDS).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DESTRUCTIVE_BRIDGE_COMMANDS, OWNER_REPLY, OperationRunning, beginOperation, currentSignal, checkExecute, createPreview, dedicatedToolRefusal, endOperation, markItem, noteWords, parseToken,
  noBackupNote, readOperation, readPreview, storeBackup, summarizeOperation, withPreviewNote, wordsSha256, hashedWords, withoutWords,
} from './destructive-operations.mjs';
import { namesWhole } from './service-center/auth.mjs';
import { codeFromText, isCode } from './refusal-codes.mjs';

// To confirm with the owner (CX15 report): the most rows a studio_data_delete preview reads looking for its ids.
export const DATA_PREVIEW_MAX_ROWS = 10000;
const PAGE_ROWS = 5000; // the most rows one bridge `data` read answers (DataCommands.cs clamps --limit to 5000)
const REQUIRED = "deletes take two calls now: show the list, then call again with confirmationToken and the owner's reply";
export { OWNER_REPLY }; // the neutral marker of the owner's words (CX15 r2: one, in the common module)
// Per item, short (a preview lists every record): the whole row as read, kept under backups\<operationId>\ before the delete.
const BACKUP_HOW = 'its row as read now';

const text = value => (value === null || value === undefined ? '' : String(value));
const msOf = now => (typeof now === 'function' ? msOf(now()) : typeof now === 'number' ? now : now instanceof Date ? now.getTime() : Date.now());
const iso = now => new Date(msOf(now)).toISOString();
const isRef = id => id !== null && typeof id === 'object' && !Array.isArray(id) && typeof id.$ref === 'string';
const keyOf = id => (isRef(id) ? '$ref:' + id.$ref : text(id));
const idOfKey = key => (key.startsWith('$ref:') ? { $ref: key.slice(5) } : key);
// The identifier is the first column of a row (O11 EnvironmentData.NamedRows writes Id first; the ODC bridge its IdName).
const rowId = row => (row && typeof row === 'object' ? text(Object.values(row)[0]) : '');
const tokenIn = op => text(op?.confirmationToken).trim() !== '';
export const dataOps = request => (Array.isArray(request?.batch) ? request.batch : request && typeof request === 'object' ? [request] : []);
export const hasDataDelete = request => dataOps(request).some(op => op?.operation === 'delete');

// One item per record found, in the order of the ids; $ref ids (a record an earlier insert of the batch creates) are items
// with nothing to back up. complete: the read covered the whole table, so a missing id is absent (else unverified).
function recordItems(entity, ids, rows, { complete = true } = {}) {
  const found = new Map(rows.map(row => [rowId(row), row]));
  const items = []; const kept = []; const absent = []; const unverified = [];
  for (const key of [...new Set((ids ?? []).map(keyOf))].filter(Boolean)) {
    if (key.startsWith('$ref:')) items.push({ kind: 'record', key, name: `${entity} ${key}`, inserted: true, backup: { possible: false, why: 'an earlier insert of this batch creates it: nothing exists before it' } });
    else if (found.has(key)) { items.push({ kind: 'record', key, name: `${entity} ${key}`, backup: { possible: true, how: BACKUP_HOW } }); kept.push(found.get(key)); }
    else (complete ? absent : unverified).push(key);
  }
  return { items, rows: kept, absent, unverified };
}
// The words name the entity of the preview (WORDS_MUST_NAME, the code of the other deletes); the count is checkExecute's.
const entityRule = (preview, words) => (preview.mustName ?? []).filter(name => !namesWhole(words, name)).map(name => ({ code: 'WORDS_MUST_NAME', target: name,
  message: `The owner's words do not name the entity ${name}`,
  fix: `the owner's next message after the list, naming ${name} and stating the number ${preview.items.length}. Ask the owner again; never write, complete or reuse words yourself.` }));
const sameTarget = (preview, { tool, host, operation }) => preview && preview.tool === tool && text(preview.host).toLowerCase() === text(host).toLowerCase() && preview.operation === operation;
const refusal = (problems, extra = {}) => ({ ok: false, code: problems[0].code, error: `${problems.length} problem(s); nothing was sent`, problems, ...extra });
// CX15 r2 (C2/T5): a record refused before any send (notSent) is no execution: the token stays usable. CX15 r3 (F3): one
// running now (OPERATION_RUNNING) or of a process that is gone (OPERATION_INTERRUPTED) is not "already ran" either:
// checkExecute answers it (liveRefusal), never CONFIRMATION_ALREADY_USED.
const liveRecord = record => Boolean(record && (record.orphaned || record.state === 'running'));
const ranBefore = record => Boolean(record && !liveRecord(record) && record.state !== 'cancelled' && !(record.state === 'refused' && record.notSent === true));
const taskStep = (operationId, why) => ({ tool: 'ssam_task', arguments: { id: operationId }, why });
// The answer to a token whose operation runs now or was interrupted: checkExecute's problem (OPERATION_RUNNING, or
// OPERATION_INTERRUPTED naming what the interrupted operation did), the record and ssam_task; nothing read or sent.
function liveRefusal(entries, { tool, now, root, uuid, extra = {} }) {
  const problems = entries.flatMap(({ token, host, operation, words, index }) => checkExecute({ token, tool, host, operation, words, now, root, uuid }).problems
    .map(p => ({ ...(index !== undefined ? { op: index } : {}), ...p })));
  const summaries = entries.map(e => summarizeOperation(e.record));
  return { ...refusal(problems, extra), outcome: 'not-sent', operationId: entries[0].record.operationId, ...(summaries.length === 1 ? { operation: summaries[0] } : { operations: summaries }),
    continuation: taskStep(entries[0].record.operationId, 'read the record of the operation (item by item) and tell the owner; a new delete is a new call without confirmationToken (a new preview of what is left) and the owner\'s new reply') };
}
// CX15 r3 (F3: N2, CT-4): ONE exit for any exception of an execution, as the Service Center engine has (delete.mjs
// localFailure). Before the send (sent false), every item reads not-started and the record closes refused with notSent:
// the lease is released and the owner's new reply runs the token again. After the send started, an item caught sending
// reads uncertain and the record closes uncertain. A record that cannot be written still releases its lease (endOperation)
// and reads interrupted to every reader. The answer carries operationId, the names by state and ssam_task.
function localFailure(records, error, { sent, now, root, extra = {} }) {
  const cause = text(error?.code || error?.name || 'Error');
  const code = isCode(error?.code) ? error.code : 'DATA_LOCAL_FAILURE';
  let anySent = false;
  for (const record of records) {
    if (record.state !== 'running') continue;
    for (const item of record.items) {
      if (item.state === 'sending') item.state = sent ? 'uncertain' : 'not-started';
      else if (['backing-up', 'backed-up'].includes(item.state)) item.state = 'not-started';
    }
    const went = sent && record.items.some(i => ['uncertain', 'deleted', 'refused'].includes(i.state));
    anySent ||= went;
    try { endOperation(record, went ? 'uncertain' : 'refused', { now, root, localFailure: cause, ...(went ? {} : { notSent: true }) }); }
    catch { /* the lease is released; a reader sees the record interrupted (destructive-operations live) */ }
  }
  const summaries = records.map(r => summarizeOperation(r));
  const id = records[0]?.operationId ?? null;
  const detail = text(error?.message).slice(0, 300);
  return { ok: false, code, cause, outcome: anySent ? 'uncertain' : 'not-sent', ...extra,
    error: anySent ? 'A local failure (' + cause + ') stopped the execution after the delete was sent: it may have run. ' + detail
      : 'A local failure (' + cause + ') stopped the execution before any send; nothing was sent. ' + detail,
    ...(id ? { operationId: id } : {}), ...(summaries.length === 1 ? { operation: summaries[0] } : summaries.length ? { operations: summaries } : {}),
    ...(id ? { continuation: taskStep(id, anySent ? 'read the record item by item and tell the owner what is uncertain before anything else; never repeat this call by yourself'
      : 'nothing was sent: once the cause is solved, the same call with the owner\'s new reply runs the token again (or a new preview)') } : {}) };
}
// A cancellation before the send: every item not-started, the records cancelled, nothing sent.
function cancelledData(records, { now, root, when, extra = {} }) {
  const at = iso(now);
  for (const record of records) { for (const item of record.items) item.state = 'not-started'; endOperation(record, 'cancelled', { now, root, cancelledAt: at }); }
  const summaries = records.map(r => summarizeOperation(r));
  return { ok: false, code: 'CANCELLED', outcome: 'not-sent', cancelledAt: at, error: `Cancelled by the client ${when}; nothing was sent.`, ...extra,
    ...(summaries.length === 1 ? { operation: summaries[0] } : summaries.length ? { operations: summaries } : {}),
    ...(records.length ? { continuation: { tool: 'ssam_task', arguments: { id: records[0].operationId }, why: 'read the record before telling the owner anything; a new delete is a new preview and a new confirmation' } } : {}) };
}
// The answer of a token that already ran: its record, never a second send.
const byState = records => {
  const operations = records.map(r => summarizeOperation(r));
  const ok = operations.every(o => o.state === 'completed');
  return { ok, ...(ok ? {} : { code: 'CONFIRMATION_ALREADY_USED' }), outcome: 'not-sent',
    note: 'This confirmationToken already ran; nothing was sent again. Its record says record by record what happened; a new delete is a new preview and a new confirmation of the owner.',
    ...(operations.length === 1 ? { operation: operations[0] } : { operations }) };
};
// Every item of a record set at once, persisted in one write (markItem writes the whole record).
function markAll(record, patch, { now, root, only = () => true } = {}) {
  const at = iso(now);
  const items = record.items.filter(only);
  for (const item of items) Object.assign(item, typeof patch === 'function' ? patch(item) : patch, { at });
  if (items.length) markItem(record, items.at(-1), {}, { now, root });
}

// ---- O11: o11_data and the CLI share one flow; read(request) and send(request) reach the kernel `data` command.
// read -> {ok, results, host, failure}; send -> {results, unknown, refusedBeforeWrite, answer}; shape(request) -> the fields
// of the exact next call (MCP: continuation; CLI: confirmRequest).
const operationOf = (module, op) => `delete ${module}.${text(op.entity)}${op.tenantId !== undefined && op.tenantId !== null ? ` tenant ${op.tenantId}` : ''}`;
const resultsOf = envelope => {
  const data = envelope?.data && typeof envelope.data === 'object' ? envelope.data : null;
  return Array.isArray(data?.results) ? data.results : data ? [data] : [];
};
const readRequestOf = reads => (reads.length === 1 ? reads[0] : { batch: reads });
const readOf = (entity, ids, tenantId) => ({ operation: 'read', entity, ids, ...(tenantId !== undefined && tenantId !== null ? { tenantId } : {}) });

async function o11Flow({ request, host, module, tool, read, send, shape, now, root, uuid, signal = currentSignal() }) {
  const ops = dataOps(request);
  const batched = Array.isArray(request.batch);
  const batchWords = batched ? request.authorization : undefined;
  const wordsOf = op => op.authorization ?? batchWords;
  const said = [...new Set([batchWords, ...ops.flatMap(op => [op?.authorization, op?.ownerRequest])].map(text).filter(w => w.trim()))];
  const note = h => { for (const words of said) noteWords({ host: h, tool, words, now, root }); };
  const deletes = ops.map((op, index) => ({ op, index })).filter(d => d.op?.operation === 'delete');
  if (host) note(host);

  // ---- 1. preview: any delete op without its token. Nothing is sent but the read; the whole call is the preview.
  const pending = deletes.filter(d => !tokenIn(d.op));
  if (pending.length) {
    const problems = []; const reads = [];
    for (const d of pending) {
      const plain = (d.op.ids ?? []).filter(id => !isRef(id)).map(text);
      if (!(d.op.ids ?? []).length) problems.push({ op: d.index, code: 'DATA_REQUEST_INVALID', pointer: (batched ? `/batch/${d.index}` : '') + '/ids', message: 'delete needs ids, a nonempty array of record ids', fix: 'the ids of the records to delete' });
      else if (plain.length) { d.read = reads.length; reads.push(readOf(d.op.entity, [...new Set(plain)], d.op.tenantId)); }
    }
    let results = [];
    if (reads.length) {
      const r = await read(readRequestOf(reads));
      if (!r.ok) return { ...r.failure, stage: 'preview', note: 'the preview reads the records first and that read failed; nothing was deleted' };
      results = r.results;
      if (!host) { host = r.host || 'o11-studio'; note(host); }
    }
    const tokens = new Map(); const dropped = new Set(); const previews = []; const previewed = [];
    for (const d of pending) {
      if (problems.some(p => p.op === d.index)) { dropped.add(d.index); continue; }
      const result = d.read === undefined ? { records: [] } : results[d.read] ?? {};
      if (result.ok === false) return { ok: false, lane: 'o11', verb: 'data', code: result.code ?? 'DATA_PREVIEW_READ_FAILED', stage: 'preview', error: text(result.error ?? 'the read of the records failed').slice(0, 2000), note: 'nothing was deleted' };
      const { items, rows, absent } = recordItems(d.op.entity, d.op.ids, Array.isArray(result.records) ? result.records : []);
      if (!items.length) {
        problems.push({ op: d.index, code: 'TARGET_NOT_FOUND', entity: d.op.entity, absent, message: `None of the ids exists in ${d.op.entity} now; nothing to delete`, fix: 'the ids of records that exist (read them first)' });
        dropped.add(d.index); continue;
      }
      // CX15 r2 (C6): a preview keeps no row (it is a read; an unconfirmed preview leaves no data in the profile): the rows
      // are backed up by the execution, read again, right before the delete.
      const block = createPreview({ tool, lane: 'o11', host, operation: operationOf(module, d.op), selection: { entity: d.op.entity, ids: d.op.ids, ...(d.op.tenantId != null ? { tenantId: d.op.tenantId } : {}) },
        items, ownerRequest: d.op.ownerRequest, words: wordsOf(d.op), mustName: [d.op.entity], now, root, uuid, extra: absent.length ? { absent } : {} });
      tokens.set(d.index, block); previewed.push(...items);
      previews.push({ ...(batched ? { op: d.index } : {}), ...block, ...(absent.length ? { absent } : {}) });
    }
    // Words in the call (the incident case): the preview answers as a refusal that says the rule; they never confirm it.
    const words = [batchWords, ...ops.map(op => op?.authorization)].some(w => text(w).trim() !== '');
    const head = !tokens.size ? { ok: false, code: problems[0].code, error: `${problems.length} problem(s); nothing to delete, nothing was sent` }
      : words ? { ok: false, code: 'CONFIRMATION_REQUIRED', error: withPreviewNote(REQUIRED, previewed) }
        : problems.length ? { ok: false, code: problems[0].code, error: `${problems.length} problem(s); the other deletes are previewed` } : { ok: true };
    // CX15 r3 (CT-7): the step to the confirmation (the CLI's next, the MCP continuation) also says what goes WITHOUT a backup.
    const next = tokens.size ? shape(confirmRequest(request, tokens, dropped), [dropped.size ? 'the delete ops with a problem are left out' : '', noBackupNote(previewed) ?? ''].filter(Boolean).join('; ')) : {};
    // CX15 r2 (L6): the other ops of the batch (inserts, updates, reads) did not run either: the whole call is the preview.
    const notRun = batched ? ops.map((op, index) => ({ op: index, operation: text(op?.operation) })).filter(o => o.operation !== 'delete') : [];
    return { ...head, lane: 'o11', verb: 'data', ...(previews.length === 1 ? previews[0] : previews.length ? { state: 'previewed', count: previews.reduce((n, p) => n + p.count, 0), previews } : {}),
      ...(problems.length ? { problems } : {}), ...(notRun.length ? { notRun, notRunNote: 'these ops of the batch did not run: the whole call is the preview; they run with the confirmation (the same batch with the tokens)' } : {}), ...next };
  }

  // ---- 2. execution: every delete op carries its token.
  for (const d of deletes) { const parsed = parseToken(d.op.confirmationToken); d.preview = parsed ? readPreview(parsed.previewId, { root }) : null; d.record = d.preview ? readOperation(d.preview.operationId, { root }) : null; }
  // CX15 r2 (J): the kernel works on the host of the preview. A call without a host runs on the preview's (the CLI passes
  // it to the kernel), and a read again that answers from another host (the Studio connected now is on another) is
  // PREVIEW_OTHER_TARGET, in the same refusal as the other problems.
  const given = Boolean(host);
  if (!host) { host = deletes.find(d => d.preview)?.preview.host ?? 'o11-studio'; note(host); }
  const kernelAt = { host: realHost(host) };
  for (const d of deletes) d.operation = operationOf(module, d.op);
  const used = deletes.filter(d => ranBefore(d.record));
  if (used.length === deletes.length) return { lane: 'o11', verb: 'data', ...byState(used.map(d => d.record)) };
  const live = deletes.filter(d => liveRecord(d.record));
  if (live.length) return liveRefusal(live.map(d => ({ token: d.op.confirmationToken, host, operation: d.operation, words: text(wordsOf(d.op)), record: d.record, ...(batched ? { index: d.index } : {}) })),
    { tool, now, root, uuid, extra: { lane: 'o11', verb: 'data' } });
  const reread = deletes.filter(d => !ranBefore(d.record) && d.record?.state !== 'cancelled' && sameTarget(d.preview, { tool, host, operation: d.operation }));
  // CX15 r2 (C2/T5): the records open at the start of the execution, before the read again (ssam_task finds them); the
  // cancellation is read before them, after the backups and before the send.
  if (signal?.aborted) return { lane: 'o11', verb: 'data', ...cancelledData([], { now, root, when: 'before the execution started' }) };
  const closeBegun = () => { for (const d of reread) if (d.begun) endOperation(d.begun, 'refused', { now, root, notSent: true }); };
  // The lease of each operation (CX15 r2, I): another execution of one of these tokens running now sends nothing.
  try { for (const d of reread) d.begun = beginOperation({ preview: d.preview, now, root, words: text(wordsOf(d.op)) }); }
  catch (error) { closeBegun(); if (error instanceof OperationRunning) return { ...refusal([error.problem], { lane: 'o11', verb: 'data' }), outcome: 'not-sent' }; throw error; }
  const state = { sent: false, opened: reread.map(d => d.begun).filter(Boolean) };
  try { return await o11Execute({ request, host, module, tool, read, send, shape, now, root, uuid, signal, deletes, reread, batched, wordsOf, given, kernelAt, closeBegun, state }); }
  catch (error) { return localFailure(state.opened, error, { sent: state.sent, now, root, extra: { lane: 'o11', verb: 'data' } }); }
}
// The execution of o11Flow once the records are open (CX15 r3: one try/catch around it, in o11Flow).
async function o11Execute({ request, host, module, tool, read, send, shape, now, root, uuid, signal, deletes, reread, batched, wordsOf, given, kernelAt, closeBegun, state }) {
  const reads = [];
  for (const d of reread) { const plain = (d.preview.selection?.ids ?? []).filter(id => !isRef(id)).map(text); if (plain.length) { d.read = reads.length; reads.push(readOf(d.op.entity, [...new Set(plain)], d.preview.selection?.tenantId)); } }
  let results = []; let readHost = null;
  if (reads.length) {
    const r = await read(readRequestOf(reads), kernelAt);
    if (!r.ok) { closeBegun(); return { ...r.failure, stage: 'execute', note: 'the records are read again before the delete and that read failed; nothing was deleted' }; }
    results = r.results;
    readHost = realHost(r.host);
  }
  const problems = []; const fresh = new Map();
  for (const d of deletes) {
    let current = null;
    if (reread.includes(d)) {
      const result = d.read === undefined ? { records: [] } : results[d.read] ?? {};
      if (result.ok === false) { closeBegun(); return { ok: false, lane: 'o11', verb: 'data', code: result.code ?? 'DATA_PREVIEW_READ_FAILED', stage: 'execute', error: text(result.error ?? 'the read of the records failed').slice(0, 2000), note: 'nothing was deleted' }; }
      ({ items: current, rows: d.rows } = recordItems(d.op.entity, d.preview.selection?.ids, Array.isArray(result.records) ? result.records : []));
    }
    const checked = checkExecute({ token: d.op.confirmationToken, tool, host, operation: d.operation, words: text(wordsOf(d.op)), selection: { ids: d.op.ids }, current,
      nameRule: entityRule, now, root, uuid, begun: d.begun ?? null });
    const own = [...checked.problems];
    if (checked.used) own.push({ code: 'CONFIRMATION_ALREADY_USED', operationId: checked.preview.operationId, message: `This token already ran (operation ${checked.preview.operationId}, ${checked.operation.state}); it never sends again`, fix: 'leave this op out, or a new preview and a new confirmation' });
    if (checked.preview && d.op.operationId !== undefined && text(d.op.operationId).toLowerCase() !== checked.preview.operationId)
      own.push({ code: 'PREVIEW_OTHER_TARGET', message: `The operationId of the execution is the one of its preview (${checked.preview.operationId}), not ${d.op.operationId}`, fix: 'the operationId of the preview, or none' });
    const previewHost = realHost(checked.preview?.host);
    if (reread.includes(d) && readHost && previewHost && readHost.toLowerCase() !== previewHost.toLowerCase())
      own.push({ code: 'PREVIEW_OTHER_TARGET', host: readHost, previewHost, message: `The records were read again on ${readHost}, but the preview is of ${previewHost}${given ? '' : ' (the call named no host: the Studio connected now is on another)'}; nothing was sent`,
        fix: `connect the Studio to ${previewHost} (or name it as the host) and confirm again, or a new preview on ${readHost} and the owner's confirmation of it` });
    problems.push(...own.map(p => ({ ...(batched ? { op: d.index } : {}), ...p })));
    if (checked.fresh) fresh.set(d.index, checked.fresh);
  }
  if (problems.length) {
    closeBegun();
    const blocks = [...fresh.entries()].map(([index, block]) => ({ ...(batched ? { op: index } : {}), ...block }));
    return { ...refusal(problems, { lane: 'o11', verb: 'data' }), ...(blocks.length === 1 ? { preview: blocks[0] } : blocks.length ? { previews: blocks } : {}),
      ...(fresh.size ? shape(confirmRequest(request, fresh, new Set()), 'a new preview: confirm it with its own token and count') : {}) };
  }

  // Backups of the rows read now, then today's request to the kernel, once.
  const records = deletes.map(d => ({ d, record: d.begun ?? beginOperation({ preview: d.preview, now, root, words: text(wordsOf(d.op)) }) }));
  for (const { record } of records) if (!state.opened.includes(record)) state.opened.push(record);
  const backups = [];
  for (const { d, record } of records) {
    const real = item => !item.key.startsWith('$ref:');
    markAll(record, { state: 'backing-up' }, { now, root, only: real });
    try {
      const file = storeBackup({ operationId: d.preview.operationId, name: `${d.op.entity}-before-delete.json`, root,
        data: JSON.stringify({ host, module, entity: d.op.entity, tenantId: d.preview.selection?.tenantId ?? null, readAt: iso(now), records: d.rows ?? [] }, null, 2) });
      backups.push(file);
      markAll(record, { state: 'backed-up', backup: { files: [file] } }, { now, root, only: real });
      if (signal?.aborted) return { lane: 'o11', verb: 'data', ...cancelledData(records.map(r => r.record), { now, root, when: 'after the backup of the ' + d.op.entity + ' records', extra: { backups: [...backups, file] } }) };
    } catch (error) {
      markAll(record, { state: 'backup-failed', error: error.message }, { now, root, only: real });
      for (const other of records) endOperation(other.record, 'refused', { now, root });
      return { ok: false, lane: 'o11', verb: 'data', code: 'BACKUP_FAILED', outcome: 'not-sent', error: `The backup of the ${d.op.entity} records failed (${error.message}); nothing was sent`,
        ...(records.length === 1 ? { operation: summarizeOperation(record) } : { operations: records.map(r => summarizeOperation(r.record)) }) };
    }
  }
  if (signal?.aborted) return { lane: 'o11', verb: 'data', ...cancelledData(records.map(r => r.record), { now, root, when: 'before the send', extra: { backups } }) };
  for (const { record } of records) markAll(record, { state: 'sending' }, { now, root });
  const previews = new Map(deletes.map(d => [d.index, d.preview]));
  let sent;
  state.sent = true;
  try { sent = await send(kernelRequest(request, previews), kernelAt); }
  catch (error) { sent = { unknown: true, results: [], answer: { ok: false, lane: 'o11', verb: 'data', code: 'DATA_OUTCOME_UNKNOWN', outcome: 'uncertain', error: error.message } }; }
  for (const { d, record } of records) {
    const result = sent.results[batched ? d.index : 0];
    if (sent.unknown) markAll(record, { state: 'uncertain' }, { now, root });
    else if (result?.ok === true) markAll(record, { state: 'deleted', ...(result.receipt ? { receipt: result.receipt } : {}) }, { now, root });
    else if (!result) markAll(record, sent.refusedBeforeWrite ? { state: 'refused', error: 'the kernel refused the request before any write' } : { state: 'not-started' }, { now, root });
    else {
      const reports = new Map((Array.isArray(result.reports) ? result.reports : []).map(r => [text(r?.recordId), r]));
      markAll(record, item => { const report = reports.get(item.key); return !reports.size ? { state: 'uncertain', error: text(result.error).slice(0, 500) || null }
        : report?.status === 'Success' && !report.error ? { state: 'deleted' } : report ? { state: 'refused', error: text(report.error ?? report.status) } : { state: 'uncertain' }; }, { now, root });
    }
    const states = record.items.map(i => i.state);
    endOperation(record, states.every(s => s === 'deleted') ? 'completed' : states.includes('uncertain') ? 'uncertain' : states.includes('deleted') ? 'partial' : 'refused', { now, root });
  }
  const summaries = records.map(r => summarizeOperation(r.record, { root }));
  return { ...sent.answer, ...(summaries.length === 1 ? { operation: summaries[0] } : { operations: summaries }), backups };
}
// The exact next call: each previewed delete op without its ids, with its token, the operationId of its preview and the
// owner's reply as a template; ops with a problem left out; the other ops (and the batch words) unchanged.
function confirmRequest(request, blocks, dropped) {
  const one = (op, index) => {
    const block = blocks.get(index);
    if (!block) return op;
    const { ids, ownerRequest, confirmationToken, operationId, authorization, ...rest } = op;
    return { ...rest, operationId: block.operationId, confirmationToken: block.confirmationToken, authorization: OWNER_REPLY };
  };
  return Array.isArray(request.batch) ? { ...request, batch: request.batch.map(one).filter((_, index) => !dropped.has(index)) } : one(request, 0);
}
// Today's request: the ids of the token, the operationId of the preview; confirmationToken and ownerRequest never reach
// the kernel (it does not know them). The kernel only needs a nonempty authorization (EnvironmentData.Refusal,
// DataReceipt), and its request file and receipt keep it: it gets the sha256 of the owner's words, never the words
// (CX15 r2, C6), for every op of a request that passes through this gate.
const hashed = hashedWords; // CX15 r4: one helper for every lane (W-2, W-4)
function kernelRequest(request, previews) {
  const one = (op, index) => {
    const { confirmationToken, ownerRequest, ...rest } = op ?? {};
    const preview = previews.get(index);
    const out = preview ? { ...rest, ids: preview.items.map(item => idOfKey(item.key)), operationId: preview.operationId } : rest;
    return out.authorization !== undefined ? { ...out, authorization: hashed(out.authorization) } : out;
  };
  return Array.isArray(request.batch) ? { ...request, ...(request.authorization !== undefined ? { authorization: hashed(request.authorization) } : {}), batch: request.batch.map(one) } : one(request, 0);
}
// CX15 r4 (W-4): the same request for the kernel of an o11_data WITHOUT a delete (insert, update, read, a batch of them):
// the authorization of the request and of each op as sha256:<hex>, before the request file is written and before the
// kernel is called (it only requires a nonempty value: DataReceipt.cs:13, EnvironmentData.cs:611); confirmationToken and
// ownerRequest never reach the kernel.
export const hashedDataRequest = request => (request && typeof request === 'object' ? kernelRequest(request, new Map()) : request);
// A host the kernel can be asked for (the placeholder of a preview without one is not).
const realHost = value => { const h = text(value).trim(); return h && h !== 'o11-studio' && h !== 'odc-studio' ? h : null; };

// o11_data (ssam.mjs): the same runner, arguments, work folder and answer as its handler.
export async function o11DataDelete({ host, module, oml, request }, { o11Runner, o11DataArguments, o11DataAnswer, dataRoot, lane, now, root, uuid, signal } = {}) {
  const work = path.join(dataRoot, lane === 'ss5' ? '.local/lane-ss5/data' : '.local/data');
  const runRequest = async value => {
    const requests = path.join(work, 'requests'); fs.mkdirSync(requests, { recursive: true });
    const file = path.join(requests, randomUUID() + '.json'); fs.writeFileSync(file, JSON.stringify(value));
    return { value, r: await o11Runner(['data', ...o11DataArguments({ host, module, oml }, file, work)]) };
  };
  const call = { host, module, oml };
  return o11Flow({ request, host, module, tool: 'o11_data', now, root, uuid, signal: signal ?? currentSignal(),
    read: async value => { const { r } = await runRequest(value); const data = r?.envelope?.data;
      return r?.ok === true && r?.envelope?.ok === true ? { ok: true, results: resultsOf(r.envelope), host: data?.host } : { ok: false, failure: o11DataAnswer(r, value, call) }; },
    send: async value => { const { r } = await runRequest(value); const data = r?.envelope?.data;
      // No envelope (no answer, a timeout, a process that printed nothing): whether the kernel wrote is not known.
      return { results: resultsOf(r?.envelope), unknown: Boolean(r?.unknown || !r?.envelope),
        refusedBeforeWrite: data?.ok === false && data?.submitted === 0, answer: o11DataAnswer(r, value, call) }; },
    shape: (value, why) => ({ continuation: { tool: 'o11_data', arguments: { host, module, oml, request: value },
      why: 'the confirmation: show the owner the list, then this call with the owner\'s reply in authorization, verbatim' + (why ? `; ${why}` : '') } }) });
}

// The CLI `ssam data --lane o11 ... --request <file>` (lanes.mjs run): null when the request has no delete (today's path);
// send(argv) runs the same line with another request file.
// The text of a request file as the kernel reads it (CX15 r2, R-A2): UTF-8, UTF-8 with BOM, UTF-16LE or UTF-16BE with BOM
// (the default of > and Out-File in Windows PowerShell 5.1 is UTF-16LE with BOM).
export function decodeRequestFile(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) { const body = Buffer.from(bytes.subarray(2)); body.swap16(); return body.toString('utf16le'); }
  return bytes.toString('utf8');
}
const unreadable = (why, file) => ({ ok: false, lane: 'o11', verb: 'data', code: 'DATA_REQUEST_UNREADABLE', outcome: 'not-sent',
  error: `The request file ${why}; nothing was sent to the kernel (a request this gate cannot read is never passed on: it could hold a delete).`,
  ...(file ? { file } : {}), fix: 'a JSON request file in UTF-8 or UTF-16 with BOM, given as --request <file>' });
export async function cliDataDelete(args = [], { send, cwd = process.cwd(), now, root, uuid } = {}) {
  const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  // --request <file> or --request=<file>; a --request without its file, or one that cannot be read, is refused (fail closed).
  const joined = args.find(a => typeof a === 'string' && a.startsWith('--request='));
  const named = args.includes('--request') || joined !== undefined;
  const file = joined !== undefined ? joined.slice('--request='.length) : option('--request');
  if (!named) return null;
  if (!file) return unreadable('is missing after --request', null);
  let bytes;
  try { bytes = fs.readFileSync(path.resolve(cwd, file)); } catch (error) { return unreadable(`could not be read (${error.code ?? 'error'})`, file); }
  let request;
  try { request = JSON.parse(decodeRequestFile(bytes)); } catch { return unreadable('is not JSON in UTF-8 or UTF-16 with BOM', file); }
  if (!hasDataDelete(request)) return null;
  if (joined !== undefined) args = args.map(a => (a === joined ? ['--request', file] : [a])).flat();
  const work = path.resolve(cwd, option('--work') ?? path.join('.local', 'data'));
  // A line without --host runs on the host of the preview (J), still through the Studio (--host alone would select the
  // stored credential of the host: DataCommand.Run).
  const viaStudio = !args.includes('--credentials');
  const withRequest = (value, at = {}) => {
    const requests = path.join(work, 'requests'); fs.mkdirSync(requests, { recursive: true });
    const written = path.join(requests, randomUUID() + '.json'); fs.writeFileSync(written, JSON.stringify(value));
    const argv = args.map((a, i) => (args[i - 1] === '--request' ? written : a));
    return !option('--host') && at.host ? [...argv, ...(viaStudio && !argv.includes('--studio') ? ['--studio'] : []), '--host', at.host] : argv;
  };
  return o11Flow({ request, host: option('--host') ?? null, module: option('--module') ?? '', tool: 'o11_data', now, root, uuid,
    read: async (value, at) => { const reply = await send(withRequest(value, at)); const envelope = reply?.result;
      return reply?.ok === true && envelope?.ok === true ? { ok: true, results: resultsOf(envelope), host: envelope?.data?.host } : { ok: false, failure: { ...reply, ok: false } }; },
    send: async (value, at) => { const reply = await send(withRequest(value, at)); const envelope = reply?.result;
      return { results: resultsOf(envelope), unknown: !envelope, refusedBeforeWrite: envelope?.data?.ok === false && envelope?.data?.submitted === 0, answer: reply }; },
    shape: (value, why) => ({ confirmRequest: value, next: 'Show the owner the list; then write confirmRequest, with the owner\'s reply in authorization, to a file and run the same line with --request <that file>' + (why ? `; ${why}` : '') }) });
}

// ---- ODC: studio_data_delete (mcp.mjs). studioData is lib.mjs studioData (the read and today's delete).
async function pagedRead({ studioData, module, entity, ids, pid, maxRows, pageSize }) {
  const wanted = new Set(ids.map(text)); const rows = new Map();
  let offset = 0; let scanned = 0; let first = null; let complete = false;
  while (scanned < maxRows) {
    const page = await studioData({ op: 'read', module, entity, limit: Math.min(pageSize, maxRows - scanned), offset, pid });
    if (!page || page.ok === false) return { ok: false, page };
    first ??= page;
    const records = Array.isArray(page.records) ? page.records : [];
    for (const row of records) { const id = rowId(row); if (wanted.has(id) && !rows.has(id)) rows.set(id, row); }
    scanned += records.length; offset += records.length;
    if (rows.size === wanted.size || !page.more || !records.length) { complete = true; break; }
  }
  return { ok: true, first, rows: [...rows.values()], scanned, complete };
}
const odcHost = page => text(page?.tenant) || 'odc-studio';
const odcOperation = (page, module, entity) => `delete ${text(page?.module) || module}.${text(page?.entity) || entity}`;

export async function studioDataDelete({ module, entity, ids, authorize, confirmationToken, ownerRequest, pid } = {}, { studioData, now, root, uuid, maxRows = DATA_PREVIEW_MAX_ROWS, pageSize = PAGE_ROWS, signal = currentSignal() } = {}) {
  const tool = 'studio_data_delete';
  const said = [authorize, ownerRequest].map(text).filter(w => w.trim());
  const note = host => { for (const words of said) noteWords({ host, tool, words, now, root }); };
  const call = { module, entity, ...(pid !== undefined ? { pid } : {}) };

  if (!text(confirmationToken).trim()) {
    if (!(ids ?? []).length) return { ok: false, code: 'DATA_REQUEST_INVALID', error: 'studio_data_delete without confirmationToken previews the records of ids: ids are required', fix: 'the ids of the records to delete' };
    // CX15 r2 (K, the family of R-A1/R-A2: an input its reader reads otherwise): the bridge gets the ids as ONE token of
    // its line (split at spaces), split at commas and trimmed (DataCommands.cs). An id with a comma, a space or a leading
    // "--" would delete other records than the preview lists: every such id is refused at once, before any read.
    const unsafe = ids.map(text).filter(id => !/^[^\s,]+$/.test(id) || id.startsWith('--'));
    if (unsafe.length) return { ok: false, code: 'DATA_REQUEST_INVALID', outcome: 'not-sent', ids: unsafe,
      error: `${unsafe.length} id(s) the Studio's data command would read as other ids (a comma, a space or a leading "--"): ${unsafe.map(id => JSON.stringify(id)).join(', ')}; nothing was read or deleted`,
      fix: 'ids without commas, spaces or a leading "--"; a record whose identifier has them is deleted by other means (the Studio\'s own Data tab)' };
    const read = await pagedRead({ studioData, module, entity, ids, pid, maxRows, pageSize });
    if (!read.ok) return { ...(read.page ?? { ok: false, error: 'the read of the records failed' }), ok: false, stage: 'preview', note: 'the preview reads the records first and that read failed; nothing was deleted' };
    const host = odcHost(read.first); note(host);
    const name = text(read.first?.entity) || entity;
    const { items, rows, absent, unverified } = recordItems(name, ids, read.rows, { complete: read.complete });
    const apart = { ...(absent.length ? { absent } : {}), ...(unverified.length ? { unverified } : {}), scanned: read.scanned };
    if (!items.length) return { ok: false, code: 'TARGET_NOT_FOUND', error: `None of the ids is a record of ${name} ${read.complete ? 'now' : `in the first ${read.scanned} rows`}; nothing to delete`, ...apart };
    // CX15 r2 (C6): the preview keeps no row; the execution backs them up, read again, right before the delete.
    const block = createPreview({ tool, lane: 'odc', host, operation: odcOperation(read.first, module, entity), selection: { ids }, items, ownerRequest, words: authorize,
      mustName: [name], now, root, uuid, extra: apart });
    return { ...(text(authorize).trim() ? { ok: false, code: 'CONFIRMATION_REQUIRED', error: withPreviewNote(REQUIRED, items) } : { ok: true }), ...block, ...apart,
      continuation: { tool, arguments: { ...call, confirmationToken: block.confirmationToken, authorize: OWNER_REPLY },
        why: 'the confirmation: show the owner the list, then this call with the owner\'s reply in authorize, verbatim' } };
  }

  const parsed = parseToken(confirmationToken);
  const preview = parsed ? readPreview(parsed.previewId, { root }) : null;
  note(text(preview?.host) || 'odc-studio');
  const record = preview ? readOperation(preview.operationId, { root }) : null;
  if (ranBefore(record)) return byState([record]);
  if (liveRecord(record)) return liveRefusal([{ token: confirmationToken, host: preview.host, operation: preview.operation, words: text(authorize), record }], { tool, now, root, uuid });
  const state = { sent: false, opened: [] };
  try { return await studioExecute({ module, entity, ids, authorize, confirmationToken, pid }, { tool, call, preview, record, studioData, now, root, uuid, maxRows, pageSize, signal, state }); }
  catch (error) { return localFailure(state.opened, error, { sent: state.sent, now, root }); }
}
// The execution of studio_data_delete (CX15 r3: one try/catch around it, in studioDataDelete).
async function studioExecute({ module, entity, ids, authorize, confirmationToken, pid }, { tool, call, preview, record, studioData, now, root, uuid, maxRows, pageSize, signal, state }) {
  let current = null; let rows = []; let host = text(preview?.host) || 'odc-studio'; let operation = `delete ${module}.${entity}`;
  // CX15 r2 (C2/T5): the cancellation before the record, the record before the read again.
  let begun = null;
  if (preview && record?.state !== 'cancelled' && preview.tool === tool) {
    if (signal?.aborted) return cancelledData([], { now, root, when: 'before the execution started' });
    try { begun = beginOperation({ preview, now, root, words: text(authorize) }); state.opened.push(begun); }
    catch (error) { if (error instanceof OperationRunning) return { ...refusal([error.problem]), outcome: 'not-sent' }; throw error; }
    const read = await pagedRead({ studioData, module, entity, ids: (preview.selection?.ids ?? []).map(text), pid, maxRows, pageSize });
    if (!read.ok) { endOperation(begun, 'refused', { now, root, notSent: true }); return { ...(read.page ?? { ok: false, error: 'the read of the records failed' }), ok: false, stage: 'execute', note: 'the records are read again before the delete and that read failed; nothing was deleted' }; }
    host = odcHost(read.first); operation = odcOperation(read.first, module, entity);
    ({ items: current, rows } = recordItems(text(read.first?.entity) || entity, preview.selection?.ids, read.rows, { complete: read.complete }));
  }
  const checked = checkExecute({ token: confirmationToken, tool, host, operation, words: text(authorize), selection: { ids }, current, nameRule: entityRule, now, root, uuid, begun });
  if (checked.problems.length && begun) endOperation(begun, 'refused', { now, root, notSent: true });
  if (checked.problems.length)
    return refusal(checked.problems, checked.fresh ? { preview: checked.fresh, continuation: { tool, arguments: { ...call, confirmationToken: checked.fresh.confirmationToken, authorize: OWNER_REPLY },
      why: 'a new preview: show the owner this list and confirm it with its own token and count' } } : {});

  const target = checked.preview;
  const op = begun ?? beginOperation({ preview: target, now, root, words: text(authorize) });
  if (!state.opened.includes(op)) state.opened.push(op);
  markAll(op, { state: 'backing-up' }, { now, root });
  let backup;
  try { backup = storeBackup({ operationId: target.operationId, name: `${target.mustName?.[0] ?? entity}-before-delete.json`, root,
    data: JSON.stringify({ tenant: host, module, entity: target.mustName?.[0] ?? entity, readAt: iso(now), records: rows }, null, 2) }); }
  catch (error) {
    markAll(op, { state: 'backup-failed', error: error.message }, { now, root }); endOperation(op, 'refused', { now, root });
    return { ok: false, code: 'BACKUP_FAILED', outcome: 'not-sent', error: `The backup of the records failed (${error.message}); nothing was sent`, operation: summarizeOperation(op) };
  }
  markAll(op, { state: 'backed-up', backup: { files: [backup] } }, { now, root });
  if (signal?.aborted) return { ...cancelledData([op], { now, root, when: 'after the backup' }), backup };
  markAll(op, { state: 'sending' }, { now, root });
  let value;
  state.sent = true;
  // CX15 r3 (CT-6): the bridge needs a nonempty --authorize only (DataCommands.cs) and journals and answers it: it gets the
  // sha256 of the owner's words, never the words.
  try { value = await studioData({ op: 'delete', module, entity, ids: target.items.map(i => i.key), authorize: hashed(authorize), pid }); }
  catch (error) {
    const notSent = error?.sent === false;
    markAll(op, notSent ? { state: 'not-started' } : { state: 'uncertain', error: text(error?.message).slice(0, 500) }, { now, root });
    endOperation(op, notSent ? 'refused' : 'uncertain', { now, root });
    const code = isCode(error?.code) ? error.code : codeFromText(error?.message);
    return { ok: false, error: error?.message, ...(code ? { code } : {}), ...(notSent ? { outcome: 'not-sent' } : { outcome: 'uncertain' }), operation: summarizeOperation(op), backup };
  }
  const reports = new Map((Array.isArray(value?.reports) ? value.reports : []).map(r => [text(r?.recordId), r]));
  // Per id by the bridge's report (DeleteRecords answers one per id); an ok answer without reports deleted them all.
  markAll(op, item => { const report = reports.get(item.key);
    return (value?.ok === true && !reports.size) || (report?.status === 'Success' && !report.error) ? { state: 'deleted' }
      : report ? { state: 'refused', error: text(report.error ?? report.status) } : { state: 'uncertain' }; }, { now, root });
  const states = op.items.map(i => i.state);
  endOperation(op, states.every(s => s === 'deleted') ? 'completed' : states.includes('uncertain') ? 'uncertain' : states.includes('deleted') ? 'partial' : 'refused', { now, root });
  return { ...(value && typeof value === 'object' ? withoutWords(value) : { ok: false, value }), operation: summarizeOperation(op, { root }), backup };
}
// The bridge's report repeats what it got in --authorize: never spread into an answer (CX15 r3, CT-6): withoutWords, now
// in destructive-operations.mjs for every lane (CX15 r4, W-2).

// ---- studio_command (and any passthrough of bridge commands): the command the bridge would read, the first word of the
// line it receives (the bridge trims the line and splits at the first space), is refused when it is destructive.
export { bridgeCommandRefusal } from './destructive-operations.mjs'; // CX15 r2: one parse of the bridge line for every surface
