// a11-b (public-signature drift, B): the ODC bridge judges the new live messages after a merge with its own copy of the
// kernel's security list (studio/bridge/SecurityWarningsCopy.cs, MergeDiagnostics.BlocksAfterMerge): an error or a security
// warning blocks, every other one goes to the receipt's `warnings`. The customers' bridge v97 carries the list of the kernel
// it was built with (tests/fixtures/bridge-v97/SecurityWarnings.cs.txt); T12 (700a5c1f, 0a21afba) widened the kernel's:
// SQL_InputParameterPropagation, OpenRedirect, OpenRedirectNR, LdapFilterInjection, EntityActionClientSide, and the generic
// buckets CustomObjectWarning/CustomObjectError whose title is a security family's. The old list is a subset of the new one,
// so a v97 bridge never blocks what the kernel accepts; but a live message of those families that the candidate did not
// already have came back as an accepted warning of a merge that succeeded (receipt.json ok, strictlyEqual).
// The verdict lives in the merge's EVIDENCE, not only in the answer, so every later reader agrees:
//   - evidenceSecurity(evidence): the security warnings among the messages the bridge recorded there (new-messages.json,
//     the receipt's warnings) and the server's own verdict (security-after-merge.json, written by recordSecurityVerdict);
//   - judgeMergeAnswer: any merge answer with merged:true (a success, known losses, an uncertain one) whose warnings or
//     evidence hold such a message becomes MERGE_SECURITY_WARNING (outcome security), and the verdict is recorded;
//   - merge-reconcile.mjs mergeState answers outcome security for that evidence, never reconcilable; studio_publish {module}
//     refuses it; lib.mjs studio refuses a `publish` of its manifest before the bridge (studio_publish {manifest},
//     studio_command publish, the publication of studio_deliver).
// Mirrors kernel SecurityWarnings.cs (IsSecurity, BlocksWhenNew, SecurityIdOf, TitleOf, IsAnonymous, Fix without its
// acceptance sentence); tests/security-after-merge.test.mjs pins it to that file.
import fs from 'node:fs';
import path from 'node:path';

export const SECURITY_IDS = Object.freeze(['SQLInjection', 'SQLInjectionInvalidEncodeSQL', 'SQLInjectionInvalidReplace', 'SQL_InputParameterPropagation',
  'HTMLInjection', 'JavascriptInjection', 'ExpressionShouldBeEscaped', 'OpenRedirect', 'OpenRedirectNR', 'LdapFilterInjection', 'LoginSecurity',
  'EntityActionClientSide']);
export const ANONYMOUS_IDS = Object.freeze(['ServerActionInScreenAccessibleByEveryone', 'ServerActionInAnonymousScreen',
  'AnonymousAccess_NoPermissions', 'AnonymousAccess_NoPermissionsNoRoles']);
export const GENERIC_IDS = Object.freeze(['CustomObjectWarning', 'CustomObjectError']);
// The native titles of the security families (kernel TitleFamilies) and the family each names.
export const TITLE_FAMILIES = Object.freeze({ 'SQL Injection': 'sql', 'HTML Injection': 'HTMLInjection', 'JavaScript Injection': 'JavascriptInjection',
  'Expression Should Be Escaped': 'ExpressionShouldBeEscaped', 'Open Redirect': 'redirect', 'LDAP Filter Injection': 'LdapFilterInjection',
  'Unexpected Login': 'LoginSecurity', 'Security Warning': 'category' });
export const SECURITY_TITLES = Object.freeze(Object.keys(TITLE_FAMILIES));
export const ANONYMOUS_SENTENCES = Object.freeze(["You're exposing a Server Action for public access and without authentication.",
  'Consider removing the Anonymous Role from this Screen.']);
