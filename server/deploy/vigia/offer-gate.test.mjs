// A1 as a rollout condition (C:\t\r4\REVISAO-U1.md, round 3): from ODC bridge v106 on a merge may return before the bridge's
// verification ran, and the server then needs the agent's reconcile-merge. The vigia's signed offers reach any agent with
// bridgeOffer, so the hub offers v106 and later only to an agent whose hello lists reconcile-merge (agent.odcCommands, agent
// 0.3.6 / 0.4.3-native); an older agent keeps its pack or is offered an older accepted bridge. And a bridge is offered only to a
// Studio of its own runtime: the net8 v107 never to a net10 1.7.30 (it would turn the v106 into a downgrade of that pair).
// The kernels are the box's own window (server/deploy/coolify/r1-kernels.json); the agent's lists are the agent box's own
// (agent/agent/lib/kinds.mjs), so this test fails when either drifts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {generateKeyPairSync, createHash, sign} from 'node:crypto';
import {createBridgeStore, agentRuns, AGENT_NEEDS} from '../../platforms/odc/facade/bridge-store.mjs';
import {compatibility} from '../../platforms/odc/facade/agent-hub.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const KERNELS = JSON.parse(fs.readFileSync(path.join(here, '..', 'coolify', 'r1-kernels.json'), 'utf8'));
const AGENT_KINDS = path.join(here, '..', '..', '..', 'agent', 'agent', 'lib', 'kinds.mjs');
const tmp = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-gate-')); t.after(() => fs.rmSync(p, {recursive: true, force: true})); return p; };

// A signed store: odc/<studioVersion>/<protocol> with the runtime each bridge is built for.
function store(t, entries) {
  const dir = tmp(t), keys = generateKeyPairSync('ed25519');
  for (const [studioVersion, protocol, runtime] of entries) {
    const sub = path.join(dir, 'odc', studioVersion, protocol);
    fs.mkdirSync(path.join(sub, 'bridge'), {recursive: true});
    const bytes = Buffer.from('synthetic ' + protocol + ' ' + runtime);
    fs.writeFileSync(path.join(sub, 'bridge', 'ODC3.Bridge.' + protocol + '.dll'), bytes);
    const manifest = {schema: 1, lane: 'odc', studioVersion, runtime, protocol, sequence: 1, createdAt: new Date().toISOString(), authenticodeThumbprint: 'b'.repeat(40),
      files: [{path: 'bridge/ODC3.Bridge.' + protocol + '.dll', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, signer: 'owner'}]};
    const raw = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(path.join(sub, 'manifest.json'), raw);
    fs.writeFileSync(path.join(sub, 'manifest.sig'), sign(null, raw, keys.privateKey));
  }
  return createBridgeStore({root: dir, publicKey: keys.publicKey});
}
// An agent's hello: pack v0 is accepted nowhere, so the hub looks for an offer (it offers only when the pack is refused).
const hello = ({studio, runtime, odcCommands}) => ({t: 'hello', capabilities: {bridgeOffer: true}, bridges: [],
  agent: {version: odcCommands ? '0.3.6' : '0.3.5', ...(odcCommands ? {odcCommands} : {})},
  pack: {id: 'gate', lanes: ['odc'], odcBridge: 'v0'}, studios: {odc: {installed: {version: studio, dir: 'C:/S', ...(runtime ? {runtime} : {})}}}});
const offered = (h, kernel, bridges) => compatibility(h, kernel, ['odc'], {bridges}).odc;

test('the agent box runs reconcile-merge and the hub knows it needs it from v106 on', async t => {
  if (!fs.existsSync(AGENT_KINDS)) return t.skip('agent/ is not in this checkout');
  const kinds = await import(pathToFileURL(AGENT_KINDS).href);
  assert.ok(kinds.ODC_COMMANDS.includes('reconcile-merge'));
  assert.deepEqual(AGENT_NEEDS.map(n => [n.lane, n.from, [...n.commands]]), [['odc', 106, ['reconcile-merge']]]);
  for (const c of AGENT_NEEDS.flatMap(n => n.commands)) assert.ok(kinds.ODC_COMMANDS.includes(c), c);
});

