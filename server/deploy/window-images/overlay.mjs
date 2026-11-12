// overlay.mjs: a correction image ON TOP of the production image (trilha D, the X1 window; trilha C's review, I4).
// The image is `FROM <production image>@<digest>` plus one COPY per corrected file, with the production file's mode and
// owner, and the build labels. Nothing is compiled, nothing is installed: every layer of production is the image's first
// layers, byte for byte (content-addressed), so the system packages (libsqlite3-0 moved 2.8 -> 2.9 in a rebuild), the
// kernels and the Studios are production's own. The proof reads the image from OUTSIDE it (docker save, parsed here): the
// tool that audits the image is not the image's (I4).
//
//   node deploy/window-images/overlay.mjs plan --old <prod ref@digest> --tree <clean tree of --source> --files <server/x,...>
//     prints [{path, app, sha256, mode, uid, gid}] of the files to copy, and refuses a correction file the production image
//     does not carry unless .dockerignore of the tree keeps it out of the image (a plain folder line: tests).
//   node deploy/window-images/overlay.mjs dockerfile --old <prod ref@digest> --plan <plan.json> --version <tag>
//        --revision <sha40> --created <iso> --out <dir>
//     writes <dir>/Dockerfile and <dir>/files/<n> (the build context).
//   node deploy/window-images/overlay.mjs proof --new <ref> --old <prod ref@digest> --plan <plan.json> --out <file.json>
//     PASS ("OVERLAY PROOF OK") only when the new image's layers are the old image's layers followed by the extra layers
//     of the COPYs, and the extra layers hold exactly the planned files (regular files, the planned sha256, mode and owner)
//     and their parent folders (with production's mode and owner): no other file, link, device or whiteout.
// Every docker call is local: --pull=never, --network none, image inspect, image save. Nothing is pushed or pulled.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';

const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');
const docker=(args,opts={})=>cp.execFileSync(process.env.DOCKER_BIN??'docker',args,{encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,MSYS_NO_PATHCONV:'1'},...opts});
export const appPath=f=>{if(!/^server\/[^\0]+$/.test(f)||f.split('/').includes('..'))throw Error(`${f}: not a path under server/`);return '/app/'+f.slice('server/'.length);};

// The plain folder lines of a .dockerignore (no wildcard, no negation): what COPY . /app never takes.
export function ignoredFolders(text){
 return String(text).split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#')&&!l.startsWith('!')&&!/[*?[\]]/.test(l)).map(l=>l.replace(/^\/+|\/+$/g,''));
}
export const ignored=(rel,folders)=>folders.some(f=>rel===f||rel.startsWith(f+'/'));

// The files to copy: each correction file the production image carries, with production's mode and owner and the tree's
// content. stat is the production image's own (the trusted image reads itself).
export function overlayPlan({files,tree,old,stat=(img,paths)=>docker(['run','--rm','--pull=never','--network','none','--entrypoint','stat',img,'-c','%a %u %g %F %n',...paths],{stdio:['ignore','pipe','pipe']})}){
 const apps=files.map(appPath);
 let out='';try{out=stat(old,apps);}catch(e){out=String(e.stdout??'');}
 const seen=new Map();
 for(const l of out.split('\n')){const m=/^([0-7]+) (\d+) (\d+) (.+?) (\/app\/.+)$/.exec(l.trim());if(m)seen.set(m[5],{mode:m[1],uid:+m[2],gid:+m[3],type:m[4]});}
 const folders=ignoredFolders(fs.existsSync(path.join(tree,'server/.dockerignore'))?fs.readFileSync(path.join(tree,'server/.dockerignore'),'utf8'):'');
 const plan=[],left=[];
 files.forEach((f,i)=>{
  const app=apps[i],s=seen.get(app),local=path.join(tree,f);
  if(!s){
   if(ignored(f.slice('server/'.length),folders)){left.push(f);return;}
   throw Error(`${f}: the production image has no ${app}, and .dockerignore does not keep it out: a correction that adds a file to the image is a release, not an overlay`);
  }
  if(s.type!=='regular file')throw Error(`${app} is a ${s.type} in the production image: only regular files are corrected`);
  if(!fs.existsSync(local))throw Error(`${f}: the correction deletes a file the image carries: not an overlay (a release)`);
  plan.push({path:f,app,sha256:sha256(fs.readFileSync(local)),mode:s.mode.padStart(4,'0'),uid:s.uid,gid:s.gid});
 });
 if(!plan.length)throw Error('no correction file is in the production image: nothing to overlay');
 return {files:plan,notInImage:left};
}

