// Atritos 3, lane fa, C39: one MCP entry per server. configure-mcp refuses to write a second entry that runs the SSAM
// server of the same root under another name, keeps the existing one and names it back (DUPLICATE_MCP_ENTRY). Temporary
// folders only; no client configuration outside the checkout is read or written.
import '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeMcpConfig, rootEntryOf } from '../scripts/configure-mcp.mjs';

const layout = { kernel: 'kernel', odc: 'platforms/odc', o11Lane: 'ss4' };
function checkout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa3-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); fs.mkdirSync(path.join(root, 'platforms', 'odc'), { recursive: true });
  return root;
}

test('C39: a second entry for the same SSAM root is refused and the existing name comes back', t => {
  const root = checkout(t);
  const existing = { command: 'node.exe', args: [path.join(root, 'facade', 'ssam.mjs'), 'mcp'], env: { ANVIL_LANE: 'ss4' } };
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'ssam-hosted-copy': existing, other: { command: 'x', args: ['y'] } } }));
  const before = fs.readFileSync(path.join(root, '.mcp.json'), 'utf8');
  const result = writeMcpConfig({ root, layout, execPath: 'node.exe', env: {} });
  assert.equal(result.ok, false); assert.equal(result.code, 'DUPLICATE_MCP_ENTRY');
  assert.equal(result.existing, 'ssam-hosted-copy'); assert.equal(result.name, 'ssam');
  assert.match(result.error, /one MCP entry per server/);
  assert.equal(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'), before, 'nothing written where the entry exists');
  // The ODC folder had none: written there (one entry).
  assert.deepEqual(result.files, [path.join(root, 'platforms', 'odc', '.mcp.json')]);
});

test('C39: the same name is updated, the package server and other roots are other servers', t => {
  const root = checkout(t);
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
    ssam: { command: 'old-node.exe', args: [path.join(root, 'facade', 'ssam.mjs'), 'mcp'] },
    'ssam-headless-selected': { command: 'node.exe', args: [path.join(root, 'facade', 'ssam.mjs'), 'package', 'mcp'] },
    'ssam-other-root': { command: 'node.exe', args: ['C:\\Other\\SSAM\\facade\\ssam.mjs', 'mcp'] } } }));
  const result = writeMcpConfig({ root, layout, execPath: 'node.exe', env: {} });
  assert.equal(result.ok, true, result.error);
  const servers = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers;
  assert.equal(servers.ssam.command, 'node.exe');
  assert.ok(servers['ssam-headless-selected']); assert.ok(servers['ssam-other-root']);
  assert.equal(rootEntryOf(servers['ssam-headless-selected'], root), false);
  assert.equal(rootEntryOf(servers['ssam-other-root'], root), false);
  assert.equal(rootEntryOf({ args: [path.join(root, 'FACADE', 'SSAM.mjs').toLowerCase(), 'mcp'] }, root), true, 'the same root in any case');
});
