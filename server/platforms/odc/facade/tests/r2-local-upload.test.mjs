import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
test('R2 local upload requires both the flag and the advertised capability', async () => {
  const { localUploadEnabled, localFilePath } = await import('../hosted/local-upload.mjs');
  assert.equal(localUploadEnabled({ agent: { supports: () => true } }, {}), false);
  assert.equal(localUploadEnabled({ agent: { supports: () => false } }, { SSAM_LOCAL_UPLOAD: '1' }), false);
  assert.equal(localUploadEnabled({ agent: { supports: k => k === 'file.upload' } }, { SSAM_LOCAL_UPLOAD: '1' }), true);
  for (const p of ['relative.txt', 'local:C:\\data\\..\\private.txt', 'local:\\\\server\\share.txt']) assert.throws(() => localFilePath(p));
});
test('R2 local upload receives a hash-checked blob without reading the local source', async t => {
  const { uploadLocalFile } = await import('../hosted/local-upload.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-upload-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = process.env.SSAM_LOCAL_UPLOAD; process.env.SSAM_LOCAL_UPLOAD = '1'; t.after(() => old === undefined ? delete process.env.SSAM_LOCAL_UPLOAD : process.env.SSAM_LOCAL_UPLOAD = old);
  fs.mkdirSync(path.join(dir, 'inbox'));
  const bytes = Buffer.from('example'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const calls = [];
  const context = { workspace: dir, agent: { supports: () => true, call: async (kind, args) => { calls.push({ kind, args }); return { blob: { sha256, size: bytes.length } }; } },
    executor: { mirror: { receive: async (_, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes); } } } };
  const dest = await uploadLocalFile(context, 'local:C:\\Approved\\rows.csv');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'example');
  assert.equal(calls[0].kind, 'file.upload');
  assert.equal(calls[0].args.path, 'C:\\Approved\\rows.csv');
  context.executor.mirror.receive = async (_, dest) => fs.writeFileSync(dest, 'tampered');
  await assert.rejects(uploadLocalFile(context, 'local:C:\\Approved\\rows.csv'), { code: 'AGENT_PROTOCOL_VIOLATION' });
});
