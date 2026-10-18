import './fixtures/isolated-profile.mjs';
// CX15 r7, the family of the owner's words: ONE predicate (wordsGiven, destructive-operations.mjs) is the only way a gate
// decides "the owner gave words". (1) Every field of every tool of the real hub (both lanes) that takes the owner's words —
// enumerated from the live input schemas, so a new tool or field is covered by itself — refuses each text of the server
// (the words marker, OWNER_REPLY, "<the user's own words>", a sha256, punctuation) with WORDS_REQUIRED before any handler
// runs (the fake kernel runner is never called), and the enumeration covers at least the 44 fields of the cx15-5 review
// (C:\t\revisoes\cx15-5\review\repros\out\word-fields.txt). (2) In the source of the facade and the portal runtime, no gate
// decides with its own predicate: no /^<[^>]*>$/ placeholder test and no emptiness test of a words variable outside the
// declared places that do not decide authorization (each with its reason). Synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const SERVER_TEXTS = { marker: "<the user's own words>", legacyMarker: '<palavras do usuário>' /* input alias of the releases before 16/10 */, ownerReply: "<the owner's next message after the list, verbatim>", scTemplate: "<the user's own words>", hash: 'sha256:' + 'a'.repeat(64), punctuation: '!!! ... ???' };
const WORD_FIELD = /^(authorize|authorization|words|ownerRequest)$/;
// The word fields of the cx15-5 review (tool -> the last key of each path), the floor of the enumeration.
const REVIEW_FIELDS = ['o11_data:authorization', 'o11_data:ownerRequest', 'ssam_debug_invoke:authorization', 'ssam_debug_run:words', 'ssam_debug_client:words', 'ssam_debug_server:words',
  'o11_service_center_write:words', 'o11_service_center_write:ownerRequest', 'o11_deliver:authorize', 'o11_environment:authorize', 'o11_environment:ownerRequest', 'o11_publish:authorize',
  'ssam_grant:words', 'o11_extension:words', 'o11_extension:ownerRequest', 'studio_data_insert:authorize', 'studio_data_update:authorize', 'studio_data_delete:authorize', 'studio_data_delete:ownerRequest',
  'studio_authorize:text', 'studio_publish:authorize', 'studio_create_app:authorize', 'studio_deliver:authorize', 'odc_a2a_connection_delete:authorize', 'odc_a2a_connection_delete:ownerRequest',
  'odc_mcp_import:authorize', 'odc_asset_revision:authorize', 'odc_write:authorize', 'odc_write:ownerRequest', 'odc_receipt:authorize', 'odc_portal_write:authorize', 'odc_portal_write:ownerRequest',
  'odc_portal_login:authorize', 'odc_deploy:authorize', 'odc_deploy:ownerRequest', 'odc_configurations:authorize', 'odc_asset_delete:authorize', 'odc_asset_delete:ownerRequest',
  'odc_external_db_connection:authorize', 'odc_external_db_connection:ownerRequest', 'odc_external_library:authorize', 'odc_external_library:ownerRequest', 'ssam_code:authorize', 'o11_access:words', 'ssam_doctor:authorize'];

// Every path (as a list of property names, '[]' for an array item) under which a words field sits in a JSON schema.
function wordPaths(tool, schema) {
  const out = [];
  const walk = (s, at, depth) => {
    if (!s || typeof s !== 'object' || depth > 8) return;
    for (const [k, v] of Object.entries(s.properties ?? {})) {
      if (WORD_FIELD.test(k) || (tool === 'studio_authorize' && k === 'text')) out.push([...at, k]);
      else walk(v, [...at, k], depth + 1);
      if (v?.items) walk(v.items, [...at, k, '[]'], depth + 1);
    }
    for (const alt of [...(s.anyOf ?? []), ...(s.oneOf ?? []), ...(s.allOf ?? [])]) walk(alt, at, depth + 1);
  };
  walk(schema, [], 0);
  const seen = new Set();
  return out.filter(p => { const key = p.join('/'); if (seen.has(key)) return false; seen.add(key); return true; });
}
const withValue = (keys, value) => {
  const root = {}; let cursor = root;
  keys.forEach((k, i) => {
    const last = i === keys.length - 1;
    if (k === '[]') return;
    if (last) { cursor[k] = value; return; }
    const next = keys[i + 1] === '[]' ? [{}] : {};
    cursor[k] = next; cursor = Array.isArray(next) ? next[0] : next;
  });
  return root;
};

