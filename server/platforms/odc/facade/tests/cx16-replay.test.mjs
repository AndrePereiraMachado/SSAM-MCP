import './fixtures/isolated-profile.mjs';
// CX16 W8 (§7.8 M2): the replay of the corrections of 13-14/10 on copies of the owner's jobs (SSAM_CX16_DATA, never
// versioned; run only with SSAM_CX16_REPLAY=1). Each next job of the DemoLATAM chain (checks 367f7d6c -> 85be19b2 ->
// dd6a5e21 -> a4be9066 -> delivered 3c09789a) and of the 8 blocks (254e6398 -> ... -> 3a2d82bd) is written as ONE ssam_code
// write over basedOn {job, sha256} of the job that ran (its kernel form): each changed text as {find, with} (one region with
// a context that is once in its element; a text rewritten end to end as its new text in the patch), the ops the transition
// adds or changes as the patch; writeCall makes it a patch
// (jobTextEdits) and resolvePatchedJob the job: it must be the next job exactly (ops equal after normalizeCodeOps), and the
// call smaller than the job it would have resent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeCall, normalizeCodeOps, headerOf, splitActions } from '../ssam-code.mjs';
import { resolvePatchedJob } from '../job-patch.mjs';

const DATA = process.env.SSAM_CX16_DATA;
const skip = process.env.SSAM_CX16_REPLAY !== '1' ? 'SSAM_CX16_REPLAY=1 runs the replay' : !DATA || !fs.existsSync(DATA) ? 'no SSAM_CX16_DATA' : false;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const ROOT = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:screen|block)\b[^>]*?\bname\s*=\s*"([^"]+)"/;

function textsOf(op) {
  if (!plain(op) || !plain(op.data)) return [];
  const d = op.data, list = [];
  if (op.op === 'spec' && typeof d.ddl === 'string') list.push({ at: '/data/ddl', element: 'ddl', text: d.ddl });
  if (op.op === 'logic' && Array.isArray(d.flow)) d.flow.forEach((f, j) => {
    const t = typeof f === 'string' ? f : plain(f) && typeof f.text === 'string' ? f.text : null;
    if (t == null) return;
    const h = (splitActions(t) ?? [t]).map(a => headerOf(a)).filter(Boolean)[0];
    list.push({ at: `/data/flow/${j}`, element: h ? (h.owner ? `${h.owner}.${h.name}` : h.name) : null, text: t });
  });
  if (op.op === 'html' && op.parent == null && typeof d.html === 'string' && ROOT.exec(d.html)) list.push({ at: '/data/html', element: ROOT.exec(d.html)[1], text: d.html });
  if (op.op === 'html' && typeof d.screen === 'string' && Array.isArray(d.edit)) d.edit.forEach((t, j) => list.push({ at: `/data/edit/${j}`, element: d.screen, text: t }));
  return list;
}
const shape = op => JSON.stringify(op, (k, v) => (typeof v === 'string' && v.length > 60 ? '<text>' : v));
const count = (s, f) => { let n = 0; for (let i = s.indexOf(f); i >= 0 && n < 2; i = s.indexOf(f, i + 1)) n++; return n; };

// One region from the first change to the last, grown until it is once in every text of its element.
function oneEdit(a, b, texts) {
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0; while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  let from = p, to = a.length - q, w = b.slice(p, b.length - q);
  const once = f => f.length > 0 && texts.reduce((n, t) => n + count(t, f), 0) === 1;
  while (!once(a.slice(from, to))) { if (from > 0) { from--; w = a[from] + w; } else { w += a[to]; to++; } }
  return { find: a.slice(from, to), with: w };
}

function chains() {
  const D = DATA;
  const blocks = path.join(D, 'blocks');
  const pick = p => path.join(blocks, fs.readdirSync(blocks).find(n => n.startsWith(p) && /^[0-9a-f-]+\.json$/.test(n)));
  return {
    demolatam: [...['367f7d6c-b3d1-48c8-99f4-71af0b32b9ba', '85be19b2-c2e6-4965-827f-cc104c9dcf37', 'dd6a5e21-818c-4835-8856-5cf1438b3b2b', 'a4be9066-0d4e-416b-b058-5cb5b346faa5']
      .map(id => path.join(D, 'demolatam', 'check', id, 'job.json')), path.join(D, 'demolatam', 'inline', '3c09789a-e1b0-42ed-9213-603ccff55e0f.json')],
    blocks: ['254e6398', 'ce9d8529', '6b8c3245', 'a0439f33', '3a2d82bd'].map(pick),
  };
}

