// Explicit local registered-user scenario. Merely loading this file changes no state.
(function(){
 const markerKey='$SSAM$NativeO11LocalContext';
 function details(config){
  const c=config.context,s=c?.scenario,i=s?.identity;
  if(config.canStart!==true||c.status!=='authorized-local-render-scenario'||c.realBackend!==false||c.realAccessValidated!==false||location.hostname!==config.bindHost)throw Error('Declared isolated context required');
  if(!c.scope?.sha256||!c.activationId||i?.kind!=='fictitious-registered'||!Number.isSafeInteger(i.userId)||i.userId<=0||i.userId>2147483647||typeof i.userProvider!=='string'||s.roles?.length!==0||s.reload!=='preserve-native-client-variables')throw Error('Explicit registered-only scenario required');
  return {c,s,i,marker:JSON.stringify({schema:1,activationId:c.activationId,scope:c.scope.sha256,installer:c.installer.sha256,moduleKey:c.moduleKey,sessionId:c.sessionId,identity:i,roles:[],reload:s.reload})};
 }
 function cookies(){return document.cookie.split(';').map(x=>x.trim()).filter(Boolean);}
 window.__nativeO11ContextInstaller={
  async prepareRuntime({OS,config,proof}){
   const {c,i,marker}=details(config),provider=OS.ApplicationInfo.getUserProviderName(),cookieName=OS.ApplicationInfo.getUserCookieName();
   if(provider!==i.userProvider||cookieName!=='nr2'+provider||OS.RolesInfo.RolesInfoPersistentStorage!==undefined)throw Error('Native provider/context mismatch');
   const expectedCookie=cookieName+'='+encodeURIComponent('uid='+i.userId),existing=localStorage.getItem(markerKey);
   if(existing===null){
    if(cookies().length||localStorage.length||sessionStorage.length||OS.RolesInfo.getUserId()!==0)throw Error('Fresh isolated origin required');
    localStorage.setItem(markerKey,marker);
    document.cookie=expectedCookie+'; Path=/; SameSite=Strict';
    proof.contextMode='first-local-activation';
   }else{
    if((existing!==marker&&existing!==c.previousMarker)||cookies().length!==1||cookies()[0]!==expectedCookie||OS.RolesInfo.getUserId()!==i.userId)throw Error('Foreign or changed local context');
    const prefix='$OS_'+provider+'$',sessionKey=prefix+'$ClientVars$$SESSION_USER_ID';
    const allowed=new Set([markerKey,sessionKey,prefix+'CurrentLocale',prefix+'RolesInfo',...config.clientVariables.map(v=>prefix+config.module+'$ClientVars$'+v.name)]);
    if(Object.keys(localStorage).some(k=>!allowed.has(k))||Object.keys(sessionStorage).some(k=>k!=='$OS_OS$RouterHistoryAge'))throw Error('Foreign local storage namespace');
    const sid=localStorage.getItem(sessionKey);if(sid!==null&&sid!==String(i.userId))throw Error('Native client-variable identity changed');
    const roles=localStorage.getItem(prefix+'RolesInfo');if(roles!==null&&roles!==JSON.stringify(','))throw Error('Unexpected stored custom roles');
    if(existing!==marker)localStorage.setItem(markerKey,marker);
    proof.contextMode='same-scenario-native-state-preserved';
   }
   if(OS.RolesInfo.getUserId()!==i.userId||(OS.RolesInfo.areRolesDefined()&&!OS.RolesInfo.areRolesEmpty()))throw Error('Registered-only context must have no custom roles');
   // Native Factory distinguishes undefined roles (wait for application lifecycle)
   // from a known empty set. ',' is the original areRolesEmpty representation.
   await OS.RolesInfo.storeRoleInformation(',');
   if(!OS.RolesInfo.areRolesDefined()||!OS.RolesInfo.areRolesEmpty())throw Error('Native empty role set not retained');
   OS.RolesInfo.checkRegistered();
   proof.context={explicitFictitious:true,realAccessValidated:false,userId:i.userId,userProvider:provider,roles:[],activationId:c.activationId,clientDefaultsOverridden:false};
  },
  beforeScreen({OS,ModuleController,config,proof}){
   const {i}=details(config);
   if(OS.RolesInfo.getUserId()!==i.userId||!OS.RolesInfo.areRolesDefined()||!OS.RolesInfo.areRolesEmpty())throw Error('Unexpected role/identity change');
   OS.RolesInfo.checkRegistered();
   const roles=Object.values(ModuleController.default.roles??{});
   for(const role of roles){let denied=false;try{OS.RolesInfo.checkRoles([role]);}catch(error){denied=error===role.roleException;}if(!denied)throw Error('Custom role unexpectedly available');}
   proof.context.originalRegisteredCheckPassed=true;proof.context.originalCustomRoleChecksDenied=roles.length;
  }
 };
})();
