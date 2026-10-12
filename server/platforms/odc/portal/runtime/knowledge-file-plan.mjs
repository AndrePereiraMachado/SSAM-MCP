import {fingerprint,isUuid} from './write-journal.mjs';
import {createHash} from 'node:crypto';
import {fail} from './errors.mjs';
const bad=message=>fail('INPUT_INVALID',message);
// Native screenservice input observed in DataSources.datasource. This planner
// does not send, reserve a receipt or claim server-side ingestion.
export function knowledgeFileUploadPlan({knowledgeBaseId,dataSourceId,environmentKey,filename,mimeType,base64,limits}){
 if(![knowledgeBaseId,dataSourceId,environmentKey].every(isUuid))bad('Exact base, source and stage UUIDs are required.');
 if(typeof filename!=='string'||!filename.trim()||filename.length>255||/[\x00-\x1f\x7f/\\]/.test(filename)||['.','..'].includes(filename))bad('A simple nonempty filename is required.');
 if(!limits?.ok||typeof limits.data?.AllowedUploadMimeTypes!=='string')bad('Live upload limits are required.');
 const max=Number(limits.data.MaximumUploadFileSize);
 if(!Number.isSafeInteger(max)||max<=0)bad('Upload size limit is unavailable.');
 const allowed=limits.data.AllowedUploadMimeTypes.split(',').map(x=>x.trim());
 if(typeof mimeType!=='string'||!allowed.includes(mimeType))bad('File MIME type is not in the observed allowed list.');
 if(typeof base64!=='string'||!base64||base64.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))bad('File content must be canonical base64.');
 const bytes=Buffer.from(base64,'base64');
 if(bytes.toString('base64')!==base64||!bytes.length||bytes.length>max)bad('File content exceeds the observed limit or is not canonical.');
 const input={inputParameters:{KnowledgeBaseId:knowledgeBaseId,DataSourceId:dataSourceId,EnvironmentId:environmentKey,
  FileMetaData:{Filename:filename,SizeBytes:String(bytes.length),ContentType:mimeType},FileContent:base64}};
 // This is the existing generic Portal input budget, not a claimed server limit.
 if(Buffer.byteLength(JSON.stringify(input))>262144)fail('REQUEST_TOO_LARGE','Upload requires a dedicated large-file transport; generic Portal input is limited to 256 KiB. Nothing was sent.');
 const plan={schema:'ssam-knowledge-file-upload/1',knowledgeBaseId,dataSourceId,environmentKey,filename,mimeType,byteLength:bytes.length,
  input,contentSha256:createHash('sha256').update(bytes).digest('hex'),limitsSha256:fingerprint(limits.data),inputSha256:fingerprint(input)};
 return {ok:true,...plan,planSha256:fingerprint(plan),sent:false,ingestionVerified:false};
}
