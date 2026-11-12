// overlay.test.mjs: the correction image on top of the production image and its proof (trilha D; trilha C's review, I4),
// offline: tar files written here, a fake stat and a fake docker image save. From server/:
//   node --test deploy/window-images/tests/overlay.test.mjs
import test,{after} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import zlib from 'node:zlib';import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {appPath,ignoredFolders,ignored,overlayPlan,overlayDockerfile,writeContext,TarReader,readLayer,savedLayers,proveOverlay,proofOf} from '../overlay.mjs';

const made=[];after(()=>{for(const d of made)fs.rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'overlay-'));made.push(d);return d;};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');

// A tar writer: ustar headers, a pax header for a long path.
function header(name,{size=0,type='0',mode=0o644,uid=0,gid=0,link=''}={}){
 const h=Buffer.alloc(512);const w=(s,o,n)=>Buffer.from(s).copy(h,o,0,n);const oct=(v,n)=>w(v.toString(8).padStart(n-1,'0')+'\0',0,n);
 w(name,0,100);h.write(mode.toString(8).padStart(7,'0')+'\0',100);h.write(uid.toString(8).padStart(7,'0')+'\0',108);h.write(gid.toString(8).padStart(7,'0')+'\0',116);
 h.write(size.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.write(type,156);w(link,157,100);h.write('ustar\0',257);h.write('00',263);
 h.fill(' ',148,156);let s=0;for(const x of h)s+=x;h.write(s.toString(8).padStart(6,'0')+'\0 ',148);void oct;return h;
}
const pad=b=>Buffer.concat([b,Buffer.alloc((512-b.length%512)%512)]);
function tar(entries){
 const out=[];
 for(const e of entries){
  const body=Buffer.from(e.body??'');
  if(e.name.length>99){const rec=` path=${e.name}\n`;let len=rec.length+1;len+=String(len).length;const kv=Buffer.from(`${len}${rec}`.replace(/^\d+/,String(Buffer.from(`${len}${rec}`).length)));out.push(header('PaxHeader',{size:kv.length,type:'x'}),pad(kv));}
  out.push(header(e.name.slice(0,99),{size:e.type&&e.type!=='0'?0:body.length,...e}));if(!e.type||e.type==='0')out.push(pad(body));
 }
 out.push(Buffer.alloc(1024));return Buffer.concat(out);
}

const fixed='export const fixed = true;\n',FIX=sha(fixed);
const plan={files:[{path:'server/platforms/odc/facade/read-budget.mjs',app:'/app/platforms/odc/facade/read-budget.mjs',sha256:FIX,mode:'0644',uid:10001,gid:10001}],notInImage:[]};
const dirs={'/app':{mode:'0755',uid:10001,gid:10001},'/app/platforms':{mode:'0755',uid:10001,gid:10001},'/app/platforms/odc':{mode:'0755',uid:10001,gid:10001},'/app/platforms/odc/facade':{mode:'0755',uid:10001,gid:10001}};
const goodLayer=()=>tar([{name:'app/',type:'5',mode:0o755,uid:10001,gid:10001},{name:'app/platforms/odc/facade/',type:'5',mode:0o755,uid:10001,gid:10001},
 {name:'app/platforms/odc/facade/read-budget.mjs',body:fixed,mode:0o644,uid:10001,gid:10001}]);
const L=n=>'sha256:'+String(n).repeat(64).slice(0,64);

test('paths and .dockerignore: server/<x> is /app/<x>; plain folder lines keep tests out',()=>{
 assert.equal(appPath('server/platforms/odc/facade/read-budget.mjs'),'/app/platforms/odc/facade/read-budget.mjs');
 assert.throws(()=>appPath('agent/a.js'),/not a path under server/);assert.throws(()=>appPath('server/../x'),/not a path under server/);
 const f=ignoredFolders('# c\n.git\n**/bin\nplatforms/odc/facade/tests\n!kernel/x\ntests\n');
 assert.deepEqual(f,['.git','platforms/odc/facade/tests','tests']);
 assert.equal(ignored('platforms/odc/facade/tests/a.test.mjs',f),true);assert.equal(ignored('platforms/odc/facade/read-budget.mjs',f),false);
});

test('plan: production\'s mode and owner, the tree\'s content; a file not in production refused unless .dockerignore keeps it out',()=>{
 const t=tmp();fs.mkdirSync(path.join(t,'server/platforms/odc/facade/tests'),{recursive:true});
 fs.writeFileSync(path.join(t,'server/platforms/odc/facade/read-budget.mjs'),fixed);fs.writeFileSync(path.join(t,'server/platforms/odc/facade/tests/r.test.mjs'),'t');
 fs.writeFileSync(path.join(t,'server/.dockerignore'),'platforms/odc/facade/tests\n');fs.writeFileSync(path.join(t,'server/new.mjs'),'n');
 const stat=(img,paths)=>{assert.equal(img,'prod@sha256:'+'a'.repeat(64));return paths.filter(p=>p.endsWith('read-budget.mjs')).map(p=>`644 10001 10001 regular file ${p}`).join('\n')+'\n';};
 const p=overlayPlan({files:['server/platforms/odc/facade/read-budget.mjs','server/platforms/odc/facade/tests/r.test.mjs'],tree:t,old:'prod@sha256:'+'a'.repeat(64),stat});
 assert.deepEqual(p,{files:plan.files,notInImage:['server/platforms/odc/facade/tests/r.test.mjs']});
 assert.throws(()=>overlayPlan({files:['server/new.mjs'],tree:t,old:'x',stat}),/has no \/app\/new.mjs, and .dockerignore does not keep it out/);
 assert.throws(()=>overlayPlan({files:['server/platforms/odc/facade/tests/r.test.mjs'],tree:t,old:'x',stat}),/nothing to overlay/);
 const link=()=>'777 0 0 symbolic link /app/platforms/odc/facade/read-budget.mjs\n';
 assert.throws(()=>overlayPlan({files:['server/platforms/odc/facade/read-budget.mjs'],tree:t,old:'x',stat:link}),/is a symbolic link in the production image/);
});

test('Dockerfile: FROM production by digest, one COPY per file with mode and owner, the three build labels; the context',()=>{
 const old='docker.io/x/ssam-server@sha256:'+'b'.repeat(64);
 const d=overlayDockerfile({old,plan,version:'prod-20261111-r47-25d768f-o115594-odc1731',revision:'c'.repeat(40),created:'2026-11-11T16:00:00Z'});
 assert.match(d,new RegExp(`^FROM ${old.replace(/[.@]/g,'\\$&')}$`,'m'));
 assert.match(d,/^COPY --chown=10001:10001 --chmod=0644 files\/0 \/app\/platforms\/odc\/facade\/read-budget.mjs$/m);
 assert.match(d,/^LABEL "org.opencontainers.image.version"="prod-20261111-r47-25d768f-o115594-odc1731" "org.opencontainers.image.revision"="c{40}" "org.opencontainers.image.created"="2026-11-11T16:00:00Z"$/m);
 assert.equal(d.split('\n').filter(l=>/^(RUN|ADD|ENV|USER|CMD|ENTRYPOINT|WORKDIR)/.test(l)).length,0,'nothing else');
 assert.throws(()=>overlayDockerfile({old:'x:tag',plan,version:'v',revision:'c'.repeat(40),created:'t'}),/by digest/);
 const t=tmp(),c=path.join(t,'ctx');fs.mkdirSync(path.join(t,'server/platforms/odc/facade'),{recursive:true});fs.writeFileSync(path.join(t,'server/platforms/odc/facade/read-budget.mjs'),fixed);
 writeContext({dir:c,tree:t,plan,dockerfile:d});assert.equal(fs.readFileSync(path.join(c,'files/0'),'utf8'),fixed);assert.equal(fs.readFileSync(path.join(c,'Dockerfile'),'utf8'),d);
});

test('tar: ustar and pax long names, read in pieces of any size; a layer\'s entries with sha256, mode and owner',()=>{
 const long='app/'+'x'.repeat(120)+'/f.mjs';
 const b=tar([{name:'app/',type:'5',mode:0o755,uid:1,gid:2},{name:long,body:'long'},{name:'app/l',type:'2',link:'f.mjs'},{name:'app/.wh.gone',body:''}]);
 const whole=readLayer(b);
 assert.deepEqual(whole.map(e=>[e.path,e.kind]),[['/app','dir'],['/'+long,'file'],['/app/l','symlink'],['/app/.wh.gone','file']]);
 assert.equal(whole[1].sha256,sha('long'));assert.equal(whole[0].mode,'0755');assert.equal(whole[0].uid,1);assert.equal(whole[2].link,'f.mjs');
 for(const step of [1,7,511,513,4096]){const got=[];const r=new TarReader(e=>{got.push(e.name.replace(/\/$/,''));return null;});for(let i=0;i<b.length;i+=step)r.push(b.subarray(i,i+step));assert.deepEqual(got,whole.map(e=>e.path.slice(1)),'step '+step);}
});

test('proof: production\'s layers first, then only the corrected file with its sha256, mode and owner, and its folders',()=>{
 const old=[L(1),L(2)],top=L(9),ok=e=>proveOverlay({oldLayers:old,newLayers:[...old,top],extra:new Map([[top,e]]),plan,dirs});
 const r=ok(readLayer(goodLayer()));assert.equal(r.ok,true,r.fails.join('; '));assert.equal(r.productionLayers,2);assert.equal(r.overlayLayers,1);
 const cases=[
  ['another content',[{name:'app/platforms/odc/facade/read-budget.mjs',body:'export const fixed = false;\n',mode:0o644,uid:10001,gid:10001}],/sha256 .*, the source tree's is/],
  ['another mode',[{name:'app/platforms/odc/facade/read-budget.mjs',body:fixed,mode:0o755,uid:10001,gid:10001}],/mode\/owner 0755 10001:10001, production's 0644/],
  ['another owner',[{name:'app/platforms/odc/facade/read-budget.mjs',body:fixed,mode:0o644,uid:0,gid:0}],/production's 0644 10001:10001/],
  ['an extra file',[{name:'app/platforms/odc/facade/read-budget.mjs',body:fixed,mode:0o644,uid:10001,gid:10001},{name:'usr/lib/libsqlite3.so.0',body:'x'}],/\/usr\/lib\/libsqlite3.so.0: a file in the overlay/],
  ['a whiteout',[{name:'app/platforms/odc/facade/read-budget.mjs',body:fixed,mode:0o644,uid:10001,gid:10001},{name:'app/.wh.studio-from-image',body:''}],/a whiteout/],
  ['a folder with another mode',[{name:'app/',type:'5',mode:0o777,uid:10001,gid:10001},{name:'app/platforms/odc/facade/read-budget.mjs',body:fixed,mode:0o644,uid:10001,gid:10001}],/\/app: folder mode\/owner 0777/],
  ['the file missing',[{name:'app/',type:'5',mode:0o755,uid:10001,gid:10001}],/not in the overlay layers/],
 ];
 for(const [what,e,re] of cases){const x=ok(readLayer(tar(e)));assert.equal(x.ok,false,what);assert.ok(x.fails.some(f=>re.test(f)),`${what}: ${x.fails.join('; ')}`);}
 const rebuilt=proveOverlay({oldLayers:old,newLayers:[L(1),L(3),top],extra:new Map([[top,readLayer(goodLayer())]]),plan,dirs});
 assert.ok(rebuilt.fails.some(f=>/first layers of the new image are not the production image's/.test(f)),'a rebuild (libsqlite3-0 2.9) is not an overlay');
 assert.ok(proveOverlay({oldLayers:old,newLayers:old,extra:new Map(),plan,dirs}).fails.some(f=>/no overlay layer/.test(f)));
 assert.ok(proveOverlay({oldLayers:old,newLayers:[...old,top,L(8)],extra:new Map([[top,readLayer(goodLayer())]]),plan,dirs}).fails.some(f=>/2 layers on top of production for 1 file|not readable from docker save/.test(f)));
});

test('docker image save, read as a stream: the overlay blob found by its diff id (gzip or not); then the whole proof',async()=>{
 const layer=goodLayer(),id='sha256:'+sha(layer),big=Buffer.alloc(3000,1);
 const outer=tar([{name:'blobs/sha256/'+sha(big),body:big},{name:'blobs/sha256/'+sha(zlib.gzipSync(layer)),body:zlib.gzipSync(layer)},{name:'index.json',body:'{}'},{name:'manifest.json',body:'[]'}]);
 const spawn=(bin,args)=>{assert.deepEqual(args,['image','save','new:t']);const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();
  setImmediate(()=>{for(let i=0;i<outer.length;i+=1000)p.stdout.write(outer.subarray(i,i+1000));p.stdout.end();p.stdout.on('end',()=>p.emit('close',0));});p.kill=()=>{};return p;};
 const found=await savedLayers('new:t',{want:[id],spawn});assert.deepEqual([...found.keys()],[id]);assert.equal(sha(found.get(id)),sha(layer));
 const small=await savedLayers('new:t',{want:['sha256:'+sha(big)],spawn,maxBytes:100});assert.equal(small.size,0,'a blob over maxBytes is skipped');
 const old=[L(1),L(2)];
 const r=await proofOf({newRef:'new:t',oldRef:'prod@sha256:'+'a'.repeat(64),plan,inspect:ref=>ref==='new:t'?[...old,id]:old,save:(ref,o)=>savedLayers(ref,{...o,spawn}),
  stat:(img,paths)=>paths.map(p=>`755 10001 10001 ${p}`).join('\n')});
 assert.equal(r.ok,true,r.fails.join('; '));
});
