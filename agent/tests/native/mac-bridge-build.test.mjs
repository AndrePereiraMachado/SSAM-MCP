import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { selectStudio } from '../../scripts/mac-build-bridges.mjs';

test('bridge build selects one diagnosed Studio inside its declared bundle', () => {
  const root = path.resolve('fixture/ODC Studio.app');
  const process = { lane: 'odc', version: '1.7.12.10367', path: path.join(root, 'Contents/MacOS/ODCStudio'), diagnostics: { ok: true } };
  const report = { studios: { odc: { installed: { dir: root } } }, processes: [process] };
  assert.equal(selectStudio(report, 'odc').version, '1.7.12.10367');
  assert.throws(() => selectStudio({ ...report, processes: [] }, 'odc'), /exactly one/);
  assert.throws(() => selectStudio({ ...report, processes: [process, process] }, 'odc'), /exactly one/);
  assert.throws(() => selectStudio({ ...report, processes: [{ ...process, path: root + '-other/ODCStudio' }] }, 'odc'), /outside/);
  assert.throws(() => selectStudio({ ...report, processes: [{ ...process, version: 'unknown' }] }, 'odc'), /version/);
});
