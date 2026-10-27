import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const states = {
  screen: ['loaded'], table: ['empty', 'single', 'many'], popup: ['open', 'cancelled', 'invalid', 'saved'],
  tabs: ['first', 'other'], accordion: ['open', 'closed'], form: ['invalid', 'submitted', 'failed'], upload: ['empty', 'selected', 'invalid'], download: ['downloaded'],
  pagination: ['first', 'next', 'last'], temporal: ['date', 'client-local', 'instant', 'dst']
};
const fail = message => { throw Object.assign(new Error(message), { code: 'MIGRATION_ACCEPTANCE_INVALID' }); };
export const migrationStates = states;

function readEvidence(root, evidence) {
  if (!evidence || !/^[a-f0-9]{64}$/.test(evidence.sha256 ?? '')) fail('Evidence requires file and sha256');
  const realRoot = fs.realpathSync(root), file = fs.realpathSync(path.resolve(root, evidence.file));
  const relative = path.relative(realRoot, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('Evidence must be inside this workspace');
  const bytes = fs.readFileSync(file);
  if (bytes.length > 20000000 || hash(bytes) !== evidence.sha256) fail('Evidence changed: ' + relative);
  return bytes;
}

export function acceptMigration({ contract, evidence }, { workspace } = {}) {
  if (!path.isAbsolute(workspace ?? '')) fail('A workspace is required');
  if (contract?.schema !== 'ssam-migration-acceptance/1' || !Array.isArray(contract.components) || !contract.components.length
    || !Array.isArray(contract.cases) || !Array.isArray(evidence)) fail('A versioned component inventory, cases and evidence are required');
  if (contract.components.length > 500 || contract.cases.length > 5000 || evidence.length > 5000) fail('Acceptance contract too large');
  const ids = new Set(), requirements = new Set(), cases = new Map(), supplied = new Map(), problems = [];
  for (const component of contract.components) {
    if (!component.id || ids.has(component.id) || !states[component.kind]) fail('Invalid or duplicate component');
    ids.add(component.id);
    for (const state of states[component.kind]) requirements.add(component.id + '/' + state);
  }
  for (const scenario of contract.cases) {
    if (!scenario.id || cases.has(scenario.id) || !ids.has(scenario.component)) fail('Invalid or duplicate scenario');
    const key = scenario.component + '/' + scenario.state;
    if (!requirements.has(key)) fail('Scenario is outside the component state contract: ' + key);
    requirements.delete(key); cases.set(scenario.id, scenario);
  }
  for (const missing of requirements) problems.push({ code: 'MIGRATION_STATE_MISSING', state: missing });
  for (const entry of evidence) {
    if (!cases.has(entry.scenario) || supplied.has(entry.scenario)) fail('Unknown or duplicate evidence scenario');
    supplied.set(entry.scenario, entry);
  }
  const checked = [];
  for (const [id, scenario] of cases) {
    const entry = supplied.get(id);
    if (!entry) { problems.push({ code: 'MIGRATION_EVIDENCE_MISSING', scenario: id }); continue; }
    const receipt = JSON.parse(readEvidence(workspace, entry.receipt));
    if (receipt.schema !== 'ssam-browser-comparison/1' || receipt.scenario !== id || receipt.passed !== true) {
      problems.push({ code: 'MIGRATION_COMPARISON_FAILED', scenario: id }); continue;
    }
    if (receipt.sourceRevisionVerified !== true || !receipt.revisions?.reference?.verified || !receipt.revisions?.candidate?.verified
      || !receipt.revisions.reference.assets.length || !receipt.revisions.candidate.assets.length) {
      problems.push({ code: 'MIGRATION_REVISION_UNVERIFIED', scenario: id }); continue;
    }
    for (const side of ['reference', 'candidate']) {
      const expected = contract.revisions?.[side];
      const observed = receipt.revisions[side];
      if (!expected || expected !== observed.fingerprint || observed.assets.some(a => !a.matched || a.actual !== a.expected))
        problems.push({ code: 'MIGRATION_REVISION_MISMATCH', scenario: id, side });
    }
    for (const resource of ['reference', 'candidate', 'referenceImage', 'candidateImage']) readEvidence(workspace, receipt.evidence?.[resource]);
    const kind = contract.components.find(c => c.id === scenario.component).kind;
    if (kind === 'pagination' && !receipt.assertions?.some(a => a.expected?.reference?.length && a.expected?.candidate?.length))
      problems.push({ code: 'MIGRATION_EXPECTED_RECORDS_REQUIRED', scenario: id });
    if (kind === 'table' && !receipt.assertions?.some(a => scenario.state === 'empty' ? a.count === 0
      : scenario.state === 'single' ? a.count === 1 : a.count > 1))
      problems.push({ code: 'MIGRATION_EXPECTED_ROW_COUNT_REQUIRED', scenario: id });
    if (kind === 'table' && scenario.state === 'empty' && !receipt.assertions?.some(a => a.count > 0))
      problems.push({ code: 'MIGRATION_TABLE_CONTAINER_REQUIRED', scenario: id });
    if (scenario.state === 'next') {
      const transition = entry.transition ? JSON.parse(readEvidence(workspace, entry.transition)) : null;
      if (transition?.schema !== 'ssam-browser-comparison/1' || transition.passed !== true || transition.relation !== 'pagination'
        || transition.sourceRevisionVerified !== true || transition.revisions?.reference?.fingerprint !== contract.revisions.candidate
        || transition.revisions?.candidate?.fingerprint !== contract.revisions.candidate)
        problems.push({ code: 'MIGRATION_TRANSITION_UNPROVEN', scenario: id });
      else for (const resource of ['reference', 'candidate', 'referenceImage', 'candidateImage']) readEvidence(workspace, transition.evidence?.[resource]);
    }
    checked.push({ scenario: id, component: scenario.component, state: scenario.state, receipt: entry.receipt });
  }
  const result = { ok: true, schema: 'ssam-migration-acceptance-result/1', accepted: problems.length === 0,
    contractSha256: hash(JSON.stringify(contract)), checked, problems, evaluatedAt: new Date().toISOString(),
    scope: 'All declared components and required states, at the verified deployed asset revisions. Not a claim about undeclared components or unexecuted business paths.' };
  const directory = path.join(workspace, '.local', 'preview', 'acceptance'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, randomUUID() + '.json'); const bytes = JSON.stringify(result, null, 2);
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return { ...result, receipt: { file, sha256: hash(bytes) } };
}
