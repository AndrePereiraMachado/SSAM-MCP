import {createPowerShellRunner,CREDENTIAL} from './vault.mjs';
import {hostName} from './http.mjs';
import {ProtocolError} from './errors.mjs';

// Dedicated GET transport: Basic credentials remain inside the short-lived
// vault process. No arbitrary URL, redirects, cookies or response headers.
export function performanceEventsRequest({host,target,principal,since,until,limit=100,eventAuth='basic'}){
 const name=hostName(host),a=Date.parse(since),b=Date.parse(until);
 if(!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(since??'')||!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(until??'')
  ||!Number.isFinite(a)||!Number.isFinite(b)||a>=b||b-a>3600000||!Number.isInteger(limit)||limit<1||limit>100)
  throw new ProtocolError('Timer events require a UTC window up to one hour and limit 1..100.');
 const prefix=`SSAM/O11/${name}/ServiceCenter`;
 if(!['basic','service-token'].includes(eventAuth))throw new ProtocolError('Unknown monitoring authentication mode.');
 if(eventAuth==='service-token'){
  if(target!==`SSAM/O11/${name}/LifeTime`||principal!=null)throw new ProtocolError('Service-token monitoring requires the exact same-host LifeTime vault entry, without an assumed user principal.');
 }else if(typeof target!=='string'||!(target===prefix||target.startsWith(prefix+'/Profiles/')&&/^\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(target.slice((prefix+'/Profiles').length)))
  ||typeof principal!=='string'||!principal.trim())throw new ProtocolError('Exact same-host credential target and expected principal are required.');
 const url=new URL(`https://${name}/PerformanceProbe/rest/PerformanceMonitoringAPI/RequestEvents/`);
 url.search=new URLSearchParams({EventNames:'TimerExecuted',StartInstant:new Date(a).toISOString(),EndInstant:new Date(b).toISOString(),NumberOfResults:String(limit)}).toString();
 return {host:name,target,principal,eventAuth,url:url.href,limit};
}

const BODY=String.raw`
$ErrorActionPreference='Stop'
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
<SETUP>
$target=[string]$request.target; $wantSecret=$true
<READ>
if (-not $found -or -not $secret) { @{ok=$false;code='VAULT_UNAVAILABLE'}|ConvertTo-Json -Compress; exit 0 }
if ($request.eventAuth -eq 'basic' -and (-not $user -or -not [string]::Equals($user,[string]$request.principal,[StringComparison]::OrdinalIgnoreCase))) { @{ok=$false;code='VAULT_PRINCIPAL_MISMATCH'}|ConvertTo-Json -Compress; exit 0 }
try {
 [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
 if($request.eventAuth -eq 'service-token'){$authorization='Bearer '+$secret;$basic=$null}else{$basic=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($user+':'+$secret));$authorization='Basic '+$basic}
 $web=[Net.HttpWebRequest]::Create([string]$request.url)
 $web.Method='GET';$web.AllowAutoRedirect=$false;$web.KeepAlive=$false;$web.Timeout=30000;$web.ReadWriteTimeout=30000
 $web.Accept='application/json';$web.Headers['Authorization']=$authorization
 try {$response=$web.GetResponse()} catch [Net.WebException] {$response=$_.Exception.Response;if($null -eq $response){throw}}
 $status=[int]$response.StatusCode
 if($status -ne 200){
  $diagnostic=@();$stream=$response.GetResponseStream();$buffer=New-Object byte[] 16384;$n=$stream.Read($buffer,0,$buffer.Length)
  try{
   $errorData=[Text.Encoding]::UTF8.GetString($buffer,0,$n)|ConvertFrom-Json
   $diagnostic=@(foreach($entry in @($errorData.Errors)|Select-Object -First 3){
    if($entry -is [string]){
     $safe=[string]$entry
     foreach($echo in @($secret,$basic,$authorization,[Uri]::EscapeDataString($secret),[Net.WebUtility]::HtmlEncode($secret))){if($echo){$safe=$safe.Replace($echo,'<redacted>')}}
     if($safe.Length -gt 256){$safe=$safe.Substring(0,256)};$safe
    }
   })
  }catch{}
  @{ok=$true;status=$status;diagnostic=$diagnostic}|ConvertTo-Json -Depth 4 -Compress;exit 0
 }
 $stream=$response.GetResponseStream();$memory=New-Object IO.MemoryStream;$buffer=New-Object byte[] 8192
 while(($n=$stream.Read($buffer,0,$buffer.Length)) -gt 0){$memory.Write($buffer,0,$n);if($memory.Length -gt 2097152){throw 'Oversized response'}}
 $data=[Text.Encoding]::UTF8.GetString($memory.ToArray())|ConvertFrom-Json
 if($null -eq $data.RequestEventList -or $data.ResultsTruncated -isnot [bool]){throw 'Invalid event envelope'}
 $events=@(foreach($event in @($data.RequestEventList)){
  if($event.RequestEventName -ne 'TimerExecuted'){throw 'Unexpected event type'}
  $details=$event.RequestEventDetails;if($details -is [string]){$details=$details|ConvertFrom-Json}
  @{Instant=$event.Instant;RequestKey=$event.RequestKey;RequestEventName=$event.RequestEventName;ModuleKey=$event.ModuleKey;ModuleName=$event.ModuleName;
    ApplicationKey=$event.ApplicationKey;ApplicationName=$event.ApplicationName;Details=@{AN=$details.AN;AK=$details.AK;EC=$details.EC;D=$details.D}}
 })
 if($events.Count -gt [int]$request.limit){throw 'Event limit exceeded'}
 $answer=@{ok=$true;status=$status;authenticated=$true;RequestEventList=$events;ResultsTruncated=$data.ResultsTruncated}|ConvertTo-Json -Depth 10 -Compress
 foreach($echo in @($secret,$basic,$authorization,[Uri]::EscapeDataString($secret))){if($echo){$answer=$answer.Replace($echo,'<redacted>')}}
 $answer
}catch{@{ok=$false;code='PERFORMANCE_EVENTS_READ_FAILED'}|ConvertTo-Json -Compress}
finally{if($response){$response.Close()};$secret=$null;$basic=$null;$authorization=$null;$user=$null}
`;
export async function readPerformanceEvents(input,{run=createPowerShellRunner(),credential=CREDENTIAL}={}){
 const request=performanceEventsRequest(input);
 const script=BODY.replace('<SETUP>',()=>credential.setup).replace('<READ>',()=>credential.read);
 const result=await run(script,request);
 if(result?.ok!==true)return {ok:false,host:request.host,error:{code:result?.code??'PERFORMANCE_EVENTS_READ_FAILED'}};
 if(result.status!==200)return {ok:false,host:request.host,status:result.status,authenticated:[401,403].includes(result.status)?false:null,
  diagnostic:Array.isArray(result.diagnostic)?result.diagnostic:[],error:{code:'PERFORMANCE_EVENTS_ACCESS_UNVERIFIED'}};
 if(result.authenticated!==true||!Array.isArray(result.RequestEventList)||typeof result.ResultsTruncated!=='boolean')
  throw new ProtocolError('Invalid private monitoring result.');
 const completions=timerCompletionEvents(result.RequestEventList,input);
 return {ok:true,host:request.host,status:200,authenticated:true,events:result.RequestEventList,truncated:result.ResultsTruncated,
  monitoringEnabledVerified:completions.length>0,completionEvents:completions,executionCausalityVerified:false,
  verificationScope:'authenticated-timer-completion-events; no administrative-run attribution',auth:{path:request.eventAuth==='service-token'?'vault-service-token':'vault-basic',principal:request.principal??null,
   ...(request.eventAuth==='service-token'?{serviceAccountIdentityVerified:false}: {})}};
}

