import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { laneTable, o11LaneOf, authorityDir, authorityKeyPath, readAuthorityKey } from '../o11-lane.mjs';
import { anvilLaneFacts } from '../lanes.mjs';

const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('the lane table is the lanes.py table, with the worker ports of .ssam-workspace.json', () => {
  const root = temp('o11-lane-ws-');
  try {
    assert.deepEqual(laneTable(root), { ss4: { bridge: 4516, cdp: 9226, worker: 4517, local: '.local' },
      ss5: { bridge: 4536, cdp: 9246, worker: 4537, local: path.join('.local', 'lane-ss5') } });
    fs.writeFileSync(path.join(root, '.ssam-workspace.json'), '\uFEFF' + JSON.stringify({ workers: { o11ss4: 14517, o11ss5: 14537 } }));
    assert.equal(laneTable(root).ss4.worker, 14517);
    assert.equal(laneTable(root).ss5.worker, 14537);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a lane resolves its Studio, CLI, folders and child environment as lanes.py does', () => {
  const root = temp('o11-lane-root-'); const profile = temp('o11-lane-home-');
  try {
    const env = { USERPROFILE: profile, LOCALAPPDATA: path.join(profile, 'Local'), ProgramFiles: 'C:\\PF' };
    const ss5 = o11LaneOf('SS5', { root, workspace: root, env });
    assert.equal(ss5.name, 'ss5'); assert.equal(ss5.bridge, 4536); assert.equal(ss5.local, path.join(root, '.local', 'lane-ss5'));
    assert.equal(ss5.studioDir, path.join(profile, 'OutSystems', 'Service Studio 11 - Anvil 4536', 'Service Studio'));
    assert.equal(ss5.cli, path.join(root, 'src', 'Anvil.Cli', 'bin', 'Release', 'net8.0', 'anvil.dll'));
    fs.mkdirSync(path.join(root, '.local', 'cli'), { recursive: true }); fs.writeFileSync(path.join(root, '.local', 'cli', 'anvil.dll'), '');
    assert.equal(ss5.cli, path.join(root, '.local', 'cli', 'anvil.dll'));
    assert.equal(ss5.bridgeLog, path.join(profile, 'Local', 'Anvil', 'bridge-4536.log'));
    // The Studio enters the child environment only when that installation exists, and never over an explicit one.
    assert.equal(ss5.env({ X: '1' }).ANVIL_STUDIO_DIR, undefined);
    assert.equal(ss5.env({ X: '1' }).ANVIL_LANE, 'ss5');
    fs.mkdirSync(ss5.studioDir, { recursive: true });
    assert.equal(ss5.env({}).ANVIL_STUDIO_DIR, ss5.studioDir);
    assert.equal(ss5.env({ ANVIL_STUDIO_DIR: 'D:\\S' }).ANVIL_STUDIO_DIR, 'D:\\S');
    assert.equal(o11LaneOf('ss4', { root, workspace: root, env: { ...env, ANVIL_STUDIO_DIR: 'D:\\Other' } }).studioDir, 'D:\\Other');
    const dict = ss5.asDict();
    assert.deepEqual(Object.keys(dict), ['name', 'bridge', 'cdp', 'worker', 'local', 'studioDir', 'studioExists', 'baseStudio', 'cli', 'bridgeLog']);
    assert.equal(dict.studioExists, true); assert.equal(dict.baseStudio, path.join('C:\\PF', 'OutSystems', 'Service Studio 11', 'Service Studio'));
    assert.throws(() => o11LaneOf('ss6', { root, workspace: root, env }), /Unknown O11 lane 'ss6'/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('the controller key folder follows the record, then ANVIL_AUTHORITY_DIR, then the user environment, then LOCALAPPDATA', () => {
  const dir = temp('o11-lane-auth-');
  try {
    const none = () => null;
    assert.equal(authorityDir({ env: { LOCALAPPDATA: 'L:\\x' }, readUserEnvironment: none }), path.join('L:\\x', 'Anvil', 'authority'));
    assert.equal(authorityDir({ env: { LOCALAPPDATA: 'L:\\x' }, readUserEnvironment: () => 'U:\\auth' }), 'U:\\auth');
    assert.equal(authorityDir({ env: { ANVIL_AUTHORITY_DIR: dir }, readUserEnvironment: () => 'U:\\auth' }), dir);
    assert.equal(authorityDir({ env: { ANVIL_AUTHORITY_DIR: dir }, record: { authorityDir: 'R:\\rec' } }), 'R:\\rec');
    assert.equal(authorityKeyPath({ env: { ANVIL_AUTHORITY_DIR: dir } }), path.join(dir, 'bridge.key'));
    assert.equal(readAuthorityKey({ env: { ANVIL_AUTHORITY_DIR: dir } }), null);
    fs.writeFileSync(path.join(dir, 'bridge.key'), 'ABC123\r\n', 'ascii');
    assert.equal(readAuthorityKey({ env: { ANVIL_AUTHORITY_DIR: dir } }), 'ABC123');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lanes.mjs answers the lane facts in process, without spawning Python', async () => {
  const facts = await anvilLaneFacts('ss4');
  assert.equal(facts.name, 'ss4'); assert.equal(facts.bridge, 4516); assert.equal(typeof facts.studioDir, 'string');
});
