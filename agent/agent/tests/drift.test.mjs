// Drift: the agent keeps byte-equal copies of the frozen transport code of the facade (docs/FASE2-AGENTE.md 10.2) and
// never imports from platforms/ (it ships alone in the customer pack).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.dirname(agentDir);
const facade = path.join(repo, 'platforms', 'odc', 'facade');

test('agent/lib/odc-pipe.mjs is byte-equal to platforms/odc/facade/odc-pipe.mjs', () => {
  assert.ok(fs.readFileSync(path.join(agentDir, 'lib', 'odc-pipe.mjs')).equals(fs.readFileSync(path.join(facade, 'odc-pipe.mjs'))));
});

test('agent/lib/o11-wire.mjs carries the frozen block of o11-bridge.mjs unchanged', () => {
  const copy = fs.readFileSync(path.join(agentDir, 'lib', 'o11-wire.mjs'), 'utf8');
  const block = /\/\/ ---- begin copy of o11-bridge\.mjs\n([\s\S]*?)\n\/\/ ---- end copy of o11-bridge\.mjs/.exec(copy)?.[1];
  assert.ok(block, 'markers present');
  for (const name of ['export const MAX_REPLY_BYTES', 'export const TIMEOUTS', 'export const timeoutFor', 'export class BridgeError', 'export function bridgeRequest'])
    assert.ok(block.includes(name), name);
  assert.ok(fs.readFileSync(path.join(facade, 'o11-bridge.mjs'), 'utf8').includes(block));
});

test('no file of agent/ imports from platforms/', () => {
  const files = [];
  const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, item.name); if (item.isDirectory()) walk(full); else if (/\.(mjs|js|cjs)$/.test(item.name)) files.push(full); } };
  walk(agentDir);
  assert.ok(files.length >= 10);
  const specifiers = /\bimport\s*(?:[^'"()]*?\bfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(specifiers)) {
      const spec = match[1] ?? match[2] ?? match[3];
      assert.ok(!/(^|[\\/])platforms([\\/]|$)/.test(spec), `${path.relative(repo, file)} imports ${spec}`);
      if (spec.startsWith('.')) assert.ok(path.resolve(path.dirname(file), spec).startsWith(agentDir + path.sep), `${path.relative(repo, file)} imports ${spec} outside agent/`);
    }
  }
});