// TimerExecuted records completion of one server request. EC describes errors
// in that request; neither EC=0 nor a matching name proves the Run Now cause,
// business success, or completion of every automatic retry in a timer cycle.
export function timerCompletionEvents(events,{since,until,limit=100}){
 const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x)&&x!=='00000000-0000-0000-0000-000000000000';
 const start=Date.parse(since),end=Date.parse(until),seen=new Set();
 if(!Array.isArray(events)||events.length>limit||!Number.isFinite(start)||!Number.isFinite(end)||start>=end)
  throw new ProtocolError('Invalid timer completion event envelope.');
 return events.map(event=>{
  const instant=Date.parse(event?.Instant),details=event?.Details;
  if(event?.RequestEventName!=='TimerExecuted'||!uuid(event.RequestKey)||!uuid(event.ModuleKey)||!uuid(event.ApplicationKey)
   ||typeof event.Instant!=='string'||!event.Instant.endsWith('Z')||!Number.isFinite(instant)||instant<start||instant>end
   ||typeof event.ModuleName!=='string'||!event.ModuleName||typeof event.ApplicationName!=='string'||!event.ApplicationName
   ||!details||!uuid(details.AK)||typeof details.AN!=='string'||!details.AN
   ||!Number.isSafeInteger(details.EC)||details.EC<0||typeof details.D!=='number'||!Number.isFinite(details.D)||details.D<0
   ||seen.has(event.RequestKey.toLowerCase()))throw new ProtocolError('Timer completion event identity, window or metrics are invalid.');
  seen.add(event.RequestKey.toLowerCase());
  return {requestKey:event.RequestKey,moduleKey:event.ModuleKey,applicationKey:event.ApplicationKey,actionKey:details.AK,
   actionName:details.AN,instant:event.Instant,durationMs:details.D,errorCount:details.EC,
   serverRequestCompleted:true,outcome:details.EC===0?'completed-without-reported-errors':'completed-with-errors',
   attributedToRunNow:false,timerCycleCompleted:null,businessSuccessVerified:false};
 });
}
