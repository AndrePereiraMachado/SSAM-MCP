import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { selectedO11Compiler } from '../debug-o11-compiler.mjs';

test('compiler selection preserves default and accepts only pinned successful native evidence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-compiler-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const dir=path.join(root,'.local/debugger');fs.mkdirSync(dir,{recursive:true});
  const inputs={source:'current',sdk:'native'},bundle={assemblyPath:path.join(dir,'anvil.dll'),hash:'qualified'};
  const options={root,fingerprint:async()=>inputs,packageFingerprint:async()=>bundle};
  assert.equal(await selectedO11Compiler('sdk','default',options),'default');
  const pin=p=>({path:p,sha256:createHash('sha256').update(fs.readFileSync(p)).digest('hex')});
  const candidate=path.join(dir,'candidate.oml');fs.writeFileSync(candidate,'native-fixture');
  const proof=path.join(dir,'apply.json');
  fs.writeFileSync(proof,JSON.stringify({ok:true,command:'apply',data:{accepted:true,isValid:true,dataContract:{accepted:true},outPath:candidate}}));
  const selection={schema:'ssam-o11-compiler-selection/1',capability:'apply',inputs,package:bundle,nativeApply:pin(proof),candidate:pin(candidate)};
  const file=path.join(dir,'o11-compiler-selection.json');fs.writeFileSync(file,JSON.stringify(selection));
  assert.equal(await selectedO11Compiler('sdk','default',options),bundle.assemblyPath);
  await assert.rejects(selectedO11Compiler('sdk','default',{...options,fingerprint:async()=>({source:'changed'})}),/selection_invalid/);
  await assert.rejects(selectedO11Compiler('sdk','default',{...options,packageFingerprint:async()=>({...bundle,hash:'changed'})}),/selection_invalid/);
  fs.writeFileSync(candidate,'modified');await assert.rejects(selectedO11Compiler('sdk','default',options),/selection_invalid/);
  fs.writeFileSync(candidate,'native-fixture');fs.writeFileSync(proof,JSON.stringify({ok:true,command:'apply',data:{accepted:false,isValid:true}}));
  selection.nativeApply=pin(proof);fs.writeFileSync(file,JSON.stringify(selection));
  await assert.rejects(selectedO11Compiler('sdk','default',options),/selection_invalid/);
});
