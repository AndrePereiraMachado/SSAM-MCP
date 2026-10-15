// ssam_discover and the rest-consume generator for the request of the 2026-10-13 gate (consume 4 public REST APIs and expose
// service actions). The generator is offered only while approved (generators.mjs GENERATOR_APPROVAL, owner rule 2026-10-13):
// pending (the declared state), the work packet and the REST capability answer as before the generator existed (no
// next.generator, no rest-consume op, the capability's text of 8ddf39da); approved, the packet delivers the generator op
// in next.deliver with its card in next.generator, and integration.rest-consume leads with it. Needs the lane CLI (the
// index reads `api --op` and the jobs); each state builds its own index (the states are part of its identity).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discover, laneSources } from '../discovery.mjs';
import { withGeneratorStates, GENERATOR_APPROVAL } from '../generators.mjs';

const GATE = 'Terceiro pedido: no VisitaCertaPortao_IS integre estes REST públicos e exponha service actions para cada um: feriados nacionais (BrasilAPI https://brasilapi.com.br/api/feriados/v1/{ano}), câmbio (Frankfurter https://api.frankfurter.app/latest?from=BRL), estados e municípios (IBGE https://servicodados.ibge.gov.br/api/v1/localidades) e países (REST Countries https://restcountries.com/v3.1/alpha/{codigo}). Publique ao final.';

for (const lane of ['o11', 'odc']) {
  test(`[${lane}] the gate's request with rest-consume pending: no generator, the REST capability as before it`, async t => {
    if (!fs.existsSync(laneSources(lane).cli)) { t.skip(`the ${lane} CLI is not built`); return; }
    assert.equal(GENERATOR_APPROVAL['rest-consume'].state, 'blind-test-pending');
    const sources = { ...laneSources(lane), cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), `rest-consume-discover-${lane}-`)) };
    t.after(() => fs.rmSync(sources.cacheDir, { recursive: true, force: true }));
    const packet = await discover({ lane, intent: GATE, packet: true, sources });
    assert.equal(packet.ok, true, JSON.stringify(packet).slice(0, 600));
    assert.equal(packet.next.generator, undefined, JSON.stringify(packet.next).slice(0, 800));
    assert.doesNotMatch(JSON.stringify(packet), /"op":"rest-consume"|GENERATOR FIRST|rest-consume-generate/);
    const plain = await discover({ lane, intent: GATE, sources });
    const text = JSON.stringify(plain);
    assert.match(text, /integration\.rest-consume/);
    assert.doesNotMatch(text, /GENERATOR FIRST|rest-consume-generate|rest-consume-auth/);
  });

  test(`[${lane}] the gate's request with rest-consume approved: the packet delivers rest-consume and the REST capability leads with it`, async t => {
    if (!fs.existsSync(laneSources(lane).cli)) { t.skip(`the ${lane} CLI is not built`); return; }
    const sources = { ...laneSources(lane), cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), `rest-consume-discover-${lane}-`)) };
    t.after(() => fs.rmSync(sources.cacheDir, { recursive: true, force: true }));
    await withGeneratorStates({ 'rest-consume': { state: 'approved' } }, async () => {
      const packet = await discover({ lane, intent: GATE, packet: true, sources });
      assert.equal(packet.ok, true, JSON.stringify(packet).slice(0, 600));
      assert.equal(packet.next.generator?.op, 'rest-consume', JSON.stringify(packet.next).slice(0, 800));
      assert.equal(packet.next.deliver.arguments.job.ops[0].op, 'rest-consume');
      const plain = await discover({ lane, intent: GATE, sources });
      const text = JSON.stringify(plain);
      assert.match(text, /integration\.rest-consume/);
      assert.match(text, /GENERATOR FIRST: \{\\"op\\":\\"rest-consume\\"/);
      // The proven example the capability cites first: the lane's rest-consume-generate job.
      assert.match(text, /rest-consume-generate/);
    });
  });
}