// The fix of each security warning (kernel SecurityWarnings.Fix, the platform's own advice), without the acceptance sentence:
// after a merge the warning is in the module, and declaring it in a job's expectedMessages accepts nothing there.
export const FIXES = Object.freeze({
  SQLInjection: "turn Expand Inline off and pass the value as a query parameter; when it must be inlined, encode it (EncodeSql for a value inside a quoted string literal, the BuildSafe_InClause lists for an IN list) or check it against a fixed list of allowed values",
  SQLInjectionInvalidEncodeSQL: "EncodeSql escapes only a value written inside a quoted string literal ('...'): quote it there; an IN list takes the BuildSafe_InClause lists, and a column, table or keyword must come from a fixed list of allowed names",
  SQLInjectionInvalidReplace: "do not escape with Replace: encode a string literal with EncodeSql, build an IN list with the BuildSafe_InClause lists, or turn Expand Inline off",
  SQL_InputParameterPropagation: "check the value against a fixed list of the allowed column names (an allowlist) before it is inlined after GROUP BY or ORDER BY, and inline only the name from that list; EncodeSql and a plain parameter do not work in that position",
  HTMLInjection: "encode the value with EncodeHtml() before it is written into the HTML",
  JavascriptInjection: "encode the value with EncodeJavaScript() before it is written into the script",
  ExpressionShouldBeEscaped: "set Escape Content to Yes on the Expression, or encode the value with EncodeHtml() when it must stay unescaped",
  OpenRedirect: "wrap each input of the URL in ReplaceURLDomain() (HTTPRequestHandler, O11 Traditional Web), or navigate to a screen of the module instead",
  OpenRedirectNR: "do not redirect to a URL taken from a screen input as it is: navigate to a screen of the module, or redirect only after the URL is checked against a fixed list of allowed hosts or paths",
  LdapFilterInjection: "encode the value with LdapFilterEncode() before it builds the LDAP filter",
  LoginSecurity: "log in through the login actions of the module the message names",
  EntityActionClientSide: "move the entity action into a server action that validates the data, and call that server action",
  anonymous: "the screen is open to everyone and runs a server action: restrict the screen (O11: Roles without Anonymous, such as [Registered]; ODC: AnonymousAccess false), or, when the user wants it public, declare that on the screen (O11: Roles with Anonymous; ODC: AnonymousAccess true)",
});
export const SECURITY_CODE = 'MERGE_SECURITY_WARNING';
export const VERDICT_FILE = 'security-after-merge.json';
export const VERDICT_SCHEMA = 'ssam-security-after-merge/1';

const ids = new Set(SECURITY_IDS), anonymous = new Set(ANONYMOUS_IDS), generic = new Set(GENERIC_IDS);
const titleOf = text => { const t = String(text ?? '').trim(); const bar = t.indexOf('|'); return bar > 0 ? t.slice(0, bar).trim() : null; };
export const isAnonymous = (id, text) => anonymous.has(id)
  || (id === 'CustomObjectWarning' && ANONYMOUS_SENTENCES.every(sentence => String(text ?? '').includes(sentence)));
export function securityIdOf(id, text) {
  if (ids.has(id)) return id;
  const family = generic.has(id) && !isAnonymous(id, text) ? TITLE_FAMILIES[titleOf(text)] : undefined;
  if (!family) return null;
  const says = words => String(text ?? '').toLowerCase().includes(words.toLowerCase());
  if (family === 'sql') return says('Group By') || says('Order By') ? 'SQL_InputParameterPropagation' : says('EncodeSql should') ? 'SQLInjectionInvalidEncodeSQL' : says('Replace') ? 'SQLInjectionInvalidReplace' : 'SQLInjection';
  if (family === 'redirect') return says('screen input') ? 'OpenRedirectNR' : 'OpenRedirect';
  if (family === 'category') return 'EntityActionClientSide';
  return family;
}
export const blocksWhenNew = (id, text) => securityIdOf(id, text) != null;
export const isSecurity = (id, text) => blocksWhenNew(id, text) || isAnonymous(id, text);

// The text the bridge judges a live message by: message, "|", detail (MergeDiagnostics.BlocksAfterMerge).
const textOf = warning => String(warning?.message ?? '') + '|' + String(warning?.detail ?? '');
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// A security warning among live messages (an error is the bridge's own refusal and never reaches here as a warning).
const securityWarning = w => isObject(w) && !String(w.type ?? '').includes('Error') && isSecurity(String(w.id ?? ''), textOf(w));
const sameMessage = w => JSON.stringify([w?.key ?? w?.ownerKey ?? null, w?.id ?? null, w?.message ?? null, w?.detail ?? null]);
function securityOf(lists) {
  const seen = new Set(), out = [];
  for (const w of lists.flat()) { if (!securityWarning(w)) continue; const k = sameMessage(w); if (seen.has(k)) continue; seen.add(k); out.push(w); }
  return out;
}
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };

// The security warnings of a merge, from its evidence directory: what the bridge recorded (new-messages.json, the receipt's
// and the known-loss receipt's warnings) and the server's verdict. [] when none, or no evidence.
export function evidenceSecurity(evidence) {
  if (typeof evidence !== 'string' || !evidence) return [];
  const list = file => { const v = readJson(path.join(evidence, file)); return Array.isArray(v) ? v : []; };
  const warnings = file => { const v = readJson(path.join(evidence, file)); return Array.isArray(v?.warnings) ? v.warnings : []; };
  const verdict = readJson(path.join(evidence, VERDICT_FILE));
  return securityOf([list('new-messages.json'), warnings('receipt.json'), warnings('incomplete-receipt.json'), Array.isArray(verdict?.blocking) ? verdict.blocking : []]);
}

