import {pinned,readPinned,requireThat,exactRoute,canonical} from './common.mjs';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
// Fixed visual fixtures. This does not implement server business logic or authentication.
export function createDataScenario(plan,{module,moduleKey,sourceSha256,emitted}={}){
 requireThat(plan?.schema==='ssam-native-o11-data-scenario/1'&&plan.explicitSynthetic===true&&plan.realBackend===false,'SCENARIO_CONTRACT');
 requireThat(plan.module===module&&plan.moduleKey===moduleKey&&/^[a-f0-9]{64}$/.test(plan.sourceSha256)&&(!sourceSha256||plan.sourceSha256===sourceSha256),'SCENARIO_SOURCE');
 requireThat(Number.isSafeInteger(plan.maxBodyBytes)&&plan.maxBodyBytes>0&&plan.maxBodyBytes<=1048576&&Array.isArray(plan.endpoints),'SCENARIO_BOUND');
 const endpoints=new Map();
 for(const endpoint of plan.endpoints){
  const prefix='/'+module+'/screenservices/'+module+'/',parts=endpoint.path?.slice(prefix.length).split('/');
  requireThat(endpoint.kind==='DataAction'&&endpoint.status==='ready'&&exactRoute(endpoint.path)&&endpoint.path.startsWith(prefix)&&parts?.length===3&&/^DataAction[A-Za-z0-9_]+$/.test(parts[2]),'DATA_ACTION_ONLY');
  requireThat(endpoint.viewName===parts.slice(0,2).join('.')&&typeof endpoint.apiVersion==='string'&&endpoint.apiVersion&&endpoint.moduleVersion===''&&endpoint.inputParameters==='none','ENDPOINT_PROFILE');
  requireThat(endpoint.inputPolicy?.mode==='fixed-response'&&canonical(endpoint.inputPolicy.independentOf?.slice().sort())===canonical(['clientVariables','screenData.variables']),'FIXED_RESPONSE_POLICY');
  requireThat(!endpoints.has(endpoint.path),'ENDPOINT_DUPLICATE');
  const source=pinned(endpoint.source).toString('utf8');
  // Provenance ties the literal endpoint/API to an actually emitted original controller.
  requireThat(source.includes(JSON.stringify(endpoint.path.slice(module.length+2)))&&source.includes(JSON.stringify(endpoint.apiVersion)),'ENDPOINT_SOURCE_LITERAL');
  if(emitted)requireThat(emitted.some(e=>e.sha256===endpoint.source.sha256&&e.role==='controller'),'ENDPOINT_CONTROLLER_NOT_EMITTED');
  const body=pinned(endpoint.response),response=JSON.parse(body);
  requireThat(object(response)&&Object.keys(response).length===1&&object(response.data),'RESPONSE_DATA_ONLY');
  endpoints.set(endpoint.path,{endpoint,body});
 }
 return {paths:Object.freeze([...endpoints.keys()]),maxBodyBytes:plan.maxBodyBytes,sourceSha256:plan.sourceSha256,
  dispatch({method,path,contentType,body}){
   requireThat(method==='POST','METHOD_REFUSED');const found=endpoints.get(path);requireThat(found,'ENDPOINT_REFUSED');
   requireThat(/^application\/json(?:\s*;|$)/i.test(contentType??''),'CONTENT_TYPE');
   const bytes=Buffer.isBuffer(body)?body:Buffer.from(body??'');requireThat(bytes.length<=plan.maxBodyBytes,'REQUEST_SIZE');
   let request;try{request=JSON.parse(bytes.toString('utf8'));}catch{requireThat(false,'REQUEST_JSON');}
   const {endpoint}=found;
   requireThat(object(request)&&request.viewName===endpoint.viewName&&object(request.versionInfo)&&request.versionInfo.apiVersion===endpoint.apiVersion&&request.versionInfo.moduleVersion===endpoint.moduleVersion,'REQUEST_PROFILE');
   requireThat(object(request.screenData)&&object(request.screenData.variables)&&(request.clientVariables===undefined||object(request.clientVariables)),'REQUEST_SHAPE');
   requireThat(request.inputParameters===undefined||(object(request.inputParameters)&&Object.keys(request.inputParameters).length===0),'INPUT_PARAMETERS');
   return {status:200,contentType:'application/json; charset=utf-8',body:Buffer.from(found.body),responseSha256:endpoint.response.sha256,scenarioName:plan.name};
  }
 };
}
export function readDataScenario(config,emitter){
 if(config.transportPolicy==='deny-all'){requireThat(!config.scenarioPlan,'UNUSED_SCENARIO_PLAN');return null;}
 requireThat(config.transportPolicy==='local-data-actions'&&config.scenarioPlan,'LOCAL_DATA_POLICY');
 const plan=readPinned(config.scenarioPlan);
 const dispatcher=createDataScenario(plan,{...config.target,sourceSha256:emitter?.source.sha256,emitted:emitter?.emitted});
 return {plan,dispatcher};
}
