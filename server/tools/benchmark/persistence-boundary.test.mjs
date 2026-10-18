// N4c + X1: every persistence boundary (ledger, --md, --json) is checked before any write, in one refusal.
// Exercised through the CLIs as child processes, with a synthetic USERPROFILE and synthetic values only.
import '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {privacyIssues} from './privacy.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),ledgerCli=path.join(here,'speed-ledger.mjs'),analyzeCli=path.join(here,'analyze.mjs');
const owner='synthetic-owner',secret='synthetic-secret',tenant='personal-'+'z'.repeat(8);
const at=second=>new Date(Date.UTC(2026,0,1,10,0,second)).toISOString();
function temporary(run){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx10-boundary-'));try{return run(dir);}finally{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}}
const homeOf=dir=>{const home=path.join(dir,'home',owner);fs.mkdirSync(home,{recursive:true});return home;};
function cli(dir,script,args){const home=homeOf(dir),r=spawnSync(process.execPath,[script,...args],{cwd:dir,encoding:'utf8',env:{...process.env,USERPROFILE:home,HOME:home,HOMEDRIVE:'',HOMEPATH:''}});return {status:r.status,stdout:r.stdout,stderr:r.stderr};}
const sha=file=>fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):'absent';
function codexSession(dir,id,cwd,tag){const sessions=path.join(dir,'codex','archived_sessions');fs.mkdirSync(sessions,{recursive:true});fs.mkdirSync(cwd,{recursive:true});const rows=[{timestamp:at(0),type:'session_meta',payload:{id,cwd}},{timestamp:at(0),type:'event_msg',payload:{type:'task_started',turn_id:'turn'}},{timestamp:at(0),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'[BenchSSAM case='+tag+' lane=o11]'}]}},{timestamp:at(2),type:'event_msg',payload:{type:'task_complete',turn_id:'turn'}}];fs.writeFileSync(path.join(sessions,id+'.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');}
// Claude session inside the synthetic home: the prompt carries a typed credential and a subagent file sits under the home.
function claudeSession(home){const project=path.join(home,'.claude','projects','synthetic-project'),file=path.join(project,'session.jsonl'),cwd=path.join(home,'work','demo');fs.mkdirSync(path.join(project,'session','subagents'),{recursive:true});
 const main=[{timestamp:at(0),type:'user',cwd,sessionId:'session',message:{content:[{type:'text',text:'abrir modulo demo senha '+secret}]}},{timestamp:at(1),type:'assistant',cwd,sessionId:'session',message:{id:'m1',model:'model-x',usage:{output_tokens:10},content:[{type:'tool_use',id:'call',name:'mcp__ssam__studio_deliver',input:{}}]}},{timestamp:at(3),type:'user',cwd,sessionId:'session',message:{content:[{type:'tool_result',tool_use_id:'call',content:'{"ok":true,"outcome":"delivered"}'}]}},{timestamp:at(9),type:'assistant',cwd,sessionId:'session',message:{id:'m2',model:'model-x',usage:{output_tokens:5},content:[{type:'text',text:'ok'}]}}];
 const child=[{timestamp:at(2),type:'assistant',isSidechain:true,agentId:'helper',sessionId:'session',message:{id:'c1',model:'model-x',usage:{output_tokens:3},content:[{type:'text',text:'child'}]}}];
 fs.writeFileSync(file,main.map(r=>JSON.stringify(r)).join('\n')+'\n');fs.writeFileSync(path.join(project,'session','subagents','agent-helper.jsonl'),child.map(r=>JSON.stringify(r)).join('\n')+'\n');return {file,relative:'.claude/projects/synthetic-project/session.jsonl'};}
