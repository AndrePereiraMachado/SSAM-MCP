import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { CommunityIdentity, verifyIdentityJwt } from '../service-center/community-identity.mjs';

const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwks={keys:[{...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'}]};
const issuer='https://id.outsystems.com/auth/realms/11111111-2222-3333-4444-555555555555';
const endpoint=issuer+'/protocol/openid-connect/';
const role='c089d722-19c8-4ed6-a329-cf2e78c54b56.ab2a6b39-1f30-4f20-a069-cf5d18b076f4';
const now=Math.floor(Date.now()/1000);
const jwt=(extra={},header={alg:'RS256',kid:'test-key'})=>{
  const a=Buffer.from(JSON.stringify(header)).toString('base64url'), b=Buffer.from(JSON.stringify({iss:issuer,sub:'user-id',iat:now-5,exp:now+600,aud:'client_runtime',nonce:'test-nonce',...extra})).toString('base64url');
  return a+'.'+b+'.'+sign('RSA-SHA256',Buffer.from(a+'.'+b),privateKey).toString('base64url');
};

test('JWT validation checks actual signature and bound issuer, audience, nonce and lifetime',()=>{
  assert.equal(verifyIdentityJwt(jwt(),jwks,{issuer,audience:'client_runtime',nonce:'test-nonce'}).sub,'user-id');
  for(const token of [jwt({iss:'https://other.example'}),jwt({aud:'other'}),jwt({nonce:'other'}),jwt({exp:now-1}),jwt({iat:now+500}),jwt({azp:'other'}),jwt({aud:['client_runtime','other']}),jwt({}, {alg:'none',kid:'test-key'}),jwt()+ 'x'])
    assert.throws(()=>verifyIdentityJwt(token,jwks,{issuer,audience:'client_runtime',nonce:'test-nonce'}),e=>e.code==='IDENTITY_TOKEN_INVALID');
  assert.throws(()=>verifyIdentityJwt(jwt(),{keys:[...jwks.keys,...jwks.keys]},{issuer}),e=>e.code==='IDENTITY_TOKEN_INVALID');
});

function fixture({badState=false,badNonce=false,wrongPrincipal=false,missingRole=false}={}) {
  let state,nonce,loginCalls=0;const calls=[];
  const json=x=>new Response(JSON.stringify(x),{status:200,headers:{'content-type':'application/json'}});
  const redirect=url=>new Response(null,{status:303,headers:{location:url}});
  const fetchImpl=async(value,opts)=>{
    const u=new URL(value);calls.push({path:u.pathname,method:opts.method,auth:!!opts.headers.Authorization});
    assert.equal(opts.redirect,'manual');assert.equal(u.origin,'https://id.outsystems.com');
    switch(u.pathname){
      case '/identity/.well-known/openid-configuration':return json({issuer,authorization_endpoint:endpoint+'auth',token_endpoint:endpoint+'token',jwks_uri:endpoint+'certs'});
      case new URL(endpoint+'auth').pathname:{
        state=u.searchParams.get('state');nonce=u.searchParams.get('nonce');
        assert.equal(u.searchParams.get('code_challenge_method'),'S256');
        const landing=new URL('https://os-community-id.outsystems.app/identity');landing.search=new URLSearchParams({redirect_uri:issuer+'/broker/os-builtin/endpoint',state:'provider-state'});return redirect(landing.href);
      }
      case '/community/moduleservices/auth/configs':return json({authConfigurations:[{type:'cognito',kc_hint:'os-builtin',configs:{region:'us-east-1',authFlow:'USER_PASSWORD_AUTH',amplifyClientId:'fictionalclient123'}}]});
      case '/identityapi/v1alpha1/oidc/store-token':assert.equal(loginCalls,1);return new Response(JSON.stringify({authCode:'provider-code'}),{status:201});
      case new URL(issuer+'/broker/os-builtin/endpoint').pathname:{
        assert.equal(u.searchParams.get('code'),'provider-code');assert.equal(u.searchParams.get('state'),'provider-state');
        return redirect('https://id.outsystems.com/identity?'+new URLSearchParams({code:'platform-code',state:badState?'wrong':state,iss:issuer}));
      }
      case new URL(endpoint+'token').pathname:{
        const form=new URLSearchParams(opts.body);assert.equal(form.get('code'),'platform-code');assert.equal(form.get('grant_type'),'authorization_code');assert.equal(form.get('redirect_uri'),'https://id.outsystems.com/identity');
        return json({token_type:'Bearer',id_token:jwt({nonce:badNonce?'wrong':nonce}),access_token:jwt({nonce,azp:'client_runtime'}),refresh_token:'fictional-refresh'});
      }
      case new URL(endpoint+'certs').pathname:return json(jwks);
      case '/api/user-information/v1/profiles/me':assert.match(opts.headers.Authorization,/^Bearer /);return json({id:'user-id',email:wrongPrincipal?'other@example.test':'tester@example.test'});
      case '/api/user-information/v1/claims':return json({claims:missingRole?[]:[role]});
      case '/community/moduleservices/users/userinfosync':assert.equal(opts.method,'POST');assert.ok(opts.headers.Authorization);return new Response(null,{status:204});
      default:throw Error('Unexpected request path');
    }
  };
  const client=new CommunityIdentity({host:'lab.example',principal:'tester@example.test',target:'SSAM/O11/lab.example/ServiceCenter',fetchImpl,login:async(target,ctx)=>{
    loginCalls++;assert.equal(ctx.expectedClientId,'fictionalclient123');return{IdToken:'fake-id',AccessToken:'fake-access',RefreshToken:'fake-refresh'};
  }});
  return{client,calls,loginCalls:()=>loginCalls};
}

test('complete community protocol binds both states, validates signatures and principal/roles before sync',async()=>{
  const {client,calls,loginCalls}=fixture();
  assert.deepEqual(await client.authenticate(),{ok:true,principalMatches:true,communityRoleVerified:true,tokenSignaturesVerified:true,windowCreated:false});
  assert.equal(loginCalls(),1);assert.equal(calls.at(-1).path,'/community/moduleservices/users/userinfosync');
  await assert.rejects(client.authenticate(),e=>e.code==='IDENTITY_NO_REPLAY');
  await client.close();assert.equal(client.tokens,null);
});

test('state mismatch refuses before token exchange; nonce mismatch refuses before protected API reads',async()=>{
  for(const [settings,code,forbidden] of [[{badState:true},'IDENTITY_CALLBACK_INVALID',new URL(endpoint+'token').pathname],[{badNonce:true},'IDENTITY_TOKEN_INVALID','/api/user-information/v1/profiles/me']]){
    const {client,calls}=fixture(settings);await assert.rejects(client.authenticate(),e=>e.code===code);
    assert.equal(calls.some(x=>x.path===forbidden),false);assert.equal(client.tokens,null);
  }
});

test('principal or role mismatch refuses before sync without granting access or retrying credentials',async()=>{
  for(const [settings,code] of [[{wrongPrincipal:true},'AUTH_PRINCIPAL_MISMATCH'],[{missingRole:true},'IDENTITY_ROLE_REQUIRED']]){
    const {client,calls,loginCalls}=fixture(settings);await assert.rejects(client.authenticate(),e=>e.code===code);
    assert.equal(calls.some(x=>x.path.includes('userinfosync')),false);assert.equal(loginCalls(),1);assert.equal(client.tokens,null);
  }
});

test('private transport rejects another origin before sending even a cookie or token',async()=>{
  const {client,calls}=fixture();await assert.rejects(client.request('https://other.example/x'),e=>e.code==='IDENTITY_ORIGIN_REFUSED');assert.equal(calls.length,0);
});
