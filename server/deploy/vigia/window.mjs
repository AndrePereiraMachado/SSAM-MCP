import fs from 'node:fs';
import path from 'node:path';
import {versionPairs,generateCompose} from '../coolify/gen-compose.mjs';
const version=value=>/^(\d+\.\d+\.\d+)/.exec(String(value??''))?.[1]??null;
export const compareVersion=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};
export function detectVersionFolders(folders){
 return Object.entries(folders).flatMap(([lane,studio])=>{try{const fullVersion=fs.readFileSync(path.join(studio,'Version.txt'),'utf8').trim().split(/\s/)[0];return version(fullVersion)?[{lane,studio,fullVersion,version:version(fullVersion)}]:[];}catch{return [];}});
}
export function planWindow(manifest,observed=[],state={}){
 versionPairs(manifest);
 const candidates=observed.filter(o=>['odc','o11'].includes(o.lane)&&version(o.version)).map(o=>({...o,version:version(o.version)})).filter(o=>!manifest[o.lane].some(v=>v.version===o.version)&&manifest[o.lane].every(v=>compareVersion(o.version,v.version)>0));
 candidates.sort((a,b)=>['odc','o11'].indexOf(a.lane)-['odc','o11'].indexOf(b.lane));
 const requested=[];
 for(const lane of ['odc','o11'])for(const [v,data]of Object.entries(state.unserved?.[lane]??{}))if(version(v)&&manifest[lane].every(x=>compareVersion(version(v),x.version)>0))requested.push({lane,version:version(v),customers:data.tokens?.length??0});
 return {window:manifest.window??3,observed:observed.map(({lane,version,fullVersion,requiresInstallation})=>({lane,version,fullVersion,requiresInstallation:!!requiresInstallation})),candidates,requested};
}
export function rotateWindow(manifest,pair,state={}){
 const old=versionPairs(manifest),window=manifest.window??3;
 pair={odc:old[0].odc,o11:old[0].o11,...pair};
 const entries=[{...pair},...old.filter(p=>p.odc!==pair.odc||p.o11!==pair.o11).map(p=>{
  const at=manifest.odc.find(x=>x.version===p.odc&&p.image.startsWith(x.image+':'+x.tag));return {odc:p.odc,o11:p.o11,...at};
 })].slice(0,window);
 const next={window,odc:[],o11:[]};
 for(const p of entries)for(const lane of ['odc','o11'])next[lane].push({version:p[lane],tag:p.tag,image:p.image,sha256:p.sha256});
 versionPairs(next);
 const leaving={};for(const lane of ['odc','o11'])leaving[lane]=[...new Set(manifest[lane].map(x=>x.version))].filter(v=>!next[lane].some(x=>x.version===v));
 const affected=[];for(const [token,data]of Object.entries(state.tokens??{}))for(const lane of ['odc','o11'])if(leaving[lane].includes(version(data[lane]?.installed)))affected.push({token,customer:data.customer??null,lane,version:version(data[lane].installed),lastSeen:data.seen??null});
 return {manifest:next,leaving,affected};
}
export function compareFailures(before,after){const a=new Set(before.failures),b=new Set(after.failures);return {before:before.failures,after:after.failures,newFailures:[...b].filter(n=>!a.has(n)),resolved:[...a].filter(n=>!b.has(n))};}
const xml=s=>s.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
export function readTrx(text){
 const results=[...text.matchAll(/<UnitTestResult\b([^>]*)\/?\s*>/g)].map(([,attrs])=>Object.fromEntries([...attrs.matchAll(/([\w:]+)="([^"]*)"/g)].map(([,k,v])=>[k,xml(v)])));
 if(!results.length)throw Error('No test results in TRX.');
 if(results.every(r=>r.outcome==='NotExecuted'))throw Error('No executed tests in TRX.');
 return {total:results.length,passed:results.filter(r=>r.outcome==='Passed').length,skipped:results.filter(r=>r.outcome==='NotExecuted').length,failures:results.filter(r=>!['Passed','NotExecuted'].includes(r.outcome)).map(r=>r.testName).sort()};
}
function proposal(candidate,pair,next,comparison){
 return `# Studio version proposal — owner approval required\n\nLane: ${candidate.lane}; version: ${candidate.version}.\n\nImage: ${pair.image}:${pair.tag}\nManifest digest: sha256:${pair.sha256.replace(/^sha256:/,'')}\n\nNo image was published. No deployment was performed. The agent package is unchanged. Live bridge validation remains an owner action.\n\n## Leaving the window\n\n${JSON.stringify({leaving:next.leaving,affected:next.affected},null,2)}\n\n## Tests compared by full failure name\n\n${JSON.stringify(comparison,null,2)}\n\n## Owner sequence\n\n1. Run ssamctl.sh backup for the entire window before changing the deployment. Keep its embedded volume manifest and database dump.\n2. Publish the tested local image to the existing private repository, without latest:\n\n\`DOCKER="docker --context desktop-linux" sh server/deploy/publish.sh --source ${pair.image} --image ${pair.image} --tag ${pair.tag} --private-repo-ready\`\n\n3. Review and merge this proposal branch. Install the generated compose in Coolify.\n4. SSAM_CONTAINER takes precedence over --version and SSAM_VERSION. Use the exact container when a qualified selector reports multiple candidates. For the prepared, stopped version container, run:\n\n\`sh ssamctl.sh kernel write --version ${candidate.lane}=${pair[candidate.lane]} /tmp/ssam-vigia/kernel.json\`\n\`sh ssamctl.sh features put --version ${candidate.lane}=${pair[candidate.lane]} /tmp/ssam-vigia/Features.plain.xml\`\n\n5. Redeploy only after pair-ok. Verify aggregate health, kernel and warm events, routing and both agent lanes.\n6. Roll back with the previous window and its immutable tags. Never move latest.\n\nCopy kernel.json and Features.plain.xml from this proposal's private output directory to /tmp/ssam-vigia before step 4. The proposed-window.json and compose.coolify.yml here are review copies.\n`;
}
export async function runVigia(config,ops){
 const plan=planWindow(config.manifest,config.observed,config.state);
 if(config.dryRun)return {status:'dry-run',plan};
 if(!plan.candidates.length&&plan.requested.length===0)return {status:'idle',plan};
 if(!plan.candidates.length||plan.candidates[0].requiresInstallation){
  fs.mkdirSync(config.outDir,{recursive:true});const pending=JSON.stringify({requested:plan.requested,installers:plan.candidates.filter(x=>x.requiresInstallation)},null,2);
  const file=path.join(config.outDir,'pending.json');let previous='';try{previous=fs.readFileSync(file,'utf8');}catch{}
  if(previous!==pending){fs.writeFileSync(file,pending);fs.writeFileSync(path.join(config.outDir,'PENDENTE.md'),'# Studio installation required\n\nInstall or provide a frozen copy of the observed Studio before generating its bundle. No image was built or published.\n\n'+pending+'\n');await ops.notify('SSAM Studio version observed','A newer Studio needs a local installation before its bundle can be tested.');}
  return {status:'waiting-for-studio',plan};
 }
 const candidate=plan.candidates[0],dir=path.join(config.outDir,`${candidate.lane}-${candidate.version}`);
 if(fs.existsSync(path.join(dir,'PROPOSTA.md')))return {status:'pending-approval',dir,plan};
 fs.mkdirSync(dir,{recursive:true});
 try{
  await ops.checkWorkspace();
  const bundle=await ops.bundle(candidate,dir);
  const baseline=await ops.test(candidate,'baseline',bundle,dir);
  const current=await ops.test(candidate,'candidate',bundle,dir);
  const comparison=compareFailures(baseline,current);fs.writeFileSync(path.join(dir,'comparison.json'),JSON.stringify({baseline,current,...comparison},null,2));
  if(comparison.newFailures.length)throw Error('New kernel test failures:\n'+comparison.newFailures.join('\n'));
  const pair=await ops.build(candidate,bundle,dir);
  const smoke=await ops.smoke(pair,bundle,dir);fs.writeFileSync(path.join(dir,'smoke.json'),JSON.stringify(smoke,null,2));
  if(!smoke.ok)throw Error('Image smoke failed. See smoke.json.');
  const next=rotateWindow(config.manifest,pair,config.state);
  fs.writeFileSync(path.join(dir,'proposed-window.json'),JSON.stringify(next.manifest,null,2)+'\n');
  fs.writeFileSync(path.join(dir,'compose.coolify.yml'),'# Generated by gen-compose.mjs.\n'+JSON.stringify(generateCompose(next.manifest),null,2)+'\n');
  const branch=`vigia/${candidate.lane}-${candidate.version}`;
  await ops.propose(next,branch,dir);
  fs.writeFileSync(path.join(dir,'PROPOSTA.md'),proposal(candidate,pair,next,comparison));
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({status:'proposed',branch,pair,affected:next.affected},null,2));
  await ops.notify('SSAM Studio version ready for owner approval',`${candidate.lane} ${candidate.version}: ${dir}`);
  return {status:'proposed',branch,dir,pair};
 }catch(error){
  fs.writeFileSync(path.join(dir,'FALHAS.md'),'# Studio version pipeline stopped\n\n'+String(error.message)+'\n\nNo deployment or publication was performed.\n');
  await ops.notify('SSAM Studio version checks failed',`${candidate.lane} ${candidate.version}: ${dir}`);
  return {status:'failed',dir,error:String(error.message)};
 }
}