const q=s=>JSON.stringify(String(s));
export function overlayDockerfile({old,plan,version,revision,created}){
 if(!/@sha256:[0-9a-f]{64}$/.test(old))throw Error(`--old ${old}: the production image by digest (<ref>@sha256:<64 hex>)`);
 if(!/^[0-9a-f]{40}$/.test(revision))throw Error('--revision: the full commit of --source');
 return [
  '# A correction image: the production image, byte for byte, plus the corrected files (overlay.mjs; trilha D, X1 window).',
  `FROM ${old}`,
  ...plan.files.map((f,i)=>`COPY --chown=${f.uid}:${f.gid} --chmod=${f.mode} files/${i} ${f.app}`),
  `LABEL "org.opencontainers.image.version"=${q(version)} "org.opencontainers.image.revision"=${q(revision)} "org.opencontainers.image.created"=${q(created)}`,
  '',
 ].join('\n');
}
export function writeContext({dir,tree,plan,dockerfile}){
 fs.mkdirSync(path.join(dir,'files'),{recursive:true});
 plan.files.forEach((f,i)=>fs.copyFileSync(path.join(tree,f.path),path.join(dir,'files',String(i))));
 fs.writeFileSync(path.join(dir,'Dockerfile'),dockerfile);
 fs.writeFileSync(path.join(dir,'.dockerignore'),'Dockerfile\n.dockerignore\n');
}

// ---- tar, read here (no system tar, no tool of the image): ustar, pax (path, size, uid, gid), GNU long names.
const str=(b,o,n)=>{const s=b.subarray(o,o+n);const z=s.indexOf(0);return s.subarray(0,z<0?n:z).toString('utf8');};
const num=(b,o,n)=>{if(b[o]&0x80){let v=0;for(let i=1;i<n;i++)v=v*256+b[o+i];return v;}const s=str(b,o,n).trim();return s?parseInt(s,8):0;};
function pax(buf){const out={};let i=0;while(i<buf.length){const sp=buf.indexOf(0x20,i);const len=+buf.subarray(i,sp).toString();const kv=buf.subarray(sp+1,i+len-1).toString('utf8');const eq=kv.indexOf('=');out[kv.slice(0,eq)]=kv.slice(eq+1);i+=len;}return out;}
// Streaming reader: onEntry({name, type, size, mode, uid, gid, linkname}) returns a sink {data(chunk), end()} or null to skip.
export class TarReader{
 constructor(onEntry){this.onEntry=onEntry;this.buf=Buffer.alloc(0);this.state='header';this.left=0;this.pad=0;this.sink=null;this.next={};this.special=null;this.done=false;}
 push(chunk){
  this.buf=this.buf.length?Buffer.concat([this.buf,chunk]):chunk;
  for(;;){
   if(this.done)return;
   if(this.state==='header'){
    if(this.buf.length<512)return;
    const h=this.buf.subarray(0,512);this.buf=this.buf.subarray(512);
    if(h.every(x=>x===0)){this.zero=(this.zero??0)+1;if(this.zero>=2)this.done=true;continue;}
    this.zero=0;
    const type=String.fromCharCode(h[156]||48),prefix=str(h,345,155);
    const e={name:this.next.path??(prefix?prefix+'/':'')+str(h,0,100),type,size:this.next.size!=null?+this.next.size:num(h,124,12),mode:num(h,100,8),
     uid:this.next.uid!=null?+this.next.uid:num(h,108,8),gid:this.next.gid!=null?+this.next.gid:num(h,116,8),linkname:this.next.linkpath??str(h,157,100)};
    this.left=e.size;this.pad=(512-e.size%512)%512;
    if(type==='x'||type==='L'||type==='K'||type==='g'){this.special={type,chunks:[]};this.sink={data:c=>this.special.chunks.push(c),end:()=>{}};}
    else{this.next={};this.special=null;this.sink=this.onEntry(e);}
    this.state='data';
   }
   if(this.state==='data'){
    if(this.left>0){if(!this.buf.length)return;const n=Math.min(this.left,this.buf.length);this.sink?.data(this.buf.subarray(0,n));this.buf=this.buf.subarray(n);this.left-=n;if(this.left>0)return;}
    if(this.buf.length<this.pad)return;
    this.buf=this.buf.subarray(this.pad);this.sink?.end();
    if(this.special){const b=Buffer.concat(this.special.chunks);
     if(this.special.type==='x')Object.assign(this.next,pax(b));else if(this.special.type==='L')this.next.path=b.toString('utf8').replace(/\0+$/,'');else if(this.special.type==='K')this.next.linkpath=b.toString('utf8').replace(/\0+$/,'');}
    this.special=null;this.sink=null;this.state='header';
   }
  }
 }
}
const TYPE={'0':'file','\0':'file','7':'file','1':'hardlink','2':'symlink','3':'char','4':'block','5':'dir','6':'fifo'};
// A layer tar (uncompressed) into its entries: {path (absolute, no trailing /), kind, mode, uid, gid, sha256 for files}.
export function readLayer(buf){
 const out=[];const r=new TarReader(e=>{const x={path:'/'+e.name.replace(/^\.?\/+/,'').replace(/\/+$/,''),kind:TYPE[e.type]??('type '+e.type),mode:(e.mode&0o7777).toString(8).padStart(4,'0'),uid:e.uid,gid:e.gid,link:e.linkname||null};
  out.push(x);if(x.kind!=='file')return null;const h=crypto.createHash('sha256');return {data:c=>h.update(c),end:()=>{x.sha256=h.digest('hex');}};});
 r.push(buf);return out;
}

