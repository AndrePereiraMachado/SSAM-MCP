import './fixtures/isolated-profile.mjs';
// English-only, the search half for the suite jobs (review english-junction round 1, F1 with the rule of F2): the prose
// of the suite jobs (description, op _why, expected-message why) is English since 16/10/2026, and a Portuguese request
// keeps finding the jobs it found when that prose was Portuguese: the folded words of the old prose are search-only
// aliases (kernel/tests/jobs-search-aliases.json, search-aliases.mjs), added to what the recipes and ssam_discover match.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { odcRecipe } from '../ssam-reference.mjs';
import { jobSearchAlias } from '../search-aliases.mjs';
import { portugueseIn } from './fixtures/portuguese-text.mjs';

const kernel = fileURLToPath(new URL('../../../../kernel/', import.meta.url));
// What the ODC recipe answered for each query over the Portuguese prose of 8a399ca0 (before the translation).
const BEFORE = {
  'entidade estatica': ['static-entity-lifecycle', 'static-entity'],
  'variavel cliente': ['external-site-and-events', 'platform-events-lifecycle', 'rest-consume-lifecycle', 'security-settings', 'structure-list-type'],
  'evento bloco': ['block-event-lifecycle', 'block-events-mandatory', 'block-events-nested', 'block-events-two-instances', 'block-events-types', 'block-events', 'block-reuse', 'cat-b-block-event-delete', 'cat-b-screen-lifecycle', 'html-visual-block'],
  'tela detalhe': ['action-edit-lifecycle', 'block-events-mandatory', 'block-reuse', 'cat-b-widget-gallery'],
  'publicar': ['resource-script-lifecycle', 'theme-css-reload'],
  'papel': ['delete-platform-consumers', 'delete-screen'],
  'criar entidade': ['action-edit-lifecycle', 'block-event-lifecycle', 'cat-b-choice-table', 'edit-inherited-data', 'entity-lifecycle', 'platform-events-lifecycle', 'rest-consume-lifecycle', 'service-action', 'static-entity-lifecycle', 'structure-lifecycle'],
  'apagar atributo': ['delete-attribute-no-consumers', 'delete-data-consumers', 'delete-entity-whole', 'entity-lifecycle', 'entity-refactor', 'static-record-refactor', 'structure-refactor'],
};

test('job search: each Portuguese recipe query finds the jobs it found before the translation; the descriptions served are English', () => {
  for (const [find, names] of Object.entries(BEFORE)) {
    const found = odcRecipe(kernel, { find });
    assert.ok(Array.isArray(found), find);
    assert.deepEqual(found.map(d => d.name), names, find);
    for (const d of found) assert.equal(portugueseIn(d.description.replace(/(^|[\s(:,=])'[^'\n]+'(?=[\s.,;:)!?]|$)/g, ' ')), null, find + ': ' + d.name + ' serves English');
  }
});

test('job search: without the aliases the same queries lose jobs (the aliases are what keeps them), and an alias is never served', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'job-search-'));
  try {
    fs.mkdirSync(path.join(tmp, 'tests', 'jobs-odc'), { recursive: true });
    for (const f of fs.readdirSync(path.join(kernel, 'tests', 'jobs-odc')).filter(x => x.endsWith('.json'))) fs.copyFileSync(path.join(kernel, 'tests', 'jobs-odc', f), path.join(tmp, 'tests', 'jobs-odc', f));
    let lost = 0;
    for (const [find, names] of Object.entries(BEFORE)) lost += names.length - odcRecipe(tmp, { find }).filter(d => names.includes(d.name)).length;
    assert.ok(lost > 0, 'the English prose alone finds fewer jobs: ' + lost);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const alias = jobSearchAlias(kernel, 'jobs-odc', 'block-events');
  assert.ok(alias && alias.words.split(' ').includes('evento'), 'the alias holds the old words');
  for (const d of odcRecipe(kernel, { find: 'evento bloco' })) assert.ok(!JSON.stringify(d).includes(alias.words), 'never served');
});

// ssam_discover ranks the related jobs, picks their notes and the proven example on the text the jobs had before the
// translation (the same answer as bb12d2b3, which served them in Portuguese; 56 of 56 answers equal on the reviewer's
// intents). The index needs the lane CLI, as every discovery test.
import { discover, laneSources } from '../discovery.mjs';
const ON_BB12D2B3 = [
  { lane: 'o11', intent: 'criar uma tela de lista de pedidos com tabela', relatedJobs: ['cat-b-traditional-gallery', 'block-events-types-reactive', 'cat-b-app-events'], provenExample: 'screen-reactive' },
  { lane: 'o11', intent: 'criar um bloco com evento', relatedJobs: ['block-events-two-instances-reactive', 'cat-b-traditional-gallery', 'rename-name-property'], provenExample: 'block-events-reactive' },
  { lane: 'odc', intent: 'criar tela de listagem de pedidos com tabela e filtro', relatedJobs: ['examples/ecommerce-all', 'aggregate-full', 'cat-b-widget-gallery'], provenExample: 'examples/cap-screen-spec-typical' },
  { lane: 'odc', intent: 'criar uma tela de lista de pedidos com tabela', relatedJobs: ['examples/usage-cart-line-quantity-typical', 'action-edit-lifecycle', 'block-event-lifecycle'], provenExample: 'screen-block-edit' },
];
for (const want of ON_BB12D2B3) {
  const sources = laneSources(want.lane);
  test(`job search (${want.lane}): "${want.intent}" ranks the related jobs and picks the proven example it picked before the translation`, { skip: !fs.existsSync(sources.cli) && 'the lane CLI is not built' }, async () => {
    const a = await discover({ lane: want.lane, intent: want.intent, budgetBytes: 400000, sources });
    assert.deepEqual((a.relatedJobs ?? []).map(r => r.job), want.relatedJobs);
    assert.equal(a.provenExample?.job, want.provenExample);
    for (const r of a.relatedJobs ?? []) assert.equal(portugueseIn(r.description.replace(/(^|[\s(:,=])'[^'\n]+'(?=[\s.,;:)!?]|$)/g, ' ')), null, r.job + ': its description is served in English');
  });
}