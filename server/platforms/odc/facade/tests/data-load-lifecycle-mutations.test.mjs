import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

// Semantic equivalents of review/mut/apply.mjs M2, M6 and M7. The close branch
// added in correction 4 changes M6's textual anchor, so it is mutated too.
const facade=fileURLToPath(new URL('../',import.meta.url));
const property=fileURLToPath(new URL('./data-load-lifecycle-property.test.mjs',import.meta.url));
function replaceOnce(text,from,to){assert.equal(text.split(from).length-1,1,`mutation anchor occurs once: ${from}`);return text.replace(from,to);}
const mutations={
  M2:{reason:/M2: failed rows recheck externally adopted keys|duplicate natural keys/,apply:text=>{
    text=replaceOnce(text,"return!entry||entry.state==='not-submitted'||entry.state==='failed';})) {","return!entry||entry.state==='not-submitted';})) {");
    return replaceOnce(text,"if(freshTarget&&(!prior||prior.state==='not-submitted'||prior.state==='failed')) {","if(freshTarget&&(!prior||prior.state==='not-submitted')) {");
  }},
  M6:{reason:/M6: full continuation retains original arguments/,apply:text=>{
    text=replaceOnce(text,"function closeContinuation(plan,input){return loadContinuation(withoutWords(plan?.resumeContinuation??{arguments:plan?.resumeInput??input}),{close:{preview:true}});}","function closeContinuation(plan,input){return{arguments:{...input,close:{preview:true}}};}");
    text=replaceOnce(text,"plan?.resumeContinuation??continuation??{arguments:plan?.resumeInput??input}","{arguments:input}");
    return replaceOnce(text,"previous.resumeContinuation??{arguments:previous.resumeInput??input}","{arguments:input}");
  }},
  // Review 5 U1: an overwrite sent without the owner's confirmation.
  U1:{reason:/U1: unconfirmed overwrite of an existing row/,apply:text=>replaceOnce(text,"const covered=transition=>{const granted=plan?.confirmedUpdates?.[transition.globalRow];return!!granted&&granted.id===transition.id&&granted.changesSha===fingerprint(transition.changes);};","const covered=()=>true;")},
  M7:{reason:/M7: native failure cannot poison reconciled completion|M7: current receipt is clean/,apply:text=>replaceOnce(text,
    "if(!reconciled.rows.length){prior.nativeHistory=[...(prior.nativeHistory??[]),{nativeOk:prior.nativeOk,code:prior.code,error:prior.error}];plan.notes.push({rule:'reconciled-native-outcome',batch:batch.batch});delete prior.nativeOk;delete prior.code;delete prior.error;",
    "if(!reconciled.rows.length){")}
};
for(const [name,mutation]of Object.entries(mutations))test(`property itself kills review mutation ${name}`,t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),`cx13-${name.toLowerCase()}-`));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  // servidor/fase4-26 a9: on the hosted line these modules also import the hosted context (./executor.mjs,
  // ./hosted/mirror.mjs). A relative import outside the copied files is read from the facade itself, so the copies
  // still form the one mutated graph and every other module is the real one.
  const copied=['data-load.mjs','data-load-lock.mjs','destructive-operations.mjs','data-files.mjs'];
  const outside=text=>text.replace(/(\bfrom\s*|\bimport\(\s*)(['"])(\.\.?\/[^'"]+)\2/g,(whole,head,quote,spec)=>copied.includes(spec.replace(/^\.\//,''))?whole:head+quote+pathToFileURL(path.join(facade,spec)).href+quote);
  for(const file of copied)fs.writeFileSync(path.join(root,file),outside(fs.readFileSync(path.join(facade,file),'utf8')));
  fs.writeFileSync(path.join(root,'data-load.mjs'),mutation.apply(fs.readFileSync(path.join(root,'data-load.mjs'),'utf8')));
  const childEnv={...process.env,CX13_PROPERTY_MODULE:path.join(root,'data-load.mjs'),CX13_PROPERTY_TRIALS:'16'};
  // A nested Node test runner otherwise suppresses its own discovery entirely.
  delete childEnv.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--test',property],{env:childEnv,encoding:'utf8',timeout:90000,windowsHide:true});
  assert.equal(result.error,undefined);assert.notEqual(result.status,0,`${name} survived the property: ${result.stdout}${result.stderr}`);
  const output=result.stdout+result.stderr;
  if(process.env.CX13_PROPERTY_MUTATION_EVIDENCE){fs.mkdirSync(process.env.CX13_PROPERTY_MUTATION_EVIDENCE,{recursive:true});fs.writeFileSync(path.join(process.env.CX13_PROPERTY_MUTATION_EVIDENCE,`${name}.tap`),output);}
  assert.match(output,mutation.reason,'killed by the behavioral property, not by import or infrastructure failure');
  assert.match(output,/(?:# |ℹ )fail 2(?:\r?\n|$)/,'the same generated property kills the mutation in BOTH lanes');
  assert.doesNotMatch(output,/ERR_MODULE_NOT_FOUND|SyntaxError|spawnSync.*ETIMEDOUT/);
  t.diagnostic(`CX13_MUTATION ${JSON.stringify({mutation:name,killed:true,propertyTrialsPerLane:16,status:result.status})}`);
});
