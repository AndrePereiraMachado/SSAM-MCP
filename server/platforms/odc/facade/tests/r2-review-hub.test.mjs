import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { startHttpServer } from '../http-server.mjs';
import { createTokenStore } from '../server-tokens.mjs';
import { CALL_KINDS } from '../agent-hub.mjs';
import { Mirror } from '../hosted/mirror.mjs';
import { uploadLocalFile } from '../hosted/local-upload.mjs';

test('review 5 real hub uploads only for an explicitly capable agent',{timeout:15000},async t=>{
  assert.ok(CALL_KINDS.includes('file.upload'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-hub-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const handle=await startHttpServer({createServer:async()=>new McpServer({name:'test',version:'1'}),dir,port:0,agents:{kernel:{o11:'11.55.91',odc:'1.7.28',odcBridge:'v35'}}});
  t.after(()=>handle.close());const base=handle.url.replace(/\/mcp$/,''),tokens=createTokenStore(dir),old=process.env.SSAM_LOCAL_UPLOAD;
  process.env.SSAM_LOCAL_UPLOAD='1';t.after(()=>old===undefined?delete process.env.SSAM_LOCAL_UPLOAD:process.env.SSAM_LOCAL_UPLOAD=old);
  for(const supported of [false,true]){
    const token=tokens.issue({customer:'Test'}),headers={authorization:'Bearer '+token.agentCredential,'content-type':'application/json'};
    const hello={t:'hello',protocol:'ssam-agent/1',instance:randomUUID(),agent:{version:supported?'0.3.2':'0.1.3',node:process.version,platform:'win32',startedAt:new Date().toISOString(),...(supported?{kinds:['file.upload']}: {})},
      pack:{id:'test',lanes:['o11','odc'],o11BuiltFor:'11.55.91',odcBridge:'v35'},studios:{},o11Connection:null};
    const welcomed=await fetch(base+'/agent/v1/hello',{method:'POST',headers,body:JSON.stringify(hello)});assert.equal(welcomed.status,200);
    const {channel}=await welcomed.json(),stream=await fetch(base+'/agent/v1/stream?channel='+channel,{headers});
    const reader=stream.body.getReader();
    try{
      const link=handle.hub.link(token.id),workspace=path.join(dir,'customers',token.id);fs.mkdirSync(path.join(workspace,'inbox'),{recursive:true});
      const context={workspace,agent:link,executor:{mirror:new Mirror({workspace,link})}};
      if(!supported){assert.equal(link.supports('file.upload'),false);await assert.rejects(uploadLocalFile(context,'local:C:\\Approved\\file.csv'),{code:'HOSTED_UNAVAILABLE'});await assert.rejects(link.call('file.upload',{}),{code:'KIND_NOT_ALLOWED'});continue;}
      const uploading=uploadLocalFile(context,'local:C:\\Approved\\file.csv');
      let buffer='',call;const decoder=new TextDecoder();
      while(!call){const chunk=await reader.read();assert.equal(chunk.done,false);buffer+=decoder.decode(chunk.value);for(const line of buffer.split('\n').slice(0,-1)){if(!line)continue;const message=JSON.parse(line);if(message.t==='call')call=message;}buffer=buffer.slice(buffer.lastIndexOf('\n')+1);}
      assert.equal(call.kind,'file.upload');assert.equal(call.params.path,'C:\\Approved\\file.csv');
      const bytes=Buffer.from('uploaded rows'),sha=createHash('sha256').update(bytes).digest('hex'),transfer=randomBytes(16).toString('hex');
      const result=await fetch(base+'/agent/v1/blobs/'+transfer+'/0?channel='+channel,{method:'PUT',body:bytes,headers:{authorization:headers.authorization,'content-type':'application/octet-stream','x-ssam-part-sha256':sha,'x-ssam-total-sha256':sha,'x-ssam-total-size':String(bytes.length),'x-ssam-parts':'1'}});assert.equal(result.status,204);
      const sent=await fetch(base+'/agent/v1/messages?channel='+channel,{method:'POST',headers,body:JSON.stringify({messages:[{t:'result',id:call.id,ok:true,value:{blob:{transfer,sha256:sha,size:bytes.length,parts:1,partBytes:bytes.length}}}]})});assert.equal(sent.status,204);
      const dest=await uploading;assert.deepEqual(fs.readFileSync(dest),bytes);
    }finally{await reader.cancel();}
  }
});