// The server's verdict next to the bridge's evidence (one file, written once; a later one adds what it did not hold).
export function recordSecurityVerdict(evidence, blocking, { module = null, now = () => new Date() } = {}) {
  if (typeof evidence !== 'string' || !evidence || !blocking?.length) return null;
  const file = path.join(evidence, VERDICT_FILE);
  try {
    const earlier = readJson(file);
    const all = securityOf([Array.isArray(earlier?.blocking) ? earlier.blocking : [], blocking]);
    if (earlier && all.length === (earlier.blocking?.length ?? 0)) return file;
    fs.mkdirSync(evidence, { recursive: true });
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ schema: VERDICT_SCHEMA, module, at: now().toISOString(), outcome: 'security', publishable: false, blocking: all }, null, 2));
    fs.renameSync(temporary, file);
    return file;
  } catch { return null; }
}

// The fix of each blocking warning, one line per kind, in the platform's words.
export function securityFixes(blocking) {
  const out = [];
  for (const w of blocking ?? []) {
    const kind = isAnonymous(String(w?.id ?? ''), textOf(w)) ? 'anonymous' : securityIdOf(String(w?.id ?? ''), textOf(w));
    if (kind && FIXES[kind] && !out.some(f => f.kind === kind)) out.push({ kind, fix: FIXES[kind] });
  }
  return out;
}
const named = blocking => [...new Set(blocking.map(w => w?.id).filter(id => typeof id === 'string' && id))].slice(0, 5);
const where = w => w?.element ?? w?.ownerPath ?? w?.ownerKey ?? w?.key ?? null;
// What is left to do with a security warning already merged. Only ways that exist: the fix in the module (a new delivery
// whose job fixes what the message names), or the owner's own publication from ODC Studio, which accepts it as it is.
export const SECURITY_WAY_OUT = 'The merge is in the open module and nothing was published. Fix each warning in the module (a new delivery whose job changes what the message names), or the owner, accepting the warning as it is, publishes the module from ODC Studio. SSAM does not publish it. Never repeat this merge.';

// The refusal of a merged module that holds a new security warning. extra: the fields of the bridge's answer worth keeping.
export function securityRefusal(blocking, { module = null, extra = {} } = {}) {
  const fixes = securityFixes(blocking);
  return { ok: false, code: SECURITY_CODE, outcome: 'security', gate: 'candidate_validation', merged: true, equal: false, publishInvoked: false, executed: true, module,
    error: 'The merge of ' + (module ?? 'the module') + ' brought ' + blocking.length + ' new security warning(s) into the open module (' + named(blocking).join(', ') + '); a security warning blocks the publication until it is fixed. '
      + fixes.map(f => f.kind + ': ' + f.fix + '.').join(' '),
    blocking: blocking.map(w => ({ key: w?.key ?? w?.ownerKey ?? null, id: w?.id ?? null, type: w?.type ?? null, message: w?.message ?? null, detail: w?.detail ?? null, element: where(w) })),
    fixes, note: SECURITY_WAY_OUT, ...extra };
}

// Any merge answer with merged:true is judged with the kernel's list: its warnings and the messages its evidence holds. A
// security warning makes it the refusal above and records the verdict there; every other answer is returned as it is.
export function judgeMergeAnswer(value, { evidence = null, now } = {}) {
  if (!isObject(value) || value.merged !== true) return value;
  // judged already (lib.mjs studio, then the delivery): the verdict is recorded where this caller's evidence is
  if (value.code === SECURITY_CODE && Array.isArray(value.blocking)) { recordSecurityVerdict(evidence, value.blocking, { module: value.module ?? null, now }); return value; }
  const blocking = securityOf([Array.isArray(value.warnings) ? value.warnings : [], evidenceSecurity(evidence)]);
  if (!blocking.length) return value;
  const verdict = recordSecurityVerdict(evidence, blocking, { module: value.module ?? null, now });
  const extra = {
    ...(Array.isArray(value.warnings) ? { warnings: value.warnings.filter(w => !securityWarning(w)) } : {}),
    // known losses stay named, but their repair is no way out of a security warning
    ...(value.outcome === 'incomplete' || value.gate === 'known_losses' ? { knownLosses: { missing: value.missing ?? [], gate: value.gate ?? null } } : {}),
    judgedBy: 'server', verdictRecorded: !!verdict,
  };
  return securityRefusal(blocking, { module: value.module ?? null, extra });
}

// A publication of a manifest whose merge evidence holds a security warning: refused before the bridge. null: none.
export function publishSecurityRefusal(evidence, { module = null } = {}) {
  const blocking = evidenceSecurity(evidence);
  if (!blocking.length) return null;
  return { ...securityRefusal(blocking, { module }), executed: false, merged: true,
    error: 'The last SSAM merge of ' + (module ?? 'this module') + ' brought new security warning(s) (' + named(blocking).join(', ') + '); SSAM does not publish it. ' + securityFixes(blocking).map(f => f.kind + ': ' + f.fix + '.').join(' ') };
}
