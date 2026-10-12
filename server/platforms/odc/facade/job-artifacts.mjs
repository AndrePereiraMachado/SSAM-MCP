import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {cleanCandidateValidation} from '../portal/runtime/asset-source-revision.mjs';

const artifact=file=>({file:path.resolve(file),sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
export const captureJobArtifacts=(base,job)=>({base:artifact(base),job:artifact(job)});
export function bindJobArtifacts(before,out,result){
 for(const item of Object.values(before))if(artifact(item.file).sha256!==item.sha256)throw Error('Job inputs changed during native validation');
 const data=result.data;
 if(result.ok!==true||!cleanCandidateValidation(data)||!data.handles?.['@espace'])return null;
 if(path.resolve(data.outPath)!==path.resolve(out))throw Error('Native output path differs from requested candidate');
 return {schema:'ssam-job-artifacts/1',lane:'odc',...before,candidate:artifact(out),moduleKey:data.handles['@espace']};
}
