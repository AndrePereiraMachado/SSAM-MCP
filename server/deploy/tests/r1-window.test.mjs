import '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {compatibility} from '../../platforms/odc/facade/agent-hub.mjs';
import {studioRefusal} from '../../platforms/odc/facade/studio-identity.mjs';
import {offersPreferForeign} from '../../platforms/odc/facade/odc-prefer-foreign.mjs';
import {agentRuns} from '../../platforms/odc/facade/bridge-store.mjs';
const kernels=JSON.parse(fs.readFileSync(new URL('../coolify/r1-kernels.json',import.meta.url),'utf8'));
const kernel={...kernels.v1,servedVersions:{odc:['1.7.30','1.7.29','1.7.28'],o11:['11.55.94','11.55.93','11.55.92']}};
function hello(bridge,o11='11.55.94') {return {agent:{version:'0.1.3'},studios:{odc:{installed:{version:'1.7.30.10980'}},o11:{installed:{version:o11+'.65328'}}},pack:{lanes:['odc','o11'],odcBridge:bridge,o11BuiltFor:o11,o11Hook:'dev'}};}
test('the new pair accepts the current v98 agent and refuses v97',()=>{
  assert.equal(compatibility(hello('v98'),kernel,['odc','o11']).odc.ok,true);
  assert.equal(compatibility(hello('v97'),kernel,['odc','o11']).odc.code,'AGENT_PACK_MISMATCH');
});
for(const o11 of ['11.55.93','11.55.92'])test(`the mixed ${o11} machine retains ODC and receives the exact O11 update step`,()=>{
  const result=compatibility(hello('v98',o11),kernel,['odc','o11']);
  assert.equal(result.odc.ok,true);assert.equal(result.o11.cause,'STUDIO_VERSION_CHANGED');
  assert.match(result.o11.message,/Update Service Studio to 11\.55\.94/);
  assert.equal(studioRefusal(result.o11.studio).continuation.tool,'ssam_doctor');
});
// R4 (U1): the net10 pair serves v106 and still accepts v101, so a Studio that loaded it keeps service (a loaded DLL is never
// replaced); the net8 v107 of the agent pack is accepted on the three pairs, as v102 is, but only by an agent that runs
// reconcile-merge (agent 0.3.6 / 0.4.3-native): an old agent keeps its v102 pack, and an old core in a v107 pack is refused.
const withCommands = h => ({ ...h, agent: { ...h.agent, odcCommands: ['merge', 'reconcile-merge'] } });
test('R4: v109 on the net10 pair with older bridges kept and reconcile-merge required', () => {
  assert.equal(kernels.v1.odcBridge, 'v109');
  for (const pack of ['v101', 'v102', 'v98']) assert.equal(compatibility(hello(pack), kernel, ['odc', 'o11']).odc.ok, true, pack);
  for (const pack of ['v106', 'v107', 'v108', 'v109']) {
    assert.equal(compatibility(withCommands(hello(pack)), kernel, ['odc', 'o11']).odc.ok, true, pack);
    assert.equal(compatibility(hello(pack), kernel, ['odc', 'o11']).odc.code, 'AGENT_PACK_MISMATCH', pack + ' without reconcile-merge');
  }
  for (const name of ['v2', 'v3']) {
    const pair = { ...kernels[name], servedVersions: kernel.servedVersions };
    const h = { ...hello('v107', kernels[name].o11), studios: { odc: { installed: { version: kernels[name].odc + '.1' } }, o11: { installed: { version: kernels[name].o11 + '.1' } } } };
    const as = pack => ({ ...h, pack: { ...h.pack, odcBridge: pack } });
    assert.equal(compatibility(as('v102'), pair, ['odc', 'o11']).odc.ok, true, name + ' v102');
    assert.equal(compatibility(withCommands(as('v107')), pair, ['odc', 'o11']).odc.ok, true, name + ' v107');
    assert.equal(compatibility(as('v107'), pair, ['odc', 'o11']).odc.code, 'AGENT_PACK_MISMATCH', name + ' v107 without reconcile-merge');
  }
});

