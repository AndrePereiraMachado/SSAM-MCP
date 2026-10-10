// The comprehensive-catalog mechanism (M0, 2026-09-23): fragments of the three fronts compose with the shared
// descriptor into the SAME index (no second catalog), the pure check refuses what the contract forbids, the accounting
// follows the pinned ownership, and the real index build checks fragment pointers and native types against the lane
// CLI and runtime. The fixture fragments (tests/fixtures/catalog/fragments) are mechanism probes, not coverage claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCatalog, composeCatalog, applySupersedes, textSha256, FRAGMENT_SCHEMA } from '../catalog.mjs';
import { buildIndex, laneSources, discover, projectShared } from '../discovery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const facade = path.resolve(here, '..');
const root = path.resolve(facade, '..', '..', '..');
const fixtures = path.join(here, 'fixtures', 'catalog', 'fragments');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
function fragmentsDir(files) {
  const dir = temp();
  for (const [rel, value] of Object.entries(files)) { const file = path.join(dir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
  return dir;
}
const fixture = front => readJson(path.join(fixtures, front, 'm0-probe.json'));

test('the three fixture fragments compose and pass the pure check, with accounting per lane and front', () => {
  const report = checkCatalog({ root, fragmentsDir: fixtures });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.deepEqual(report.fragments.map(f => f.front), ['A', 'B', 'C']);
  const a = report.accounting.find(x => x.lane === 'odc' && x.owner === 'A');
  // The shared data capabilities already represent ten A types on ODC; the fixture adds IAssignNode and IAssignment.
  assert.equal(a.represented, 12); assert.equal(a.classified.undetermined, 1);
  assert.equal(a.types, a.represented + a.classified.undetermined + a.unaccounted);
  assert.equal(report.pendingRequires.length, 1); assert.equal(report.pendingRequires[0].id, 'logic.m0-probe-missing');
  assert.ok(report.info.some(i => i.text.includes('logic.m0-probe-assign') && i.text.includes('now exists')));
  assert.equal(report.legacy.capabilities.find(c => c.id === 'read.inspect').superseded, 'read.m0-probe-inspect');
  assert.equal(report.tools.classified, 1);
});

test('the pure check refuses what the contribution contract forbids, naming the front and the rule', () => {
  const a = fixture('A');
  const bad = structuredClone(a.capabilities[0]);
  const dir = fragmentsDir({
    'A/dup.json': { ...a, capabilities: [a.capabilities[0], { ...a.capabilities[0] }], coverage: [] },
    'B/wrong-front.json': { ...fixture('B'), front: 'C', capabilities: [], unavailable: [] },
    'B/rules.json': { schemaVersion: FRAGMENT_SCHEMA, front: 'B', title: 't', reviewedAt: '2026-09-23',
      capabilities: [{ ...bad, id: 'logic.not-a-ui-id', operations: { read: { route: 'x', roles: { 'assign node': { odc: { status: 'applicable' } }, ghost: { odc: { status: 'undetermined' } } } } }, depends: ['logic.does-not-exist'] },
        { ...bad, id: 'ui.takes-a-legacy', supersedes: ['logic.aggregate'], operations: {} }],
      coverage: [{ type: 'odc:OutSystems.Model.Data.IEntityDiagram', status: 'gap', applicability: 'applicable', reason: 'r' }, { type: 'odc:No.Such.IType', status: 'excluded', applicability: 'not-applicable', reason: 'r', origin: 'o' }] },
    'C/broken.json': '{ not json',
    'C/cycle.json': { schemaVersion: FRAGMENT_SCHEMA, front: 'C', title: 't', reviewedAt: '2026-09-23', capabilities: [
      { id: 'integration.m0-x', category: 'integration', title: 'x', keywords: ['x'], summary: 's', route: { kind: 'job' }, depends: ['integration.m0-y'] },
      { id: 'integration.m0-y', category: 'integration', title: 'y', keywords: ['y'], summary: 's', route: { kind: 'job' }, depends: ['integration.m0-x'] }] },
  });
  const report = checkCatalog({ root, fragmentsDir: dir });
  const text = report.errors.map(e => `[${e.front}] ${e.text}`).join('\n');
  assert.equal(report.ok, false);
  for (const expected of [
    /\[A\] fragment A\/dup\.json: duplicate capability id logic\.m0-probe-assign/,
    /\[B\] fragment B\/wrong-front\.json: front 'C' differs from its directory 'B'/,
    /\[C\] fragment C\/broken\.json: not JSON/,
    /\[B\] B\/rules\.json logic\.not-a-ui-id: id must start with ui\./,
    /read\/assign node\/odc: applicable without a proof job/,
    /operation read role 'ghost' is not a declared element role/,
    /unknown dependency logic\.does-not-exist on odc\/o11 \(a pending cross-front need goes in requires/,
    /ui\.takes-a-legacy: supersedes logic\.aggregate, owned by front A/,
    /coverage odc:OutSystems\.Model\.Data\.IEntityDiagram: owned by front A/,
    /coverage odc:OutSystems\.Model\.Data\.IEntityDiagram: gap needs origin/,
    /coverage odc:No\.Such\.IType: not in the pinned inventory/,
    /\[C\] dependency cycle on odc: integration\.m0-x > integration\.m0-y > integration\.m0-x/,
  ]) assert.match(text, expected);
  assert.ok(report.errors.every(e => ['A', 'B', 'C', 'integrator'].includes(e.front)));
  assert.equal(checkCatalog({ root, fragmentsDir: dir, front: 'A' }).errors.every(e => e.front === 'A'), true);
});

test('a keyword is a string or an anchored form {form, with?, without?}: the pure check accepts it and refuses a malformed one, naming the front and the rule (request A-006)', () => {
  const a = fixture('A'); const cap = structuredClone(a.capabilities[0]);
  cap.keywords = ['m0probeassign', { form: 'false branch', with: ['if', 'if node'], without: ['widget'] }, { form: 'delete the unused action', without: ['toolbar'] }];
  const unavailable = [{ id: 'logic.m0-probe-refusal', keywords: [{ form: 'screen preparation', without: ['pwa'] }], reason: 'r', evidence: 'fixture' }];
  assert.equal(checkCatalog({ root, fragmentsDir: fragmentsDir({ 'A/anchored.json': { ...a, capabilities: [cap], unavailable, coverage: [] } }) }).ok, true);
  const bad = { ...cap, keywords: ['m0probeassign', { with: ['if'] }, { form: 'branch' }, { form: 'branch', with: [] }, { form: 'branch', with: ['if', ' '] }, { form: 'branch', without: [3] }, { form: 'branch', with: ['if'], near: ['x'] }, 7, ''] };
  const report = checkCatalog({ root, fragmentsDir: fragmentsDir({ 'A/anchored.json': { ...a, capabilities: [bad], unavailable: [{ ...unavailable[0], keywords: [{ form: 'screen preparation', with: 'if' }] }], coverage: [] } }) });
  const text = report.errors.map(e => `[${e.front}] ${e.text}`).join('\n');
  assert.equal(report.ok, false);
  for (const expected of [/\[A\] A\/anchored\.json logic\.m0-probe-assign: anchored keyword without a form: \{"with":\["if"\]\}/, /anchored keyword "branch" has neither with nor without \(write it as a plain string\)/,
    /anchored keyword "branch": with must be a non-empty list of terms/, /anchored keyword "branch": empty or non-string with term " "/, /anchored keyword "branch": empty or non-string without term 3/,
    /anchored keyword "branch": unknown field\(s\) near/, /keyword 7 is neither a string nor an anchored form/, /logic\.m0-probe-assign: empty keyword/,
    /\[A\] A\/anchored\.json unavailable logic\.m0-probe-refusal: anchored keyword "screen preparation": with must be a non-empty list of terms/]) assert.match(text, expected);
  // The pure check tokenizes as the build does: a form or term left without a word (stopwords, one-letter words), an
  // entry that can never count and a null side are refused here, not only by the index build.
  const never = { ...cap, keywords: ['m0probeassign', { form: 'uso', with: ['m0y'] }, { form: 'branch', with: ['de', 'if'] }, { form: 'excluir a action', without: ['action'] }, { form: 'branch', with: ['if'], without: ['if'] }, { form: 'branch', without: null, with: ['if'] }] };
  const tokenized = checkCatalog({ root, fragmentsDir: fragmentsDir({ 'A/anchored.json': { ...a, capabilities: [never], coverage: [] } }) });
  const tokenText = tokenized.errors.map(e => `[${e.front}] ${e.text}`).join('\n');
  for (const expected of [/\[A\] A\/anchored\.json logic\.m0-probe-assign: anchored keyword "uso": the form keeps no word after tokenization/, /anchored keyword "branch": with term "de" keeps no word after tokenization/,
    /anchored keyword "excluir a action": without term "action" is said by the form itself/, /anchored keyword "branch": term "if" is in both with and without/, /anchored keyword "branch": without must be a non-empty list of terms/]) assert.match(tokenText, expected);
  // A term that is a synonym canonical is said by every variant of its group on the lane: the check lists them (info).
  const canonical = { ...cap, keywords: ['m0probeassign', { form: 'm0probeanchored', without: ['rest', 'm0probeexclusion'] }] };
  const listed = checkCatalog({ root, fragmentsDir: fragmentsDir({ 'A/anchored.json': { ...a, capabilities: [canonical], coverage: [] } }) });
  assert.equal(listed.ok, true, JSON.stringify(listed.errors));
  const info = listed.info.filter(i => /is a synonym canonical/.test(i.text));
  assert.equal(info.length, 1, JSON.stringify(info));
  // Per lane: the ODC descriptor has a rest group; O11 has none here (its rest variants come from the real fragments).
  assert.match(info[0].text, /A\/anchored\.json logic\.m0-probe-assign: anchored keyword "m0probeanchored": without term "rest" is a synonym canonical, said by every variant of its group \(odc: [^;]*\bapi\b[^;]*\)$/);
});

test('synonym variants are non-empty strings: an anchored form in a synonym group refuses the composition, naming the front (request A-006)', () => {
  const a = fixture('A');
  const dir = fragmentsDir({ 'A/syn.json': { ...a, synonyms: { m0probegroup: [{ form: 'variaveis', with: ['tipo'] }, '', 'm0probevariant'] }, coverage: [] } });
  const composed = composeCatalog({ shared: readJson(path.join(facade, 'discovery-capabilities-shared.json')), fragmentsDir: dir });
  assert.match(composed.problems.join('\n'), /fragment A\/syn\.json: synonyms\.m0probegroup: variant \{"form":"variaveis","with":\["tipo"\]\} is not a non-empty string/);
  assert.deepEqual(composed.shared.synonyms.m0probegroup, ['m0probevariant'], 'only the string variants would compose');
  const report = checkCatalog({ root, fragmentsDir: dir });
  const text = report.errors.map(e => `[${e.front}] ${e.text}`).join('\n');
  assert.match(text, /\[A\] fragment A\/syn\.json: synonyms\.m0probegroup: variant \{"form"/);
  assert.match(text, /\[A\] fragment A\/syn\.json: synonyms\.m0probegroup: variant "" is not a non-empty string/);
});

test('a negative must be a refusal job (expectError), as the index reads it; an O11 job asserted by a C# test is not', () => {
  const a = fixture('A'); const cap = structuredClone(a.capabilities[0]);
  cap.operations.read.roles['assign node'].o11 = { status: 'not-applicable', negative: ['dropdown-prompt'] };
  const refused = checkCatalog({ root, fragmentsDir: fragmentsDir({ 'A/neg.json': { ...a, capabilities: [cap], coverage: [] } }) });
  assert.match(refused.errors.map(e => e.text).join('\n'), /read\/assign node\/o11: negative job not found or not a refusal job \(a negative needs expectError; cite other negative jobs as a limit with origin\): dropdown-prompt/);
  cap.operations.read.roles['assign node'].o11 = { status: 'not-applicable', negative: ['delete-attribute-in-use'] };
  assert.equal(checkCatalog({ root, fragmentsDir: fragmentsDir({ 'A/neg.json': { ...a, capabilities: [cap], coverage: [] } }) }).ok, true);
});

test('references and requires resolve per lane of the capability; a tool is represented by the capability of its contract', () => {
  const a = fixture('A'); const c = fixture('C');
  // logic.server-action exists only on ODC (lane-own legacy): a two-lane capability may not depend on it.
  const twoLanes = { ...structuredClone(a.capabilities[0]), depends: ['logic.server-action'], requires: [{ id: 'logic.server-action', provider: 'A', why: 'body of the handler' }] };
  const r = checkCatalog({ root, fragmentsDir: fragmentsDir({ 'A/lanes.json': { ...a, capabilities: [twoLanes], coverage: [] } }) });
  assert.match(r.errors.map(e => e.text).join('\n'), /unknown dependency logic\.server-action on o11/);
  assert.deepEqual(r.pendingRequires.map(p => [p.id, p.missingOn]), [['logic.server-action', ['o11']]]);
  assert.ok(!r.info.some(i => /logic\.server-action.*now exists/.test(i.text)), 'no advice to move a lane-missing id into depends');
  const odcOnly = { ...twoLanes, lanes: ['odc'], elements: twoLanes.elements.map(e => ({ ...e, platforms: { odc: e.platforms.odc } })), operations: { read: { route: 'x', roles: { 'assign node': { odc: { status: 'undetermined' } } } } }, platforms: { odc: twoLanes.platforms.odc } };
  assert.equal(checkCatalog({ root, fragmentsDir: fragmentsDir({ 'A/lanes.json': { ...a, capabilities: [odcOnly], coverage: [] } }) }).ok, true);
  // B-001: a two-lane capability may depend on an ODC-only id through an entry restricted to ODC; the O11 projection
  // drops the edge.
  const scoped = { ...twoLanes, depends: [{ id: 'logic.server-action', lanes: ['odc'] }], requires: [] };
  assert.equal(checkCatalog({ root, fragmentsDir: fragmentsDir({ 'A/lanes.json': { ...a, capabilities: [scoped], coverage: [] } }) }).ok, true);
  const shared = readJson(path.join(facade, 'discovery-capabilities-shared.json'));
  const composedScoped = composeCatalog({ shared, fragmentsDir: fragmentsDir({ 'A/lanes.json': { ...a, capabilities: [scoped], coverage: [] } }) }).shared;
  assert.deepEqual(projectShared(composedScoped, 'odc').find(x => x.id === scoped.id).depends, [{ id: 'logic.server-action' }]);
  assert.deepEqual(projectShared(composedScoped, 'o11').find(x => x.id === scoped.id).depends, []);
  const wrongLane = { ...scoped, lanes: ['o11'], depends: [{ id: 'logic.server-action', lanes: ['odc'] }] };
  assert.match(checkCatalog({ root, fragmentsDir: fragmentsDir({ 'A/lanes.json': { ...a, capabilities: [wrongLane], coverage: [] } }) }).errors.map(e => e.text).join('\n'), /names lane odc, which the capability does not cover/);
  const tools = { ...c, capabilities: c.capabilities, coverage: [{ type: 'tool:ssam_app_url', status: 'represented', applicability: 'applicable', capability: 'read.m0-probe-inspect' }] };
  assert.equal(checkCatalog({ root, fragmentsDir: fragmentsDir({ 'C/tools.json': tools }) }).ok, true);
  const noCap = { ...tools, coverage: [{ type: 'tool:ssam_app_url', status: 'represented', applicability: 'applicable' }] };
  assert.match(checkCatalog({ root, fragmentsDir: fragmentsDir({ 'C/tools.json': noCap }) }).errors.map(e => e.text).join('\n'), /represented needs the capability that carries the tool contract/);
});

test('composition: a superseding capability removes the legacy one on its lanes and answers for its id', () => {
  const shared = readJson(path.join(facade, 'discovery-capabilities-shared.json'));
  const odc = readJson(path.join(facade, 'discovery-capabilities.json'));
  const composed = composeCatalog({ shared, fragmentsDir: fixtures });
  assert.deepEqual(composed.problems, []);
  assert.deepEqual(composed.fragments.map(f => f.capabilities).flat(), ['logic.m0-probe-assign', 'ui.m0-probe-button', 'read.m0-probe-inspect']);
  assert.ok(composed.shared.capabilities.every(c => !('requires' in c) && !('supersedes' in c)), 'catalog-only fields never reach the index');
  const { descriptor, removed } = applySupersedes(odc, composed.supersedes, 'odc');
  assert.deepEqual(removed, ['read.inspect']);
  const refs = descriptor.capabilities.flatMap(c => [...(c.depends ?? []), ...(c.recommends ?? []), ...(c.alternatives ?? [])].map(d => (typeof d === 'string' ? d : d.id)));
  assert.ok(!refs.includes('read.inspect') && refs.includes('read.m0-probe-inspect'));
  assert.deepEqual(applySupersedes(readJson(path.join(facade, 'discovery-capabilities-o11.json')), composed.supersedes, 'o11').removed, []);
});

test('the owning front takes over a capability of the shared descriptor by superseding it with the same id', () => {
  const shared = readJson(path.join(facade, 'discovery-capabilities-shared.json'));
  const structure = structuredClone(shared.capabilities.find(c => c.id === 'data.structure'));
  const mine = { schemaVersion: FRAGMENT_SCHEMA, contract: 'ssam-catalog-contribution/1', front: 'A', title: 't', reviewedAt: '2026-09-23', capabilities: [{ ...structure, supersedes: ['data.structure'], summary: structure.summary + ' (taken over)' }] };
  const dir = fragmentsDir({ 'A/data-structure.json': mine });
  const composed = composeCatalog({ shared, fragmentsDir: dir });
  assert.deepEqual(composed.problems, []);
  const taken = composed.shared.capabilities.filter(c => c.id === 'data.structure');
  assert.equal(taken.length, 1); assert.equal(taken[0].origin.front, 'A'); assert.match(taken[0].summary, /taken over/);
  assert.equal(checkCatalog({ root, fragmentsDir: dir }).ok, true);
  const other = fragmentsDir({ 'B/data-structure.json': { ...mine, front: 'B' } });
  assert.match(checkCatalog({ root, fragmentsDir: other }).errors.map(e => e.text).join('\n'), /supersedes data\.structure, owned by front A/);
});

test('the pinned inventory identity does not depend on the line endings a checkout received', () => {
  const ownership = readJson(path.join(facade, 'catalog', 'ownership.json'));
  const text = fs.readFileSync(path.join(root, ownership.inventory.file), 'utf8').replace(/\r\n/g, '\n');
  const dir = temp(); fs.writeFileSync(path.join(dir, 'lf.json'), text); fs.writeFileSync(path.join(dir, 'crlf.json'), text.replace(/\n/g, '\r\n'));
  assert.equal(textSha256(path.join(dir, 'lf.json')), ownership.inventory.sha256);
  assert.equal(textSha256(path.join(dir, 'crlf.json')), ownership.inventory.sha256);
});

test('without fragments the shared identity is unchanged (the index cache of the base stays valid)', () => {
  const shared = readJson(path.join(facade, 'discovery-capabilities-shared.json'));
  const composed = composeCatalog({ shared, fragmentsDir: temp() });
  assert.equal(composed.fragments.length, 0); assert.equal(composed.shared.capabilities.length, shared.capabilities.length);
});

test('selection and budget over fragments: an element-less shared capability stays direct beside a named family, a declared refusal survives the minimal budget', { skip: !fs.existsSync(laneSources('odc').cli) && 'the odc CLI is not built in this checkout' }, async () => {
  const probe = { ...laneSources('odc'), fragments: fixtures, cacheDir: temp() };
  // C-008: read.m0-probe-inspect is a shared capability without roles; the intent also names the entity family.
  const mixed = await discover({ lane: 'odc', intent: 'm0probeinspect de uma entidade e os seus atributos', sources: probe, budgetBytes: 40960 });
  const direct = mixed.matches.filter(m => m.via === 'match').map(m => m.id);
  assert.ok(direct.includes('read.m0-probe-inspect'), JSON.stringify(mixed.matches.map(m => m.id + ':' + m.via)));
  assert.ok(direct.includes('data.entity'));
  // C-003: a declared refusal keeps at least its id under a budget that forces the minimal answer.
  for (const budgetBytes of [40960, 8192, 4096]) {
    const a = await discover({ lane: 'odc', intent: 'm0probeunavailable num formulario com dropdown pesquisavel, carregar dados e salvar numa entidade', sources: probe, budgetBytes });
    assert.ok(a.size.bytes <= budgetBytes);
    assert.ok((a.unavailable ?? []).some(u => u.id === 'ui.m0-probe-unavailable'), `budget ${budgetBytes}: ${a.size.status} ${JSON.stringify(a.unavailable)}`);
  }
});

for (const lane of ['odc', 'o11']) {
  const sources = laneSources(lane);
  test(`real index build (${lane}): fragments are checked against the lane CLI, suites and runtime, and discover answers them`, { skip: !fs.existsSync(sources.cli) && `the ${lane} CLI is not built in this checkout` }, async () => {
    const cacheDir = temp();
    // The fixture fragments, front A's capability with one anchored keyword more (request A-006).
    const anchoredA = fixture('A'); anchoredA.capabilities[0].keywords.push({ form: 'm0probeanchored', with: ['m0probecontext'], without: ['m0probeexclusion'] });
    const probe = { ...sources, fragments: fragmentsDir({ 'A/m0-probe.json': anchoredA, 'B/m0-probe.json': fixture('B'), 'C/m0-probe.json': fixture('C') }), cacheDir };
    const { index } = await buildIndex(lane, { sources: probe, rebuild: true, persist: false });
    const ids = index.capabilities.map(c => c.id);
    assert.ok(ids.includes('logic.m0-probe-assign') && ids.includes('ui.m0-probe-button'));
    assert.equal(ids.includes('read.m0-probe-inspect'), lane === 'odc');
    assert.equal(ids.includes('read.inspect'), false);
    assert.equal(index.identity.descriptor.shared.fragments.length, 3);
    for (const t of ['OutSystems.Model.Logic.Nodes.IAssignNode', 'ServiceStudio.Plugin.NRWidgets.IButton']) assert.equal(index.nativeRuntime[t]?.found, true, t);
    const answer = await discover({ lane, intent: 'm0probebutton m0probeassign', sources: probe, budgetBytes: 12000 });
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.matches.filter(m => m.via === 'match').map(m => m.id).sort(), ['logic.m0-probe-assign', 'ui.m0-probe-button']);
    assert.ok(answer.size.bytes <= 12000);
    // The anchored keyword reaches the index as written and counts only with its context.
    const directOf = a => a.matches.filter(m => m.via === 'match');
    const alone = await discover({ lane, intent: 'm0probeanchored m0probebutton', sources: probe, budgetBytes: 12000 });
    assert.deepEqual(directOf(alone).map(m => m.id), ['ui.m0-probe-button']);
    const anchored = await discover({ lane, intent: 'm0probeanchored m0probecontext m0probebutton', sources: probe, budgetBytes: 12000 });
    // why names the form and the with-term said, in tokens as every why does ("-ed" is stemmed).
    assert.deepEqual(directOf(anchored).find(m => m.id === 'logic.m0-probe-assign')?.why, ['m0probeanchor [m0probecontext]'], JSON.stringify(directOf(anchored)));
    const excluded = await discover({ lane, intent: 'm0probeanchored m0probecontext m0probeexclusion m0probebutton', sources: probe, budgetBytes: 12000 });
    assert.deepEqual(directOf(excluded).map(m => m.id), ['ui.m0-probe-button']);
    // An anchored keyword whose term keeps no word after tokenization (a stopword) refuses the build, as the pure check
    // does, naming the fragment capability and, with it, its pointer that does not resolve in the lane CLI. A broken
    // pointer alone drops the capability with a note instead (atritos 2, A10: pa2-f7b-discovery.test.mjs).
    const bad = fixture('A'); bad.capabilities[0].contract = ['logic.no.such.pointer']; bad.capabilities[0].keywords.push({ form: 'm0probeanchored', with: ['uso'] });
    const badDir = fragmentsDir({ 'A/bad.json': bad });
    await assert.rejects(buildIndex(lane, { sources: { ...sources, fragments: badDir, cacheDir }, rebuild: true, persist: false }), error => {
      assert.match(error.message, /logic\.m0-probe-assign: contract pointer does not resolve: logic\.no\.such\.pointer/);
      assert.match(error.message, /logic\.m0-probe-assign: anchored keyword "m0probeanchored": with term "uso" keeps no word after tokenization/);
      return true;
    });
  });
}
