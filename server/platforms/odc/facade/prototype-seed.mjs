// The seed phase of the prototype importer (docs/PROTOTIPO-NATIVO.md 3.4 and 7.6, lane surface): after a clean
// publication, the rows of the prototype's store are written into the regular entities the import created and marked,
// only into the ones that are still empty, through the native Edit Data (O11: the o11_data path, kernel DataCommand
// through the connected Studio's own session; ODC: studio_data_insert), with the authorization words of the call. No timer
// and no load action (owner's instruction of 2026-09-29: the data is written directly).
//
//   seedPlan({receipt, capture})                      the entities to seed, parents first, with the rows and their keys
//   seedPrototypeData({lane, module, receipt, bundle, authorize, write, published, seed})
//                                                     -> {ran, entities, rows, seeded[], skippedNotEmpty[], failed?, reason?}
//   o11DataWriter / odcDataWriter                     the default writers (one o11_data batch per phase; ODC per entity)
//
// write(request) is injectable: request = {lane, module, authorization, batch:[{operation:'read-all'|'insert', entity,
// limit?, records?, step, operationId?}]} (the o11_data batch shape) -> {ok, results:[{ok, rows?|records?|count?|inserted?,
// error?}]}. Nothing is written without publish:true and a clean publication (published:true), nor with data.seed false.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashedWords, wordsGiven } from './destructive-operations.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const clip = (text, max = 300) => { const s = String(text ?? ''); return s.length > max ? s.slice(0, max - 3) + '...' : s; };
export const MARK = prefix => 'ssam:prototype ' + prefix;

// The capture IR of a bundle: the capture.json path, its folder, or the IR itself.
export function captureOf(bundle) {
  if (isObject(bundle) && bundle.schema) return bundle;
  if (typeof bundle !== 'string' || !bundle) return null;
  const file = /\.json$/i.test(bundle) ? bundle : path.join(bundle, 'capture.json');
  try { return readJson(file); } catch { return null; }
}

// An entity of the receipt is seeded only when the import created and marked it: marked !== false, and when the kernel gave
// its description, the mark of the prefix is in it.
function marked(entity, prefix) {
  if (!isObject(entity) || entity.marked === false || entity.created === false) return false;
  if (typeof entity.description === 'string' && prefix && !entity.description.includes(MARK(prefix))) return false;
  return true;
}
// The collection of the store an entity of the receipt holds: its own `collection`, else its name without the prefix.
const collectionName = (entity, prefix) => entity.collection ?? (prefix && String(entity.name).startsWith(prefix) ? String(entity.name).slice(prefix.length) : String(entity.name));

// The plan: one entry per marked regular entity whose collection has rows, parents before children (references of the
// store), the rows with their prototype keys (Id included: no AutoNumber).
export function seedPlan({ receipt, capture }) {
  const prefix = capture?.app?.prefix ?? receipt?.flow ?? null;
  const collections = new Map((Array.isArray(capture?.store?.collections) ? capture.store.collections : []).map(c => [c?.name, c]));
  const entries = [];
  for (const entity of Array.isArray(receipt?.data?.entities) ? receipt.data.entities : []) {
    if (!marked(entity, prefix) || entity.autoNumber === true) continue;
    const collection = collections.get(collectionName(entity, prefix));
    // a field the compiler gave another attribute name (receipt entity.attributes: field -> attribute, the entity's name
    // scope of PrototypeFieldNames) is written to that attribute
    const renames = isObject(entity.attributes) ? entity.attributes : {};
    const attribute = name => (typeof renames[name] === 'string' ? renames[name] : name);
    const rows = (Array.isArray(collection?.rows) ? collection.rows.filter(isObject) : []).map(row => (Object.keys(renames).length ? Object.fromEntries(Object.entries(row).map(([k, v]) => [attribute(k), v])) : row));
    if (!rows.length) continue;
    entries.push({ entity: entity.name, collection: collection.name, key: attribute(collection.key ?? 'Id'), rows,
      references: (Array.isArray(collection.references) ? collection.references : []).map(r => r?.collection).filter(Boolean) });
  }
  // Parents first: an entry waits for the entries of the collections it references (a cycle keeps the document order).
  const ordered = []; const placed = new Set(); const byCollection = new Map(entries.map(e => [e.collection, e]));
  const place = (e, stack = new Set()) => {
    if (placed.has(e.collection) || stack.has(e.collection)) return;
    stack.add(e.collection);
    for (const ref of e.references) if (byCollection.has(ref) && ref !== e.collection) place(byCollection.get(ref), stack);
    if (!placed.has(e.collection)) { placed.add(e.collection); ordered.push(e); }
  };
  for (const e of entries) place(e);
  return ordered;
}

const countOf = result => {
  if (!isObject(result)) return null;
  for (const v of [result.count, result.total, result.totalCount]) if (Number.isInteger(v)) return v;
  for (const list of [result.rows, result.records, result.value?.records, result.value?.rows, result.data?.records, result.data?.rows]) if (Array.isArray(list)) return list.length;
  return null;
};