// docker save of the new image, read as a stream: the blobs (OCI layout) or layer.tar files (older layout) up to maxBytes,
// decompressed when gzip, keyed by their diff id; the bigger ones are skipped (an overlay layer is a few files).
export function savedLayers(ref,{want,maxBytes=64*1024*1024,spawn=cp.spawn}={}){
 return new Promise((resolve,reject)=>{
  const found=new Map(),p=spawn(process.env.DOCKER_BIN??'docker',['image','save',ref],{stdio:['ignore','pipe','pipe']});let err='';
  const r=new TarReader(e=>{
   if(!(e.type==='0'||e.type==='\0')||e.size>maxBytes||!(/^blobs\/sha256\/[0-9a-f]{64}$/.test(e.name)||/\/layer\.tar$/.test(e.name)))return null;
   const parts=[];return {data:c=>parts.push(Buffer.from(c)),end:()=>{let b=Buffer.concat(parts);
    if(b[0]===0x1f&&b[1]===0x8b){try{b=zlib.gunzipSync(b);}catch{return;}}
    const id='sha256:'+sha256(b);if(want.includes(id))found.set(id,b);}};
  });
  p.stdout.on('data',c=>{try{r.push(c);}catch(e){p.kill();reject(e);}});
  p.stderr.on('data',c=>{err+=c;});
  p.on('error',reject);
  p.on('close',code=>code===0?resolve(found):reject(Error(`docker image save ${ref}: ${err.trim().split('\n').at(-1)}`)));
 });
}

// The proof, on what was read: layers and the entries of the extra layers.
export function proveOverlay({oldLayers,newLayers,extra,plan,dirs}){
 const fails=[];
 if(newLayers.length<=oldLayers.length)fails.push(`the new image has ${newLayers.length} layers, production ${oldLayers.length}: no overlay layer`);
 const lower=newLayers.slice(0,oldLayers.length);
 if(JSON.stringify(lower)!==JSON.stringify(oldLayers))fails.push('the first layers of the new image are not the production image\'s layers, in order');
 const top=newLayers.slice(oldLayers.length);
 if(top.length>plan.files.length)fails.push(`${top.length} layers on top of production for ${plan.files.length} file(s)`);
 const want=new Map(plan.files.map(f=>[f.app,f])),seenFiles=new Set(),parents=new Set();
 for(const f of plan.files){let d=path.posix.dirname(f.app);while(d!=='/'){parents.add(d);d=path.posix.dirname(d);}}
 for(const id of top){
  const entries=extra.get(id);
  if(!entries){fails.push(`layer ${id.slice(7,19)} is not readable from docker save (bigger than an overlay, or compressed otherwise)`);continue;}
  for(const e of entries){
   const f=want.get(e.path);
   if(e.path.split('/').at(-1).startsWith('.wh.')){fails.push(`${e.path}: a whiteout (a file of production removed)`);continue;}
   if(f){
    if(e.kind!=='file')fails.push(`${e.path}: a ${e.kind}, not a regular file`);
    else{if(e.sha256!==f.sha256)fails.push(`${e.path}: sha256 ${e.sha256?.slice(0,12)}, the source tree's is ${f.sha256.slice(0,12)}`);
     if(e.mode!==f.mode||e.uid!==f.uid||e.gid!==f.gid)fails.push(`${e.path}: mode/owner ${e.mode} ${e.uid}:${e.gid}, production's ${f.mode} ${f.uid}:${f.gid}`);}
    seenFiles.add(e.path);continue;
   }
   if(e.kind==='dir'&&parents.has(e.path)){const d=dirs?.[e.path];
    if(!d)fails.push(`${e.path}: a folder whose production mode/owner was not read`);
    else if(e.mode!==d.mode||e.uid!==d.uid||e.gid!==d.gid)fails.push(`${e.path}: folder mode/owner ${e.mode} ${e.uid}:${e.gid}, production's ${d.mode} ${d.uid}:${d.gid}`);
    continue;}
   fails.push(`${e.path}: a ${e.kind} in the overlay that is not a corrected file`);
  }
 }
 for(const f of plan.files)if(!seenFiles.has(f.app))fails.push(`${f.app}: not in the overlay layers`);
 return {ok:!fails.length,fails,productionLayers:oldLayers.length,overlayLayers:top.length,files:plan.files.map(f=>({app:f.app,sha256:f.sha256}))};
}

