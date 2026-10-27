// T3, paging that does not page: what the facade teaches. The logic grammar card never teaches START on a server action (the
// runtime ignores it there and the kernel refuses it: LOGIC_START_SERVER_IGNORED) and says how a screen and a server action
// page; every paging pattern of the OutSystems UI catalog (an input StartIndex and an event with NewStartIndex, derived from
// the catalog) carries the data-source step the kernel checks (PAGINATION_SOURCE_UNBOUND), at the full and the brief level.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CODE_FORMS_EXACT, EXAMPLE_LOGIC, grammarCard } from '../ssam-code.mjs';
import { loadOsuiCatalog, osuiExpansion, isPagingPattern, PAGING_WIRING } from '../osui-catalog.mjs';

test('the logic card pages a server action by SQL OFFSET and never teaches START on it', () => {
  for (const text of EXAMPLE_LOGIC.filter(t => /^(server|service) action /m.test(t)))
    assert.doesNotMatch(text, /\bMAX \S+ START \S+/, 'a server action example pages by START: ' + text.split('\n')[1]);
  assert.match(CODE_FORMS_EXACT.logic.pagination, /OFFSET @\w+ ROWS FETCH NEXT @\w+ ROWS ONLY/);
  assert.ok(EXAMPLE_LOGIC.join('\n').includes(CODE_FORMS_EXACT.logic.pagination));
  for (const lane of ['o11', 'odc']) {
    const rule = grammarCard('logic', lane).card.rules.find(r => r.startsWith('Pagination:'));
    assert.ok(rule, lane);
    assert.match(rule, /LOGIC_START_SERVER_IGNORED/);
    assert.match(rule, /os-StartIndex="StartIndex"/);
    assert.match(rule, /TotalCount = <Aggregate>\.Count/);
    assert.match(rule, /assigns StartIndex = NewStartIndex then refresh/);
  }
});

test('every paging pattern of the catalog carries the data-source step, and no other pattern does', () => {
  const catalog = loadOsuiCatalog();
  const paging = new Set();
  for (const library of catalog.libraries) for (const p of library.patterns) if (isPagingPattern(p)) paging.add(p.name);
  assert.ok(paging.has('Pagination'), 'the catalog has Pagination as a paging pattern');
  for (const lane of ['o11', 'odc'])
    for (const name of paging) {
      const full = osuiExpansion(lane, name);
      if (full.error) continue;
      for (const library of full.libraries) for (const p of library.patterns) {
        assert.equal(p.wiring, PAGING_WIRING, `${lane} ${name} full`);
        assert.match(p.wiring, /PAGINATION_SOURCE_UNBOUND/);
      }
      const brief = osuiExpansion(lane, name, { capBytes: Buffer.byteLength(JSON.stringify(full), 'utf8') - 1 });
      if (brief.level === 'brief') for (const library of brief.libraries) for (const p of library.patterns) assert.equal(p.wiring, PAGING_WIRING, `${lane} ${name} brief`);
    }
  const tabs = osuiExpansion('o11', 'Tabs');
  for (const library of tabs.libraries) for (const p of library.patterns) assert.equal(p.wiring, undefined);
});
