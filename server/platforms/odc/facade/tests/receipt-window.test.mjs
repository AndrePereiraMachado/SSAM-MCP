import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { patchesAppliedOf, normalizationsOf } from '../refusal-problems.mjs';

// Reproductions verify-3, verify-6 and verify-13: neighboring changed lines and a
// placeholder whose first changed character follows column 160. Keep the cases
// here so the regression does not depend on a local revision directory.
const neighboringLines = [
  `<input bind='Nome' placeholder="Nome completo do cliente"/>`,
  `<input bind='Rua' placeholder="Rua e numero da entrega"/>`,
];
const lateLine = '<textarea id="VerifySixDraftInput" class="df-input df-input-wide df-input-rounded df-input-shadow df-input-focus-ring" bind="DraftText" os-MaxLength="20000" os-Enabled="True" placeholder="Escreva sua mensagem aqui..."/>';
const quoted = line => line.replace(/placeholder="([^"]+)"/, (_all, prose) => `placeholder='"${prose}"'`);
const receipt = (from, to) => ({ code: 'HTML_INVALID', pointer: '/ops/1/data/html', phase: 'apply',
  patchRule: 'TEXT_LITERAL_QUOTED', reason: 'Literal prose', from, to, patchSha256: 'a'.repeat(64) });

function readableWindow(pair) {
  assert.notEqual(pair.from, pair.to, 'the actual change must remain visible');
  assert.ok(pair.from.length <= 160 && pair.to.length <= 160);
  assert.ok(pair.from.startsWith('...') && pair.to.startsWith('...'), 'a removed prefix is disclosed');
  assert.ok(pair.from.includes('placeholder="Escreva'));
  assert.ok(pair.to.includes(`placeholder='"Escreva`));
}

test('applied receipts focus oversized legacy lines around a late difference', () => {
  assert.ok(lateLine.indexOf('placeholder=') > 160);
  const original = receipt(lateLine, quoted(lateLine));
  readableWindow(patchesAppliedOf({ patchesApplied: [original] }).patchesApplied[0]);
  assert.equal(original.from, lateLine, 'the producer receipt is not mutated');
});

test('applied normalizations keep the same focused difference as the receipt', () => {
  const applied = receipt(lateLine, quoted(lateLine));
  const norm = { rule: applied.patchRule, path: applied.pointer, patchApplied: true, from: applied.from, to: applied.to };
  const shown = normalizationsOf({ normalizations: [norm] }).normalizations.items[0];
  readableWindow(shown);
  const patch = patchesAppliedOf({ patchesApplied: [applied] }).patchesApplied[0];
  assert.equal(shown.from, patch.from);
  assert.equal(shown.to, patch.to);
});

test('producer focused windows and neighboring per-problem lines pass through intact', () => {
  const focused = receipt('...maxlength="20000" placeholder="Escreva sua mensagem aqui..."/>',
    `...maxlength="20000" placeholder='"Escreva sua mensagem aqui..."'/>`);
  const entries = [focused, ...neighboringLines.map(line => receipt(line, quoted(line)))];
  const shown = patchesAppliedOf({ patchesApplied: entries }).patchesApplied;
  assert.deepEqual(shown, entries);
  const norms = entries.map(p => ({ rule: p.patchRule, patchApplied: true, from: p.from, to: p.to }));
  assert.deepEqual(normalizationsOf({ normalizations: norms }).normalizations.items, norms);
  assert.ok(shown[1].from.includes('Nome completo'));
  assert.ok(!shown[1].from.includes('Rua e numero'));
  assert.ok(shown[2].from.includes('Rua e numero'));
});

test('ordinary normalization values retain their existing display budget', () => {
  const source = { normalizations: [{ rule: 'ARGUMENT_RENAMED', from: 'a'.repeat(200), to: 'b'.repeat(200) }] };
  const shown = normalizationsOf(source).normalizations.items[0];
  assert.equal(shown.from, 'a'.repeat(157) + '...');
  assert.equal(shown.to, 'b'.repeat(157) + '...');
});
