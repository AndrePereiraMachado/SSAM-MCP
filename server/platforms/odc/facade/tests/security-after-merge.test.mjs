// a11-b (B): a v97 ODC bridge on the server line after T12. The bridge judges the new live messages after a merge with the
// security list of the kernel it was built with (tests/fixtures/bridge-v97/SecurityWarnings.cs.txt = SecurityWarningsCopy.cs);
// the kernel's list grew (T12, 700a5c1f + 0a21afba). This file proves (1) the v97 list is a subset of the kernel's, so the
// v97 bridge refuses nothing the kernel accepts; (2) a T12 family message that a v97 bridge left among the merge receipt's
// warnings now gets the bridge's own refusal from the server (security-after-merge.mjs, through lib.mjs studio); (3) the
// server's mirror equals the kernel's SecurityWarnings.cs, so a change of the kernel's list fails here first.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SECURITY_IDS, ANONYMOUS_IDS, GENERIC_IDS, SECURITY_TITLES, TITLE_FAMILIES, ANONYMOUS_SENTENCES, FIXES, isSecurity, securityIdOf, judgeMergeAnswer } from '../security-after-merge.mjs';
import { runWithExecutor } from '../executor.mjs';
import { studio } from '../lib.mjs';

const facade = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(facade, '..', '..', '..');
const kernelFile = path.join(repo, 'kernel', 'src', 'Anvil.Core', 'Kernel', 'SecurityWarnings.cs');
const v97File = path.join(facade, '..', 'tests', 'fixtures', 'bridge-v97', 'SecurityWarnings.cs.txt');
const code = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n');
const strings = block => [...String(block ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
const setOf = (text, name) => strings(new RegExp('\\b' + name + ' = new HashSet<string>\\(StringComparer\\.Ordinal\\)\\s*\\{([^}]*)\\}').exec(text)?.[1]);

// The v97 bridge's own rule (MergeDiagnostics.BlocksAfterMerge over SecurityWarningsCopy.cs): its Ids, or the anonymous family.
const v97 = code(v97File);
const v97Ids = new Set(setOf(v97, 'Ids'));
const v97Blocks = (warning, text) => String(warning.type).includes('Error') || v97Ids.has(warning.id) || ANONYMOUS_IDS.includes(warning.id)
  || (warning.id === 'CustomObjectWarning' && ANONYMOUS_SENTENCES.every(s => text.includes(s)));
const textOf = w => (w.message ?? '') + '|' + (w.detail ?? '');

test('the v97 list is a subset of the kernel list: a v97 bridge refuses nothing the kernel accepts', () => {
  const kernel = code(kernelFile);
  assert.deepEqual([...v97Ids].filter(id => !setOf(kernel, 'Ids').includes(id)), []);
  assert.deepEqual(setOf(v97, 'AnonymousIds'), setOf(kernel, 'AnonymousIds'));
  const anonymous = text => /public static bool IsAnonymous[\s\S]*?\n {4}\}/.exec(text)?.[0].replace(/\s+/g, ' ');
  assert.equal(anonymous(v97), anonymous(kernel), 'IsAnonymous is the same in both');
  // the families T12 added, which a v97 bridge accepts as warnings after a merge
  assert.deepEqual(setOf(kernel, 'Ids').filter(id => !v97Ids.has(id)),
    ['SQL_InputParameterPropagation', 'OpenRedirect', 'OpenRedirectNR', 'LdapFilterInjection', 'EntityActionClientSide']);
});

test('the server mirror is the kernel SecurityWarnings.cs: ids, buckets, titles, sentences and the classifying code', () => {
  const kernel = code(kernelFile);
  assert.deepEqual([...SECURITY_IDS], setOf(kernel, 'Ids'));
  assert.deepEqual([...ANONYMOUS_IDS], setOf(kernel, 'AnonymousIds'));
  assert.deepEqual([...GENERIC_IDS], setOf(kernel, 'GenericIds'));
  const titles = /TitleFamilies = new\(StringComparer\.Ordinal\)\s*\{([\s\S]*?)\};/.exec(kernel)?.[1];
  assert.deepEqual([...SECURITY_TITLES], [...String(titles).matchAll(/\["([^"]+)"\]\s*=/g)].map(m => m[1]));
  assert.deepEqual({ ...TITLE_FAMILIES }, Object.fromEntries([...String(titles).matchAll(/\["([^"]+)"\]\s*=\s*"([^"]+)"/g)].map(m => [m[1], m[2]])));
  // the fixes (SecurityWarnings.Fix, the platform's advice), each one word for word
  const fixes = /public static string\? Fix\([\s\S]*?var fix = security switch\s*\{([\s\S]*?)\};/.exec(kernel)?.[1];
  assert.deepEqual({ ...FIXES }, Object.fromEntries([...String(fixes).matchAll(/"(\w+)" => "([^"]*)",/g)].map(m => [m[1], m[2]])));
  // the generic SQL bucket by its words, as SecurityIdOf reads it
  assert.equal(securityIdOf('CustomObjectWarning', 'SQL Injection | When adding an expand inline parameter after a Group By or Order By'), 'SQL_InputParameterPropagation');
  assert.equal(securityIdOf('CustomObjectWarning', 'Open Redirect | the URL comes from a screen input'), 'OpenRedirectNR');
  assert.equal(securityIdOf('CustomObjectWarning', 'Deprecated Widget | x'), null);
  assert.deepEqual([...ANONYMOUS_SENTENCES], ['AnonymousAccessSentence', 'Ss11ScreenSentence'].map(name => new RegExp('const string ' + name + ' = "([^"]+)"').exec(kernel)?.[1]));
  // Every family of SecurityIdOf yields an id (never null), so "a generic bucket with a security title" is the whole rule the
  // mirror needs; a change of that code, of TitleOf, BlocksWhenNew, IsAnonymous or IsSecurity changes this hash: review
  // security-after-merge.mjs against it, then update the hash.
  const parts = [/private static string\? TitleOf[\s\S]*?private const string Acceptance/, /public static bool IsAnonymous[\s\S]*$/].map(rule => rule.exec(kernel)?.[0] ?? '');
  assert.ok(parts.every(part => part.length > 100), 'the classifying code is found');
  assert.match(parts[0], /public static bool BlocksWhenNew/); assert.match(parts[1], /public static bool IsSecurity/);
  const logic = parts.join('\n').replace(/\s+/g, ' ');
  assert.equal(createHash('sha256').update(logic).digest('hex').slice(0, 16), '6e3d3cc98c5199ac', 'the classifying code of SecurityWarnings.cs changed');
});

const receipt = warnings => ({ ok: true, merged: true, module: 'Orders', outcome: 'Merged', equivalence: 'strict', strictlyEqual: true, sha256: 'A'.repeat(64),
  afterSnapshot: 'C:\\lab\\evidence\\after-merge.oml', publishInvoked: false, warnings });
const openRedirect = { key: 'k1', id: 'OpenRedirect', type: 'Warning', message: 'Open Redirect', detail: 'The URL of the redirect uses an input', ownerKey: 'k1' };
const genericSql = { key: 'k2', id: 'CustomObjectWarning', type: 'Warning', message: 'SQL Injection', detail: 'When adding an expand inline parameter after a Group By or Order By, check it against an allowlist' };
const harmless = { key: 'k3', id: 'UnusedVariable', type: 'Warning', message: 'Unused Variable', detail: 'Local variable X is never used' };
const genericOther = { key: 'k4', id: 'CustomObjectWarning', type: 'Warning', message: 'Deprecated Widget', detail: 'Use the new one' };

test('a T12 family warning a v97 bridge accepted after the merge: the server answers the bridge refusal, never a success', () => {
  for (const w of [openRedirect, genericSql]) assert.equal(v97Blocks(w, textOf(w)), false, w.id + ': the v97 bridge leaves it among the warnings');
  for (const w of [harmless, genericOther]) assert.equal(isSecurity(w.id, textOf(w)), false, w.id + ' is no security warning');
  const judged = judgeMergeAnswer(receipt([harmless, openRedirect, genericSql, genericOther]));
  assert.equal(judged.ok, false);
  assert.equal(judged.code, 'MERGE_SECURITY_WARNING'); assert.equal(judged.outcome, 'security');
  assert.equal(judged.merged, true); assert.equal(judged.gate, 'candidate_validation');
  assert.match(judged.error, /brought 2 new security warning\(s\) into the open module \(OpenRedirect, CustomObjectWarning\)/);
  assert.match(judged.error, /ReplaceURLDomain/); assert.match(judged.error, /allowlist/);
  assert.deepEqual(judged.blocking.map(w => w.id), ['OpenRedirect', 'CustomObjectWarning']);
  assert.deepEqual(judged.warnings, [harmless, genericOther]);
  assert.equal(judged.afterSnapshot, undefined, 'no success field of the receipt stays');
  assert.match(judged.note, /Never repeat this merge/);
  assert.doesNotMatch(judged.note, /expectedMessages|from a new snapshot/, 'no way out that does not exist');  // Nothing else changes: only harmless warnings, a refusal, or another command's answer.
  const fine = receipt([harmless, genericOther]);
  assert.equal(judgeMergeAnswer(fine), fine);
  const refused = { ok: false, error: 'x' };
  assert.equal(judgeMergeAnswer(refused), refused);
  assert.equal(judgeMergeAnswer(null), null);
});

test('hosted: studio_merge through the agent of a customer with bridge v97 refuses the merge answer with a T12 warning', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-security-after-merge-'));
  try {
    const sent = [];
    const executor = { id: 'fake', hosted: true, o11Connection() { return null; }, async close() {},
      async call(kind, params) { sent.push({ kind, args: params?.args }); if (kind === 'odc.pipe') return { line: JSON.stringify(receipt([harmless, openRedirect])) }; return {}; } };
    const context = { id: randomUUID(), hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc'], workspace, agent: null, executor, close: async () => {} };
    const value = await runWithExecutor(context, () => studio(['merge', path.join(workspace, 'odc', 'lab', '01', 'manifest.json')], 4120));
    assert.deepEqual(sent.filter(s => s.kind === 'odc.pipe').map(s => s.args[0]), ['merge']);
    assert.equal(value.ok, false, JSON.stringify(value).slice(0, 300));
    assert.equal(value.merged, true);
    assert.deepEqual(value.blocking.map(w => w.id), ['OpenRedirect']);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});
