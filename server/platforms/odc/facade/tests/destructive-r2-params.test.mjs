import './fixtures/isolated-profile.mjs';
// CX15 r2, the provisional parameters (to confirm with the owner): a preview is confirmed within 30 min, never sooner
// than 5 s; words seen on a host are refused for 24 h, and the seen-words folder is pruned (one file per day; the days
// older than the window go, L5); the count is required even for one item; an ODC data preview reads at most 10000 rows.
// Offline: temporary roots, a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ops from '../destructive-operations.mjs';
import { DATA_PREVIEW_MAX_ROWS } from '../data-delete-gate.mjs';

const HOST = 'personal-r2params.outsystemscloud.com';
const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-10-15T12:00:00Z');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const files = root => { try { return fs.readdirSync(path.join(root, 'seen-words'), { recursive: true }).map(String).sort(); } catch { return []; } };

test('provisional parameters: 30 min, 5 s, 24 h, the count even for one item, 10000 rows', () => {
  assert.deepEqual([ops.PREVIEW_TTL_MS, ops.CONFIRM_MIN_AGE_MS, ops.SEEN_WORDS_WINDOW_MS, DATA_PREVIEW_MAX_ROWS], [30 * 60000, 5000, DAY, 10000]);
  assert.equal(ops.countProblem('sim, pode apagar ZZ One', 1, ['ZZ One'])?.code, 'CONFIRMATION_COUNT_MISMATCH', 'one item still needs the number');
  assert.equal(ops.countProblem('sim, pode apagar o 1, ZZ One', 1, ['ZZ One']), null);
});

test('L5: the seen-words of a host are one file per day, pruned past the window; the words of before still count within 24 h', () => {
  const root = tmp('cx15r2-seen-');
  try {
    ops.noteWords({ host: HOST, tool: 't', words: 'apaga os testes', now: T0, root });
    ops.noteWords({ host: HOST, tool: 't', words: 'pode apagar os 2', now: T0 + DAY - 3600000, root });
    assert.deepEqual(files(root), [HOST, path.join(HOST, '2026-10-15.jsonl'), path.join(HOST, '2026-10-16.jsonl')].sort());
    const seen = ops.seenWords({ host: HOST, now: T0 + DAY - 60000, root });
    assert.ok(seen.has(ops.wordsSha256('apaga os testes')) && seen.has(ops.wordsSha256('pode apagar os 2')), 'both within 24 h, across two day files');
    // Two days later a note prunes the day files older than the window.
    ops.noteWords({ host: HOST, tool: 't', words: 'outra frase', now: T0 + 2 * DAY + 3600000, root });
    assert.ok(!files(root).includes(path.join(HOST, '2026-10-15.jsonl')), 'the day older than the window is gone: ' + files(root).join(', '));
    assert.equal(ops.seenWords({ host: HOST, now: T0 + 2 * DAY + 3600000, root }).has(ops.wordsSha256('apaga os testes')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('L5: the single file of before is still read within the window and removed once all of it is older', () => {
  const root = tmp('cx15r2-seen-legacy-');
  try {
    const legacy = path.join(root, 'seen-words', HOST + '.jsonl');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ at: new Date(T0).toISOString(), tool: 't', sha256: ops.wordsSha256('frase antiga') }) + '\n');
    assert.ok(ops.seenWords({ host: HOST, now: T0 + 3600000, root }).has(ops.wordsSha256('frase antiga')));
    ops.noteWords({ host: HOST, tool: 't', words: 'nova', now: T0 + 3600000, root });
    assert.ok(fs.existsSync(legacy), 'kept while it has lines within the window');
    ops.noteWords({ host: HOST, tool: 't', words: 'mais nova', now: T0 + DAY + 3600000, root });
    assert.equal(fs.existsSync(legacy), false, 'removed once all of it is older than the window');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('L5: words said before the preview are refused with the rule that the reply must be a new sentence', () => {
  const root = tmp('cx15r2-seen-refusal-');
  try {
    ops.noteWords({ host: HOST, tool: 'o11_service_center_write', words: 'sim, apaga o 1, ZZ One', now: T0, root });
    const block = ops.createPreview({ tool: 'o11_service_center_write', lane: 'o11', host: HOST, operation: 'delete', items: [{ kind: 'application', key: 'a-1', name: 'ZZ One' }], now: T0 + 1000, root });
    const check = ops.checkExecute({ token: block.confirmationToken, tool: 'o11_service_center_write', host: HOST, operation: 'delete', words: 'sim, apaga o 1, ZZ One', now: T0 + 60000, root });
    const before = check.problems.find(p => p.code === 'WORDS_BEFORE_PREVIEW');
    assert.ok(before, JSON.stringify(check.problems.map(p => p.code)));
    assert.match(before.message, /refused for 24 h on this host: the reply must be a new one/);
    assert.match(before.fix, /a new sentence/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
