import { CommunityIdentity } from './community-identity.mjs';
import { AuthRequired } from './errors.mjs';
import { hostName } from './http.mjs';
import { Document, caption, formFields } from './html.mjs';
import { PortalMetadata } from '../../portal/runtime/portal-metadata.mjs';
import { screenservice } from '../../portal/runtime/portal-routes.mjs';
import { readCheckpoint } from '../read-budget.mjs';

const ID='https://id.outsystems.com';
const fail=(code,diagnostic={})=>{const e=new AuthRequired(code,'Headless Service Center SSO did not complete; no login window, role grant, or terms acceptance was attempted.');e.diagnostic=diagnostic;throw e;};
export function isProtectedScHtml(html) {
  const doc=new Document(html);
  if(doc.all('form').some(n=>/(?:^|\/)\_?login(?:sso)?\.aspx(?:\?|$)/i.test(n.attr('action','')))
    ||doc.all('div').some(n=>/\bsc-layout-login\b/i.test(n.attr('class',''))))return false;
  return doc.all('a','button','input').some(n=>/logout/i.test(n.attr('href','')+' '+n.attr('onclick','')));
}
export function isProtectedLifetimeHtml(html){
 const doc=new Document(html);
 if(doc.all('form').some(n=>/login\.aspx/i.test(n.attr('action',''))))return false;
 return doc.all('form').some(n=>/(?:^|\/)Applications_List\.aspx(?:\?|$)/i.test(n.attr('action','')))
  &&doc.all('a').some(n=>n.attr('href','').split('?')[0]==='/lifetime/MySettings.aspx')
  &&doc.all('a','button','input').some(n=>/logout/i.test(n.attr('href','')+' '+n.attr('onclick',''))
    ||(caption(n).trim()==='Logout'&&/^javascript:__doPostBack\(/.test(n.attr('href',''))));
}
export function lifetimeUserManagementCapability(html){
 const doc=new Document(html),text=doc.root.text;
 const welcome=doc.all('form').some(n=>/(?:^|\/)Welcome\.aspx(?:\?|$)/i.test(n.attr('action','')));
 const premium=welcome&&text.includes('Welcome to Users Management')&&text.includes('PREMIUM')
   &&text.includes('Upgrade to manage IT users roles and permissions.');
 return {userManagementAvailable:premium?false:null,serviceAccountProvisioningVerified:false,
   code:premium?'LIFETIME_USER_MANAGEMENT_UPGRADE_REQUIRED':'LIFETIME_USER_MANAGEMENT_UNVERIFIED'};
}

export class ServiceCenterSso extends CommunityIdentity {
  constructor(options){super(options);this.sc='https://'+hostName(options.host);}
  scUrl(value){let u;try{u=new URL(value,this.sc+'/ServiceCenter/');}catch{fail('SC_SSO_CALLBACK_INVALID');}
    const allowed=u.pathname.startsWith('/ServiceCenter/')||(this.surface==='lifetime'&&['/lifetime/Applications_List.aspx','/lifetime/Users_List.aspx','/LifeTimeSDK/SDKScreens.Login.aspx'].includes(u.pathname));
    if(u.origin!==this.sc||u.username||u.password||u.hash||!allowed||/%2e|%2f|%5c/i.test(u.pathname))fail('SC_SSO_CALLBACK_INVALID',{path:u.pathname});return u;}
  async scRequest(value,fields=null) {
    readCheckpoint('authentication');
    const url=this.scUrl(value),headers={Accept:'text/html'};
    const cookie=await this.jar.getCookieString(url.href);if(cookie)headers.Cookie=cookie;
    if(fields)headers['Content-Type']='application/x-www-form-urlencoded';
    let response;try{response=await this.fetch(url,{method:fields?'POST':'GET',headers,body:fields?new URLSearchParams(fields).toString():undefined,redirect:'manual',signal:this.signal});}catch{fail('SC_SSO_TRANSPORT_FAILED');}
    for(const c of response.headers.getSetCookie())await this.jar.setCookie(c,url.href,{ignoreError:true});
    const chunks=[];let size=0;const reader=response.body?.getReader();
    if(reader)try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>4194304){await reader.cancel();fail('SC_SSO_RESPONSE_TOO_LARGE');}chunks.push(Buffer.from(p.value));}}catch(e){if(e instanceof AuthRequired)throw e;fail('SC_SSO_TRANSPORT_FAILED');}
    return{status:response.status,location:response.headers.get('location'),text:Buffer.concat(chunks).toString('utf8')};
  }
  async authenticateSc() {
    return this.authenticateSurface('service-center');
  }
  async authenticateLifetime(){
    return this.authenticateSurface('lifetime');
  }
  async lifetimeCapabilities(){
    if(this.surface!=='lifetime'||!this.scAuthenticated)fail('WEB_SIGN_IN_REQUIRED');
    const page=await this.scRequest(this.sc+'/lifetime/Users_List.aspx');
    return {httpStatus:page.status,...(page.status===200?lifetimeUserManagementCapability(page.text):
      {userManagementAvailable:null,serviceAccountProvisioningVerified:false,code:'LIFETIME_USER_MANAGEMENT_UNVERIFIED'})};
  }
  async authenticateSurface(surface){
    if(!['service-center','lifetime'].includes(surface))fail('SC_SSO_SURFACE_INVALID');
    if(this.scAttempted)fail('IDENTITY_NO_REPLAY');this.scAttempted=true;
    this.surface=surface;
    try {
      this.stage('sc-start');
      const startUrl=this.sc+(surface==='lifetime'?'/lifetime/Applications_List.aspx':'/ServiceCenter/Login.aspx');let response=await this.scRequest(startUrl);
      if(surface==='lifetime'){
        for(let hop=0;hop<3&&[302,303].includes(response.status)&&response.location;hop++){
          const next=new URL(response.location,this.sc);
          if(next.origin!==this.sc)break;
          if(!['/LifeTimeSDK/SDKScreens.Login.aspx','/ServiceCenter/CentralizedLogin_AuthCodeFlow_CodePart.aspx'].includes(next.pathname))
            fail('SC_SSO_CALLBACK_INVALID',{path:next.pathname});
          response=await this.scRequest(next);
        }
      }
      if(response.status===200){
        const doc=new Document(response.text);
        const buttons=doc.all('input','button').filter(n=>!n.has('disabled')&&n.attr('type',n.tag==='button'?'submit':'')==='submit'&&/log ?in with|single sign/i.test(caption(n)));
        if(buttons.length!==1)fail('SC_SSO_FORM_UNSUPPORTED');
        const button=buttons[0],form=button.ancestor('form');
        if(!form||this.scUrl(form.attr('action','')).pathname!=='/ServiceCenter/Login.aspx')fail('SC_SSO_FORM_UNSUPPORTED');
        response=await this.scRequest(startUrl,formFields(form,button));
      }
      if(![302,303].includes(response.status)||!response.location)fail('SC_SSO_REDIRECT_REQUIRED');
      const login=this.url(new URL(response.location,startUrl));
      if(login.pathname!=='/community/login')fail('SC_SSO_PROVIDER_UNSUPPORTED');
      const vars=Object.fromEntries(['response_type','client_id','scope','code_challenge','code_challenge_method','redirect_uri','state','nonce','login_hint'].map(k=>[k,login.searchParams.get(k)??'']));
      const callback=this.scUrl(vars.redirect_uri);
      if(callback.pathname!=='/ServiceCenter/CentralizedLogin_AuthCodeFlow_TokenPart.aspx'||callback.search||vars.response_type!=='code'||vars.code_challenge_method!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(vars.code_challenge)||!vars.state||!vars.client_id||!vars.scope.split(' ').includes('openid'))fail('SC_SSO_CALLBACK_INVALID');
      const identity=await super.authenticate();
      this.stage('sc-authorize');
      const metadata=new PortalMetadata({origin:ID,request:(u,o)=>this.request(u,o)});
      const answer=await screenservice({origin:ID,metadata,request:(u,o)=>this.request(u,{...o,token:true})},{module:'community',view:'Auth.login',action:'community/Auth/login/DataActionGetSessionData',screenVariables:vars});
      const session=answer.data;
      if(session?.HasSession!==true||session.IsAuthorizedRedirect_Uri!==true)fail('SC_SSO_SESSION_REQUIRED');
      if(session.NeedsToAcceptTerms!==false)fail('IDENTITY_TERMS_REQUIRED');
      if(session.AuthEndpointKC!==this.endpoints.authorization_endpoint||session.AuthRedirectUriKC!==ID+'/community/rest/redirect/login')fail('SC_SSO_CONTRACT_CHANGED');
      let next=new URL(session.AuthEndpointKC);
      next.search=new URLSearchParams({...vars,redirect_uri:session.AuthRedirectUriKC,prompt:'none'});
      let callbackSeen=false;
      for(let hop=0;hop<8;hop++){
        if(next.origin===this.sc){
          this.scUrl(next);
          if(!callbackSeen){
            if(next.pathname!==callback.pathname||next.searchParams.get('state')!==vars.state||!next.searchParams.get('code')||next.searchParams.has('error'))fail('SC_SSO_STATE_MISMATCH');
            callbackSeen=true;this.stage('sc-callback');
          }
          response=await this.scRequest(next);
        }else{
          this.url(next);
          if(![new URL(this.endpoints.authorization_endpoint).pathname,'/community/rest/redirect/login'].includes(next.pathname))fail('SC_SSO_INTERACTIVE_REQUIRED');
          response=await this.request(next);
        }
        if(![302,303].includes(response.status)||!response.location)break;
        next=new URL(response.location,next);
      }
      if(!callbackSeen)fail('SC_SSO_CALLBACK_INCOMPLETE',{path:next.pathname,httpStatus:response.status});
      this.stage('sc-protected-read');
      const protectedPage=await this.scRequest(this.sc+(surface==='lifetime'?'/lifetime/Applications_List.aspx':'/ServiceCenter/Error_Logs.aspx'));
      if(protectedPage.status!==200||!(surface==='lifetime'?isProtectedLifetimeHtml(protectedPage.text):isProtectedScHtml(protectedPage.text)))
        fail('WEB_SIGN_IN_REQUIRED',{surface,httpStatus:protectedPage.status,
          expectedForm:new Document(protectedPage.text).all('form').some(n=>/(?:^|\/)Applications_List\.aspx(?:\?|$)/i.test(n.attr('action',''))),
          logoutControl:new Document(protectedPage.text).all('a','button','input').some(n=>/logout/i.test(n.attr('href','')+' '+n.attr('onclick','')))});
      this.scAuthenticated=true;
      return{ok:true,...identity,surface,signedIn:true,transport:'headless-sso',protectedReadVerified:true};
    }catch(e){await this.close();throw e;}
  }
}
