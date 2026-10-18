import { parseMcpProfile } from '../platforms/odc/facade/server-profiles.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root as workspace, layout as workspaceLayout } from '../facade/launch.mjs';
// The .mcp.json of this checkout (the root and the ODC folder). The ODC tenant is not written here unless
// SSAM_HYBRID_ODC_TENANT is set explicitly: the server resolves it (SSAM_HYBRID_ODC_TENANT, then .ssam-local.json of this
// machine, then the default of platforms/odc/tenants.json).
// A development checkout (a git worktree: its .git is a file) registers its own server name, ssam-dev-<folder>, and never
// keeps a server named `ssam` there: a session in a worktree that loaded the `ssam` of another root worked on the wrong
// release (atritos 2, A09; ssam_doctor answers WRONG_SERVER for it). Only the files of this checkout are written; no client
// configuration outside it is read or written.
export const isDevWorktree = root => { try { return fs.statSync(path.join(root, '.git')).isFile(); } catch { return false; } };
export const serverName = root => (isDevWorktree(root)
  ? 'ssam-dev-' + (path.basename(path.resolve(root)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'checkout')
  : 'ssam');

export function mcpServers({ root = workspace, layout = workspaceLayout, execPath = process.execPath, env = process.env } = {}) {
  const tenant = env.SSAM_HYBRID_ODC_TENANT ? { SSAM_HYBRID_ODC_TENANT: env.SSAM_HYBRID_ODC_TENANT } : {};
  const servers = { [serverName(root)]: { command: execPath, args: [path.join(root, 'facade', 'ssam.mjs'), 'mcp'], env: { ANVIL_LANE: layout.o11Lane, ...tenant } } };
  if (fs.existsSync(path.join(root, '.local/releases/active-readonly.json'))) servers['ssam-headless-selected'] = {
    command: execPath, args: [path.join(root, 'facade/ssam.mjs'), 'package', 'mcp'],
  };
  return servers;
}

// One MCP entry per server (C39 of the atritos 3 package): two entries for the same SSAM root (2026-10-06: "ssam" and a
// second name, both started by the client) ran two servers on the same folders. The entry of the SSAM server of a root is
// the one whose args run <root>\facade\ssam.mjs mcp (the package server, `package mcp`, is another server). An existing
// entry of the same root under another name is kept as it is and named back; nothing is written in that folder (code
// DUPLICATE_MCP_ENTRY). In a development worktree the name `ssam` is still replaced.
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
export function rootEntryOf(server, root) {
  const args = Array.isArray(server?.args) ? server.args.map(String) : [];
  const at = args.indexOf('mcp');
  if (at < 1 || args.includes('package')) return false;
  try { if (parseMcpProfile(args.slice(at + 1), {}) === 'debug') return false; } catch { return false; }
  return args.some(a => /ssam\.mjs$/i.test(a) && samePath(a, path.join(root, 'facade', 'ssam.mjs')));
}

// Merges the servers into each folder's .mcp.json (the root and the ODC folder by default). In a development worktree the
// name `ssam` is removed, whatever it pointed to.
export function writeMcpConfig({ root = workspace, layout = workspaceLayout, execPath = process.execPath, env = process.env, folders, debug = false } = {}) {
  if (debug) return writeDebugMcpConfig({ root, execPath, env });
  const servers = mcpServers({ root, layout, execPath, env });
  const name = serverName(root);
  const dev = isDevWorktree(root);
  const written = [], refused = [];
  for (const folder of folders ?? [root, path.join(root, layout.odc)]) {
    const file = path.join(folder, '.mcp.json');
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) : {};
    const kept = { ...(previous.mcpServers ?? {}) };
    if (dev) delete kept.ssam;
    const existing = Object.keys(kept).find(key => key !== name && rootEntryOf(kept[key], root));
    if (existing) { refused.push({ file, existing }); continue; }
    fs.writeFileSync(file, JSON.stringify({ ...previous, mcpServers: { ...kept, ...servers } }, null, 2) + '\n');
    written.push(file);
  }
  if (refused.length) return { ok: false, code: 'DUPLICATE_MCP_ENTRY', name, existing: refused[0].existing, dev, files: written, refused,
    error: 'The SSAM server of ' + root + ' already has the MCP entry "' + refused[0].existing + '" (' + refused.map(r => r.file).join(', ') + '); a second entry "' + name + '" was not written: one MCP entry per server.' };
  return { ok: true, name, dev, files: written };
}

export function writeDebugMcpConfig({ root = workspace, execPath = process.execPath, env = process.env } = {}) {
  const file = path.join(root, 'debug.mcp.json');
  const tenant = env.SSAM_HYBRID_ODC_TENANT ? { SSAM_HYBRID_ODC_TENANT: env.SSAM_HYBRID_ODC_TENANT } : {};
  const name = serverName(root) + '-debug';
  const config = { mcpServers: { [name]: { command: execPath, args: [path.join(root, 'facade', 'ssam.mjs'), 'mcp', '--profile', 'debug'], env: tenant } } };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return { ok: true, name, files: [file] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = writeMcpConfig({ debug: process.argv.includes('--debug') });
  if (result.ok) console.log('MCP ' + result.name + ' configured for ' + workspace);
  else console.log(result.error + ' Keep using "' + result.existing + '".');
}
