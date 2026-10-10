// Standing grants (contract I6 of docs/PACOTE-SESSOES-NOVO.md): the user's own words, given once, authorize a verb
// (deliver, publish) on an application, or on some of its modules, until revoked. One JSON file per workspace,
// <workspaceRoot>/.local/grants/standing-grants.json (outside git; ssam_evidence redacts "words"). The words are kept
// verbatim because a delivery or publication that uses the grant journals them exactly as when the person typed them
// (only their sha256 leaves this file); every answer and listing shows wordsSha256 instead.
//
// The words must name the application as whole words, case-insensitive (the rule of studio-create-app.mjs namesWhole):
// "pode publicar o QuizLive" does not name "QuizLive Core". A grant without that is refused with
// GRANT_WORDS_MUST_NAME_APP; nothing is written.
//
// Matching (findGrant): same lane, the verb among the grant's verbs, and
//   - the app named (case-insensitive) with modules '*' or listing the module (the O11 tools take the app of a module
//     from the environment inventory), or
//   - the module listed explicitly in the grant (no app known, or another app).
// Module and app names compare by letters and digits (a label "GameStore CS" is the module GameStore_CS).
// The newest matching grant wins. Revoking removes the grant from the file.
//
// Hosted (the SSAM server answering a customer, executor.mjs): the file is the customer's own,
// <ws>/state/grants/standing-grants.json, outside the area tools read back (state/ is internal). One customer's grant never
// authorizes another customer or the owner, and the owner's grants never authorize a customer. A served process without a
// hosted context fails closed (HOSTED_CONTEXT_LOST) instead of reading the owner's file.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { usesWorkspace, workspacePath } from './executor.mjs';

export const GRANTS_SCHEMA = 'ssam-standing-grants/1';
export const GRANT_VERBS = Object.freeze(['deliver', 'publish']);
export const GRANT_LANES = Object.freeze(['o11', 'odc']);

const sha256 = text => createHash('sha256').update(String(text), 'utf8').digest('hex');
const iso = now => (typeof now === 'function' ? now() : now ?? new Date()).toISOString();
const squash = name => String(name ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const sameName = (a, b) => squash(a) !== '' && squash(a) === squash(b);
const placeholder = words => /^<[^>]*>$/.test(String(words ?? '').trim());

export function grantsFile(root = workspaceRoot) {
  return usesWorkspace(root, workspaceRoot) ? workspacePath('state', 'grants', 'standing-grants.json') : path.join(root, '.local', 'grants', 'standing-grants.json');
}

// The words name the app as whole words, case-insensitive; spaces in the name match any run of spaces.
export const namesApp = (words, app) => typeof words === 'string' && typeof app === 'string' && app.trim() !== ''
  && new RegExp('(?<![\\p{L}\\p{N}_])' + app.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '(?![\\p{L}\\p{N}_])', 'iu').test(words);

function read(file) {
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return { schema: GRANTS_SCHEMA, grants: Array.isArray(document?.grants) ? document.grants.filter(g => g && typeof g === 'object') : [] };
  } catch (error) {
    if (error?.code === 'ENOENT') return { schema: GRANTS_SCHEMA, grants: [] };
    throw new Error('The standing grants file cannot be read: ' + file + ' (' + error.message + ')');
  }
}
function write(file, document) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ schema: GRANTS_SCHEMA, grants: document.grants }, null, 2));
  fs.renameSync(temporary, file);
}

// What an answer may show: never the words.
export const publicGrant = grant => {
  if (!grant) return null;
  const { words: _words, ...rest } = grant;
  return { ...rest, wordsSha256: grant.wordsSha256 ?? (grant.words ? sha256(grant.words) : null) };
};

const fileOf = options => options?.file ?? grantsFile();

