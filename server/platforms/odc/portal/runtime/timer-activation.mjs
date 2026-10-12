import { fail } from './errors.mjs';
import { timerWakeInput, timerVariables } from './portal-timer.mjs';
import { assertOnlyTimerOverrides } from './timer-configuration-approval.mjs';

const refuse = (message, code = 'TIMER_CONTEXT_UNPROVEN') => fail(code, message);
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const readable = x => typeof x === 'string' && x.trim().length > 0 && !x.includes('[REDACTED]');
const stable = c => c && c.isSecret === false && readable(c.value) && readable(c.deployedValue)
  && c.value === c.deployedValue && c.valueOrigin === c.deployedValueOrigin
  && ['ApplicationLevelDefault','ApplicationLevelOverride'].includes(c.valueOrigin);

export async function prepareTimerActivation(raw, active, {configuration,application,portalRead}) {
  if (typeof active !== 'boolean') refuse('The requested activation must be Boolean.');
  const ids=timerWakeInput(raw).inputParameters, vars=timerVariables(ids);
  const readConfig=()=>configuration({environmentKey:ids.StageKey,applicationKey:ids.ApplicationKey});
  const first=await readConfig(), data=first?.data;
  if(!first?.ok || !data || !Number.isInteger(data.revisionDeployed) || data.revisionDeployed<1
    || data.revisionBaseline!==data.revisionDeployed || !Array.isArray(data.timers))
    refuse('The deployed revision is unavailable or has drifted.');
  const asset=await application({assetKey:ids.ApplicationKey,revisionNumber:data.revisionDeployed});
  if(!asset?.ok || !same(asset.data?.assetKey,ids.ApplicationKey) || asset.data?.revision!==data.revisionDeployed || !readable(asset.data?.name))
    refuse('The exact deployed application could not be identified.');
  const timers=data.timers.filter(t=>same(t.key,ids.TimerKey)), timer=timers[0];
  if(timers.length!==1 || !readable(timer.name) || !Array.isArray(timer.configs)) refuse('Exactly one named timer is required.');
  const fields={};
  for(const name of ['IsActive','Schedule','Timeout']) {
    const found=timer.configs.filter(c=>c.key===name);
    if(found.length!==1 || !stable(found[0])) refuse('Timer values and origins must be readable and unchanged.','TIMER_CONFIGURATION_PENDING');
    fields[name]=found[0];
  }
  if(fields.IsActive.dataType!=='Boolean' || fields.Timeout.dataType!=='Integer' || fields.Schedule.dataType!=='Text' || !/^(True|False)$/i.test(fields.IsActive.value) || !/^\d+$/.test(fields.Timeout.value)
    || !Number.isSafeInteger(Number(fields.Timeout.value))) refuse('Timer activation or timeout has an unknown representation.');
  // Restrict application-wide ApplyConfigs to inherited defaults outside this timer.
  // This does not claim an atomic snapshot or secret-value equality.
  try { assertOnlyTimerOverrides(data,[timer]); } catch { refuse('Unrelated application configuration cannot be proved inherited and unchanged.','TIMER_CONFIGURATION_PENDING'); }
  const info=await portalRead('timers.info',vars), native=info?.data?.TimerInfo?.Timer;
  if(!info?.ok || info.data?.NotFound!==false || info.data?.TimerInfo?.HasPendingConfigurations!==false
    || !same(native?.Key,ids.TimerKey) || native?.Name!==timer.name) refuse('The Portal did not confirm the timer and its clean configuration.');
  const n=native.Configs;
  if(typeof n?.IsActive?.Current!=='boolean' || n.IsActive.Current!==n.IsActive.Deployed
    || n.IsActive.Current!==(/^true$/i.test(fields.IsActive.value)) || n.IsActive.ValueOrigin!==fields.IsActive.valueOrigin || n.IsActive.DeployedValueOrigin!==fields.IsActive.deployedValueOrigin
    || n.Schedule?.Value!==fields.Schedule.value || n.Schedule?.DeployedValue!==fields.Schedule.deployedValue
    || n.Schedule?.ValueOrigin!==fields.Schedule.valueOrigin || n.Schedule?.DeployedValueOrigin!==fields.Schedule.deployedValueOrigin
    || String(n.Timeout?.Value)!==fields.Timeout.value || String(n.Timeout?.DeployedValue)!==fields.Timeout.deployedValue
    || n.Timeout?.ValueOrigin!==fields.Timeout.valueOrigin || n.Timeout?.DeployedValueOrigin!==fields.Timeout.deployedValueOrigin)
    refuse('Portal and public timer configurations disagree.');
  const pending=await portalRead('timers.pendingConfiguration',vars);
  if(!pending?.ok || !Array.isArray(pending.data?.PendingConfigurations?.List) || pending.data.PendingConfigurations.List.length)
    refuse('The application has pending or unreadable configuration changes.','TIMER_CONFIGURATION_PENDING');
  const run=await portalRead('timers.currentRun',vars), state=run?.data?.TimerRunInformation;
  if(!run?.ok || state?.isRunning!==false || state?.isPendingRun!==false)
    refuse('The timer is running, pending, or its state is unknown.','TIMER_ALREADY_RUNNING');
  const deployment=await portalRead('timers.deploymentStatus',vars);
  if(!deployment?.ok || deployment.data?.HasOngoingDeployments!==false)
    refuse('A deployment is in progress or cannot be ruled out.','TIMER_DEPLOYMENT_PENDING');
  const last=await readConfig();
  if(!last?.ok || JSON.stringify(last.data)!==JSON.stringify(data)) refuse('Configuration changed during preflight.','TIMER_CONFIGURATION_DRIFT');
  const desired={Timer:{Key:ids.TimerKey,Configs:{IsActive:{Current:active,ValueOrigin:'ApplicationLevelOverride'},
    Schedule:{Value:fields.Schedule.value,ValueOrigin:fields.Schedule.valueOrigin},
    Timeout:{Value:fields.Timeout.valueOrigin==='ApplicationLevelDefault'?'0':fields.Timeout.value,ValueOrigin:fields.Timeout.valueOrigin}}}};
  return {input:{inputParameters:{EnvironmentKey:ids.StageKey,ApplicationKey:ids.ApplicationKey,RevisionBaseline:data.revisionDeployed,TimerInfo:desired},screenVariables:{},clientVariables:{}},
    target:{environmentKey:ids.StageKey,applicationKey:ids.ApplicationKey,timerKey:ids.TimerKey},
    before:{applicationName:asset.data.name,timerName:timer.name,revision:data.revisionDeployed,active:n.IsActive.Current,
      schedule:fields.Schedule.value,scheduleOrigin:fields.Schedule.valueOrigin,timeout:fields.Timeout.value,timeoutOrigin:fields.Timeout.valueOrigin},
    desiredActive:active,alreadyApplied:n.IsActive.Current===active,atomicityProven:false};
}