function casesSpec(dir,name){const file=path.join(dir,'cases.json');fs.writeFileSync(file,JSON.stringify({schema:'ssam-benchmark-cases/1',cases:[{name,client:'claude',file:'.claude/projects/synthetic-project/session.jsonl',start:at(0),end:at(9),metrics:[{metric:'rounds',value:1,tolerance:0,source:'synthetic'}]}]}));return file;}
const oldRow=()=>({schema:'ssam-speed-ledger/1',key:'codex:old:turn',client:'codex',workspace:owner,case:'C1',wallSec:10,lanes:{o11:{writes:0},odc:{writes:0}}});
const keysOf=value=>Array.isArray(value)?value.flatMap(keysOf):value&&typeof value==='object'?Object.entries(value).flatMap(([k,v])=>[k,...keysOf(v)]):[];
// An export either is absent because the run was refused, or carries no home name, credential or source path.
function assertNoLeak(dir,r,files){const tmp=JSON.stringify(dir).slice(1,-1);for(const file of files){const name=path.basename(file);if(!fs.existsSync(file)){assert.notEqual(r.status,0,name+' absent only after a refusal');continue;}const text=fs.readFileSync(file,'utf8');for(const [what,value] of [['home name',owner],['credential',secret],['source path',dir],['escaped source path',tmp]])assert.ok(!text.includes(value),name+' persists the '+what);assert.deepEqual(privacyIssues(name.endsWith('.json')?JSON.parse(text):text),[],name+' privacy labels');}for(const value of [owner,secret,dir])assert.ok(!(r.stdout+r.stderr).includes(value),'console output carries a private value');}

