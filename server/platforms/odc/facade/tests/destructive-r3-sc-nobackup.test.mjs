import './fixtures/isolated-profile.mjs';
// CX15 r3, CT-7 (subagent SC): a preview whose items go WITHOUT a backup (M5: the O11 CLI not built or the selected
// Studio gone; an application with no module; an extension, whose .xif is not backed up yet; a solution, whose definition
// is not exported) says so where the model reads what to tell the owner: next, confirmWith and the error of
// CONFIRMATION_REQUIRED say "N item(s) will be deleted WITHOUT a backup (<reason>): tell the owner" (and the extensions
// inside items that are backed up otherwise). The execution keeps M5: it follows the preview (deletes without a backup
// what the preview showed without one). The prerequisites are injected, so this runs the same with and without the CLI
// built. Offline: fake bridge, fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_MIN_AGE_MS } from '../destructive-operations.mjs';
import { registerO11Extension } from '../o11-extension.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { PERSONAL, engineWorld, pageWorld, tools } from './fixtures/r3-sc-world.mjs';

const CLI_NOT_BUILT = async () => ({ code: 'CLI_NOT_BUILT', why: 'the O11 Anvil CLI of this lane is not built, so the published OML cannot be downloaded' });
const texts = answer => ({ next: answer.next, confirmWith: answer.confirmWith, error: answer.error });

test('CT-7: without the backup prerequisites the preview says in next, confirmWith and the error how many items go WITHOUT a backup and why; the execution deletes them without a download', async () => {
  const w = engineWorld({ names: ['A', 'B', 'C'], modules: { A: 2, B: 1 } });
  const downloads = [];
  const t = tools(w, { backupReady: CLI_NOT_BUILT, backup: async item => { downloads.push(item.name); return { files: [] }; } });
  const preview = await t.call({ action: 'delete', host: PERSONAL, prefix: 'ZZC', words: 'ok apaga os apps zzc' });
  assert.deepEqual([preview.code, preview.state, preview.count], ['CONFIRMATION_REQUIRED', 'previewed', 3], JSON.stringify(preview).slice(0, 300));
  const note = /3 items will be deleted WITHOUT a backup \(the O11 CLI of this lane is not built; the application has no module to back up\): tell the owner/;
  for (const [field, value] of Object.entries(texts(preview))) assert.match(String(value), note, field + ' says it: ' + value);
  // The note is a text of the server: copied as the owner's words it never confirms.
  w.clock.advance(CONFIRM_MIN_AGE_MS);
  const copied = await t.call({ action: 'delete', host: PERSONAL, confirmationToken: preview.confirmationToken, words: '3 items will be deleted WITHOUT a backup (the O11 CLI of this lane is not built; the application has no module to back up): tell the owner ZZC' });
  assert.ok(copied.problems?.some(p => p.code === 'WORDS_BEFORE_PREVIEW'), JSON.stringify(copied.problems?.map(p => p.code)));
  const done = await t.call({ action: 'delete', host: PERSONAL, confirmationToken: preview.confirmationToken, words: 'sim, apaga os 3 ZZC mesmo sem backup' });
  assert.deepEqual([done.state, w.sends().length, downloads], ['confirmed', 3, []], JSON.stringify(done).slice(0, 300));
});

test('CT-7: a preview whose items all have their backup says nothing of it (passes before and after, on purpose)', async () => {
  const w = engineWorld({ names: ['A', 'B'], modules: { A: 1, B: 1 } });
  const t = tools(w, { backupReady: async () => null });
  const preview = await t.call({ action: 'delete', host: PERSONAL, prefix: 'ZZC', words: 'ok apaga os apps zzc' });
  for (const value of Object.values(texts(preview))) assert.doesNotMatch(String(value), /without a backup/i);
});

test('CT-7: extensions inside a backed-up application and an extension deleted alone are said to go without a backup (.xif)', async () => {
  const w = engineWorld({ names: ['A'], modules: { A: 1 }, extensions: { A: 2 } });
  const t = tools(w, { backupReady: async () => null });
  const app = await t.call({ action: 'delete', host: PERSONAL, prefix: 'ZZC' });
  assert.match(app.next, /2 extensions inside backed-up items go without a backup \(an extension \(\.xif\) is not backed up yet\): tell the owner/);
  assert.match(app.confirmWith, /2 extensions inside backed-up items/);
  // o11_extension delete: the extension itself goes without a backup; its continuation says so too.
  const handlers = {};
  registerO11Extension({ registerTool: (name, config, handler) => { handlers[name] = handler; } },
    { serviceCenter: (argv, extra) => runServiceCenter(argv, w.deps({ backupReady: async () => null, ...extra })), destructiveRoot: w.root });
  const ext = (await handlers.o11_extension({ action: 'delete', host: PERSONAL, extension: 'ZZCAExt1' })).structuredContent;
  assert.equal(ext.state, 'previewed', JSON.stringify(ext).slice(0, 300));
  assert.match(ext.next, /1 item will be deleted WITHOUT a backup \(an extension \(\.xif\) is not backed up yet\): tell the owner/);
  assert.match(ext.confirmWith, /WITHOUT a backup/);
  assert.match(ext.continuation?.why ?? '', /WITHOUT a backup/);
});

test('CT-7 (page delete): a solution goes without a backup and its preview says so in next, confirmWith, the error and the continuation; a connection (backed up) says nothing', async () => {
  const w = pageWorld();
  const solution = await w.run('solution-delete', ['--words', 'apaga a solution Billing']);
  assert.deepEqual([solution.code, solution.state], ['CONFIRMATION_REQUIRED', 'previewed'], JSON.stringify(solution).slice(0, 300));
  for (const [field, value] of Object.entries(texts(solution)))
    assert.match(String(value), /1 item will be deleted WITHOUT a backup \(its definition is not exported here \(to confirm\)\): tell the owner/, field + ': ' + value);
  assert.match(solution.continuation.why, /WITHOUT a backup/);
  const connection = await w.run('db-connection-delete', ['--words', 'apaga a conexao LegacyERP']);
  for (const value of Object.values(texts(connection))) assert.doesNotMatch(String(value), /without a backup/i);
});
