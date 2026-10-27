// R4 follow-up (2026-10-24): the discovery of a machine that ran the suites for weeks. kernel/.local/[lane-odc/]test-work
// holds one <job>.result.json per job and example (the suites rewrite it; the newest result of a job is the only one), each
// stamped with the kernel, Studio and assemblies that ran it. With a few hundred of them the proofs of every capability turn
// "historical", and each proof listed every Studio assembly that differs (hundreds of lines): the evidence of data.entity
// reached 92 KB and pushed its contract out of the expansion, and the composite answer cut contracts and examples while the
// proof lists stayed whole (discovery.test.mjs 816 and 841, failing at any HEAD with such a folder). The same assertions
// hold here with an empty folder and with 300 synthetic results built from the committed snapshot.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wireBytes } from './fixtures/answer-wire.mjs';
import { discover, laneSources, ASSEMBLY_LINES, DEFAULT_BUDGET_BYTES } from '../discovery.mjs';
import { resultsSnapshot } from './fixtures/discovery-results.mjs';

const live = laneSources('odc');
const cliBuilt = fs.existsSync(live.cli);
const BASE_ONLY = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-scale-base-only-'));
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// 300 results: every job of the lane and the first examples, the snapshot's own result where it has one, else a copy of
// the snapshot's data-entity result (a historical stamp: another kernel, Studio and assembly set), as an accumulated folder.
function syntheticResults(count = 300) {
  const snapshot = resultsSnapshot().dirs.odc;
  const dir = temp('discovery-scale-results-');
  const jobs = fs.readdirSync(live.jobsDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
  const examples = fs.existsSync(live.examplesDir) ? fs.readdirSync(live.examplesDir).filter(f => f.endsWith('.json')).map(f => 'examples/' + f.slice(0, -5)).sort() : [];
  const names = [...jobs, ...examples].slice(0, count);
  const template = fs.readFileSync(path.join(snapshot, 'data-entity.result.json'), 'utf8');
  for (const name of names) {
    const own = path.join(snapshot, ...name.split('/')) + '.result.json';
    const file = path.join(dir, ...name.split('/')) + '.result.json';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fs.existsSync(own) ? fs.readFileSync(own, 'utf8') : template);
  }
  return { dir, count: names.length };
}

const folders = () => {
  const synthetic = syntheticResults();
  return [['empty', temp('discovery-scale-empty-'), 0], ['300 results', synthetic.dir, synthetic.count]];
};

test('with an empty results folder and with 300 stamped results the expansion keeps its contract and the composite answer its contracts, examples and dependencies', { skip: !cliBuilt && 'anvil-odc CLI not built', timeout: 600000 }, async () => {
  for (const [label, testWork, count] of folders()) {
    if (label !== 'empty') assert.ok(count >= 300, label + ': ' + count + ' results');
    const sources = { ...live, fragments: BASE_ONLY, testWork, cacheDir: temp('discovery-scale-cache-') };
    // The single-capability form: the contract is what was asked first; the proofs stay, each mismatch list bounded.
    const detail = await discover({ lane: 'odc', detail: 'data.entity', sources });
    const part = detail.expansions?.['data.entity'];
    assert.ok(part?.contract?.['verbs.verbs.rename']?.required?.includes('name'), label + ': contract of the detail: ' + JSON.stringify(detail.size?.truncated ?? detail).slice(0, 400));
    for (const p of part.evidence?.proofs ?? []) {
      assert.ok(Array.isArray(p.mismatches), label + ' ' + p.job);
      assert.ok(p.mismatches.filter(m => m.startsWith('nativeAssemblies:')).length <= ASSEMBLY_LINES * 2, label + ' ' + p.job + ': ' + p.mismatches.length + ' mismatch lines');
    }
    // The composite answer at the default budget: the proof lists go first, never the contracts, examples or dependencies.
    const answer = await discover({ lane: 'odc', intent: 'formulário com dropdown pesquisável, carregar dados e salvar', sources });
    assert.equal(answer.ok, true, label);
    assert.equal(answer.size.budgetBytes, DEFAULT_BUDGET_BYTES);
    assert.ok(wireBytes(answer) <= answer.size.budgetBytes, label + ': bytes ' + answer.size.bytes);
    const sections = (answer.size.truncated ?? []).map(t => t.section);
    assert.ok(!sections.some(s => ['contracts', 'examples', 'matches.dependencies'].includes(s)), label + ': reductions ' + sections.join(','));
    if (sections.includes('matches.proofs')) assert.ok(answer.matches.some(m => m.proofsOmitted > 0), label + ': the proofs left out are counted');
    // The list-with-join intent keeps its aggregate contract and the list/aggregate bindings (discovery.test.mjs 789).
    const list = await discover({ lane: 'odc', intent: 'tela de listagem de apolices: static entity PolicyStatus, entidade Policy com FK, tela WfPolicies com um aggregate das apolices ordenado por Number e uma lista com Number e Label do status, clique navega para WfPolicyDetail com input PolicyId', sources, budgetBytes: 40960 });
    assert.ok(list.contracts['logic.steps.get'] && list.contracts['logic.queryJoin'] !== undefined, label + ': aggregate contracts');
    const rules = (list.bindings ?? []).map(b => b.rule);
    assert.ok(rules.includes('set <IList> Source = <Aggregate>.List'), label + ': ' + rules.join(' | '));
  }
});
