import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunityPortalIdentity } from '../runtime/community-portal.mjs';
import { Odc3PortalBroker } from '../runtime/odc3-context.mjs';

const origin='https://personal-test.outsystems.dev', id='https://id.outsystems.com';
const auth=id+'/auth/realms/11111111-2222-3333-4444-555555555555/protocol/openid-connect/auth';
const callback=origin+'/authentication/redirect';
const parameters={response_type:'code',client_id:'portal-client',scope:'openid',code_challenge:'x'.repeat(43),code_challenge_method:'S256',redirect_uri:callback,state:'original-state',nonce:'original-nonce'};
const redirect=location=>new Response(null,{status:302,headers:{location}});
function fixture({badState=false,foreign=false,terms=false,unauthorized=false,drift=false}={}){
 const calls=[];let authentications=0;
 class Ready extends CommunityPortalIdentity {
  async perform(){authentications++;this.endpoints={authorization_endpoint:auth};this.tokens={access_token:'PRIVATE_TOKEN'};return {ok:true};}
 }
 const identity=new Ready({host:new URL(origin).host,principal:'dev@example.test',target:'SSAM/ODC3/personal-test.outsystems.dev/Portal',fetchImpl:async(value,options)=>{
  const u=new URL(value);calls.push(u);assert.equal(u.origin,id);
  switch(u.pathname){
   case '/community/moduleservices/moduleversioninfo':return Response.json({versionToken:'v1'});
   case '/community/':return new Response('<script src="/community/scripts/_osbundle-test.index.js"></script>');
   case '/community/scripts/_osbundle-test.index.js':return new Response('screenName:"Auth.login",load:import("./login.js")');
   case '/community/scripts/login.js':return new Response('"screenservices/community/Auth/login/DataActionGetSessionData","api-version"');
   case '/community/screenservices/community/Auth/login/DataActionGetSessionData':{
    assert.equal(options.headers.Authorization,'Bearer PRIVATE_TOKEN');
    const vars=JSON.parse(options.body).screenData.variables;assert.equal(vars.state,parameters.state);assert.equal(vars.code_challenge,parameters.code_challenge);
    return Response.json({data:{HasSession:true,IsAuthorizedRedirect_Uri:!unauthorized,NeedsToAcceptTerms:terms,AuthEndpointKC:drift?id+'/wrong':auth,AuthRedirectUriKC:id+'/community/rest/redirect/login'}});
   }
   case new URL(auth).pathname:
    assert.equal(u.searchParams.get('prompt'),'none');assert.equal(u.searchParams.get('state'),parameters.state);
    assert.equal(u.searchParams.get('code_challenge'),parameters.code_challenge);
    return redirect(id+'/community/rest/redirect/login?code=PRIVATE_CODE&state='+parameters.state);
   case '/community/rest/redirect/login':return redirect((foreign?'https://foreign.invalid/callback':callback)+'?code=PRIVATE_FINAL_CODE&state='+(badState?'wrong':parameters.state));
   default:assert.fail('Unexpected path');
  }
 }});
 return {identity,calls,authentications:()=>authentications};
}
test('Portal community authorization preserves the original state and PKCE and returns only the exact callback',async()=>{
 const {identity,calls,authentications}=fixture();
 const result=await identity.authorizePortal(id+'/community/login?'+new URLSearchParams(parameters),origin);
 assert.equal(result.origin,origin);assert.equal(result.pathname,'/authentication/redirect');assert.equal(result.searchParams.get('state'),parameters.state);
 assert.equal(authentications(),1);assert.equal(calls.some(u=>u.origin===origin),false);
 await identity.close();assert.equal(identity.tokens,null);
});
test('foreign callback, missing state and invalid PKCE fail before reading any credential',async()=>{
 for(const patch of [{redirect_uri:'https://foreign.invalid/callback'},{state:''},{code_challenge_method:'plain'},{code_challenge:'x'}]){
  const f=fixture();await assert.rejects(f.identity.authorizePortal(id+'/community/login?'+new URLSearchParams({...parameters,...patch}),origin),{code:'PORTAL_CONTRACT_CHANGED'});
  assert.equal(f.authentications(),0);assert.equal(f.calls.length,0);
 }
});
test('callback drift, terms and unapproved redirect cannot complete authentication',async()=>{
 for(const [options,code]of [[{badState:true},'PORTAL_LOGIN_STATE_MISMATCH'],[{foreign:true},'IDENTITY_ORIGIN_REFUSED'],[{terms:true},'PORTAL_LOGIN_TERMS_REQUIRED'],[{unauthorized:true},'PORTAL_LOGIN_REJECTED'],[{drift:true},'PORTAL_CONTRACT_CHANGED']]){
  const f=fixture(options);await assert.rejects(f.identity.authorizePortal(id+'/community/login?'+new URLSearchParams(parameters),origin),{code});
  assert.equal(f.calls.some(u=>u.origin===origin),false);await f.identity.close();
 }
});
test('the broker uses the exact tenant/profile and requires a protected read after the community callback',async()=>{
 for(const protectedRead of [true,false]){
  let closed=0,community=0;const calls=[];
  const broker=new Odc3PortalBroker({origin,identityTarget:'SSAM/ODC3/personal-test.outsystems.dev/Portal',credentialProvider:async mode=>mode==='status'?{available:true}:{available:true,username:'dev@example.test',password:'PRIVATE_PASSWORD'},
   communityFactory:options=>{
    assert.equal(options.host,'personal-test.outsystems.dev');assert.equal(options.principal,'dev@example.test');assert.equal(options.target,'SSAM/ODC3/personal-test.outsystems.dev/Portal');
    return {authorizePortal:async(login,wanted)=>{community++;assert.equal(wanted,origin);assert.equal(login.origin,id);return new URL(callback+'?code=PRIVATE_FINAL_CODE&state=original-state');},close:async()=>{closed++;}};
   }});
  broker.action=async(module,_view,action,input)=>{
   calls.push(action);
   if(module==='authentication'&&action.endsWith('/DataActionGetProviders'))return {data:{RedirectNowUrl:id+'/community/login?'+new URLSearchParams(parameters)}};
   if(action.endsWith('/ActionProcessCodeRedirect')){assert.equal(input.Code,'PRIVATE_FINAL_CODE');return {data:{}};}
   if(module==='connections')return {data:protectedRead?{Providers:[]}:{}};
   assert.fail('Unexpected action');
  };
  const result=await broker.authenticate();assert.equal(result.ok,protectedRead);assert.equal(broker.authenticated,protectedRead);assert.equal(community,1);assert.equal(closed,1);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);assert.ok(calls.at(-1).startsWith('connections/'));
 }
});
test('unknown identity origin stays blocked without invoking a credential exchange',async()=>{
 let calls=0;const broker=new Odc3PortalBroker({origin,communityFactory:()=>{calls++;assert.fail();},credentialProvider:async mode=>mode==='status'?{available:true}:{available:true,username:'dev@example.test',password:'PRIVATE_PASSWORD'}});
 broker.action=async()=>({data:{RedirectNowUrl:'https://foreign.invalid/login?code=PRIVATE_CODE'}});
 const r=await broker.authenticate();assert.equal(r.error.code,'PORTAL_LOGIN_PROVIDER_UNSUPPORTED');assert.equal(calls,0);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_/);
});
