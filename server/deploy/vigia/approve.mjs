// The owner's one command after a proposal: check, publish, pin, print what is left. Also -Reject and -Retry.
// Never a VPS, Coolify or GitHub action; never latest.
import fs from 'node:fs';
import path from 'node:path';
import {STUDIO_NAME,pinDigest,literalComposeText,windowPairs,pairId} from './window.mjs';
import {readAttempts,writeAttempt} from './pipeline.mjs';
export function findAttempt(outDir,selector,statuses){
 const attempts=Object.values(readAttempts(outDir)).filter(a=>statuses.includes(a.status));
 const hits=attempts.filter(a=>a.id===selector||(a.pair.lanes??[]).some(l=>`${l}-${a.pair[l]}`===selector));
 if(hits.length===1)return hits[0];
 const known=attempts.map(a=>a.id).join(', ')||'none';
 throw Error(hits.length?`${selector} matches several attempts (${hits.map(a=>a.id).join(', ')}); give the pair id.`:`No ${statuses.join('/')} attempt matches ${selector}. Known: ${known}.`);
}
// The selector names a lane version that only the new pair has (the new lane is newer than the whole window).
const ssamctl=(pair,kernel,features)=>{const lane=pair.lanes[0],sel=lane+'='+pair[lane];return [
 `sh ssamctl.sh kernel write --version ${sel} /tmp/ssam-vigia/kernel.json   # copy ${kernel}`,
 `sh ssamctl.sh features put --version ${sel} /tmp/ssam-vigia/Features.plain.xml   # copy ${features}`];};
export function ownerSteps({attempt,dir,published,commit,files,newPair}){
 const a=attempt,p=a.pair;
 return `# Approved: ${a.id}\n\nDone by the watcher:\n- local image digest checked: sha256:${a.built.sha256}\n- published ${a.built.image}:${a.built.tag} to the private registry${published.already?' (it was already there with the same digest)':''}; latest was not moved\n- pinned the published digest in versions.json and regenerated the compose, tests green, commit ${commit} on ${a.branch} (not pushed)\n\nWhat is left (owner; the watcher never touches the VPS or Coolify):\n\n1. Backup of the whole window on the VPS (ssamctl.sh backup, or the Integradora's recipe).\n${newPair?`2. The new pair ${a.id} needs its kernel and features before its container serves (COOLIFY.md section 5). On the VPS, in deploy/coolify:\n\n   ${ssamctl(p,files.kernel,files.features).join('\n   ')}\n\n`:'2. No new pair container: kernel and features are already on the VPS.\n'}3. In Coolify, replace the compose with:\n\n   ${files.compose}\n\n   and click Redeploy. Then check /health, the kernel and warm events of each backend, and the agents.\n4. The Integradora merges ${a.branch} into main (local, no push without your OK). Until then the watcher already plans from this window.\n\nWay back: paste ${files.rollback} in Coolify and Redeploy. Tags stay in the registry; latest is untouched.\n`;
}
export async function approve(config,ops,selector){
 const log=ops.log??(()=>{});
 let a=findAttempt(config.outDir,selector,['proposed']);const dir=path.join(config.outDir,a.id);
 log(`approve ${a.id}`);
 // Everything that can be checked before publishing is checked first; each step is recorded, so an approval stopped
 // half-way resumes where it stopped (a published tag is never pushed again, a pin is never repeated).
 literalComposeText(a.baseManifest,config.domains);
 if(!a.published){
  await ops.verifyBranch(a.branch,a.commit);
  await ops.verifyLocalImage(a.built);
  const published=await ops.publish(a.built);
  if(published.digest!=='sha256:'+a.built.sha256)throw Error(`The registry holds ${published.digest} for ${a.built.tag}, not the tested sha256:${a.built.sha256}. Nothing was pinned; check the registry before anything else.`);
  log(`published ${a.built.tag} ${published.digest}${published.already?' (already in the registry)':''}`);
  a=writeAttempt(config.outDir,{...a,published:{...published,at:new Date().toISOString()}});
 }else log(`already published ${a.published.digest}`);
 const published=a.published,pinned=pinDigest(a.proposedManifest,a.built.tag,published.digest);
 if(!a.pinCommit){
  await ops.verifyBranch(a.branch,a.commit);
  const {commit}=await ops.pin(pinned,a.branch,dir,`build(deploy): pin the image ${a.built.tag}\n\nPublished to the private registry by the owner's approval (vigia.ps1 -Approve ${a.id}); digest ${published.digest}.\nlatest is unchanged.\n`);
  a=writeAttempt(config.outDir,{...a,pinCommit:commit});
 }else await ops.verifyBranch(a.branch,a.pinCommit);
 const commit=a.pinCommit;
 const files={compose:path.join(dir,'compose.coolify.literal.yml'),rollback:path.join(dir,'compose.rollback.literal.yml'),kernel:path.join(dir,'kernel.json'),features:path.join(dir,'Features.plain.xml')};
 fs.writeFileSync(files.compose,literalComposeText(pinned,config.domains));
 fs.writeFileSync(files.rollback,literalComposeText(a.baseManifest,config.domains));
 const newPair=!windowPairs(a.baseManifest).some(p=>pairId(p)===a.id);
 const steps=ownerSteps({attempt:a,dir,published,commit,files,newPair});
 fs.writeFileSync(path.join(dir,'APROVADO.md'),steps);
 writeAttempt(config.outDir,{...a,status:'approved',approved:{at:new Date().toISOString(),digest:published.digest,commit,already:!!published.already}});
 return {status:'approved',id:a.id,commit,steps};
}
export function reject(config,selector,reason){
 const a=findAttempt(config.outDir,selector,['proposed']);
 if(!reason)throw Error('Give the reason: -Reason "<why>".');
 writeAttempt(config.outDir,{...a,status:'rejected',rejected:{at:new Date().toISOString(),reason}});
 return {status:'rejected',id:a.id,note:`${a.id} will not be rebuilt with the same inputs. Its branch ${a.branch} and local image stay for reference. -Retry ${a.id} builds it again.`};
}
export function retry(config,selector){
 const a=findAttempt(config.outDir,selector,['failed','rejected','deferred']);
 writeAttempt(config.outDir,{...a,retry:true});
 return {status:'retry',id:a.id,note:`The next round runs ${a.id} again (${a.pair.lanes.map(l=>`${STUDIO_NAME[l]} ${a.pair[l]}`).join(', ')}).`};
}
