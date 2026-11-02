// Synthetic renderer exercise of the packaged worker. No vault, network or real credentials.
const {app}=require('electron');
const fs=require('fs');
const {pathToFileURL}=require('url');
app.on('browser-window-created',(_event,win)=>{
 win.once('ready-to-show',()=>setTimeout(async()=>{
  try {
   win.setTitle('SSAM Synthetic Test - no credentials');
   if (process.env.SSAM_TEST_ACTION === 'cancel') {
    await win.webContents.executeJavaScript('window.ssamPrivate.cancel()');
    return;
   }
   const result=await win.webContents.executeJavaScript(`(async()=>{
    const api=window.ssamPrivate,model=await api.bootstrap();
    const values=model.form==='login'?{username:'fixture@example.invalid',password:'synthetic-password',remember:false}:model.form==='password'?{password:'synthetic-password',confirmation:'synthetic-password'}:model.form==='profile'?{profile:model.profiles[0].profile}:{approved:true};
    let earlyRejected=true;
    if(model.form==='approve'){earlyRejected=(await api.submit(values)).ok===false;await new Promise(resolve=>setTimeout(resolve,1600));}
    const first=await api.submit(values);const duplicate=await api.submit(values);
    await new Promise(resolve=>setTimeout(resolve,350));
    const inlineError=document.querySelector('.error').textContent==='Could not save the credential. Please try again.';
    await api.submit(values);
    return {earlyRejected,firstAccepted:first.ok===true,duplicateRejected:duplicate.ok===false,inlineError};
   })()`);
   fs.writeFileSync(process.env.SSAM_TEST_RESULT,JSON.stringify(result));
  }catch{fs.writeFileSync(process.env.SSAM_TEST_RESULT,JSON.stringify({driverFailed:true}));}
 },250));
});
process.argv.push('--ssam-private-dialog-worker');
import(pathToFileURL(process.env.SSAM_TEST_APP_ENTRY).href);