test('CX15 r7 family (1): every words field of every tool refuses every server text with WORDS_REQUIRED before any handler runs', async t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r7-gates-')); t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const dataRoot = path.join(work, 'data'), answersRoot = path.join(work, 'answers'), lockRoot = path.join(work, 'lock');
  for (const d of [dataRoot, answersRoot, lockRoot]) fs.mkdirSync(d, { recursive: true });
  const runs = [];
  // profile 'all': every tool of every server (where the debugger tools are a server of their own, ssam-debug, they are here too).
  const hub = await createSsamServer({ o11: true, odc: true, profile: 'all', deps: { runAnvil: async argv => { runs.push(argv[0]); return { ok: false, exitCode: 2, envelope: { ok: false, error: 'fake' } }; },
    dataRoot, answersRoot, lock: { o11Root: lockRoot, odcRoot: lockRoot } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r7-gates', version: '1.0.0' });
  await Promise.all([hub.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await hub.close(); });
  const { tools } = await client.listTools();
  const fields = tools.flatMap(tool => wordPaths(tool.name, tool.inputSchema).map(keys => ({ tool: tool.name, keys })));
  const covered = new Set(fields.map(f => f.tool + ':' + f.keys.at(-1)));
  assert.deepEqual(REVIEW_FIELDS.filter(f => !covered.has(f)), [], 'the enumeration covers every words field of the review');
  const wrong = [];
  for (const { tool, keys } of fields) {
    for (const [kind, value] of Object.entries(SERVER_TEXTS)) {
      const reply = await client.callTool({ name: tool, arguments: withValue(keys, value) });
      const v = reply.structuredContent ?? (() => { try { return JSON.parse(reply.content?.[0]?.text ?? 'null'); } catch { return { text: reply.content?.[0]?.text }; } })();
      if (v?.code !== 'WORDS_REQUIRED') wrong.push(`${tool} ${keys.join('/')} ${kind}: ${v?.code ?? String(v?.text ?? v?.error ?? '').slice(0, 80)}`);
    }
  }
  t.diagnostic('cx15r7-gates ' + JSON.stringify({ tools: tools.length, fields: fields.length, calls: fields.length * Object.keys(SERVER_TEXTS).length }));
  assert.deepEqual(wrong, [], 'every server text is WORDS_REQUIRED');
  assert.deepEqual(runs, [], 'no handler reached the kernel');
});

// The places that test a words variable for emptiness without deciding authorization (each said why); everything else in
// the facade and the portal runtime that decides "the owner gave words" calls wordsGiven.
const NOT_A_GATE = {
  'data-delete-gate.mjs': 'the words of a preview call only select the refusal the preview answers with (CONFIRMATION_REQUIRED); they never confirm',
  'service-center/delete.mjs': '`asked` selects the mode of the delete engine (an attempt to execute); the engine checks the words after the preview',
  'studio-write-lock.mjs': 'hasWords only classifies a Service Center delete as a write for the Studio lock',
  'kernel-delivery.mjs': 'forwarding an authorize already given (publishAuthorization decided it with wordsGiven)',
  'studio-publish-log.mjs': 'after the wordsGiven refusal of the line above',
  'odc-external-library.mjs': 'after the wordsGiven refusal at the start of wordsFor',
  'next-steps.mjs': 'a list of texts to show, no gate',
  'ssam-reference.mjs': 'a reference text, no authorization',
  'job-guidance.mjs': 'a sentence of guidance, no authorization',
  'prototype/dimensions.mjs': 'words of a prototype layout, no authorization',
  'destructive-operations.mjs': 'the predicate itself and the bridge line readers',
  'credential-profiles.mjs': 'after wordsGiven: the words of the selection must also name the tenant and the principal',
};
test('CX15 r7 family (2): no gate of the facade or the portal runtime decides with its own predicate', () => {
  const facade = path.join(import.meta.dirname, '..'), runtime = path.join(facade, '..', 'portal', 'runtime');
  const files = [...fs.readdirSync(facade, { recursive: true }).map(String).filter(f => f.endsWith('.mjs') && !f.startsWith('tests' + path.sep) && !f.includes('node_modules')).map(f => [facade, f]),
    ...fs.readdirSync(runtime, { recursive: true }).map(String).filter(f => f.endsWith('.mjs')).map(f => [runtime, f])];
  const PLACEHOLDER = /\/\^<\[\^>\]\*>\$\//;
  const EMPTINESS = /(!\s*\(?\s*[\w.?]*\b(words|authorize|authorization|userWords|authorizationWords)\??\.trim\(\)|\b(words|authorize|authorization|userWords|authorizationWords)\??\.trim\(\)\s*(!==|===)\s*''|\b(words|authorize|authorization)\??\.trim\(\)\.length\s*<)/;
  const hits = [];
  for (const [dir, f] of files) {
    const rel = f.split(path.sep).join('/');
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (PLACEHOLDER.test(line)) hits.push(`${rel}:${i + 1} placeholder regex`);
      // (a length or shape rule may sit beside the wordsGiven decision: on the same line or within the next two)
      if (EMPTINESS.test(line) && !NOT_A_GATE[rel] && !/wordsGiven\(/.test(line + (lines[i + 1] ?? '') + (lines[i + 2] ?? ''))) hits.push(`${rel}:${i + 1} ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, [], 'every gate decides with wordsGiven (or is declared in NOT_A_GATE with its reason)');
});