export async function seedPrototypeData({ lane, module, receipt, bundle, authorize, write, published = false, seed = true, now = Date.now, uuid = randomUUID } = {}) {
  const started = now();
  const skipped = reason => ({ ran: false, reason, entities: 0, rows: 0, seeded: [], skippedNotEmpty: [], seedMs: now() - started });
  if (published !== true) return skipped('publish:true was not asked or the publication did not end clean: nothing is seeded');
  if (seed === false) return skipped('data.seed is false');
  if (!wordsGiven(authorize)) return skipped( // CX15 r7 (L-7): one predicate
    'the call carries no authorization words (a standing grant does not cover demo data)');
  if (typeof write !== 'function') return skipped('no data writer on lane ' + lane);
  const capture = captureOf(bundle);
  if (!capture) return skipped('the capture bundle could not be read');
  const plan = seedPlan({ receipt, capture });
  if (!plan.length) return { ...skipped('no regular entity of the import has rows to seed'), ran: true };
  // One read of each entity (only the empty ones are written), then one batch of inserts, parents first.
  const reads = await write({ lane, module, authorization: authorize, batch: plan.map((e, i) => ({ operation: 'read-all', entity: e.entity, limit: 1, step: 'read' + i })) });
  const empty = []; const skippedNotEmpty = []; const failed = [];
  plan.forEach((e, i) => {
    const r = reads?.results?.[i];
    const n = countOf(r);
    if (reads?.ok === false && !r) failed.push({ entity: e.entity, error: clip(reads.error ?? 'read refused') });
    else if (r?.ok === false || n == null) failed.push({ entity: e.entity, error: clip(r?.error ?? 'the read gave no row count') });
    else if (n > 0) skippedNotEmpty.push(e.entity);
    else empty.push(e);
  });
  const seeded = [];
  if (empty.length) {
    const inserts = await write({ lane, module, authorization: authorize,
      batch: empty.map((e, i) => ({ operation: 'insert', entity: e.entity, records: e.rows, step: 'seed' + i, operationId: uuid() })) });
    empty.forEach((e, i) => {
      const r = inserts?.results?.[i];
      if (inserts?.ok === false && !r) failed.push({ entity: e.entity, error: clip(inserts.error ?? 'insert refused') });
      else if (r?.ok === false) failed.push({ entity: e.entity, error: clip(r.error ?? 'insert refused') });
      else seeded.push({ entity: e.entity, rows: Number.isInteger(r?.inserted) ? r.inserted : e.rows.length, keys: e.rows.map(row => row[e.key]).filter(v => v != null).slice(0, 50) });
    });
  }
  return { ran: true, entities: seeded.length, rows: seeded.reduce((n, s) => n + s.rows, 0), seeded, skippedNotEmpty, ...(failed.length ? { failed } : {}), seedMs: now() - started };
}

// ---- the default writers
// O11: one `anvil data --studio` call per batch (kernel DataCommand.RunThroughStudio: the connected Studio's own login, SSO
// included), the request written under <work>/requests. runAnvil is the lane runner of the delivery (already holding the
// Studio). -> the batch answer as {ok, results}.
export function o11DataWriter({ runAnvil, host, oml, work }) {
  return async ({ module, authorization, batch }) => {
    const requests = path.join(work, 'requests'); fs.mkdirSync(requests, { recursive: true });
    const file = path.join(requests, randomUUID() + '.json');
    // CX15 r4 (W-2): the request file and the kernel's receipt keep sha256:<hex> of the owner's words, never the words.
    fs.writeFileSync(file, JSON.stringify({ authorization: hashedWords(authorization), batch: batch.map(op => (op.operation === 'insert' ? op : (({ operationId, ...rest }) => rest)(op))) }));
    const r = await runAnvil(['data', '--studio', '--host', host, '--module', module, '--oml', path.resolve(oml), '--request', file, '--work', work]);
    const envelope = r?.envelope ?? null;
    const data = envelope?.data && typeof envelope.data === 'object' ? envelope.data : envelope;
    return { ok: envelope?.ok === true, results: Array.isArray(data?.results) ? data.results : [], ...(envelope?.ok === true ? {} : { error: clip(envelope?.error?.message ?? envelope?.error ?? (r?.stderr ?? []).join(' ') ?? 'the data command failed') }) };
  };
}
// ODC: the bridge's data service, one command per entity (data <Module> <Entity> --limit 1; data-insert <Module> <Entity>
// --records-file <file> --authorize <words>), the records file next to the delivery evidence.
export function odcDataWriter({ studio, pid, dir }) {
  return async ({ module, authorization, batch }) => {
    const results = [];
    for (const op of batch) {
      try {
        if (op.operation === 'insert') {
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, 'seed-' + String(op.entity).replace(/[^\w.-]/g, '_') + '.json');
          fs.writeFileSync(file, JSON.stringify(op.records));
          // CX15 r4 (W-2): the bridge gets sha256:<hex> of the owner's words (it only requires a nonempty --authorize).
          const value = await studio(['data-insert', module, op.entity, '--records-file', file, '--authorize', hashedWords(authorization)], pid);
          results.push({ ok: value?.ok !== false, inserted: Array.isArray(value?.records) ? value.records.length : Number.isInteger(value?.inserted) ? value.inserted : op.records.length, ...(value?.ok === false ? { error: value.error } : {}) });
        } else {
          const value = await studio(['data', module, op.entity, '--limit', String(op.limit ?? 1)], pid);
          results.push(value?.ok === false ? { ok: false, error: value.error } : { ok: true, records: value?.records ?? value?.rows ?? value?.value?.records ?? [], ...(Number.isInteger(value?.total) ? { total: value.total } : {}) });
        }
      } catch (error) { results.push({ ok: false, error: clip(error.message) }); }
    }
    return { ok: results.every(r => r.ok !== false), results };
  };
}
