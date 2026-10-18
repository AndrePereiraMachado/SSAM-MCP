import './fixtures/isolated-profile.mjs';
// Round 4, D10 (Integradora, 17/10): a local `ssam mcp` over stdio with SSAM_EXPOSURE=licensee serves every answer and its
// listing under the licensee rule, also when a cached tool listing exists (warm start: <root>/.local/mcp/tools-list-<key>.json,
// whose key names the release and the arguments, never the exposure). With the cached surface, the proxy called the inner
// handler of each tool (ssamHandlers) without the rule, and an owner start's listing was served with the owner's
// instructions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { toolsSnapshotKey, toolsSnapshotPath } from '../warm-start.mjs';
import { serverIdentity } from '../server-identity.mjs';
import { workspaceRoot } from '../workspace.mjs';
import { LICENSEE_INSTRUCTION } from '../exposure.mjs';
import { findings } from './fixtures/internal-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ssam = path.join(here, '..', 'ssam.mjs');
const ARGS = ['--profile', 'all'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shown = list => list.map(f => f.family + ' ' + f.at + ' ' + f.sample.replace(/\s+/g, ' ').slice(0, 120));
// The child's environment: this process's isolated profile, no worker, no warm-up, no exposure of the calling shell.
const base = () => {
  const env = { ...process.env, SSAM_NO_WARM: '1', ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_ODC_OFFLINE: '1' };
  for (const name of ['SSAM_EXPOSURE', 'SSAM_EXPOSURE_CALLER', 'SSAM_REFERENCE_DAY_BYTES', 'SSAM_TOOLS_SNAPSHOT_DISABLE', 'SSAM_MAX_ANSWER_BYTES']) delete env[name];
  return env;
};
async function stdio(extra = {}) {
  const client = new Client({ name: 'no-internals-stdio', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [ssam, 'mcp', ...ARGS], env: { ...base(), ...extra }, stderr: 'ignore' }));
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  // a call the deadline detached is followed with continueTask to its final answer
  const call = async (name, args) => {
    let body = await once(name, args);
    for (let i = 0; i < 120; i++) {
      const next = [body?.continuation, body?.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
      if (!next) break;
      await sleep(500);
      body = await once(next.tool, next.arguments);
    }
    return body;
  };
  return { client, call, close: () => client.close() };
}
// The premise: this release has a key for its cached listing (warm-start.mjs toolsSnapshotKey: the head of the checkout and
// the hashes of the facade and the catalog). A copy without .git has none: no start writes a cached listing there, so the
// test cannot hold its premise and skips, saying why (round 5, the record of the re-review of round 4).
const snapshotKey = toolsSnapshotKey(serverIdentity(), base(), [...ARGS, 'profile:all']);
const skip = !snapshotKey && 'this checkout has no release key (no git head): no start writes a cached listing, so the premise of D10 does not hold';

test('a local ssam mcp over stdio with SSAM_EXPOSURE=licensee and a cached listing serves under the licensee rule (D10)', { skip, timeout: 900000 }, async () => {
  // an owner start writes (or finds) the cached listing of this release and these arguments
  const owner = await stdio();
  try { assert.ok((await owner.client.listTools()).tools.length > 0); } finally { await owner.close(); }
  const snapshot = toolsSnapshotPath(workspaceRoot, snapshotKey);
  assert.ok(snapshot && fs.existsSync(snapshot), 'the cached listing exists, so the licensee start may read it (the test is not vacuous): ' + snapshot);

  const licensee = await stdio({ SSAM_EXPOSURE: 'licensee', SSAM_EXPOSURE_CALLER: 'stdio-' + process.pid + '-' + Date.now(), SSAM_REFERENCE_DAY_BYTES: '3000' });
  // every facet is read, then judged together, so a failure names each one
  const problems = [];
  try {
    // the listing: the licensee's instructions
    if (!(licensee.client.getInstructions() ?? '').includes(LICENSEE_INSTRUCTION)) problems.push('listing: the licensee instructions are not served');
    // an answer: the state report under the rule, inline and read back
    const doctor = await licensee.call('ssam_doctor', {});
    assert.equal(doctor.ok, true, JSON.stringify(doctor).slice(0, 300));
    for (const line of shown(findings(doctor))) problems.push('ssam_doctor inline: ' + line);
    if (doctor.omitted?.arguments?.file) for (const line of shown(findings(await licensee.call(doctor.omitted.tool, doctor.omitted.arguments)))) problems.push('ssam_doctor omitted part: ' + line);
    // the day of the reference
    await licensee.call('ssam_reference', { lane: 'o11', kind: 'rules', query: 'session' });
    const past = await licensee.call('ssam_reference', { lane: 'o11', kind: 'rules', query: 'session' });
    if (past.code !== 'REFERENCE_DAY_LIMIT') problems.push('day: past the day ssam_reference answered ' + (past.code ?? 'ok:' + past.ok));
  } finally { await licensee.close(); }
  assert.deepEqual(problems, []);
});