for (const [name, pair] of Object.entries(kernels)) test(`R39: ${name} gates prefer separately from legacy merge and requires reconciliation`, () => {
  assert.equal(pair.odcBridge, ['1.7.28', '1.7.29'].includes(pair.odc) ? 'v108' : 'v109');
  const commands = ['merge', 'reconcile-merge', 'merge:prefer-foreign'];
  for (const version of [pair.odcBridge, 'v107']) {
    const h = { ...hello(version, pair.o11), agent: { odcCommands: commands },
      studios: { odc: { installed: { version: pair.odc } }, o11: { installed: { version: pair.o11 } } } };
    assert.equal(compatibility(h, pair, ['odc', 'o11']).odc.ok, true);
    assert.equal(agentRuns(h, 'odc', version), true);
    assert.equal(agentRuns({ ...h, agent: { odcCommands: ['merge:prefer-foreign'] } }, 'odc', version), false);
    const offered = list => offersPreferForeign({ info: () => ({ connected: true, instance: name,
      connectedAt: 1, pack: { odcBridge: version }, agentOdcCommands: list }) });
    assert.equal(offered(commands), version !== 'v107');
    assert.equal(offered(['merge', 'reconcile-merge']), false);
  }
});
// R4 (ODC 1.7.31.10988): a fourth pair, appended after v1-v3 so their names, kernels and the default stay as they were. It is the
// net10 pair of v1 with ODC Studio 1.7.31: the same v106 metadata, the agent pack's v107 accepted (with reconcile-merge), and
// the 1.7.31 Studio is served there, while the 1.7.30 kernel does not take it.
test('R4: the 1.7.31 pair serves ODC Studio 1.7.31 with the v1 net10 bridge metadata; v1-v3 unchanged', () => {
  // r44 appends v5 after v4: the first four keep their names and order.
  assert.deepEqual(Object.keys(kernels).slice(0, 4), ['v1', 'v2', 'v3', 'v4']);
  assert.deepEqual({ ...kernels.v4, odc: kernels.v1.odc }, kernels.v1);
  assert.equal(kernels.v4.odc, '1.7.31');
  const served = { odc: ['1.7.30', '1.7.29', '1.7.28', '1.7.31'], o11: ['11.55.94', '11.55.93', '11.55.92', '11.55.94'] };
  const h = pack => ({ ...hello(pack), studios: { odc: { installed: { version: '1.7.31.10988' } }, o11: { installed: { version: '11.55.94.65328' } } } });
  const v4 = { ...kernels.v4, servedVersions: served };
  assert.equal(compatibility(withCommands(h('v107')), v4, ['odc', 'o11']).odc.ok, true, 'v107 with reconcile-merge');
  assert.equal(compatibility(withCommands(h('v107')), v4, ['odc', 'o11']).o11.ok, true, 'O11 11.55.94');
  assert.equal(compatibility(h('v107'), v4, ['odc', 'o11']).odc.code, 'AGENT_PACK_MISMATCH', 'v107 without reconcile-merge');
  assert.equal(compatibility(h('v97'), v4, ['odc', 'o11']).odc.code, 'AGENT_PACK_MISMATCH', 'v97');
  assert.notEqual(compatibility(withCommands(h('v107')), { ...kernels.v1, servedVersions: served }, ['odc', 'o11']).odc.ok, true, 'the 1.7.30 kernel does not serve 1.7.31');
});
// r44 (ODC Studio 1.7.32.11065 / Service Studio 11.55.95.65352): a fifth pair, appended after v1-v4 so their names, kernels, images
// and the default stay as they were; the same net10 bridge metadata as v1 and v4. The hello is the one the published app 0.2.7
// sends (installer pack pack-r43-027-native-bc680e70a2a1: ODC bridge v108, thin O11 bridges built for 11.55.94/.93/.92, the
// native core's command list): it must not get AGENT_PACK_MISMATCH on either lane of the new pair.
const ODC_COMMANDS_027 = ['status', 'wait', 'authorize', 'open', 'snapshot', 'latest', 'check-base', 'preview', 'merge', 'reconcile-merge', 'publish',
  'publish-status', 'publish-log', 'dismiss-dialog', 'close', 'module-info', 'assets', 'consumers', 'create', 'create-app', 'templates',
  'template-download', 'refresh-references', 'reference-snapshot', 'reference-producers', 'data', 'data-insert', 'data-update', 'data-delete',
  'portal-call', 'portal-session', 'auth-status', 'stop', 'query-test', 'merge:prefer-foreign'];
