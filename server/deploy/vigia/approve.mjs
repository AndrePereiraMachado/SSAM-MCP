// The owner's one command after a proposal: check, publish, pin, print what is left. Also -Reject and -Retry.
// Never a VPS, Coolify or GitHub action; never latest.
import fs from 'node:fs';
import {readJournal} from './journal.mjs';
import path from 'node:path';
import {STUDIO_NAME,pinDigest,literalComposeText,windowPairs,pairId,hasPair} from './window.mjs';
import {readAttempts,writeAttempt} from './pipeline.mjs';
export function findAttempt(outDir,selector,statuses){
 const attempts=Object.values(readAttempts(outDir)).filter(a=>statuses.includes(a.status));
 const hits=attempts.filter(a=>a.id===selector||(a.pair.lanes??[]).some(l=>`${l}-${a.pair[l]}`===selector));
 if(hits.length===1)return hits[0];
 const known=attempts.map(a=>a.id).join(', ')||'none';
 throw Error(hits.length?`${selector} matches several attempts (${hits.map(a=>a.id).join(', ')}); give the pair id.`:`No ${statuses.join('/')} attempt matches ${selector}. Known: ${known}.`);
}
// The owner's steps after an approval, in the order of COOLIFY.md sections 5 and 7: ssamctl.sh finds a version container by
// its labels and writes into its volumes, so the new pair's container must exist (from the new compose, stopped) before its
// kernel and features are written, and Redeploy comes only after them. The selector names a lane version only the new pair
// has (the new lane is newer than the whole window).
export function ownerSteps({attempt,published,commit,files,newPair,proposed}){
 const a=attempt,p=a.pair,lane=p.lanes[0],sel=`${lane}=${p[lane]}`,short=commit.slice(0,7);
 const tags=windowPairs(proposed).map(x=>pairId(x)).join(', ');
 const steps=[
  `Tell the customers about the maintenance window: recreating the containers cuts the calls in flight; afterwards they only reconnect the MCP (no new agent package).`,
  `On the VPS, back up the whole window before changing anything: sh ssamctl.sh backup (deploy/coolify of the commit in production). Keep its volume manifest and database dump.`,
  `Copy to the VPS the deploy folder of the approved commit ${short}: ${files.deploy} (git archive of server/deploy; tar -xzf unpacks it into server/deploy/, with server/deploy/coolify/ssamctl.sh and server/deploy/kernel-pair-check.mjs)${newPair?`, and into /tmp/ssam-vigia/ the kernel of the new pair, ${files.kernel}, and its features, ${files.features} (private: never leave other copies)`:''}.`,
  `In Coolify, replace the compose with ${files.compose} and prepare the containers of the new window stopped, without a Redeploy yet (COOLIFY.md 5: the containers must exist, stopped, with the image and the volumes of the new compose; the router must not serve before the pins). Then, in the unpacked server/deploy/coolify: sh ssamctl.sh status must list the new pair ${a.id} (o11 ${p.o11}, odc ${p.odc}).`,
  ...(newPair?[`Write the kernel and the features of the new pair (the kernel write runs the pair check inside the new image and must exit 0):\n\n   sh ssamctl.sh kernel write --version ${sel} /tmp/ssam-vigia/kernel.json\n   sh ssamctl.sh features put --version ${sel} /tmp/ssam-vigia/Features.plain.xml\n   rm /tmp/ssam-vigia/Features.plain.xml\n\n   "version must identify exactly one container; candidates: none" means the new compose of the previous step is not applied yet: go back one step, never Redeploy first (the new pair is the default and would start without its kernel).`]:[`No new pair: the kernels and features of every pair are already on the VPS.`]),
  `Redeploy in Coolify. Then check: sh ssamctl.sh status lists the pairs of the proposed window (${tags}) and the digest sha256:${a.built.sha256} for ${a.built.tag}; /health aggregate ok; the kernel and warm events of each backend (indexes, builder and worker ok); an agent with the new Studio and one with an older Studio are routed to their pairs; an MCP session opened before the Redeploy gets SESSION_REROUTED once and reconnects.`,
  `The Integradora merges ${a.branch} into main (local, no push without your OK). Until then the watcher already plans from this window.`];
 return `# Approved: ${a.id}\n\nDone by the watcher:\n- local image digest checked: sha256:${a.built.sha256}\n- published ${a.built.image}:${a.built.tag} to the private registry${published.already?' (it was already there with the same digest)':''}; latest was not moved\n- pinned the published digest in versions.json and regenerated the compose, tests green, commit ${commit} on ${a.branch} (not pushed)\n- deploy folder of that commit: ${files.deploy}\n\nWhat is left, in this order (owner; the watcher never touches the VPS or Coolify):\n\n${steps.map((s,i)=>`${i+1}. ${s}`).join('\n')}\n\nWay back (if the checks fail): paste ${files.rollback} in Coolify and Redeploy. The previous pairs keep their own kernel.json and features (per-pair folder and volumes); the new pair's volumes stay unused. Restore data (ssamctl.sh restore) only if data must come back, with every backend stopped. Tags stay in the registry; latest is untouched.\n`;
}
export async function approve(config,ops,selector){
 const log=ops.log??(()=>{});
 let a=findAttempt(config.outDir,selector,['proposed']);const dir=path.join(config.outDir,a.id);
 log(`approve ${a.id}`);
 // Everything that can be checked before publishing is checked first; each step is recorded, so an approval stopped
 // half-way resumes where it stopped (a published tag is never pushed again, a pin is never repeated).
 literalComposeText(a.baseManifest,config.domains);
 // A pair main already serves was published by another way: a second image of it is never made.
 if(!a.published&&ops.manifest&&hasPair(ops.manifest(),a.pair))throw Error(`main already serves ${a.id} (published another way). Nothing was published; drop this proposal with -Reject ${a.id} -Reason "served".`);
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
  // A pin committed just before a crash (not yet recorded) is recognised instead of refused.
  const done=await ops.pinnedAt?.(a.branch,a.commit,a.built.tag,published.digest);
  if(done)a=writeAttempt(config.outDir,{...a,pinCommit:done});
  else{
   await ops.verifyBranch(a.branch,a.commit);
   const {commit}=await ops.pin(pinned,a.branch,dir,`build(deploy): pin the image ${a.built.tag}\n\nPublished to the private registry by the owner's approval (vigia.ps1 -Approve ${a.id}); digest ${published.digest}.\nlatest is unchanged.\n`);
   a=writeAttempt(config.outDir,{...a,pinCommit:commit});
  }
 }else await ops.verifyBranch(a.branch,a.pinCommit);
 const commit=a.pinCommit;
 const files={compose:path.join(dir,'compose.coolify.literal.yml'),rollback:path.join(dir,'compose.rollback.literal.yml'),kernel:path.join(dir,'kernel.json'),features:a.features??'(no ODC features recorded)',deploy:path.join(dir,`deploy-${commit.slice(0,7)}.tar.gz`)};
 fs.writeFileSync(files.compose,literalComposeText(pinned,config.domains));
 fs.writeFileSync(files.rollback,literalComposeText(a.baseManifest,config.domains));
 await ops.archiveDeploy(commit,files.deploy);
 const newPair=!windowPairs(a.baseManifest).some(p=>pairId(p)===a.id);
 const steps=ownerSteps({attempt:a,published,commit,files,newPair,proposed:pinned});
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
// -Retry also takes a proposal (its local image was pruned, say): the next round builds it again.
export function retry(config,selector){
 const a=findAttempt(config.outDir,selector,['failed','rejected','deferred','proposed']);
 const journal=path.join(config.outDir,a.id,'deployment.json');
 if(fs.existsSync(journal)){const state=readJournal(journal);if(state.status==='rollback-failed'&&config.acknowledgeRollback!==a.id)throw Error('Use -AcknowledgeRollback '+a.id+' after manually checking and restoring production.');}
 if(a.published)throw Error(`${a.id} is already published (${a.published.digest}); finish it with -Approve ${a.id}.`);
 writeAttempt(config.outDir,{...a,retry:true,...(config.acknowledgeRollback===a.id?{acknowledgeRollback:a.id}:{})});
 return {status:'retry',id:a.id,note:`The next round runs ${a.id} again (${a.pair.lanes.map(l=>`${STUDIO_NAME[l]} ${a.pair[l]}`).join(', ')}).`};
}
