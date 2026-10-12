import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceCenterSso,isProtectedScHtml} from '../service-center/sso.mjs';

const sc='https://lab.example', id='https://id.outsystems.com';
const auth=id+'/auth/realms/11111111-2222-3333-4444-555555555555/protocol/openid-connect/auth';
const callback=sc+'/ServiceCenter/CentralizedLogin_AuthCodeFlow_TokenPart.aspx';
const protectedHtml='<form action="Error_Logs.aspx"><a href="Logout.aspx">Log Out</a></form>';
function fixture({form=false,badState=false,terms=false,unauthorized=false,external=false,loginPage=false}={}){
  const calls=[];
  const params={response_type:'code',client_id:'sc-client',scope:'openid',code_challenge:'x'.repeat(43),code_challenge_method:'S256',redirect_uri:callback,state:'original-sc-state'};
  const redirect=url=>new Response(null,{status:302,headers:{location:url}});
  class ReadyIdentity extends ServiceCenterSso {
    async perform(){this.endpoints={authorization_endpoint:auth};this.tokens={access_token:'private-test-token'};return{ok:true,windowCreated:false};}
  }
  const client=new ReadyIdentity({host:'lab.example',principal:'tester@example.test',fetchImpl:async(value,opts)=>{
    const u=new URL(value);calls.push({url:u.href,method:opts.method});
    if(u.origin===sc){
      assert.equal(opts.headers.Authorization,undefined);
      if(u.pathname==='/ServiceCenter/Login.aspx'){
        if(form&&opts.method==='GET')return new Response('<form action="Login.aspx"><input name="__VIEWSTATE" value="v"><input type="submit" name="sso" value="Log In With OutSystems"></form>');
        if(form){assert.equal(new URLSearchParams(opts.body).get('__VIEWSTATE'),'v');assert.equal(new URLSearchParams(opts.body).get('sso'),'Log In With OutSystems');}
        return redirect(id+'/community/login?'+new URLSearchParams(params));
      }
      if(u.pathname===new URL(callback).pathname)return redirect('Error_Logs.aspx');
      if(u.pathname==='/ServiceCenter/Error_Logs.aspx')return new Response(loginPage?'<form action="Login.aspx"><a href="Logout.aspx">logout</a></form>':protectedHtml);
    }
    assert.equal(u.origin,id);
    switch(u.pathname){
      case '/community/moduleservices/moduleversioninfo':return Response.json({versionToken:'v1'});
      case '/community/':return new Response('<script src="/community/scripts/_osbundle-test.index.js"></script>');
      case '/community/scripts/_osbundle-test.index.js':return new Response('screenName:"Auth.login",load:import("./login.js")');
      case '/community/scripts/login.js':return new Response('"screenservices/community/Auth/login/DataActionGetSessionData","a1"');
      case '/community/screenservices/community/Auth/login/DataActionGetSessionData':{
        const body=JSON.parse(opts.body);assert.equal(body.screenData.variables.state,params.state);
        assert.equal(opts.headers.Authorization,'Bearer private-test-token');
        return Response.json({data:{HasSession:true,IsAuthorizedRedirect_Uri:!unauthorized,NeedsToAcceptTerms:terms,AuthEndpointKC:auth,AuthRedirectUriKC:id+'/community/rest/redirect/login'}});
      }
      case new URL(auth).pathname:assert.equal(u.searchParams.get('prompt'),'none');return redirect(id+'/community/rest/redirect/login?code=code&state='+params.state);
      case '/community/rest/redirect/login':return redirect((external?'https://untrusted.example/x':callback)+'?code=sc-code&state='+(badState?'wrong':params.state));
      default:throw Error('Unexpected request');
    }
  }});
  return{client,calls};
}
test('SC redirect and WebForms entries preserve state and validate a protected read',async()=>{
  for(const form of [false,true]){const {client,calls}=fixture({form});assert.equal((await client.authenticateSc()).protectedReadVerified,true);assert.equal(calls.filter(c=>c.method==='POST'&&c.url.startsWith(sc)).length,form?1:0);await assert.rejects(client.authenticateSc(),e=>e.code==='IDENTITY_NO_REPLAY');await client.close();}
});
test('SC refuses wrong state and external callbacks before sending the authorization code',async()=>{
  for(const [opts,code] of [[{badState:true},'SC_SSO_STATE_MISMATCH'],[{external:true},'IDENTITY_ORIGIN_REFUSED']]){const {client,calls}=fixture(opts);await assert.rejects(client.authenticateSc(),e=>e.code===code);assert.equal(calls.some(c=>c.url.startsWith(callback)),false);assert.equal(client.tokens,null);}
});
test('SC refuses pending terms or an unapproved callback before silent authorization',async()=>{
  for(const [opts,code] of [[{terms:true},'IDENTITY_TERMS_REQUIRED'],[{unauthorized:true},'SC_SSO_SESSION_REQUIRED']]){const {client,calls}=fixture(opts);await assert.rejects(client.authenticateSc(),e=>e.code===code);assert.equal(calls.some(c=>c.url.startsWith(auth)),false);}
});
test('SC callback alone does not prove protected access',async()=>{
  const {client}=fixture({loginPage:true});await assert.rejects(client.authenticateSc(),e=>e.code==='WEB_SIGN_IN_REQUIRED');
  assert.equal(isProtectedScHtml('<script>var logout="Logout.aspx";</script>'),false);
  assert.equal(isProtectedScHtml(protectedHtml),true);
});
