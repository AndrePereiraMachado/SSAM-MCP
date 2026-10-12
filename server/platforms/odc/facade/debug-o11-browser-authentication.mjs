// Private app-user session of the O11 owned-browser mount. Two parts:
// - the guarded host transport: the only real network of the page (version
//   checks, roles, screenservices POSTs), same origin, header allowlist, the
//   host-held cookie jar; HttpOnly cookies never reach the page;
// - the original O11 login: the page calls its published login controller with
//   random placeholders and the transport substitutes the private credentials
//   in that single POST. Credentials never enter the page, a receipt or a journal.
import {randomBytes,createHash} from 'node:crypto';
import {CookieJar,Cookie} from 'tough-cookie';

const fail=code=>{throw new Error('debug_o11_browser_authentication_'+code);};
const HEADERS=['accept','content-type','x-csrftoken','outsystems-request-token','outsystems-ccid','outsystems-dbg-stop','outsystems-dbg-bkp'];
const digest=value=>createHash('sha256').update(String(value)).digest('hex');

export function createO11BrowserSession({runtimeUrl,module,versionToken,userProvider,login,binding,fetchImpl=fetch,cookieJar,vault,validateDescriptor,
  beforeSignIn,recordSignInResult,timeoutMs=120000,responseLimit=5*1024*1024}){
  const url=new URL(runtimeUrl??'');
  if(url.protocol!=='https:'||url.pathname!=='/'+module+'/'||typeof versionToken!=='string'||!versionToken||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(userProvider??'')||
    typeof login?.endpoint!=='string'||!login.endpoint.startsWith(url.pathname+'screenservices/')||typeof beforeSignIn!=='function'||typeof recordSignInResult!=='function')fail('contract_invalid');
  const jar=cookieJar??new CookieJar(undefined,{rejectPublicSuffixes:true,prefixSecurity:'strict',allowSecureOnLocal:false});
  const signIn={armed:false,submitted:false,answered:false,accepted:false,uncertain:false},requests={submitted:0,answered:0,uncertain:0,refused:0};
  const inflight=new Set(),userCookie='nr2'+userProvider;let credentials,placeholders,cleared=false,userCookieIssued=false;
  const refuse=()=>{requests.refused++;return undefined;};
  const json=text=>{try{const v=JSON.parse(text);return v&&typeof v==='object'&&!Array.isArray(v)?v:undefined;}catch{return undefined;}};
  async function forward(target,method,headers,body){
    const out={};
    for(const [name,value] of Object.entries(headers??{}))if(HEADERS.includes(name.toLowerCase())&&typeof value==='string'&&value.length<=4096&&!/[\r\n]/.test(value))out[name]=value;
    const cookie=await jar.getCookieString(target.href);if(cookie)out.Cookie=cookie;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);inflight.add(controller);
    try{
      const response=await fetchImpl(target.href,{method,headers:out,body,redirect:'error',credentials:'omit',signal:controller.signal});
      if(response.url&&response.url!==target.href)throw new Error('origin_changed');
      const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>responseLimit)throw new Error('response_limit');
      const forwarded=[],issued=[];
      for(const item of response.headers.getSetCookie?.()??[]){
        await jar.setCookie(item,target.href);
        const parsed=Cookie.parse(item);if(parsed?.value)issued.push(parsed.key);if(parsed&&!parsed.httpOnly)forwarded.push({name:'Set-Cookie',value:item});
      }
      const type=response.headers.get('content-type');
      return {status:response.status,body:bytes.toString('utf8'),headers:[...(type?[{name:'Content-Type',value:type}]:[]),{name:'Cache-Control',value:'no-store'},...forwarded],issued};
    }finally{clearTimeout(timer);inflight.delete(controller);for(const k of Object.keys(out))out[k]='';}
  }
  async function signInRequest(target,request){
    const payload=json(request.postData??'');
    if(!credentials||!placeholders||signIn.submitted||!payload||Object.keys(payload).sort().join(',')!=='inputParameters,versionInfo,viewName'||
      payload.versionInfo?.moduleVersion!==versionToken||payload.versionInfo.apiVersion!==login.apiVersion||payload.viewName!==login.viewName||
      Object.keys(payload.inputParameters??{}).sort().join(',')!=='Password,RememberLogin,Username'||payload.inputParameters.RememberLogin!==false||
      payload.inputParameters.Username!==placeholders.username||payload.inputParameters.Password!==placeholders.password)return refuse();
    // Journaled once before the request exists; an unrecorded submission is never sent.
    const recorded=await beforeSignIn({endpoint:target.pathname,viewName:login.viewName,apiVersion:login.apiVersion,versionToken});
    if(recorded?.recorded!==true)return refuse();
    signIn.submitted=true;
    let body=JSON.stringify({...payload,inputParameters:{...payload.inputParameters,Username:credentials.username,Password:credentials.password}});
    credentials=undefined;
    let response;
    try{response=await forward(target,'POST',request.headers,body);}
    catch{body='';signIn.uncertain=true;await recordSignInResult({answered:false,transportUnconfirmed:true});return undefined;}
    body='';
    signIn.answered=true;
    const value=json(response.body);
    signIn.accepted=response.status===200&&!!value&&!value.exception&&!value.versionInfo?.hasModuleVersionChanged;
    // The user cookie the server set in reply to the vault user's credentials (the only sign-in this transport sends).
    userCookieIssued=signIn.accepted&&response.issued.includes(userCookie);delete response.issued;
    if((await recordSignInResult({answered:true,status:response.status,accepted:signIn.accepted}))?.recorded!==true)signIn.uncertain=true;
    return response;
  }
  return {
    async request(request,resourceType){
      if(cleared||signIn.uncertain||!['XHR','Fetch'].includes(resourceType))return refuse();
      let target;try{target=new URL(request?.url);}catch{return refuse();}
      if(target.origin!==url.origin||target.username||target.password||target.hash||!target.pathname.startsWith(url.pathname))return refuse();
      const method=request.method;
      if(method==='POST'&&target.pathname===login.endpoint&&!target.search)return signInRequest(target,request);
      const version=method==='GET'&&target.pathname===url.pathname+'moduleservices/moduleversioninfo'&&/^\?\d{10,16}$/.test(target.search);
      const roles=method==='GET'&&target.pathname===url.pathname+'moduleservices/roles'&&/^\?\d{10,16}$/.test(target.search);
      let body;
      if(method==='POST'&&/^\/[A-Za-z_][A-Za-z0-9_]*\/screenservices\/[A-Za-z0-9_/]+$/.test(target.pathname)&&!target.search){
        body=request.postData;const payload=json(body??'');
        if(typeof body!=='string'||Buffer.byteLength(body)>1024*1024||payload?.versionInfo?.moduleVersion!==versionToken)return refuse();
      }else if(!version&&!roles)return refuse();
      // Roles and application requests exist only for the signed-in user.
      if(!version&&!signIn.accepted)return refuse();
      requests.submitted++;
      try{const {issued:_issued,...response}=await forward(target,method,request.headers,body);requests.answered++;return response;}
      catch{requests.uncertain++;return undefined;}
    },
    async arm(descriptor){
      if(cleared||signIn.armed)fail('already_armed');
      signIn.armed=true;
      const validate=validateDescriptor??(await import('./debug-app-user-worker.mjs')).validatePrivateDescriptor;
      const safe=validate(descriptor);
      const same=['lane','runtimeUrl','app','sessionId','module','moduleKey'].every(k=>safe.binding?.[k]===binding?.[k]);
      if(!same||Date.parse(safe.expiresAt)<=Date.now())fail('scope_mismatch');
      const record=await (vault??(await import('./debug-app-user.mjs')).privateAppUserVault)('read',safe);
      try{
        if(!record?.ok||record.kind!=='credentials'||!['lane','runtimeUrl','app','sessionId','module','moduleKey'].every(k=>record.binding?.[k]===binding[k])||
          typeof record.username!=='string'||!record.username||typeof record.password!=='string'||!record.password)fail('credentials_unavailable');
        credentials={username:record.username,password:record.password};
      }finally{if(record&&typeof record==='object'){record.username='';record.password='';}}
      placeholders={username:randomBytes(24).toString('hex'),password:randomBytes(24).toString('hex')};
      return {...placeholders};
    },
    disarm(){credentials=undefined;placeholders=undefined;},
    get signedIn(){return signIn.accepted===true&&signIn.uncertain===false;},
    // Retention, not identity: the page-readable user cookie is the one the host jar holds, and that
    // cookie was issued by the sign-in reply. Values never leave.
    sessionCookieRetained(cookies){
      if(cleared||!userCookieIssued||!Array.isArray(cookies))return false;
      const name=userCookie,held=jar.getCookiesSync?.(url.href)?.find(c=>c.key===name)?.value;
      const seen=cookies.filter(c=>c?.name===name);
      return typeof held==='string'&&held.length>0&&seen.length===1&&digest(seen[0].value)===digest(held);
    },
    get userCookieIssued(){return userCookieIssued;},
    receipt:()=>({signIn:{...signIn},requests:{...requests},signedIn:signIn.accepted===true&&!signIn.uncertain,userCookieIssued,credentialsHeld:credentials!==undefined,cleared}),
    async clear(){
      cleared=true;userCookieIssued=false;credentials=undefined;placeholders=undefined;
      for(const controller of inflight)controller.abort();
      let jarCleared=true;try{await jar.removeAllCookies();}catch{jarCleared=false;}
      return {cleared:jarCleared,pending:inflight.size};
    },
  };
}

