import test from 'node:test';import assert from 'node:assert/strict';
import {mobileBinaryTransport} from '../runtime/mobile-binary-transport.mjs';
const scope={environmentKey:'stage',portfolioKey:'portfolio'};
const stages=flag=>({ok:true,data:{EnableNAOSBASE64Patch:flag,EnvironmentsApplicationVersion:{List:[{Environment:{Key:'stage',PortfolioKey:'portfolio',Status:'Ready'}}]}}});
test('native binary transport flag chooses conversion independently from Text decoding',()=>{
 assert.deepEqual(mobileBinaryTransport(stages(false),scope),{mode:'signed-upload',requiresDecoding:false,nativeAction:'ActionFileUpload_Wrapper',executionSupported:true,base64Enabled:false});
 assert.deepEqual(mobileBinaryTransport(stages(true),scope),{mode:'base64',requiresDecoding:false,nativeAction:'ActionBinaryToBase64',executionSupported:true,base64Enabled:true});
});
for(const variant of ['failed','missing','string','null','other-stage','other-portfolio','not-ready','duplicate'])test('native binary transport refuses ambiguous baseline: '+variant,()=>{
 const s=stages(false);switch(variant){case'failed':s.ok=false;break;case'missing':delete s.data.EnableNAOSBASE64Patch;break;case'string':s.data.EnableNAOSBASE64Patch='false';break;case'null':s.data.EnableNAOSBASE64Patch=null;break;case'other-stage':s.data.EnvironmentsApplicationVersion.List[0].Environment.Key='other';break;case'other-portfolio':s.data.EnvironmentsApplicationVersion.List[0].Environment.PortfolioKey='other';break;case'not-ready':s.data.EnvironmentsApplicationVersion.List[0].Environment.Status='Pending';break;case'duplicate':s.data.EnvironmentsApplicationVersion.List.push(structuredClone(s.data.EnvironmentsApplicationVersion.List[0]));break;}
 assert.throws(()=>mobileBinaryTransport(s,scope),e=>e.code==='MOBILE_BASELINE_UNVERIFIED');
});
