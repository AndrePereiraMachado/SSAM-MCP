import {recoverExpiredClientInspection} from './debug-private-inspection-recovery.mjs';
let input='';
try {
 for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>4096)throw new Error();}
 const {target,dryRun}=JSON.parse(input);input='';
 const result=recoverExpiredClientInspection(target,{dryRun});
 process.stdout.write(JSON.stringify(result));
}catch{process.stdout.write(JSON.stringify({ok:false,error:'debug_private_recovery_worker_failed'}));process.exitCode=1;}
