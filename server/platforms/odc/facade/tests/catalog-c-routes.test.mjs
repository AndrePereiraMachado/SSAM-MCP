// Front C of the comprehensive catalog (references, integrations, diagnostics, operations), 2026-09-23.
// Pure part: the front-C fragments pass the contract check, every front-C type of the reconciled inventory is accounted
// (represented, excluded, gap or undetermined; zero unaccounted per lane and class, outside-object-root included), the
// 35 operational tools are represented by the capability that carries their contract, every legacy entry of front C is superseded, and the generated accounting matches its rules.
// Index part (lane CLI, no Studio, no reader, no worker; a private cache directory): the answers an LLM receives for
// the front-C intents select the right capability per lane, state evidence per lane without inheriting the other
// lane, surface the declared refusals and stay within the byte budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireBytes } from './fixtures/answer-wire.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCatalog } from '../catalog.mjs';
import { buildIndex, laneSources, discover } from '../discovery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..');
const BUDGET = 12000;

test('front C: contract check passes, zero unaccounted types per lane and class, tools classified, legacy superseded', () => {
  const report = checkCatalog({ root, front: 'C' });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  for (const a of report.accounting) {
    assert.equal(a.owner, 'C');
    assert.equal(a.unaccounted, 0, `${a.lane}: ${a.unaccounted} unaccounted`);
    for (const [cls, c] of Object.entries(a.byClass)) assert.equal(c.unaccounted, 0, `${a.lane} ${cls}`);
    // Interfaces outside the object roots are counted in their own block (request C-007), also fully accounted.
    assert.ok(a.outsideRoot?.types > 0, `${a.lane}: outside-object-root block`); assert.equal(a.outsideRoot.unaccounted, 0, `${a.lane}: outside-object-root unaccounted`);
  }
  assert.deepEqual(report.accounting.map(a => [a.lane, a.types]).sort(), [['o11', 97], ['odc', 177]]);
  assert.equal(report.tools.tools, 35); assert.equal(report.tools.classified, 35); assert.equal(report.tools.represented, 35);
  for (const l of [...report.legacy.capabilities, ...report.legacy.unavailable]) assert.ok(l.superseded, `legacy ${l.id} not superseded`);
  // REST roles lack a native type; client variables and agent action handlers retain front A's accounting.
  for (const w of report.warnings) assert.match(w.text, /on odc without native type|IClientVariable, owned by front A|C\/agents\.json ai\.agents: role 'tool' uses odc:OutSystems\.Model\.Logic\.IActionHandler, owned by front A/);
});