test('1.7.30 (net10): an agent without reconcile-merge is never offered v106, a new one is; v107 (net8) is offered to neither', async t => {
  const v1 = KERNELS.v1;
  assert.equal(v1.odc, '1.7.30');
  const bridges = store(t, [['1.7.30', 'v101', 'net10.0'], ['1.7.30', 'v106', 'net10.0'], ['1.7.30', 'v107', 'net8.0']]);
  const commands = fs.existsSync(AGENT_KINDS) ? [...(await import(pathToFileURL(AGENT_KINDS).href)).ODC_COMMANDS] : ['merge', 'reconcile-merge'];
  const old = commands.filter(c => c !== 'reconcile-merge');
  // New agent (0.3.6): v106, the net10 bridge of its pair.
  const fresh = offered(hello({studio: '1.7.30.10980', runtime: 'net10.0', odcCommands: commands}), v1, bridges);
  assert.equal(fresh.code, 'BRIDGE_UPDATE_REQUIRED');
  assert.equal(fresh.bridgeOffer.protocol, 'v106');
  // Old agent (0.3.5: no odcCommands), and one that lists its commands without reconcile-merge: never v106, never v107; the
  // accepted v101 of the same runtime is what it can be offered.
  for (const h of [hello({studio: '1.7.30.10980', runtime: 'net10.0'}), hello({studio: '1.7.30.10980', runtime: 'net10.0', odcCommands: old})]) {
    const answer = offered(h, v1, bridges);
    assert.equal(answer.bridgeOffer?.protocol, 'v101', JSON.stringify(answer));
  }
  // Without v101 in the store, the old agent gets no offer at all: its own pack refusal, never a bridge it cannot verify.
  const only = store(t, [['1.7.30', 'v106', 'net10.0'], ['1.7.30', 'v107', 'net8.0']]);
  const refused = offered(hello({studio: '1.7.30.10980', runtime: 'net10.0'}), v1, only);
  assert.equal(refused.code, 'AGENT_PACK_MISMATCH');
  assert.equal(refused.bridgeOffer, undefined);
  // The net8 v107 under 1.7.30 is never offered to the net10 Studio, also to the new agent once v106 is gone.
  const net8 = store(t, [['1.7.30', 'v107', 'net8.0']]);
  assert.equal(offered(hello({studio: '1.7.30.10980', runtime: 'net10.0', odcCommands: commands}), v1, net8).bridgeOffer, undefined);
});

test('1.7.29 and 1.7.28 (net8): v107 only to an agent with reconcile-merge; the older agent keeps v102', async t => {
  for (const name of ['v2', 'v3']) {
    const kernel = KERNELS[name];
    const bridges = store(t, [[kernel.odc, 'v102', 'net8.0'], [kernel.odc, 'v107', 'net8.0']]);
    const fresh = offered(hello({studio: kernel.odc + '.1', runtime: 'net8.0', odcCommands: ['merge', 'reconcile-merge']}), kernel, bridges);
    assert.equal(fresh.bridgeOffer?.protocol, 'v107', name);
    const old = offered(hello({studio: kernel.odc + '.1', runtime: 'net8.0'}), kernel, bridges);
    assert.equal(old.bridgeOffer?.protocol, 'v102', name);
  }
});

test('agentRuns: only reconcile-merge in agent.odcCommands opens v106 and later; v101/v102 and O11 need nothing', () => {
  assert.equal(agentRuns({agent: {}}, 'odc', 'v106'), false);
  assert.equal(agentRuns({agent: {odcCommands: 'reconcile-merge'}}, 'odc', 'v106'), false, 'a list, not a word');
  assert.equal(agentRuns({agent: {odcCommands: ['reconcile-merge']}}, 'odc', 'v106'), true);
  assert.equal(agentRuns({agent: {odcCommands: ['reconcile-merge']}}, 'odc', 'v107'), true);
  assert.equal(agentRuns(null, 'odc', 'v105'), true);
  assert.equal(agentRuns({agent: {}}, 'odc', 'v102'), true);
  assert.equal(agentRuns({agent: {}}, 'o11', 'd1'), true);
  assert.equal(agentRuns({agent: {}}, 'odc', 'nonsense'), true, 'no number, no need (the store never names one)');
});

test('a hello without the Studio runtime, or a call without a hello, is served as before', t => {
  const bridges = store(t, [['1.7.30', 'v101', 'net10.0']]);
  assert.equal(bridges.offer('odc', '1.7.30', ['v101']).protocol, 'v101');
  assert.equal(offered(hello({studio: '1.7.30.10980'}), {odc: '1.7.30', o11: '11.55.94', odcBridge: 'v101'}, bridges).bridgeOffer.protocol, 'v101');
});
