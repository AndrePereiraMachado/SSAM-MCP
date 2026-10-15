// Private, in-memory protocol client for OutSystems ID. No downloaded script is
// evaluated. This authenticates the community provider, not Service Center yet.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { AuthRequired } from './errors.mjs';
import { vaultIdentityLogin } from './identity-vault.mjs';
import { readCheckpoint } from '../read-budget.mjs';
import { hostedContext } from '../executor.mjs';

const ID = 'https://id.outsystems.com';
const CLIENT = 'client_runtime';
const ROLE = 'c089d722-19c8-4ed6-a329-cf2e78c54b56.ab2a6b39-1f30-4f20-a069-cf5d18b076f4';
const refuse = (code, diagnostic = {}) => { const error = new AuthRequired(code, 'Headless identity protocol did not complete; no challenge, role grant, or terms acceptance was attempted.'); error.diagnostic=diagnostic; throw error; };
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

export function verifyIdentityJwt(token, jwks, { issuer, audience, nonce, subject, now = Date.now() / 1000 } = {}) {
  try {
    if (typeof token !== 'string' || token.length > 20000) throw Error();
    const pieces = token.split('.');
    if (pieces.length !== 3 || pieces.some(x=>!/^[A-Za-z0-9_-]+$/.test(x))) throw Error();
    const header = JSON.parse(Buffer.from(pieces[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(pieces[1], 'base64url'));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit || header.jku || header.x5u) throw Error();
    const keys = jwks?.keys?.filter(k=>k.kid===header.kid && k.kty==='RSA' && (!k.alg || k.alg==='RS256') && (!k.use || k.use==='sig')) ?? [];
    if (keys.length !== 1 || !verify('RSA-SHA256',Buffer.from(pieces[0]+'.'+pieces[1]),createPublicKey({key:keys[0],format:'jwk'}),Buffer.from(pieces[2],'base64url'))) throw Error();
    if (claims.iss !== issuer || typeof claims.sub !== 'string' || !claims.sub || !Number.isFinite(claims.exp) || claims.exp <= now
      || !Number.isFinite(claims.iat) || claims.iat > now + 30 || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30))) throw Error();
    if (audience && !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)) throw Error();
    if (audience && ((claims.azp !== undefined && claims.azp !== audience) || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== audience))) throw Error();
    if (nonce !== undefined && claims.nonce !== nonce) throw Error();
    if (subject !== undefined && claims.sub !== subject) throw Error();
    return claims;
  } catch { refuse('IDENTITY_TOKEN_INVALID'); }
}