test('every correction of the chains is one write of text edits that makes the next job exactly', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx16-replay-'));
  const rows = [];
  for (const [name, files] of Object.entries(chains())) {
    for (let k = 0; k + 1 < files.length; k++) {
      const base = normalizeCodeOps(read(files[k])).job, nextRaw = read(files[k + 1]), next = normalizeCodeOps(nextRaw).job;
      const baseFile = path.join(dir, `${name}-${k}.json`); fs.writeFileSync(baseFile, JSON.stringify(base));
      const sha256 = createHash('sha256').update(fs.readFileSync(baseFile)).digest('hex');
      const bOps = base.ops ?? base, nOps = next.ops ?? next, prefix = Array.isArray(base) ? '' : '/ops';
      const items = new Map(), patch = [];
      for (let i = 0; i < Math.max(bOps.length, nOps.length); i++) {
        const x = bOps[i], y = nOps[i];
        if (i >= bOps.length) { patch.push({ op: 'add', path: `${prefix}/-`, value: y }); continue; }
        if (i >= nOps.length) { patch.push({ op: 'remove', path: `${prefix}/${bOps.length - 1 - (i - nOps.length)}` }); continue; }
        if (JSON.stringify(x) === JSON.stringify(y)) continue;
        const tx = textsOf(x), ty = textsOf(y);
        if (shape(x) !== shape(y) || tx.length !== ty.length || tx.some((t, j) => t.at !== ty[j].at || !t.element || t.element !== ty[j].element)) { patch.push({ op: 'replace', path: `${prefix}/${i}`, value: y }); continue; }
        tx.forEach((t, j) => {
          if (t.text === ty[j].text) return;
          const all = bOps.flatMap(textsOf).filter(o => o.element?.toLowerCase() === t.element.toLowerCase()).map(o => o.text);
          const edit = oneEdit(t.text, ty[j].text, all);
          // A text rewritten from end to end (a rename across a document) is cheaper as the new text in the patch.
          if (edit.find.length + edit.with.length > ty[j].text.length) { patch.push({ op: 'replace', path: `${prefix}/${i}${t.at}`, value: ty[j].text }); return; }
          const list = items.get(t.element) ?? []; list.push(edit); items.set(t.element, list);
        });
      }
      const ordered = [...patch.filter(p => p.op !== 'remove'), ...patch.filter(p => p.op === 'remove').sort((a, b) => Number(b.path.split('/').pop()) - Number(a.path.split('/').pop()))];
      const [first, ...also] = [...items].map(([element, edits]) => ({ element, edits }));
      const args = { lane: 'o11', action: 'write', module: 'M', basedOn: { job: baseFile, sha256 }, ...(first ? { element: first.element, edits: first.edits } : {}),
        ...(also.length ? { also } : {}), ...(ordered.length ? { patch: ordered } : {}) };
      const call = writeCall(args);
      assert.equal(call.refusal, undefined, JSON.stringify(call.refusal)?.slice(0, 600));
      const resolved = resolvePatchedJob({ patch: call.arguments.patch, basedOn: call.arguments.basedOn }, { inlineDir: path.join(dir, 'inline') });
      assert.equal(resolved.ok, true, JSON.stringify(resolved).slice(0, 400));
      const got = normalizeCodeOps(read(resolved.path)).job;
      assert.deepEqual(got.ops ?? got, nOps, `${name} ${k} -> ${k + 1}`);
      const callBytes = Buffer.byteLength(JSON.stringify(args)), whole = Buffer.byteLength(JSON.stringify(nextRaw));
      rows.push({ name, k, whole, callBytes, ratio: +(callBytes / whole).toFixed(3) });
      assert.ok(callBytes < whole, `${name} ${k}: ${callBytes} B against ${whole} B`);
    }
  }
  console.log(JSON.stringify(rows));
});
