// Lane C, C39 and the doctor part of C15: the server instructions name the core tools in ONE ToolSearch select, and the
// O11 doctor lists the active module reservations by their real path (I11: <authority>/reservations/<sha>.json, a
// DurableJson envelope; active while payload.owner is set), including the real copies a packaged (MSIX) process does
// not see. Temporary folders only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as m_ssam from '../ssam.mjs';
const { createSsamServer, moduleReservations } = m_ssam; // a namespace: at the base each test fails on its own rule, not at import

const CORE = ['ssam_doctor', 'ssam_connect', 'ssam_discover', 'ssam_map', 'ssam_code', 'ssam_reference', 'ssam_evidence', 'ssam_task', 'o11_inspect', 'o11_deliver',
  'o11_publish', 'o11_studio', 'studio_deliver', 'studio_inspect', 'studio_status'];

test('the instructions load every core tool schema in one ToolSearch select', async t => {
  const server = await createSsamServer({ o11: false, odc: false });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pacote-c-session', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const instructions = client.getInstructions();
  const select = /"select:([^"]+)"/.exec(instructions)?.[1];
  assert.ok(select, 'one select: query');
  assert.deepEqual(select.split(',').map(n => n.replace(/^mcp__ssam__/, '')), CORE);
  assert.match(instructions, /ssam_connect \(no lane\) attaches every Studio already open in one call/);
});

const durable = payload => { const text = JSON.stringify(payload); return JSON.stringify({ format: 1, sha256: createHash('sha256').update(text).digest('hex'), payload: text }); };

test('the doctor lists the active reservations with their real path, MSIX copies included', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-c-res-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = path.join(root, 'auth');
  const reservations = path.join(authority, 'reservations');
  fs.mkdirSync(reservations, { recursive: true });
  fs.writeFileSync(path.join(reservations, 'a'.repeat(64) + '.json'), durable({ owner: 'task-1', environment: 'dev.example.test', moduleKey: 'k1', since: '2026-10-05T10:00:00Z' }));
  fs.writeFileSync(path.join(reservations, 'b'.repeat(64) + '.json'), durable({ owner: null, environment: 'dev.example.test', moduleKey: 'k2' }));
  fs.writeFileSync(path.join(reservations, 'c'.repeat(64) + '.json'), '{"format":1,"payl');
  fs.writeFileSync(path.join(reservations, 'a'.repeat(64) + '.json.lock'), '');
  const explicit = moduleReservations({ env: { ANVIL_AUTHORITY_DIR: authority, LOCALAPPDATA: path.join(root, 'Local') }, readUserEnvironment: () => null,
    root: path.join(root, 'kernel'), works: [path.join(root, 'kernel', '.local', 'work')] });
  assert.deepEqual([explicit.authority, explicit.source, explicit.directory, explicit.activeTotal], [authority, 'ANVIL_AUTHORITY_DIR (process)', reservations, 1]);
  // A reservation without a task of this root is orphan (atritos 2, A28): released with the user's words, never ssam_task.
  const file = path.join(reservations, 'a'.repeat(64) + '.json');
  assert.deepEqual(explicit.active, [{ file, owner: 'task-1', moduleKey: 'k1', environment: 'dev.example.test',
    since: '2026-10-05T10:00:00Z', state: 'orphan', reason: explicit.active[0].reason,
    next: { tool: 'ssam_doctor', arguments: { lane: 'o11', release: { reservation: file, authorize: '<palavras do usuário>' } }, why: explicit.active[0].next.why } }]);
  assert.equal(explicit.virtualization, undefined, 'an authority outside %LOCALAPPDATA% is the same inside and outside a package');
  // The default authority under %LOCALAPPDATA%: the packaged copies are listed with their own reservations.
  const local = path.join(root, 'Local');
  const packaged = path.join(local, 'Packages', 'Example.Client_1a2b3c4d5e6f7', 'LocalCache', 'Local', 'Anvil', 'authority', 'reservations');
  fs.mkdirSync(packaged, { recursive: true });
  fs.writeFileSync(path.join(packaged, 'd'.repeat(64) + '.json'), durable({ owner: 'task-9', environment: 'dev.example.test', moduleKey: 'k9' }));
  const virtual = moduleReservations({ env: { LOCALAPPDATA: local }, readUserEnvironment: () => null });
  assert.deepEqual([virtual.source, virtual.directory, virtual.activeTotal], ['%LOCALAPPDATA%\\Anvil\\authority', path.join(local, 'Anvil', 'authority', 'reservations'), 0]);
  assert.match(virtual.virtualization, /packaged \(MSIX\) process sees a private %LOCALAPPDATA%/);
  assert.deepEqual(virtual.packagedCopies.map(c => [c.directory, c.activeTotal, c.active[0].owner]), [[packaged, 1, 'task-9']]);
  // The user's HKCU value is named as the source when the process has none.
  assert.equal(moduleReservations({ env: { LOCALAPPDATA: local }, readUserEnvironment: () => authority }).source, 'ANVIL_AUTHORITY_DIR (HKCU\\Environment)');
});