export function addGrant({ lane, app, modules = '*', verbs = GRANT_VERBS, words } = {}, { file, now } = {}) {
  const invalid = error => ({ ok: false, code: 'GRANT_INVALID', error });
  if (!GRANT_LANES.includes(lane)) return invalid('lane must be one of ' + GRANT_LANES.join(', '));
  if (typeof app !== 'string' || !app.trim()) return invalid('app is required: the application the grant covers');
  const scope = modules === '*' || modules == null ? '*' : Array.isArray(modules) && modules.length && modules.every(m => typeof m === 'string' && m.trim())
    ? [...new Set(modules.map(m => m.trim()))] : null;
  if (!scope) return invalid('modules is "*" or a non-empty list of module names');
  const granted = Array.isArray(verbs) && verbs.length ? [...new Set(verbs)] : null;
  if (!granted || granted.some(v => !GRANT_VERBS.includes(v))) return invalid('verbs is a non-empty list of ' + GRANT_VERBS.join(', '));
  if (typeof words !== 'string' || !words.trim() || placeholder(words)) return invalid('words: the user\'s own words, verbatim');
  if (!namesApp(words, app)) return { ok: false, code: 'GRANT_WORDS_MUST_NAME_APP', error: 'The user\'s words must name the app "' + app.trim() + '" as written.' };
  const target = fileOf({ file });
  const document = read(target);
  const grant = { grantId: randomUUID(), lane, app: app.trim(), modules: scope, verbs: granted, words, wordsSha256: sha256(words), grantedAt: iso(now) };
  document.grants.push(grant);
  write(target, document);
  return { ok: true, grant: publicGrant(grant) };
}

// The newest grant that covers {lane, app?, module?, verb}, with its words (for the journal and the authorization of
// the call that uses it); null when none does.
export function findGrant({ lane, app, module, verb } = {}, { file } = {}) {
  if (!GRANT_LANES.includes(lane) || !GRANT_VERBS.includes(verb) || (!app && !module)) return null;
  const covers = grant => {
    if (grant.lane !== lane || !Array.isArray(grant.verbs) || !grant.verbs.includes(verb) || typeof grant.words !== 'string') return false;
    const listed = Array.isArray(grant.modules) && module != null && grant.modules.some(m => sameName(m, module));
    if (app && sameName(grant.app, app)) return grant.modules === '*' || module == null || listed;
    return listed;
  };
  const found = read(fileOf({ file })).grants.filter(covers).sort((a, b) => String(b.grantedAt).localeCompare(String(a.grantedAt)));
  return found[0] ?? null;
}

export function revokeGrant(selector = {}, { file } = {}) {
  const target = fileOf({ file });
  const document = read(target);
  const matches = grant => selector.grantId ? grant.grantId === selector.grantId
    : GRANT_LANES.includes(selector.lane) && selector.app ? grant.lane === selector.lane && sameName(grant.app, selector.app) : false;
  if (!selector.grantId && !(selector.lane && selector.app)) return { ok: false, code: 'GRANT_INVALID', error: 'revoke takes grantId, or lane and app' };
  const kept = document.grants.filter(g => !matches(g));
  const revoked = document.grants.length - kept.length;
  if (revoked) write(target, { grants: kept });
  return { ok: true, revoked };
}

export function listGrants({ lane } = {}, { file } = {}) {
  const grants = read(fileOf({ file })).grants.filter(g => !lane || g.lane === lane)
    .sort((a, b) => String(b.grantedAt).localeCompare(String(a.grantedAt))).map(publicGrant);
  return { ok: true, grants };
}

// The words a call runs with: the user's words when given, else the standing grant that covers it. authorization is
// set only when a grant was used (section 3.2: {source:"standing-grant", grantId}).
export function wordsFor({ authorize, lane, app, module, verb }, grants = { findGrant }, options = {}) {
  const given = typeof authorize === 'string' ? authorize : '';
  if (given.trim() && !placeholder(given)) return { words: given };
  let grant = null;
  try { grant = grants?.findGrant?.({ lane, app, module, verb }, options) ?? null; } catch { grant = null; }
  return grant ? { words: grant.words, authorization: { source: 'standing-grant', grantId: grant.grantId } } : { words: '' };
}
