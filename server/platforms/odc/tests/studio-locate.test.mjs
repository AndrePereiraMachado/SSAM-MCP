// platforms/odc/facade/studio-locate.mjs (lane A): the fixed order variable -> connection record -> process -> HKLM
// Uninstall (64, 32) -> HKCU Uninstall -> %ProgramFiles%, with every source injected. Only regQuery's own parsing is
// run against the real registry, read only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { locateStudio, isStudioDir, regQuery, STUDIOS, SOURCES } from '../facade/studio-locate.mjs';

const UNINSTALL = '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\';
function deps(studios, overrides = {}) {
  const queries = [];
  return {
    queries,
    env: {}, connection: () => null, processes: async () => [], programFiles: 'C:\\Program Files',
    regQuery: async (key, value, view) => { queries.push(key + '|' + value + '|' + view); return null; },
    exists: file => studios.has(file),
    ...overrides,
  };
}
const o11 = dir => path.join(dir, 'ServiceStudio.Framework.dll');
const odc = dir => path.join(dir, 'OutSystems.Model.dll');

test('the order and the facts are frozen', () => {
  assert.deepEqual(SOURCES, ['variable', 'connection', 'process', 'hklm', 'hkcu', 'programfiles']);
  assert.equal(STUDIOS.o11.variable, 'ANVIL_STUDIO_DIR');
  assert.equal(STUDIOS.odc.variable, 'ANVIL_ODC_STUDIO_DIR');
  assert.equal(isStudioDir('o11', 'D:\\S', f => f === o11('D:\\S')), true);
  assert.equal(isStudioDir('odc', 'D:\\S', f => f === o11('D:\\S')), false);
  assert.equal(isStudioDir('o11', '', () => true), false);
  assert.throws(() => isStudioDir('o12', 'D:\\S'), /Unknown Studio kind/);
});

test('the first valid folder wins and every attempt is recorded', async () => {
  const studios = new Set([o11('D:\\Connected'), o11('E:\\Running'), o11('F:\\Machine\\Service Studio')]);
  const variableWrong = await locateStudio('o11', deps(studios, { env: { ANVIL_STUDIO_DIR: 'C:\\not-a-studio' }, connection: () => 'D:\\Connected' }));
  assert.deepEqual([variableWrong.dir, variableWrong.source], ['D:\\Connected', 'connection']);
  assert.deepEqual(variableWrong.tried.map(t => [t.source, t.valid]), [['variable', false], ['connection', true]]);
  const variable = await locateStudio('o11', deps(studios, { env: { ANVIL_STUDIO_DIR: 'E:\\Running' }, connection: () => 'D:\\Connected' }));
  assert.equal(variable.source, 'variable');
  const running = await locateStudio('o11', deps(studios, { processes: async image => image === 'ServiceStudio.exe'
    ? [{ pid: 1, path: 'C:\\Old\\ServiceStudio.exe' }, { pid: 2, path: 'E:\\Running\\ServiceStudio.exe' }] : [] }));
  assert.deepEqual([running.dir, running.source, running.tried.length], ['E:\\Running', 'process', 2]);
});

test('the registry is read in HKLM 64, HKLM 32, HKCU 64, HKCU 32, then Program Files', async () => {
  const studios = new Set([o11('F:\\Machine\\Service Studio'), odc('C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio')]);
  const machine = deps(studios, { regQuery: async (key, value, view) => key.startsWith('HKLM') && view === 32 ? 'F:\\Machine' : null });
  const found = await locateStudio('o11', machine);
  assert.deepEqual([found.dir, found.source], ['F:\\Machine\\Service Studio', 'hklm']);
  const order = deps(new Set());
  const none = await locateStudio('odc', order);
  assert.deepEqual(order.queries, ['HKLM', 'HKLM', 'HKCU', 'HKCU'].map((hive, i) => hive + UNINSTALL + 'OutSystems ODC Studio|InstallLocation|' + (i % 2 ? 32 : 64)));
  assert.deepEqual([none.dir, none.source], [null, null]);
  assert.equal(none.tried.at(-1).dir, 'C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio');
  const user = await locateStudio('o11', deps(new Set([o11('G:\\User\\Service Studio')]), { regQuery: async key => key.startsWith('HKCU') ? 'G:\\User' : null }));
  assert.equal(user.source, 'hkcu');
  const fallback = await locateStudio('odc', deps(studios));
  assert.deepEqual([fallback.dir, fallback.source], ['C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio', 'programfiles']);
});

test('regQuery reads a value and answers null for a missing key (real registry, read only)', async () => {
  assert.match(await regQuery('HKCU\\Environment', 'TEMP', 64) ?? '', /temp/i);
  assert.equal(await regQuery('HKCU\\Software\\SSAM-Hybrid-locator-test-missing', 'InstallLocation', 64), null);
});
