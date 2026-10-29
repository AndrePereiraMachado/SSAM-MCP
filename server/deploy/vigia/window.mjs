// Pure planning of the Studio versions window: what is new, which pair one image carries, how the window rotates, what
// the owner reads. No process, Docker, Git or network here (runtime.mjs does that), so every rule is testable alone.
import fs from 'node:fs';
import path from 'node:path';
import {versionPairs,generateCompose} from '../coolify/gen-compose.mjs';
export const LANES=['odc','o11'];
export const STUDIO_NAME={odc:'ODC Studio',o11:'Service Studio'};
export const version=value=>/^(\d+\.\d+\.\d+)/.exec(String(value??''))?.[1]??null;
export const compareVersion=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};
// The major .NET of a target framework moniker: net8.0 -> 8, net10.0-windows -> 10, anything else -> null.
export const tfmMajor=value=>{const m=/^net(\d+)\.\d+/i.exec(String(value??''));return m?Number(m[1]):null;};
export function detectVersionFolders(folders){
 return Object.entries(folders).flatMap(([lane,studio])=>{try{const fullVersion=fs.readFileSync(path.join(studio,'Version.txt'),'utf8').trim().split(/\s/)[0];return version(fullVersion)?[{lane,studio,fullVersion,version:version(fullVersion)}]:[];}catch{return [];}});
}
export function planWindow(manifest,observed=[],state={}){
 versionPairs(manifest);
 const candidates=observed.filter(o=>LANES.includes(o.lane)&&version(o.version)).map(o=>({...o,version:version(o.version)})).filter(o=>!manifest[o.lane].some(v=>v.version===o.version)&&manifest[o.lane].every(v=>compareVersion(o.version,v.version)>0));
 candidates.sort((a,b)=>LANES.indexOf(a.lane)-LANES.indexOf(b.lane)||compareVersion(b.version,a.version));
 const requested=[];
 for(const lane of LANES)for(const [v,data]of Object.entries(state.unserved?.[lane]??{}))if(version(v)&&manifest[lane].every(x=>compareVersion(version(v),x.version)>0))requested.push({lane,version:version(v),customers:data.tokens?.length??0});
 return {window:manifest.window??3,observed:observed.map(({lane,version,fullVersion,requiresInstallation,tfm,missing})=>({lane,version,fullVersion,tfm:tfm??null,requiresInstallation:!!requiresInstallation,...(missing?.length?{missing}:{})})),candidates,requested};
}
// The newest installed candidate of each lane. Both lanes new at once go into ONE image (one build, one approval).
export function readyCandidates(plan){
 const pick={};for(const c of plan.candidates)if(!c.requiresInstallation&&(!pick[c.lane]||compareVersion(c.version,pick[c.lane].version)>0))pick[c.lane]=c;
 return LANES.filter(l=>pick[l]).map(l=>pick[l]);
}
export function pairFor(base,ready){
 const pick=Object.fromEntries(ready.map(c=>[c.lane,c]));
 return {odc:pick.odc?.version??base.odc[0].version,o11:pick.o11?.version??base.o11[0].version,lanes:LANES.filter(l=>pick[l]),candidates:LANES.filter(l=>pick[l]).map(l=>pick[l])};
}
// The pair name of gen-compose.mjs (volumes and backends use it), so one id names the proposal, its branch and its folder.
export const pairId=p=>`o11-${p.o11}-odc-${p.odc}`;
export const pairTag=(p,commit,date)=>`prod-${date}-${commit}-o${p.o11.replaceAll('.','')}-odc${p.odc.replaceAll('.','')}`;
export const windowPairs=manifest=>versionPairs(manifest).map(p=>({odc:p.odc,o11:p.o11}));
export const hasPair=(manifest,pair)=>windowPairs(manifest).some(p=>p.odc===pair.odc&&p.o11===pair.o11);
export const isRealClient=data=>!data.revokedAt&&!data.revoked&&data.state!=='revoked'&&!data.verification&&data.customer!=='Version verification';
export function rotateWindow(manifest,pair,state={}){
 const old=versionPairs(manifest),window=manifest.window??3;
 pair={odc:old[0].odc,o11:old[0].o11,...pair};
 let entries=[{...pair},...old.filter(p=>p.odc!==pair.odc||p.o11!==pair.o11).map(p=>{
  const at=manifest.odc.find(x=>x.version===p.odc&&p.image.startsWith(x.image+':'+x.tag));return {odc:p.odc,o11:p.o11,...at};
 })];
 const now=state.now??Date.now(),held=[];
 const recent=p=>Object.entries(state.tokens??{}).some(([token,data])=>{
  const active=isRealClient(data)&&now-Date.parse(data.seen)<14*86400000;
  const uses=LANES.some(l=>version(data[l]?.installed)===p[l]);
  if(active&&uses){held.push({pair:pairId(p),token,lastSeen:data.seen});return true;}return false;
 });
 entries=entries.filter((p,i)=>i<window||recent(p));
 const limit=state.maxWindow??4;
 if(!Number.isInteger(limit)||limit<3||entries.length>limit)throw Object.assign(Error('Active clients require a window above the configured limit; owner review is required.'),{code:'WINDOW_LIMIT',environmental:true});
 const next={window:Math.max(window,entries.length),odc:[],o11:[]};
 for(const p of entries)for(const lane of LANES)next[lane].push({version:p[lane],tag:p.tag,image:p.image,...(p.sha256?{sha256:p.sha256}:{})});
 versionPairs(next);
 const leaving={};for(const lane of LANES)leaving[lane]=[...new Set(manifest[lane].map(x=>x.version))].filter(v=>!next[lane].some(x=>x.version===v));
 const affected=[];for(const [token,data]of Object.entries(state.tokens??{}))for(const lane of LANES)if(leaving[lane].includes(version(data[lane]?.installed)))affected.push({token,customer:data.customer??null,lane,version:version(data[lane].installed),lastSeen:data.seen??null});
 return {manifest:next,leaving,affected,held};
}
// Approved proposals that main does not carry yet are replayed on top of it, in approval order: the next proposal starts
// from the window the owner deployed, whether or not its branch was merged. A pair main already has is skipped.
export function replayApprovals(manifest,approvals=[]){
 let current=manifest;const replayed=[];
 for(const a of [...approvals].sort((x,y)=>String(x.approved?.at).localeCompare(String(y.approved?.at)))){
  const pair={odc:a.pair.odc,o11:a.pair.o11,image:a.built.image,tag:a.built.tag,sha256:String(a.approved.digest).replace(/^sha256:/,'')};
  if(hasPair(current,pair))continue;
  current=rotateWindow(current,pair).manifest;replayed.push(a.id);
 }
 return {manifest:current,replayed};
}
// The pin: the published digest of the proposal's tag, written into every entry of that tag.
export function pinDigest(manifest,tag,digest){
 if(!/^sha256:[a-f0-9]{64}$/.test(digest))throw Error('Invalid published digest.');
 const next=structuredClone(manifest);let found=0;
 for(const lane of LANES)for(const entry of next[lane])if(entry.tag===tag){entry.sha256=digest.slice(7);found++;}
 if(found!==2)throw Error('The proposed window does not carry the tag once per lane.');
 versionPairs(next);return next;
}
export function compareFailures(before,after){const a=new Set(before.failures),b=new Set(after.failures);return {before:before.failures,after:after.failures,newFailures:[...b].filter(n=>!a.has(n)),resolved:[...a].filter(n=>!b.has(n))};}
const xml=s=>s.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
export function readTrx(text){
 const results=[...text.matchAll(/<UnitTestResult\b([^>]*)\/?\s*>/g)].map(([,attrs])=>Object.fromEntries([...attrs.matchAll(/([\w:]+)="([^"]*)"/g)].map(([,k,v])=>[k,xml(v)])));
 if(!results.length)throw Error('No test results in TRX.');
 if(results.every(r=>r.outcome==='NotExecuted'))throw Error('No executed tests in TRX.');
 return {total:results.length,passed:results.filter(r=>r.outcome==='Passed').length,skipped:results.filter(r=>r.outcome==='NotExecuted').length,failures:results.filter(r=>!['Passed','NotExecuted'].includes(r.outcome)).map(r=>r.testName).sort()};
}
// The agent pack a pair's smoke test presents and its kernel.json accepts: agentPack, with agentPackByRuntime["net<N>"]
// over the ODC fields when the pair's ODC Studio runs on .NET N, and over the O11 fields when its Service Studio does
// (a Studio that moved runtime needs the bridge built for it).
export function packFor(config,bundles){
 const pack={...config.agentPack},by=config.agentPackByRuntime??{};
 const on=lane=>{const m=tfmMajor(bundles?.[lane]?.tfm);return m?by['net'+m]:null;};
 const odc=on('odc'),o11=on('o11');
 for(const k of ['odcBridge','odcBridgeAccepted'])if(odc?.[k]!==undefined)pack[k]=odc[k];
 for(const k of ['o11BuiltFor','o11Hook'])if(o11?.[k]!==undefined)pack[k]=o11[k];
 return pack;
}
// The lanes of a pair whose Studio runs on a .NET the base agent pack was not built for (agentPack.runtime, net8.0 for the
// v97 bridges) and that agentPackByRuntime does not cover: the agent could not connect, so the round waits for the pack.
export function missingPack(config,bundles){
 const base=tfmMajor(config.agentPack?.runtime??'net8.0'),by=config.agentPackByRuntime??{};
 const need={odc:['odcBridge'],o11:['o11BuiltFor']};
 return LANES.filter(lane=>{const m=tfmMajor(bundles?.[lane]?.tfm);return m&&m!==base&&!need[lane].every(k=>by['net'+m]?.[k]!==undefined);}).map(lane=>({lane,version:bundles[lane].version,tfm:bundles[lane].tfm}));
}
export const composeText=compose=>'# Generated by gen-compose.mjs. Edit versions.json and regenerate.\n'+JSON.stringify(compose,null,2)+'\n';
// What the owner pastes in Coolify: Coolify does not expand variables inside the Traefik rule labels, so the router rules
// carry the literal domains (the "literal" copies of the releases, e.g. C:/t/vps-a11/compose.coolify.literal.yml).
export function literalCompose(compose,domains){
 if(!domains?.ssam||!domains?.console)throw Error('Set domains.ssam and domains.console in the watcher configuration.');
 for(const d of [domains.ssam,domains.console])if(!/^[a-z0-9.-]+(?::\d+)?$/i.test(d))throw Error('Invalid domain in the watcher configuration.');
 const c=structuredClone(compose);
 for(const service of Object.values(c.services??{}))for(const key of Object.keys(service.labels??{}))if(/^traefik\.http\.routers\.[^.]+\.rule$/.test(key))
  service.labels[key]=service.labels[key].replaceAll('${SSAM_DOMAIN}',domains.ssam).replaceAll('${CONSOLE_DOMAIN}',domains.console);
 return c;
}
export const literalComposeText=(manifest,domains)=>composeText(literalCompose(generateCompose(manifest),domains));
// The owner command line, from the configuration (the watcher worktree and the configuration file it runs with).
const fwd=p=>String(p).replaceAll('\\','/');
export const ownerCommand=(config,args)=>`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${fwd(config?.workspace??'C:/Users/andre/SSAM-MCP-wt/vigia-run')}/server/deploy/vigia/vigia.ps1 -Config ${fwd(config?.configFile??'C:/t/vigia/config.json')} ${args}`;
const list=values=>values.length?values.map(v=>'- '+v).join('\n'):'- none';
export function proposalText({id,pair,built,next,comparisons,branch,commit,dir,base,replayed,runtimes,features,config}){
 const lanes=pair.lanes.map(l=>`${STUDIO_NAME[l]} ${pair[l]}`).join(' and ');
 const tests=Object.entries(comparisons).map(([lane,c])=>`- ${lane}: baseline ${c.baseline.passed}/${c.baseline.total} passed, candidate ${c.current.passed}/${c.current.total} passed; new failures: ${c.newFailures.length}; resolved: ${c.resolved.length}`).join('\n');
 const runtime=Object.entries(runtimes??{}).map(([lane,r])=>`- ${lane}: Studio ${r.studio??'unknown'}, build ${r.build??'unknown'}${r.baseline&&r.studio&&r.baseline!==r.studio?` (runtime changed from ${r.baseline}; the build rule handles it)`:''}`).join('\n');
 return `# Studio versions proposal: owner approval required\n\nNew: ${lanes}. Pair ${id}.\n\nImage (local, not published): ${built.image}:${built.tag}\nBuild digest: sha256:${built.sha256}\nRevision: ${built.revision}\nBranch: ${branch} (commit ${commit}, not pushed)\n\nNo image was published. No deployment was performed. The agent package is unchanged; live bridge validation remains an owner action.\n\n## Approve with one command\n\n\`\`\`powershell\n${ownerCommand(config,'-Approve '+id)}\n\`\`\`\n\nIt checks the local image digest, publishes the tag to the private registry (never latest), pins the published digest in versions.json, regenerates and tests the compose in a commit on ${branch}, and prints the remaining owner steps in the order of COOLIFY.md sections 5 and 7 (maintenance notice, VPS backup, the new compose in Coolify with its containers prepared stopped, kernel and features of the new pair, Redeploy, checks) and the way back.\n\nTo drop this proposal instead: \`-Reject ${id} -Reason "<why>"\`.\n\n## Window\n\nBase: ${base}${replayed.length?` (approved, not yet in main: ${replayed.join(', ')})`:''}\n\nProposed pairs (newest first):\n${list(windowPairs(next.manifest).map(p=>pairId(p)))}\n\nLeaving the window: ${JSON.stringify(next.leaving)}\n\nCustomers last seen on a leaving version:\n${list(next.affected.map(a=>`${a.customer??a.token} (${a.lane} ${a.version}, last seen ${a.lastSeen??'unknown'})`))}\n\n## Tests compared by full failure name\n\n${tests}\n\nDetails: ${path.join(dir,'comparison.json')}\n\n## Runtime\n\n${runtime||'- not recorded'}\n\n## Files\n\n- proposed-window.json, compose.coolify.yml: review copies of the branch commit\n- kernel.json (here) and Features.plain.xml (private: ${features??'none'}): what the new pair container needs on the VPS (printed again by -Approve)\n- smoke.json, image.json, bundles.json, comparison.json: evidence\n\n## Not run by the watcher\n\nOf the manual release recipe (handoff of 2026-10-27, section 5), the watcher runs neither builder-image.test.mjs nor the 18-check rehearsal of the whole window (coolify/rehearse.mjs). Its smoke covers one container: pair check, health, warm with builder and worker, the agent pack, tools/list against the listing budget. Run them before approving when the server code changed too.\n`;
}
export function failureText({id,error,environmental,dir,retry,config}){
 return environmental
  ?`# Studio versions round deferred\n\nPair ${id}.\n\n${error}\n\nThis is an environment problem, not a test result. The next round retries it automatically. No image was published and nothing was deployed.\n`
  :`# Studio versions pipeline stopped\n\nPair ${id}.\n\n${error}\n\nNo image was published and nothing was deployed. The same inputs are not retried: a new commit in main or another Studio build retries it after ${retry} h, or run:\n\n\`\`\`powershell\n${ownerCommand(config,'-Retry '+id)}\n\`\`\`\n\nEvidence: ${dir}\n`;
}