export async function verifyTimerActivation(context,{configuration,portalRead,deploymentKey}) {
 const {target,before,desiredActive}=context;
 const ids={StageKey:target.environmentKey,ApplicationKey:target.applicationKey,TimerKey:target.timerKey},vars=timerVariables(ids);
 const response=await configuration({environmentKey:target.environmentKey,applicationKey:target.applicationKey}),data=response?.data;
 if(!response?.ok || data?.revisionBaseline!==before.revision || data.revisionDeployed!==before.revision)
  refuse('The deployed revision changed before timer verification.','TIMER_STATE_UNVERIFIED');
 const rows=data.timers?.filter(t=>same(t.key,target.timerKey));
 if(rows?.length!==1 || rows[0].name!==before.timerName) refuse('The timer identity changed.','TIMER_STATE_UNVERIFIED');
 const expected={IsActive:{value:String(desiredActive),origin:'ApplicationLevelOverride'},Schedule:{value:before.schedule,origin:before.scheduleOrigin},Timeout:{value:before.timeout,origin:before.timeoutOrigin}};
 for(const [key,item] of Object.entries(expected)) {
  const list=rows[0].configs?.filter(c=>c.key===key), c=list?.[0];
  const matches=value=>typeof value==='string' && (key==='IsActive' ? value.toLowerCase()===item.value : value===item.value);
  if(list?.length!==1 || c.isSecret!==false || !matches(c.value)
   || !matches(c.deployedValue) || c.valueOrigin!==item.origin || c.deployedValueOrigin!==item.origin)
    refuse('The deployed timer value or origin does not match the requested state.','TIMER_STATE_UNVERIFIED');
 }
 const info=await portalRead('timers.info',vars),n=info?.data?.TimerInfo?.Timer;
 if(!info?.ok || info.data?.NotFound!==false || info.data?.TimerInfo?.HasPendingConfigurations!==false
  || !same(n?.Key,target.timerKey) || n.Name!==before.timerName || n.Configs?.IsActive?.Current!==desiredActive
  || n.Configs?.IsActive?.Deployed!==desiredActive || n.Configs?.IsActive?.ValueOrigin!=='ApplicationLevelOverride'
  || n.Configs?.IsActive?.DeployedValueOrigin!=='ApplicationLevelOverride'
  || n.Configs?.Schedule?.Value!==before.schedule || n.Configs?.Schedule?.DeployedValue!==before.schedule
  || n.Configs?.Schedule?.ValueOrigin!==before.scheduleOrigin || n.Configs?.Schedule?.DeployedValueOrigin!==before.scheduleOrigin
  || String(n.Configs?.Timeout?.Value)!==before.timeout || String(n.Configs?.Timeout?.DeployedValue)!==before.timeout
  || n.Configs?.Timeout?.ValueOrigin!==before.timeoutOrigin || n.Configs?.Timeout?.DeployedValueOrigin!==before.timeoutOrigin)
   refuse('The Portal did not independently confirm the deployed timer state.','TIMER_STATE_UNVERIFIED');
 if(deploymentKey){
  const scope=await portalRead('timers.deploymentStatus',vars);
  if(!scope?.ok || scope.data?.HasOngoingDeployments!==false || !same(scope.data?.DeploymentKey,deploymentKey))
   refuse('The scoped Portal deployment does not identify this completed configuration operation.','TIMER_STATE_UNVERIFIED');
 }
 return{confirmed:true,target,active:desiredActive,revision:before.revision,schedulePreserved:true,timeoutPreserved:true,originsPreserved:true,...(deploymentKey?{deploymentKey}: {})};
}

export function validateTimerDeployment(receipt,operationKey,data){
 const t=receipt.timerActivation;
 if(!t || data?.key!==operationKey || data.assetKey!==t.target.applicationKey || data.operation!=='ApplyConfigs'
  || !Array.isArray(data.revisions) || data.revisions.length!==1 || data.revisions[0]!==t.before.revision)
   refuse('The deployment does not identify the timer application, revision and ApplyConfigs operation.','OPERATION_IDENTITY_UNVERIFIED');
 if(receipt.response?.DeploymentKey){
  if(receipt.response.DeploymentKey!==operationKey)refuse('The deployment key differs from the write receipt.','OPERATION_IDENTITY_UNVERIFIED');
 }else{
  const started=Date.parse(data.startedDateTime),first=Date.parse(receipt.createdAt),last=Date.parse(receipt.updatedAt);
  if(![started,first,last].every(Number.isFinite)||started<first||started>last)
   refuse('The discovered deployment did not start during the recorded write.','OPERATION_IDENTITY_UNVERIFIED');
 }
}
