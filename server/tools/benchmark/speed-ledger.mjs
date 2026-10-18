import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {analyzeFiles} from './analyze.mjs';import {discoverSessions} from './measure/transcript-discovery.mjs';
export const REGRESSION_THRESHOLDS=Object.freeze({wallIncrease:.10,modelIncrease:.10,refusalIncrease:1,ssamInputPoints:5});
import {privacyIssues,privacyFindings,privateField,safeField,exportView,exportFindings,persistenceRefusal} from './privacy.mjs';
const escape=v=>String(v??'').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
const iso=v=>/^\d{4}-\d{2}-\d{2}T/.test(v??'')&&Number.isFinite(Date.parse(v));
export function parseArguments(argv){
 const command=argv[0],options={command,workspaces:[]},errors=[];
 const flags={measure:['workspace','since','until','label','ledger','md','json','codex-home','claude-home','replace'],cases:['cases','ledger','md','json','replace'],compare:['ledger','case','base','head','md'],repair:['ledger','confirm']};
 if(!flags[command])errors.push('Expected measure, cases, compare or repair');
 for(let i=1;i<argv.length;i++){const flag=argv[i];if(!flag.startsWith('--')||!flags[command]?.includes(flag.slice(2))){errors.push('Unknown flag: '+flag);continue;}const key=flag.slice(2);if(key==='replace'){options.replace=true;continue;}if(!argv[i+1]||argv[i+1].startsWith('--')){errors.push('Missing value: '+flag);continue;}const value=argv[++i];if(key==='workspace')options.workspaces.push(value);else options[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;}
 if(command==='measure'){if(!options.workspaces.length)errors.push('Required: --workspace');if(!options.since)errors.push('Required: --since');}
 if(command==='cases'&&!options.cases)errors.push('Required: --cases');if(['compare','repair'].includes(command)&&!options.ledger)errors.push('Required: --ledger');
 for(const key of ['since','until'])if(options[key]&&!iso(options[key]))errors.push('Invalid ISO date: --'+key);
 if(options.since&&options.until&&Date.parse(options.since)>Date.parse(options.until))errors.push('--since exceeds --until');
 for(const key of ['label','case'])if(options[key]&&privacyIssues(options[key]).length)errors.push('Private identifier in --'+key);
 if(options.cases&&!fs.existsSync(options.cases))errors.push('Cases file not found');if(['compare','repair'].includes(command)&&options.ledger&&!fs.existsSync(options.ledger))errors.push('Ledger file not found');
 if(options.confirm!==undefined&&!/^(?:0|[1-9][0-9]*)$/.test(options.confirm))errors.push('Invalid confirmation count');
 if(errors.length)throw Error(errors.join('\n'));return options;
}
function buildLedgerRow(r,label='',measuredAt=new Date().toISOString()){
 const t=r.timeSplit,c=r.context,o=r.output;
 const lanes=Object.fromEntries(['o11','odc'].map(lane=>[lane,Object.fromEntries(['writes','accepted','refused','uncertain','failed','staged','firstTimeRight'].map(k=>[k,k==='staged'?(r.lanes[lane][k]??0):r.lanes[lane][k]]))]));
 const row={schema:'ssam-speed-ledger/1',key:`${r.client}:${r.sessionId}:${r.id}`,measuredAt,client:r.client,model:r.model,workspace:r.workspace,head:r.release.head,headSource:r.release.source,case:r.case,label,start:r.start,wallSec:r.wallMin*60,...Object.fromEntries(['modelSec','ssamSec','otherToolSec','ownerWaitSec','coldStartSec','subagentWaitSec'].map(k=>[k,t[k]])),pollSec:r.waits.pollSec,execYields:r.waits.execYields,waitStillRunning:r.waits.waitStillRunning,waitCalls:r.waits.waitCalls,inputTokens:c.inputTokens,cachedPct:c.cachedPct,ssamInputPct:c.ssamPct,ssamToolsInputPct:c.ssamToolsPct,outputTokens:o.tokens,reasoningTokens:o.reasoningTokens,reasoningMethod:o.reasoningMethod,rounds:r.rounds,roundsTotal:r.roundsTotal,writtenKB:r.writtenKB,readKB:r.readKB,lanes,repeatedPct:r.repeats.repeatedPct,contractRequeries:r.repeats.contractRequeries,promptSha256:r.promptSha256};
 return row;
}
const safeRowKey=(row,index)=>typeof row.key==='string'&&!privacyIssues(row.key).length&&/^[a-z0-9:_-]+$/i.test(row.key)?row.key:'row-'+(index+1);
const rowProblems=(row,index)=>privacyFindings(row).map(problem=>({key:safeRowKey(row,index),field:safeField(problem.field),label:problem.label}));
export const ledgerProblems=rows=>rows.flatMap(rowProblems);
// Rows whose key is in existingKeys were already in the file and stay untouched; the rest are new or replaced.
export function ledgerSections(rows,{existingKeys=new Set()}={}){const existing=[],incoming=[];rows.forEach((row,index)=>(existingKeys.has(row.key)?existing:incoming).push(...rowProblems(row,index)));return {existing,incoming};}
export function validateLedgerRows(rows,options){const refusal=persistenceRefusal(ledgerSections(rows,options));if(refusal)throw refusal;}
export function ledgerRow(r,label='',measuredAt){const row=buildLedgerRow(r,label,measuredAt);validateLedgerRows([row]);return row;}
export function ledgerRows(requests,label=''){const rows=requests.map(r=>buildLedgerRow(r,label));validateLedgerRows(rows);return rows;}
export function readLedger(file){if(!fs.existsSync(file))return[];return fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean).map(JSON.parse);}
// Merge without writing: the index after the merge and the keys of existing rows this run leaves untouched.
export function planLedger(file,rows,{replace=false}={}){
 const existing=readLedger(file),untouched=new Set(existing.map(r=>r.key));const index=new Map(existing.map(r=>[r.key,r]));let added=0,replaced=0;
 for(const row of rows){if(index.has(row.key)){if(replace){index.set(row.key,row);untouched.delete(row.key);replaced++;}}else{index.set(row.key,row);added++;}}
 return {file,rows:[...index.values()],untouched,added,replaced};
}
function commitLedger(plan){if(plan.added||plan.replaced){fs.mkdirSync(path.dirname(path.resolve(plan.file)),{recursive:true});const temp=plan.file+'.tmp';fs.writeFileSync(temp,plan.rows.map(r=>JSON.stringify(r)).join('\n')+'\n');fs.renameSync(temp,plan.file);}return{added:plan.added,replaced:plan.replaced,total:plan.rows.length};}
export function updateLedger(file,rows,options={}){const plan=planLedger(file,rows,options);validateLedgerRows(plan.rows,{existingKeys:plan.untouched});return commitLedger(plan);}
export function repairLedger(file,{confirm}={}){
 const rows=readLedger(file),issues=ledgerProblems(rows),count=rows.filter(row=>privacyFindings(row).length).length;
 const preview={count,issues,written:false,policy:'Redact unsafe leaf values; remove private-key fields; preserve rows and sibling counters.'};
 if(confirm===undefined)return preview;
 if(!/^(?:0|[1-9][0-9]*)$/.test(String(confirm))||Number(confirm)!==count)throw Error('Confirmation count does not match preview: '+count+' linhas. Execute a prévia antes de confirmar.');
 if(!count)return preview;
 const keys=new Set(rows.map(row=>row.key));
 function neutralize(value){if(typeof value==='string'){try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==='object')return JSON.stringify(neutralize(parsed));}catch{}return privacyIssues(value).length?'[redacted]':value;}if(Array.isArray(value))return value.map(neutralize);if(value&&typeof value==='object'){const result=Object.fromEntries(Object.entries(value).filter(([key])=>!privateField(key)).map(([key,child])=>[key,neutralize(child)]));for(const issue of privacyFindings(value))if(issue.field==='workspace'&&['user-home','user-workspace'].includes(issue.label))result.workspace='[redacted]';return result;}return value;}
 const repaired=rows.map((source,index)=>{const row=privacyFindings(source).length?neutralize(source):structuredClone(source);if(privacyIssues(source.key).length){let key='repaired-row-'+(index+1);while(keys.has(key))key+='-x';keys.add(key);row.key=key;}return row;});
 validateLedgerRows(repaired);const temp=file+'.tmp';fs.writeFileSync(temp,repaired.map(row=>JSON.stringify(row)).join('\n')+'\n');fs.renameSync(temp,file);return {...preview,written:true};
}
export function formatRepair(result){return '# Prévia do reparo do ledger\n\nLinhas a reparar: '+result.count+'\n\n'+result.issues.map(p=>'key='+p.key+' field='+p.field+' label='+p.label).join('\n')+'\n\n'+(result.written?'Reparo confirmado e gravado.':'Nenhuma gravação. Confirme somente após revisar: --confirm '+result.count)+'\n';}
export function formatLedger(rows){const cols=['client','case','head','wallSec','modelSec','ssamSec','ownerWaitSec','inputTokens','ssamInputPct','ssamToolsInputPct','outputTokens','reasoningTokens','execYields','waitStillRunning','waitCalls','stagedO11','stagedOdc'];return '# Rodadas medidas\n\n| '+cols.join(' | ')+' |\n| '+cols.map(()=>'---').join(' | ')+' |\n'+rows.map(r=>{const values={...r,stagedO11:r.lanes.o11.staged??0,stagedOdc:r.lanes.odc.staged??0};return '| '+cols.map(k=>escape(typeof values[k]==='number'?values[k].toFixed(3):values[k])).join(' | ')+' |';}).join('\n')+'\n';}
export function compareRows(rows,options={}){
 const groups=new Map();for(const row of rows){if(options.case&&row.case!==options.case)continue;for(const lane of ['o11','odc']){if(!row.lanes[lane].writes)continue;const key=row.case+':'+lane;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}}
 const comparisons=[];for(const [key,group] of groups){group.sort((a,b)=>a.measuredAt.localeCompare(b.measuredAt));const before=options.base?group.find(r=>r.head===options.base):group[0],after=options.head?group.findLast(r=>r.head===options.head):group.at(-1);if(!before||!after)continue;const lane=key.slice(key.lastIndexOf(':')+1),regressions=[];
  if(after.wallSec>before.wallSec*(1+REGRESSION_THRESHOLDS.wallIncrease))regressions.push('wallSec');if(after.modelSec>before.modelSec*(1+REGRESSION_THRESHOLDS.modelIncrease))regressions.push('modelSec');if(after.lanes[lane].refused-before.lanes[lane].refused>=REGRESSION_THRESHOLDS.refusalIncrease)regressions.push('refused');if(before.lanes[lane].firstTimeRight===true&&after.lanes[lane].firstTimeRight===false)regressions.push('firstTimeRight');if(after.ssamInputPct-before.ssamInputPct>=REGRESSION_THRESHOLDS.ssamInputPoints)regressions.push('ssamInputPct');comparisons.push({case:before.case,lane,base:before.head,head:after.head,before,after,regressions});
 }return comparisons;
}
export function formatComparison(comparisons){return '# Comparação de rodadas\n\n| Caso | Faixa | Antes | Depois | Parede s (antes → depois) | Modelo s | Recusas | Staged | Certo de primeira | Regressões |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'+comparisons.map(c=>`| ${escape(c.case)} | ${c.lane} | ${escape(c.base)} | ${escape(c.head)} | ${c.before.wallSec.toFixed(3)} → ${c.after.wallSec.toFixed(3)} | ${c.before.modelSec.toFixed(3)} → ${c.after.modelSec.toFixed(3)} | ${c.before.lanes[c.lane].refused} → ${c.after.lanes[c.lane].refused} | ${c.before.lanes[c.lane].staged??0} → ${c.after.lanes[c.lane].staged??0} | ${c.before.lanes[c.lane].firstTimeRight} → ${c.after.lanes[c.lane].firstTimeRight} | ${c.regressions.join(', ')||'nenhuma'} |`).join('\n')+'\n';}
export const metricAt=(object,metric)=>metric.split('.').reduce((v,k)=>v?.[k],object);
export function evaluateCase(request,spec){return spec.metrics.map(m=>{let measured=metricAt(request,m.metric);if(m.transform==='utc-time'&&measured)measured=new Date(measured).toISOString().slice(11,19);if(m.transform==='subtract-main-written')measured-=request.writtenKB;if(m.transform?.startsWith('find-name:')){const [,name,key]=m.transform.split(':');measured=measured.find(v=>v.name===name)?.[key];}const tolerance=m.tolerance?.relative?Math.abs(m.value)*m.tolerance.relative:Number(m.tolerance??0);const matches=typeof m.value==='number'?typeof measured==='number'&&Math.abs(measured-m.value)<=tolerance:Object.is(measured,m.value);return{...m,measured,situation:matches?'passou':m.explanation?'explicado':'falhou'};});}
export function measureCases(file,{home=os.homedir()}={}){const specs=JSON.parse(fs.readFileSync(file,'utf8')),results=[];for(const spec of specs.cases){const absolute=path.join(home,spec.file.replaceAll('<user>',path.basename(home)));if(!fs.existsSync(absolute)){results.push({case:spec.name,missing:true,checks:[]});continue;}const [request]=analyzeFiles({[spec.client]:[absolute],windows:[{name:spec.name,start:spec.start,end:spec.end}],turns:true});if(!request){results.push({case:spec.name,missing:true,checks:[]});continue;}results.push({case:spec.name,request,checks:evaluateCase(request,spec)});}return results;}
const write=(file,text)=>{if(file){fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});fs.writeFileSync(file,text);}};
export function main(argv=process.argv.slice(2)){
 const options=parseArguments(argv);if(options.command==='repair'){const data=repairLedger(options.ledger,{confirm:options.confirm}),markdown=formatRepair(data);console.log(markdown);return {data,markdown};}let rows=[],markdown,data;
 if(options.command==='measure'){const sessions=discoverSessions(options);const requests=analyzeFiles({...sessions}).filter(r=>Date.parse(r.start)>=Date.parse(options.since)&&(!options.until||Date.parse(r.start)<=Date.parse(options.until)));rows=requests.map(r=>buildLedgerRow(r,options.label));markdown=formatLedger(rows);data=rows;}
 else if(options.command==='cases'){const measured=measureCases(options.cases);rows=measured.filter(r=>r.request).map(r=>buildLedgerRow(r.request));data=exportView(measured);markdown='# Casos de aceite\n\n| Caso | Métrica | Antes | Medido | Situação |\n| --- | --- | --- | --- | --- |\n'+measured.flatMap(r=>r.missing?[`| ${r.case} | arquivo | presente | ausente | falhou |`]:r.checks.map(c=>`| ${r.case} | ${c.metric} | ${escape(c.value)} | ${escape(c.measured)} | ${c.situation} |`)).join('\n')+'\n';}
 else {data=compareRows(readLedger(options.ledger),options);markdown=formatComparison(data);}
 // Every persistence boundary is checked once, before any write: existing ledger rows left untouched, every row this
 // run measured (with or without --ledger) and each requested export. One refusal lists them all; nothing is written.
 const plan=options.command!=='compare'&&options.ledger?planLedger(options.ledger,rows,options):null;
 const existing=plan?plan.rows.flatMap((row,index)=>plan.untouched.has(row.key)?rowProblems(row,index):[]):[],incoming=ledgerProblems(rows);
 const refusal=persistenceRefusal({existing,incoming,exports:[...(options.md?exportFindings('--md',options.md,markdown):[]),...(options.json?exportFindings('--json',options.json,data):[])]});if(refusal)throw refusal;
 const ledger=plan?commitLedger(plan):null;
 write(options.md,markdown);write(options.json,JSON.stringify(data,null,2)+'\n');console.log(markdown);if(ledger)console.log(JSON.stringify(ledger));return {rows,data,ledger,markdown};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{main()}catch(e){console.error(e.message);process.exitCode=1;}}