test('N4c measure --ledger: one refusal names the dirty existing row, the dirty new row and both exports; nothing is written',()=>temporary(dir=>{
 const ws=name=>path.join(dir,'ws',name);codexSession(dir,'dirty',ws('projdirty'),'C--Users-'+owner+'-proj');codexSession(dir,'clean',ws('projclean'),'C1');
 const ledger=path.join(dir,'ledger.jsonl'),md=path.join(dir,'out.md'),json=path.join(dir,'out.json');fs.writeFileSync(ledger,JSON.stringify(oldRow())+'\n');const before=sha(ledger);
 const r=cli(dir,ledgerCli,['measure','--workspace',ws('projdirty'),'--workspace',ws('projclean'),'--since','2026-01-01T00:00:00Z','--codex-home',path.join(dir,'codex'),'--claude-home',path.join(dir,'empty'),'--ledger',ledger,'--md',md,'--json',json]);
 assert.equal(r.status,1);assert.equal((r.stderr.match(/Private identifier rejected/g)??[]).length,1,'exactly one refusal');
 assert.match(r.stderr,/linhas existentes:\r?\nkey=codex:old:turn field=workspace label=user-workspace/);
 assert.match(r.stderr,/linhas novas ou substituídas:\r?\nkey=codex:dirty:turn field=case label=user-path/);
 assert.match(r.stderr,/target=--md:out\.md field=\S+ label=user-path/);assert.match(r.stderr,/target=--json:out\.json field=\S+ label=user-path/);
 assert.match(r.stderr,/Reparo disponível/);assert.ok(!r.stderr.includes('codex:clean:turn'),'clean row is not reported');
 for(const value of ['C--Users-',owner,dir])assert.ok(!r.stderr.includes(value),'refusal carries no source value');
 assert.equal(sha(ledger),before);for(const file of [md,json,ledger+'.tmp'])assert.equal(fs.existsSync(file),false,path.basename(file)+' written');
}));
test('N4c repair hint only when an existing row is dirty; without --ledger the new rows are still validated',()=>temporary(dir=>{
 const cwd=path.join(dir,'ws','projdirty');codexSession(dir,'dirty',cwd,'C--Users-'+owner+'-proj');const base=['measure','--workspace',cwd,'--since','2026-01-01T00:00:00Z','--codex-home',path.join(dir,'codex'),'--claude-home',path.join(dir,'empty')];
 const fresh=path.join(dir,'fresh.jsonl'),withLedger=cli(dir,ledgerCli,[...base,'--ledger',fresh]),without=cli(dir,ledgerCli,base);
 for(const r of [withLedger,without]){assert.equal(r.status,1);assert.match(r.stderr,/key=codex:dirty:turn field=case label=user-path/);assert.ok(!r.stderr.includes('linhas existentes'));assert.ok(!r.stderr.includes('Reparo disponível'),'repair hint without a dirty existing row');}
 assert.equal(fs.existsSync(fresh),false);
}));
test('N4c cases --ledger: dirty existing row, dirty case name and exports share one refusal; nothing is written',()=>temporary(dir=>{
 claudeSession(homeOf(dir));const spec=casesSpec(dir,tenant),ledger=path.join(dir,'ledger.jsonl'),md=path.join(dir,'cases.md'),json=path.join(dir,'cases-out.json');fs.writeFileSync(ledger,JSON.stringify(oldRow())+'\n');const before=sha(ledger);
 const r=cli(dir,ledgerCli,['cases','--cases',spec,'--ledger',ledger,'--md',md,'--json',json]);
 assert.equal(r.status,1);assert.equal((r.stderr.match(/Private identifier rejected/g)??[]).length,1,'exactly one refusal');
 assert.match(r.stderr,/linhas existentes:\r?\nkey=codex:old:turn field=workspace label=user-workspace/);assert.match(r.stderr,/linhas novas ou substituídas:(?:\r?\nkey=\S+ field=\S+ label=\S+)*\r?\nkey=row-1 field=case label=tenant/);
 assert.match(r.stderr,/target=--md:cases\.md field=\S+ label=tenant/);assert.match(r.stderr,/target=--json:cases-out\.json field=\S+ label=tenant/);
 for(const value of [tenant,owner,secret,dir])assert.ok(!r.stderr.includes(value),'refusal carries no source value');
 assert.equal(sha(ledger),before);for(const file of [md,json,ledger+'.tmp'])assert.equal(fs.existsSync(file),false,path.basename(file)+' written');
}));
test('X1 cases --json/--md persist neither the home name nor the typed credential',()=>temporary(dir=>{
 claudeSession(homeOf(dir));const md=path.join(dir,'cases.md'),json=path.join(dir,'cases-out.json'),r=cli(dir,ledgerCli,['cases','--cases',casesSpec(dir,'S'),'--json',json,'--md',md]);assertNoLeak(dir,r,[json,md]);
}));
test('X1 analyze --json/--md persist neither the home name nor the typed credential',()=>temporary(dir=>{
 const {file}=claudeSession(homeOf(dir)),md=path.join(dir,'analyze.md'),json=path.join(dir,'analyze.json'),r=cli(dir,analyzeCli,['--claude',file,'--json',json,'--md',md]);assertNoLeak(dir,r,[json,md]);
}));
test('X1 declared export format: measured fields only, without file or prompt; Markdown shows case and no file column',()=>temporary(dir=>{
 const {file}=claudeSession(homeOf(dir)),files=Object.fromEntries(['cases.md','cases.json','analyze.md','analyze.json'].map(name=>[name,path.join(dir,name)]));
 const cases=cli(dir,ledgerCli,['cases','--cases',casesSpec(dir,'S'),'--json',files['cases.json'],'--md',files['cases.md']]),analyze=cli(dir,analyzeCli,['--claude',file,'--json',files['analyze.json'],'--md',files['analyze.md']]);
 assert.equal(cases.status,0,cases.stderr);assert.equal(analyze.status,0,analyze.stderr);
 const casesJson=JSON.parse(fs.readFileSync(files['cases.json'],'utf8')),analyzeJson=JSON.parse(fs.readFileSync(files['analyze.json'],'utf8'));
 for(const data of [casesJson,analyzeJson])for(const key of ['file','prompt'])assert.ok(!keysOf(data).includes(key),'export keeps '+key);
 assert.equal(casesJson[0].request.case,'S');assert.equal(casesJson[0].checks[0].measured,1);assert.equal(casesJson[0].checks[0].situation,'passou');
 assert.equal(analyzeJson[0].subagents.length,1);assert.equal(analyzeJson[0].subagents[0].name,'helper');assert.equal(analyzeJson[0].promptSha256.length,64);
 const md=fs.readFileSync(files['analyze.md'],'utf8');assert.match(md,/^\| id \| client \| model \| case \| start \|/m);assert.ok(!/\| prompt \|/.test(md));assert.match(md,/^\| Nome \| Min \|/m);assert.ok(!md.includes('Arquivo'));
}));
test('X1 guard stays as safety net: a dirty measured field refuses every export at once, without values, writing nothing',()=>temporary(dir=>{
 const {file}=claudeSession(homeOf(dir)),md=path.join(dir,'analyze.md'),json=path.join(dir,'analyze.json');
 const r=cli(dir,analyzeCli,['--claude',file,'--window',tenant+'='+at(0)+'/'+at(9),'--json',json,'--md',md]);
 assert.equal(r.status,1);assert.equal((r.stderr.match(/Private identifier rejected/g)??[]).length,1,'exactly one refusal');
 assert.match(r.stderr,/target=--json:analyze\.json field=0\/id label=tenant/);assert.match(r.stderr,/target=--md:analyze\.md field=linha-\d+\/id label=tenant/);
 for(const value of [tenant,owner,secret,dir])assert.ok(!r.stderr.includes(value),'refusal carries no source value');
 for(const output of [md,json])assert.equal(fs.existsSync(output),false,path.basename(output)+' written');
}));
