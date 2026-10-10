import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostOf, localSettingsFile, readLocalSettings, withLocalTenant } from '../local-settings.mjs';
import { tenants, paths, readJson } from '../lib.mjs';

const tracked = { default: 'personal-x.outsystems.dev', tenants: {
  'personal-x.outsystems.dev': { label: 'tracked', portalOrigin: 'https://personal-x.outsystems.dev', studioAuthor: 'a@b.c', policyFile: null } } };
const temporary = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-local-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('without .ssam-local.json, tenants.json decides exactly as before', t => {
  assert.equal(readLocalSettings(path.join(temporary(t), '.ssam-local.json')), null);
  assert.equal(withLocalTenant(tracked, null), tracked);
  assert.equal(withLocalTenant(tracked, { odcTenant: null, o11Host: 'h.outsystemscloud.com' }), tracked);
  if (!fs.existsSync(localSettingsFile)) assert.deepEqual(tenants(), readJson(paths.tenants));
});

test('the tenant of this machine becomes the default, added when tenants.json does not know it', t => {
  const file = path.join(temporary(t), '.ssam-local.json');
  fs.writeFileSync(file, '﻿' + JSON.stringify({ schema: 'ssam-local/1', odcTenant: 'https://Davi-Test.outsystems.dev/', o11Host: 'davi-lab.outsystemscloud.com' }));
  const local = readLocalSettings(file);
  assert.deepEqual(local, { file, odcTenant: 'davi-test.outsystems.dev', o11Host: 'davi-lab.outsystemscloud.com' });
  const merged = withLocalTenant(tracked, local);
  assert.equal(merged.default, 'davi-test.outsystems.dev');
  assert.equal(merged.tenants['davi-test.outsystems.dev'].portalOrigin, 'https://davi-test.outsystems.dev');
  assert.deepEqual(merged.tenants['personal-x.outsystems.dev'], tracked.tenants['personal-x.outsystems.dev']);
  assert.equal(tracked.default, 'personal-x.outsystems.dev', 'tenants.json content is not mutated');
});

test('a tenant already in tenants.json keeps its entry and only becomes the default', () => {
  const merged = withLocalTenant({ ...tracked, default: 'other.outsystems.dev' }, { odcTenant: 'personal-x.outsystems.dev', o11Host: null });
  assert.equal(merged.default, 'personal-x.outsystems.dev');
  assert.equal(merged.tenants['personal-x.outsystems.dev'], tracked.tenants['personal-x.outsystems.dev']);
});

test('empty values are absent; malformed files and hosts are refused with the file named', t => {
  const dir = temporary(t);
  const file = path.join(dir, '.ssam-local.json');
  fs.writeFileSync(file, JSON.stringify({ odcTenant: '', o11Host: null }));
  assert.deepEqual(readLocalSettings(file), { file, odcTenant: null, o11Host: null });
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => readLocalSettings(file), /Invalid .*\.ssam-local\.json/);
  fs.writeFileSync(file, '[]');
  assert.throws(() => readLocalSettings(file), /expected a JSON object/);
  fs.writeFileSync(file, JSON.stringify({ odcTenant: 'not a host' }));
  assert.throws(() => readLocalSettings(file), /Invalid odcTenant/);
  assert.equal(hostOf('HTTPS://A-b.outsystemscloud.com/ServiceCenter/'), 'a-b.outsystemscloud.com');
  assert.throws(() => hostOf('localhost'), /Invalid host/);
});
