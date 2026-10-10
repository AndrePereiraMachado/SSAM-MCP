// studio-open.mjs: an asset name with a space reaches the bridge as its key, never as two words (the bridge reads the
// second word as a local .oml path). Pure: no Studio, no bridge, no file.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOpenTarget } from '../studio-open.mjs';

const catalog = {
  tenant: 'personal.outsystems.dev',
  modules: [{ name: 'Escala Viva', key: 'KwiD3Tgt3kOKgCu8elGE4g' }, { name: 'Orders', key: 'o1' }],
  otherTenants: [{ tenant: 'other.outsystems.dev', modules: [{ name: 'Sinal UnimedUITheme', key: 'qclhM3yjX06Cr_HZbsHyZw' }] }],
};
// The bridge line the pipe writes (odc-pipe.mjs) and how Bridge.Open splits it (StartupHook.cs Open).
const bridgeOpen = args => args.map(String).join(' ').split(' ').slice(1).filter(Boolean);

test('a module name with spaces opens by its asset key, as a single bridge argument', () => {
  const open = resolveOpenTarget('Escala Viva', catalog);
  assert.deepEqual(open, { ok: true, target: 'KwiD3Tgt3kOKgCu8elGE4g', resolvedFrom: 'Escala Viva' });
  assert.deepEqual(bridgeOpen(['open', open.target]), ['KwiD3Tgt3kOKgCu8elGE4g']);
});

test('names with spaces resolve across tenants, case-insensitively and trimmed', () => {
  assert.equal(resolveOpenTarget('Sinal UnimedUITheme', catalog).target, 'qclhM3yjX06Cr_HZbsHyZw');
  assert.equal(resolveOpenTarget('  escala viva ', catalog).target, 'KwiD3Tgt3kOKgCu8elGE4g');
  assert.equal(resolveOpenTarget('Sinal UnimedUITheme', { modules: [], otherTenants: { other: catalog.otherTenants[0] } }).target, 'qclhM3yjX06Cr_HZbsHyZw');
});

test('names without spaces and keys pass through untouched', () => {
  assert.deepEqual(resolveOpenTarget('Orders', catalog), { ok: true, target: 'Orders' });
  assert.deepEqual(resolveOpenTarget('KwiD3Tgt3kOKgCu8elGE4g', null), { ok: true, target: 'KwiD3Tgt3kOKgCu8elGE4g' });
});

test('an unknown or ambiguous name with spaces never reaches the bridge', () => {
  for (const c of [null, catalog]) {
    const open = resolveOpenTarget('Escala Morta', c);
    assert.equal(open.ok, false); assert.equal(open.gate, 'unknown_module'); assert.equal(open.outcome, 'not_sent');
    assert.equal(open.continuation.tool, 'studio_assets');
  }
  const twice = { modules: [{ name: 'Escala Viva', key: 'a' }], otherTenants: [{ modules: [{ name: 'Escala Viva', key: 'b' }] }] };
  const open = resolveOpenTarget('Escala Viva', twice);
  assert.equal(open.ok, false); assert.equal(open.gate, 'ambiguous_module');
  assert.deepEqual(open.continuation, { tool: 'studio_open', arguments: { module: 'a' }, why: 'Choose the key of the intended asset.' });
});
