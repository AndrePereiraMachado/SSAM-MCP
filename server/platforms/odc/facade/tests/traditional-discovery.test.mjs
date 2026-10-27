import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../discovery.mjs';
import { snapshotSources } from './fixtures/discovery-results.mjs';

test('an unknown-language request retains the runtime catalog route instead of denying UI capabilities', async()=>{
 const answer=await discover({lane:'o11',intent:'一度に20件ずつ表示してください',packet:true,sources:snapshotSources('o11'),budgetBytes:14000});
 assert.equal(answer.uiCatalog.tool,'ssam_discover');
 assert.match(answer.uiCatalog.arguments.expand,/o11-traditional/);
 assert.match(answer.uiCatalog.rule,/original language/);
});

test('Traditional packet offers the native recipe and official components, never Reactive UI examples', async () => {
  const answer = await discover({ lane: 'o11', intent: 'criar app Traditional com RichWidgets Popup_Editor', packet: true,
    sources: snapshotSources('o11'), budgetBytes: 28672 });
  assert.equal(answer.text.id, 'ui.traditional-screen');
  assert.ok(answer.text.taskPlan.components.some(c => c.library === 'RichWidgets'));
  assert.equal(answer.example.for, 'ui.traditional-screen');
  assert.doesNotMatch(JSON.stringify(answer.example), /IMobileScreen|IPopup|Reactive/);
  assert.ok(answer.capabilities.items.every(c => !c.id.startsWith('ui.') || c.id.startsWith('ui.traditional-') || ['ui.theme-css', 'ui.script-resource'].includes(c.id)));
});

test('small Traditional task packet keeps every requested behavior and recovery to full contracts', async () => {
  // The kind word names the object (F4, app-kinds.mjs kindReading): "na tela Traditional", never "em Traditional" alone.
  const answer = await discover({ lane:'o11', intent:'Coloque paginação, permita ordenar e mostre mensagem ao salvar na tela Traditional',packet:true,sources:snapshotSources('o11'),budgetBytes:14000 });
  assert.deepEqual(answer.text.taskPlan.tasks.map(t=>t.id),['pagination','sorting','feedback']);
  assert.ok(answer.text.taskPlan.components.some(c=>c.name==='List_SortColumn'));
});