// The tools registered now are the input of the next reconciled inventory; the pinned one above (35 tools, 2026-09-23)
// predates ssam_map and changes only with that reconciliation. The map is a model tool carried by read.inspect.
test('front C: the live tool boundary carries ssam_map as a model tool, with its accounting rule ready', async () => {
  const { loadOperationalBoundary } = await import('../coverage-inventory.mjs');
  assert.deepEqual(loadOperationalBoundary().tools.filter(t => t.tool === 'ssam_map'), [{ tool: 'ssam_map', file: 'mcp.mjs', class: 'model' }]);
  assert.match(fs.readFileSync(path.join(root, 'docs', 'catalogo', 'C', 'contabilidade-c.mjs'), 'utf8'), /ssam_map: \['read\.inspect'/);
  const operations = JSON.parse(fs.readFileSync(path.join(here, '..', 'catalog', 'fragments', 'C', 'operations.json'), 'utf8'));
  const inspect = operations.capabilities.find(c => c.id === 'read.inspect');
  assert.match(inspect.route.operation, /^both, first: ssam map .* \/ MCP ssam_map \{lane, target/);
  assert.match(inspect.guidance, /^To read an application, start with ssam map \/ ssam_map; then inspect subtrees, properties and usages by @key with the expected sha256/);
  for (const [file, lane] of [['discovery-capabilities.json', 'odc'], ['discovery-capabilities-o11.json', 'o11']]) {
    const entries = JSON.parse(fs.readFileSync(path.join(here, '..', file), 'utf8')).routes.reader.entries;
    assert.ok(entries[0].startsWith(`.\\ssam map --lane ${lane} `), file); assert.ok(entries[1].startsWith(`ssam_map {lane:"${lane}"`), file);
  }
});

test('front C: the committed accounting.json is exactly what the reviewable rules produce', () => {
  const out = execFileSync(process.execPath, [path.join(root, 'docs', 'catalogo', 'C', 'contabilidade-c.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /matches the rules/);
});

// ---- the real answers, on a private index built with the lane CLI of this checkout
const indexes = {};
async function ask(lane, intent, budgetBytes = BUDGET) {
  const sources = indexes[lane];
  const answer = await discover({ lane, intent, sources, budgetBytes });
  assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 400));
  assert.ok(wireBytes(answer, { budgetBytes: budgetBytes }) <= budgetBytes, `${lane} '${intent}': ${answer.size.bytes} > ${budgetBytes}`);
  return answer;
}
const direct = a => a.matches.filter(m => m.via === 'match').map(m => m.id);
const unavailable = a => (a.unavailable ?? []).map(u => u.id);
const role = (a, id, op, r) => a.matches.find(m => m.id === id)?.operations?.[op]?.roles?.[r];

for (const lane of ['odc', 'o11']) {
  const base = laneSources(lane);
  const skip = !fs.existsSync(base.cli) && `the ${lane} CLI is not built in this checkout`;
  test(`front C (${lane}): the index builds with the front-C fragments and the legacy ids leave the lane`, { skip }, async () => {
    indexes[lane] = { ...base, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), `catalog-c-${lane}-`)) };
    const { index } = await buildIndex(lane, { sources: indexes[lane], rebuild: true, persist: true });
    const ids = index.capabilities.map(c => c.id);
    for (const id of ['integration.rest-consume', 'integration.rest-expose', 'timer.schedule', 'security.settings-roles', 'read.inspect', 'read.discover', 'deliver.job', 'data.records', 'diagnostic.troubleshoot', 'ops.debugger', 'ops.environment']) assert.ok(ids.includes(id), `${id} missing on ${lane}`);
    for (const legacy of ['logic.rest-consume', 'logic.rest-expose', 'logic.timer', 'data.setting']) assert.ok(!ids.includes(legacy), `${legacy} still on ${lane}`);
    const onlyOdc = ['deliver.feature', 'deliver.publish', 'ops.references-refresh', 'ops.studio-session', 'ops.portal'];
    const onlyO11 = ['process.bpt', 'reference.producer-import'];
    for (const id of onlyOdc) assert.equal(ids.includes(id), lane === 'odc', id);
    for (const id of onlyO11) assert.equal(ids.includes(id), lane === 'o11', id);
    const u = index.unavailable.map(x => x.id);
    assert.ok(u.includes('integration.rest-callbacks'), `integration.rest-callbacks on ${lane}`);
    // SOAP (lane restsoap): a capability on O11 (op soap through o11_deliver), a declared gap on ODC; OpenAPI import on both.
    assert.equal(ids.includes('integration.soap'), lane === 'o11', 'integration.soap');
    assert.equal(u.includes('integration.soap-odc'), lane === 'odc', 'integration.soap-odc');
    assert.ok(!u.includes('integration.soap'), 'integration.soap is no longer a gap');
    assert.ok(ids.includes('integration.rest-import'), 'integration.rest-import');
    assert.equal(u.includes('process.odc-workflow'), lane === 'odc'); assert.equal(u.includes('reference.import-headless-odc'), lane === 'odc');
    assert.equal(u.includes('deliver.publish-o11'), lane === 'o11'); assert.equal(u.includes('integration.sap'), lane === 'o11');
    for (const legacy of ['bpt-process', 'rest-credentials-in-model', 'reference-import-headless', 'agents']) assert.ok(!u.includes(legacy), legacy);
  });

  test(`front C (${lane}): consuming REST selects integration.rest-consume with per-lane evidence`, { skip }, async () => {
    const a = await ask(lane, 'consumir uma API REST com POST, header e estrutura de resposta aninhada');
    assert.ok(direct(a).includes('integration.rest-consume'), JSON.stringify(direct(a)));
    const m = a.matches.find(x => x.id === 'integration.rest-consume');
    assert.ok(m.focus, 'shared capability carries focus');
    const header = role(a, 'integration.rest-consume', 'create', 'client header');
    if (header) assert.equal(header.status, 'applicable');
    // The credential refusal is ODC-only: never projected on O11. Declared refusals survive the 12000-byte budget
    // (request C-003, resolved in the engine).
    const ask2 = await ask(lane, 'gravar username e password do cliente REST');
    assert.equal(unavailable(ask2).includes('integration.rest-credentials-in-model'), lane === 'odc');
  });

  test(`front C (${lane}): timers and settings/roles answer with the lane's own native types and statuses`, { skip }, async () => {
    const t = await ask(lane, 'renomear o timer noturno e mudar o agendamento');
    assert.ok(direct(t).includes('timer.schedule'));
    const rename = role(t, 'timer.schedule', 'rename', 'timer');
    assert.ok(rename, 'rename is in focus');
    assert.equal(rename.status, lane === 'odc' ? 'applicable' : 'undetermined');
    const s = await ask(lane, 'criar um role e restringir a tela, e uma setting secreta');
    assert.ok(direct(s).includes('security.settings-roles'));
    const native = s.matches.find(x => x.id === 'security.settings-roles').native?.find(n => n.role === 'application role')?.native
      ?? s.matches.find(x => x.id === 'security.settings-roles').operations?.create?.roles?.['application role']?.native;
    if (native) assert.equal(native, lane === 'odc' ? 'OutSystems.Model.Logic.IAppRole' : 'OutSystems.Model.Logic.IRole');
  });

  test(`front C (${lane}): processes and references follow the lane (O11 capabilities, ODC declared refusals)`, { skip }, async () => {
    const p = await ask(lane, 'criar um processo BPT com atividade humana de aprovacao');
    if (lane === 'o11') assert.ok(direct(p).includes('process.bpt'), JSON.stringify(direct(p)));
    else { assert.ok(!direct(p).includes('process.bpt')); assert.ok(unavailable(p).includes('process.odc-workflow'), JSON.stringify(unavailable(p))); }
    const r = await ask(lane, 'adicionar referencia ao modulo produtor e importar a action publica');
    if (lane === 'o11') assert.ok(direct(r).includes('reference.producer-import'), JSON.stringify(direct(r)));
    else assert.ok(unavailable(r).includes('reference.import-headless-odc'), JSON.stringify(unavailable(r)));
  });

  test(`front C (${lane}): publication, gaps and diagnostics`, { skip }, async () => {
    const pub = await ask(lane, 'publicar o modulo depois do merge');
    if (lane === 'odc') assert.ok(direct(pub).includes('deliver.publish'));
    else assert.ok(unavailable(pub).includes('deliver.publish-o11'), JSON.stringify(unavailable(pub)));
    const soap = await ask(lane, 'consumir um web service SOAP a partir do WSDL');
    if (lane === 'o11') assert.ok(direct(soap).includes('integration.soap'), JSON.stringify(direct(soap)));
    else { assert.ok(unavailable(soap).includes('integration.soap-odc'), JSON.stringify(unavailable(soap))); assert.ok(!direct(soap).includes('integration.soap')); }
    const diag = await ask(lane, 'diagnosticar um merge recusado com base drift e reconciliar um resultado incerto');
    assert.ok(direct(diag).includes('diagnostic.troubleshoot'), JSON.stringify(direct(diag)));
    // Platform APIs: the ODC Portal on ODC; on O11 a declared refusal, never the ODC tools.
    const portal = await ask(lane, 'ler os deployments do portal');
    if (lane === 'odc') assert.ok(direct(portal).includes('ops.portal'), JSON.stringify(direct(portal)));
    else { assert.ok(unavailable(portal).includes('ops.portal-o11'), JSON.stringify(unavailable(portal))); assert.ok(!direct(portal).includes('ops.debugger')); }
  });

  test(`front C (${lane}): native agents are ODC-only; external connections and global events retain their limits`, { skip }, async () => {
    const a = await ask(lane, 'criar um agente de IA');
    if (lane === 'odc') {
      assert.ok(direct(a).includes('ai.agents'), JSON.stringify(direct(a)));
      assert.ok(!unavailable(a).includes('ai.agents'));
      const connections = await ask(lane, 'create mcp connection');
      assert.ok(unavailable(connections).includes('ai.agent-connections'), JSON.stringify(unavailable(connections)));
    } else {
      assert.ok(unavailable(a).includes('ai.agents-o11'), JSON.stringify(unavailable(a)));
      assert.ok(!direct(a).includes('ai.agents'));
    }
    const g = await ask(lane, 'disparar um evento global para outra app');
    assert.ok(unavailable(g).includes(lane === 'odc' ? 'event.global-events' : 'event.global-events-o11'), JSON.stringify(unavailable(g)));
    assert.ok(!direct(g).includes('ops.environment'), 'the word "app" does not select the environment checks');
  });
}

test('front C (odc): refreshing the references of a changed producer reaches the live refresh operation', { skip: !fs.existsSync(laneSources('odc').cli) && 'the odc CLI is not built' }, async () => {
  if (!indexes.odc) return;
  const r = await ask('odc', 'atualizar as referencias de um produtor alterado');
  assert.ok(direct(r).includes('ops.references-refresh'), JSON.stringify(r.matches.map(m => m.id + ':' + m.via)));
  assert.ok(unavailable(r).includes('reference.import-headless-odc'));
});