// servidor/fase4-24 (R3 of PLANO-24-PRODUCAO): the identity protocol (and the Service Center and LifeTime single sign-on
// built on it, sso.mjs) is direct HTTPS from the machine that runs SSAM with a profile of its vault. Hosted it never
// starts: HOSTED_STUDIO_SESSION_ONLY before any request.
export class CommunityIdentity {
  constructor({ host, principal, target, fetchImpl = fetch, login = vaultIdentityLogin, signal, stage = ()=>{} }) {
    if (hostedContext()) throw new AuthRequired('HOSTED_STUDIO_SESSION_ONLY', 'Single sign-on with the identity provider is direct HTTPS from the SSAM server with a profile of its vault, '
      + 'never used in hosted mode: only the session of the user\'s own Service Studio is a path. Nothing was sent.');
    Object.assign(this,{host,principal,target,fetch:fetchImpl,login,signal:signal??AbortSignal.timeout(90000),stage});
    this.jar = new CookieJar(); this.tokens = null; this.endpoints = null;
  }
  url(value) {
    let u; try { u = new URL(value,ID); } catch { refuse('IDENTITY_ORIGIN_REFUSED'); }
    if (u.origin!==ID || u.username || u.password || u.hash || /%2f|%5c|%2e/i.test(u.pathname)) refuse('IDENTITY_ORIGIN_REFUSED');
    return u;
  }
  async request(value,{method='GET',body,form,token=false}={}) {
    readCheckpoint('authentication');
    const url=this.url(value), headers={Accept:'application/json'};
    const cookie=await this.jar.getCookieString(url.href); if(cookie)headers.Cookie=cookie;
    if(token){if(!this.tokens?.access_token)refuse('IDENTITY_SESSION_REQUIRED');headers.Authorization='Bearer '+this.tokens.access_token;}
    if(form){body=new URLSearchParams(form).toString();headers['Content-Type']='application/x-www-form-urlencoded';}
    else if(body!==undefined){body=JSON.stringify(body);headers['Content-Type']='application/json';}
    let response;
    try { response=await this.fetch(url,{method,body,headers,redirect:'manual',signal:this.signal}); }
    catch { refuse('IDENTITY_TRANSPORT_FAILED'); }
    for(const c of response.headers.getSetCookie())await this.jar.setCookie(c,url.href,{ignoreError:true});
    const reader=response.body?.getReader(), chunks=[];let size=0;
    if(reader)try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1048576){await reader.cancel();refuse('IDENTITY_RESPONSE_TOO_LARGE');}chunks.push(Buffer.from(part.value));}}catch(e){if(e instanceof AuthRequired)throw e;refuse('IDENTITY_TRANSPORT_FAILED');}
    return {status:response.status,location:response.headers.get('location'),text:Buffer.concat(chunks).toString('utf8')};
  }
  async json(url,options) {
    const r=await this.request(url,options);
    if(r.status<200||r.status>=300)refuse('IDENTITY_REQUEST_REJECTED',{httpStatus:r.status,path:this.url(url).pathname});
    try{return JSON.parse(r.text);}catch{refuse('IDENTITY_RESPONSE_INVALID');}
  }
  async redirects(start,stop) {
    let url=this.url(start);
    for(let hop=0;hop<8;hop++) {
      if(stop(url))return url;
      const r=await this.request(url);
      if(![302,303,307,308].includes(r.status)||!r.location)refuse('IDENTITY_REDIRECT_INCOMPLETE');
      const next=new URL(r.location,url);
      // The public builtin flow currently stops at this provider landing URL.
      // No request or credential is sent to that origin; only its resume URI is read.
      if(stop(next))return next;
      url=this.url(next);
    }
    refuse('IDENTITY_REDIRECT_LIMIT');
  }
  async authenticate() {
    if(this.attempted)refuse('IDENTITY_NO_REPLAY');this.attempted=true;
    try{return await this.perform();}catch(error){await this.close();throw error;}
  }
  async perform() {
    this.stage('discovery');
    const d=await this.json('/identity/.well-known/openid-configuration');
    const issuer=this.url(d.issuer);
    if(!/^\/auth\/realms\/[a-f0-9-]{36}$/.test(issuer.pathname))refuse('IDENTITY_PROVIDER_UNSUPPORTED');
    for(const [name,tail] of [['authorization_endpoint','auth'],['token_endpoint','token'],['jwks_uri','certs']]) {
      const u=this.url(d[name]); if(u.pathname!==issuer.pathname+'/protocol/openid-connect/'+tail||u.search)refuse('IDENTITY_PROVIDER_UNSUPPORTED');
    }
    this.endpoints=d;
    const verifier=randomBytes(32).toString('base64url'),state=randomBytes(24).toString('base64url'),nonce=randomBytes(24).toString('base64url');
    const start=new URL(d.authorization_endpoint);
    start.search=new URLSearchParams({client_id:CLIENT,scope:'openid',redirect_uri:ID+'/identity',response_type:'code',kc_idp_hint:'os-builtin',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',state,nonce});
    this.stage('authorization');
    const landing=await this.redirects(start,u=>u.origin==='https://os-community-id.outsystems.app'&&u.pathname==='/identity'&&u.searchParams.has('redirect_uri'));
    const resume=this.url(landing.searchParams.get('redirect_uri'));
    if(resume.pathname!==issuer.pathname+'/broker/os-builtin/endpoint'||!landing.searchParams.get('state'))refuse('IDENTITY_CALLBACK_INVALID');
    const config=await this.json('/community/moduleservices/auth/configs');
    const providers=config.authConfigurations?.filter(x=>x.type==='cognito'&&x.kc_hint==='os-builtin')??[];
    if(providers.length!==1||providers[0].configs?.authFlow!=='USER_PASSWORD_AUTH'||providers[0].configs.region!=='us-east-1')refuse('IDENTITY_PROVIDER_UNSUPPORTED');
    this.stage('credential');
    let cognito=await this.login(this.target,{host:this.host,principal:this.principal,expectedClientId:providers[0].configs.amplifyClientId});
    try {
      this.stage('exchange');
      const stored=await this.json('/identityapi/v1alpha1/oidc/store-token',{method:'POST',body:{clientId:providers[0].configs.amplifyClientId,idToken:cognito.IdToken,accessToken:cognito.AccessToken,refreshToken:cognito.RefreshToken}});
      if(typeof stored.authCode!=='string'||!stored.authCode)refuse('IDENTITY_RESPONSE_INVALID');
      resume.searchParams.set('code',stored.authCode);resume.searchParams.set('state',landing.searchParams.get('state'));
    } finally {cognito=null;}
    const callback=await this.redirects(resume,u=>u.origin===ID&&u.pathname==='/identity'&&(u.searchParams.has('code')||u.searchParams.has('error')));
    if(callback.searchParams.get('state')!==state||callback.searchParams.has('error')||!callback.searchParams.get('code')||(callback.searchParams.has('iss')&&callback.searchParams.get('iss')!==d.issuer))refuse('IDENTITY_CALLBACK_INVALID');
    this.stage('tokens');
    const tokens=await this.json(d.token_endpoint,{method:'POST',form:{grant_type:'authorization_code',code:callback.searchParams.get('code'),client_id:CLIENT,redirect_uri:ID+'/identity',code_verifier:verifier}});
    if(typeof tokens.token_type!=='string'||tokens.token_type.toLowerCase()!=='bearer')refuse('IDENTITY_TOKEN_INVALID');
    const jwks=await this.json(d.jwks_uri);
    const identity=verifyIdentityJwt(tokens.id_token,jwks,{issuer:d.issuer,audience:CLIENT,nonce});
    const access=verifyIdentityJwt(tokens.access_token,jwks,{issuer:d.issuer,subject:identity.sub});
    if(access.azp!==CLIENT||typeof tokens.refresh_token!=='string'||!tokens.refresh_token)refuse('IDENTITY_TOKEN_INVALID');
    this.tokens=tokens;
    this.stage('principal-and-roles');
    const profile=await this.json('/api/user-information/v1/profiles/me?embed=UserIdentityProviders',{token:true});
    if(!profile.id||!same(profile.email,this.principal))refuse('AUTH_PRINCIPAL_MISMATCH');
    const claims=await this.json('/api/user-information/v1/claims',{token:true});
    if(!Array.isArray(claims.claims)||!claims.claims.includes(ROLE))refuse('IDENTITY_ROLE_REQUIRED');
    this.stage('session-sync');
    const sync=await this.request('/community/moduleservices/users/userinfosync',{method:'POST',token:true});
    if(sync.status!==200&&sync.status!==204)refuse('IDENTITY_SESSION_SYNC_FAILED');
    return {ok:true,principalMatches:true,communityRoleVerified:true,tokenSignaturesVerified:true,windowCreated:false};
  }
  close(){this.tokens=null;return this.jar.removeAllCookies();}
}