const app027 = (odc, o11) => ({ agent: { version: '0.4.13-native', odcCommands: ODC_COMMANDS_027 },
  studios: { odc: { installed: { version: odc } }, o11: { installed: { version: o11 } } },
  pack: { id: 'pack-r43-027-native-bc680e70a2a1', lanes: ['odc', 'o11'], odcBridge: 'v108', o11BuiltFor: '11.55.94', o11Hook: 'dev', o11Builds: ['11.55.94', '11.55.93', '11.55.92'] } });
const served5 = { odc: ['1.7.30', '1.7.29', '1.7.28', '1.7.31', '1.7.32'], o11: ['11.55.94', '11.55.93', '11.55.92', '11.55.95'] };
test('r44: the 1.7.32/11.55.95 pair serves the app 0.2.7 hello on both lanes; v1-v4 unchanged', () => {
  assert.deepEqual(Object.keys(kernels), ['v1', 'v2', 'v3', 'v4', 'v5']);
  assert.deepEqual({ ...kernels.v5, odc: kernels.v1.odc, o11: kernels.v1.o11 }, kernels.v1);
  assert.deepEqual({ ...kernels.v4, odc: kernels.v1.odc }, kernels.v1);
  assert.deepEqual([kernels.v5.o11, kernels.v5.odc], ['11.55.95', '1.7.32']);
  const v5 = { ...kernels.v5, servedVersions: served5 };
  const exact = compatibility(app027('1.7.32.11065', '11.55.95.65352'), v5, ['odc', 'o11']);
  assert.equal(exact.odc.ok, true, JSON.stringify(exact.odc));
  assert.equal(exact.o11.ok, true, JSON.stringify(exact.o11));
  for (const pack of ['v106', 'v107', 'v108', 'v109']) assert.equal(compatibility({ ...app027('1.7.32.11065', '11.55.95.65352'), pack: { ...app027('', '').pack, odcBridge: pack } }, v5, ['odc', 'o11']).odc.ok, true, pack);
  assert.equal(compatibility({ ...app027('1.7.32.11065', '11.55.95.65352'), agent: { version: '0.4.2-native', odcCommands: ['merge'] } }, v5, ['odc', 'o11']).odc.code, 'AGENT_PACK_MISMATCH', 'v108 without reconcile-merge');
  assert.equal(compatibility({ ...app027('1.7.32.11065', '11.55.95.65352'), pack: { ...app027('', '').pack, odcBridge: 'v97' } }, v5, ['odc', 'o11']).odc.code, 'AGENT_PACK_MISMATCH', 'v97');
  // The thin bridge of the pack is built for 11.55.94: in the window, so 11.55.95 is served with it (the agent warns, kinds.mjs
  // O11_BRIDGE_BUILT_FOR_DIFFERS). Without the deployment window the 11.55.95 kernel alone would refuse that pack.
  assert.equal(compatibility(app027('1.7.32.11065', '11.55.95.65352'), kernels.v5, ['odc', 'o11']).o11.code, 'AGENT_PACK_MISMATCH');
  // The 1.7.31 and 1.7.30 kernels do not serve ODC 1.7.32 as their own version, and the 11.55.94 kernels do not serve 11.55.95 as theirs.
  for (const name of ['v1', 'v4']) {
    const other = compatibility(app027('1.7.32.11065', '11.55.95.65352'), { ...kernels[name], servedVersions: served5 }, ['odc', 'o11']);
    assert.equal(other.odc.cause, 'STUDIO_VERSION_CHANGED', name);
    assert.equal(other.o11.cause, 'STUDIO_VERSION_CHANGED', name);
  }
  // The other pairs keep serving the app 0.2.7 on their own Studios with the five-pair window.
  for (const name of ['v1', 'v2', 'v3', 'v4']) {
    const pair = kernels[name];
    const own = compatibility(app027(pair.odc + '.1', pair.o11 + '.1'), { ...pair, servedVersions: served5 }, ['odc', 'o11']);
    assert.equal(own.odc.ok, true, name + ' odc');
    assert.equal(own.o11.ok, true, name + ' o11');
  }
});