export async function proofOf({newRef,oldRef,plan,inspect=r=>JSON.parse(docker(['image','inspect','-f','{{json .RootFS.Layers}}',r])),
 save=(r,o)=>savedLayers(r,o),stat=(img,paths)=>docker(['run','--rm','--pull=never','--network','none','--entrypoint','stat',img,'-c','%a %u %g %n',...paths])}){
 const oldLayers=inspect(oldRef),newLayers=inspect(newRef),top=newLayers.slice(oldLayers.length);
 const raw=top.length?await save(newRef,{want:top}):new Map(),extra=new Map([...raw].map(([k,b])=>[k,readLayer(b)]));
 const parents=new Set();for(const f of plan.files){let d=path.posix.dirname(f.app);while(d!=='/'){parents.add(d);d=path.posix.dirname(d);}}
 const dirs={};
 for(const l of stat(oldRef,[...parents]).split('\n')){const m=/^([0-7]+) (\d+) (\d+) (\/.+)$/.exec(l.trim());if(m)dirs[m[4]]={mode:m[1].padStart(4,'0'),uid:+m[2],gid:+m[3]};}
 return proveOverlay({oldLayers,newLayers,extra,plan,dirs});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [cmd,...rest]=process.argv.slice(2),a={};
 for(let i=0;i<rest.length;i+=2){if(!rest[i].startsWith('--')||rest[i+1]===undefined){console.error(`overlay: unknown or incomplete argument ${rest[i]}`);process.exit(2);}a[rest[i].slice(2)]=rest[i+1];}
 const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
 try{
  if(cmd==='plan'){
   if(!a.old||!a.tree||!a.files)throw Error('plan --old <ref@digest> --tree <dir> --files <server/x,...>');
   console.log(JSON.stringify(overlayPlan({files:a.files.split(',').filter(Boolean),tree:a.tree,old:a.old})));
  }else if(cmd==='dockerfile'){
   if(!a.old||!a.plan||!a.version||!a.revision||!a.created||!a.out||!a.tree)throw Error('dockerfile --old <ref@digest> --plan <plan.json> --tree <dir> --version <tag> --revision <sha40> --created <iso> --out <dir>');
   const plan=read(a.plan);writeContext({dir:a.out,tree:a.tree,plan,dockerfile:overlayDockerfile({old:a.old,plan,version:a.version,revision:a.revision,created:a.created})});
   console.log(`overlay: ${plan.files.length} file(s) on ${a.old.split('@')[1].slice(7,19)}`);
  }else if(cmd==='proof'){
   if(!a.new||!a.old||!a.plan||!a.out)throw Error('proof --new <ref> --old <ref@digest> --plan <plan.json> --out <file>');
   const r={new:a.new,old:a.old,...await proofOf({newRef:a.new,oldRef:a.old,plan:read(a.plan)})};
   fs.writeFileSync(a.out,JSON.stringify(r,null,1)+'\n');
   console.log(`${r.productionLayers} production layers, ${r.overlayLayers} overlay layer(s): ${r.files.map(f=>f.app+' '+f.sha256.slice(0,12)).join(', ')}`);
   if(!r.ok){for(const f of r.fails)console.log('  '+f);console.log('OVERLAY PROOF FAIL');process.exit(1);}
   console.log('OVERLAY PROOF OK');
  }else throw Error('plan | dockerfile | proof');
 }catch(e){console.error(`overlay: ${e.message}`);process.exit(1);}
}
