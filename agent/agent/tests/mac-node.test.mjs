// The Node of agent/ssam-agent.sh (review B6): install.sh writes the Node it chose (--node, SSAM_NODE, the one it
// downloaded or the one on the PATH) in private/node, and ssam-agent.sh takes, in this order, SSAM_NODE, that recorded
// Node, agent/node/node and the node of the PATH, each only when it is a Node 24 with --use-env-proxy and
// --use-system-ca (the same check as install.sh). A new Terminal whose PATH starts with another node keeps the Node of the
// install; with no Node 24 at all it says so and what to do, instead of "The agent stopped (code 1)". Runs under the bash
// of Git for Windows, with a fake node on the PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { portugueseIn, describe } from './fixtures/portuguese.mjs';

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASH = ['C:\\Program Files\\Git\\usr\\bin\\bash.exe', '/bin/bash'].find(file => fs.existsSync(file));
const msys = file => (process.platform === 'win32' ? file.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()).replace(/\\/g, '/') : file);
const texts = [];

function agentRoot() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-node-'));
  const root = path.join(top, 'SSAM-Agent');
  fs.mkdirSync(path.join(root, 'agent', 'lib'), { recursive: true }); fs.mkdirSync(path.join(root, 'private'), { recursive: true });
  for (const name of ['ssam-agent.mjs', 'ssam-agent.sh']) fs.copyFileSync(path.join(agentDir, name), path.join(root, 'agent', name));
  for (const name of fs.readdirSync(path.join(agentDir, 'lib'))) fs.copyFileSync(path.join(agentDir, 'lib', name), path.join(root, 'agent', 'lib', name));
  // Another program called node, first on the PATH: it answers anything with a word that is not the check's.
  const stubs = path.join(top, 'stubs'); fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, 'node'), '#!/bin/bash\necho "fake node $*"\nexit 0\n', { mode: 0o755 });
  return { top, root, stubs, fake: path.join(stubs, 'node'), remove: () => fs.rmSync(top, { recursive: true, force: true }) };
}
const sh = (c, args, env = {}) => new Promise(resolve => {
  const system = process.platform === 'win32' ? ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Windows\\System32', 'C:\\Windows'] : ['/usr/bin', '/bin'];
  const runEnv = { ...process.env, PATH: [c.stubs, ...system].join(path.delimiter), ...env };
  delete runEnv.SSAM_NODE; if (env.SSAM_NODE) runEnv.SSAM_NODE = env.SSAM_NODE;
  execFile(BASH, [msys(path.join(c.root, 'agent', 'ssam-agent.sh')), ...args], { encoding: 'utf8', env: runEnv, timeout: 60000, windowsHide: true },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr }));
});

test('ssam-agent.sh keeps the Node recorded by install.sh over another node on the PATH', { skip: !BASH }, async () => {
  const c = agentRoot();
  try {
    fs.writeFileSync(path.join(c.root, 'private', 'node'), process.execPath + '\n');
    const result = await sh(c, ['status']);
    texts.push(['status with the recorded node', result.out]);
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /^Stopped\./m, 'the launcher ran under the recorded Node 24');
    assert.doesNotMatch(result.out, /fake node/);
  } finally { c.remove(); }
});

test('ssam-agent.sh with no Node 24 anywhere says so and what to do; a recorded node that is not Node 24 is not used', { skip: !BASH }, async () => {
  const c = agentRoot();
  try {
    fs.writeFileSync(path.join(c.root, 'private', 'node'), msys(c.fake) + '\n');
    const result = await sh(c, ['status']);
    texts.push(['status without a Node 24', result.out]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /No Node 24 with --use-env-proxy and --use-system-ca found .*run install\.sh again/);
    assert.doesNotMatch(result.out, /fake node/);
    // SSAM_NODE still wins when it is a Node 24.
    const chosen = await sh(c, ['status'], { SSAM_NODE: process.execPath });
    assert.equal(chosen.code, 3, chosen.out);
  } finally { c.remove(); }
  const found = texts.flatMap(([where, text]) => { const f = portugueseIn(text); return f.length ? [describe(where, f)] : []; });
  assert.equal(found.join('\n'), '', 'Portuguese the customer would see');
});