// Login realm -> clean mount realm. The preparation realm runs the published
// login controller (Minimal application initialization, no application
// lifecycle); reload() discards it so the mount realm starts with only cookies.
// Identity evidence: the server accepted the vault user's credentials in the one
// sign-in POST and issued the user cookie in that reply; the preparation realm
// then read a non-null user id; the mount realm holds that same session cookie.
// No expected user id is known, so none is compared (expectedUserIdCompared:false).
export function createO11BrowserAuthentication({page,session,runtimeHandle,login,runtimeUrl,reload,timeoutMs=60000}){
  if(typeof page?.evaluate!=='function'||typeof page?.send!=='function'||typeof session?.arm!=='function'||typeof reload!=='function'||
    !/^__ssamO11Runtime_[a-f0-9]{48}$/.test(runtimeHandle??'')||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)fail('contract_invalid');
  let attempted=false,confirmed=false,realmReloaded=false,sessionIssuedBySignIn=false,sessionCookieRetained=false;
  return {
    async authenticate(descriptor){
      if(attempted)fail('already_attempted');
      attempted=true;
      let result;
      try{
        const placeholders=await session.arm(descriptor);
        try{
          result=await page.evaluate(async({handle,placeholders,login})=>{
            try{const v=await globalThis[handle].authenticate(placeholders,login);
              return {loginAnswered:v?.loginAnswered===true,registered:v?.registered===true,userIdentified:v?.userIdentified===true};}
            catch{return {loginAnswered:false,registered:false,userIdentified:false};}
          },{handle:runtimeHandle,placeholders,login},timeoutMs);
        }catch{result=undefined;}
      }finally{session.disarm();}
      const state=session.receipt();
      if(state.signIn.uncertain)fail('sign_in_uncertain');
      sessionIssuedBySignIn=session.userCookieIssued===true;
      if(result?.registered!==true||result.userIdentified!==true||!session.signedIn||!sessionIssuedBySignIn)fail('identity_unconfirmed');
      await reload();realmReloaded=true;
      const cookies=await page.send('Network.getCookies',{urls:[runtimeUrl]});
      sessionCookieRetained=session.sessionCookieRetained(cookies?.cookies);
      if(!sessionCookieRetained)fail('identity_unconfirmed');
      confirmed=true;
      // identityMatches (the shared broker contract) means the evidence above, nothing more.
      return {authenticated:true,identityMatches:true,identityEvidence:{credentialsAcceptedByServer:true,sessionIssuedBySignIn:true,
        userIdentifiedInPreparation:true,sessionCookieRetained:true,expectedUserIdCompared:false},
        signInResultRecorded:true,realmReloaded:true,mounted:false,permissionCheck:false};
    },
    receipt:()=>({attempted,confirmed,realmReloaded,sessionIssuedBySignIn,sessionCookieRetained,expectedUserIdCompared:false}),
  };
}
