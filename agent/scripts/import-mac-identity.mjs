import fs from 'node:fs';
import cp from 'node:child_process';
const [keychain,file]=process.argv.slice(2);
if(process.platform!=='darwin'||!keychain||!file)throw Error('Mac identity import requires keychain and output file');
const openssl='/opt/homebrew/opt/openssl@3/bin/openssl';
const original=file+'.original';
fs.writeFileSync(original,Buffer.from(process.env.CSC_LINK,'base64'),{mode:0o600});
function run(cmd,args,input){const r=cp.spawnSync(cmd,args,{input,env:process.env,maxBuffer:16*1024*1024});if(r.status!==0)throw Error('Identity operation failed: '+cmd.split('/').pop()+' '+args[0]);return r.stdout;}
try{
 const pem=run(openssl,['pkcs12','-in',original,'-passin','env:CSC_KEY_PASSWORD','-nodes']);
 if(!pem.includes(Buffer.from('BEGIN CERTIFICATE'))||!pem.includes(Buffer.from('PRIVATE KEY')))throw Error('Identity must contain certificate and private key');
 const certFile=file+'.cert.pem', keyFile=file+'.encrypted-key.pem';
 try {
   const certificates=pem.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
   if(!certificates?.length)throw Error('Public certificate missing');
   fs.writeFileSync(certFile,certificates.join('\n'),{mode:0o600});
   run(openssl,['pkey','-aes-256-cbc','-passout','env:CSC_KEY_PASSWORD','-out',keyFile],pem);
   run(openssl,['pkcs12','-export','-in',certFile,'-inkey',keyFile,'-passin','env:CSC_KEY_PASSWORD','-out',file,'-passout','env:CSC_KEY_PASSWORD','-keypbe','PBE-SHA1-3DES','-certpbe','PBE-SHA1-3DES','-macalg','sha1']);
 } finally {pem.fill(0);fs.rmSync(certFile,{force:true});fs.rmSync(keyFile,{force:true});}
 run('/usr/bin/security',['import',file,'-k',keychain,'-P',process.env.CSC_KEY_PASSWORD,'-T','/usr/bin/codesign']);
 console.log('Encrypted signing identity imported successfully.');
}finally{fs.rmSync(original,{force:true});fs.rmSync(file,{force:true});}

