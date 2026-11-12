// image-diff.mjs: a correction image against the production image it replaces (trilha D, the X1 window; run by
// build-window-images.sh --source after the smoke). Both images are read in throwaway containers (--rm, --pull=never,
// --network none); nothing running is touched, nothing is pulled.
//
//   node deploy/window-images/image-diff.mjs --new <ref> --old <ref@digest> --allow <server/path>=<sha256>,... --out <file.json>
//
// PASS only when:
//   - every file under /app has the same sha256 in both images (and every link the same target), except the files the
//     correction changes (--allow, paths of the repository: server/<x> is /app/<x>), each of which must have the sha256 of
//     its file in the source tree (the CLI requires it), and what the build compiles or the copy
//     adds: /app/kernel/.local (the kernels), /app/platforms/odc/studio/builder/bin (the ODC builder), /app/studio-from-image
//     (the sha256 lists of the Studios copied from the old image itself);
//   - pnpm's install bookkeeping (node_modules/.modules.yaml, node_modules/.pnpm-workspace-state-v1.json) may differ only by
//     the time of the install: those two files are also hashed without their "prunedAt" / "lastValidatedTimestamp" line
//     (N lines of the list), and a file whose hash differs but whose masked hash is the same is reported as stampOnly, not
//     changed. Any other difference in them still fails;
//   - the compiled folders (COMPILED: the two above and /usr/local/lib/ssam-skia-probe, a .NET build is never byte for byte the
//     same) are not skipped blind: the same file names in both (C lines of the list) and the same sha256 of their
//     *.deps.json and *.runtimeconfig.json (text, deterministic: a NuGet package that floated changes them, an MVID does not);
//   - outside /app, the files the image runs that the Dockerfile writes or copies (OUTSIDE_FILES: ssam-server-start, the Cmd,
//     and node) have the same sha256;
//   - every entry under /app outside the pruned folders has the same mode (setuid, setgid, sticky included), owner and type,
//     and no entry is added or removed, empty folders included (M lines; a correction file too: its content may change,
//     never its metadata);
//   - the runtime config is the same (Env, Cmd, Entrypoint, User, WorkingDir, ExposedPorts, Healthcheck, Volumes, StopSignal);
//   - the labels are the same but version, revision and created (the new build's) and the ssam.studio.* provenance labels it
//     adds, a closed list (STUDIO_LABEL: from-image and <lane>.<version>.source); any other new ssam.studio.* label fails.
// The Studio folders are the smoke's (smoke.sh step 3: the same sha256 inside the source image).
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const SKIP=['./kernel/.local','./platforms/odc/studio/builder/bin','./studio-from-image'];
export const COMPILED=[SKIP[0],SKIP[1],'/usr/local/lib/ssam-skia-probe'],OUTSIDE_FILES=['/usr/local/bin/ssam-server-start','/usr/local/bin/node'];
export const STUDIO_LABEL=/^ssam\.studio\.(from-image|(o11|odc)\.[0-9]+(\.[0-9]+)+\.source)$/;
const CONFIG=['Env','Cmd','Entrypoint','User','WorkingDir','ExposedPorts','Healthcheck','Volumes','StopSignal'];
const BUILD_LABELS=['org.opencontainers.image.version','org.opencontainers.image.revision','org.opencontainers.image.created'];
const prune=SKIP.map(p=>`-path ${p}`).join(' -o ');
export const STAMPS=['.modules.yaml','.pnpm-workspace-state-v1.json'],STAMP_LINE='^[[:space:]]*"(prunedAt|lastValidatedTimestamp)":';
export const LIST=`cd /app && find . \\( ${prune} \\) -prune -o -type f -print0 | xargs -0 -r sha256sum && find . \\( ${prune} \\) -prune -o -type l -printf 'L %l  %p\\n'`+
 ` && find . \\( ${prune} \\) -prune -o -type f \\( ${STAMPS.map(n=>`-name ${n}`).join(' -o ')} \\) -print | while IFS= read -r f; do printf 'N %s  %s\\n' "$(grep -v -E '${STAMP_LINE}' "$f" | sha256sum | cut -c1-64)" "$f"; done`+
 ` && { for f in ${OUTSIDE_FILES.join(' ')}; do [ -f "$f" ] && sha256sum "$f"; done; for d in ${COMPILED.join(' ')}; do [ -d "$d" ] || continue;`+
 ` find "$d" -type f \\( -name '*.deps.json' -o -name '*.runtimeconfig.json' \\) -print0 | xargs -0 -r sha256sum; find "$d" -type f -printf 'C %p\\n'; done; true; }`+
 // The metadata of every entry under /app (trilha C, I3): mode with setuid/setgid/sticky, owner, type; empty folders included.
 ` && find . \\( ${prune} \\) -prune -o -printf 'M %#m %U:%G %y  %p\\n'`;

// sha256sum lines and link lines into {path: hash or "-> target"}; N lines (a pnpm bookkeeping file hashed without its time
// line) into "N <path>" keys.
export function parseList(text){
 const out={};
 for(const l of String(text).split('\n')){if(!l)continue;
  let m=/^L (.*)  (\.\/.*)$/.exec(l);if(m){out[m[2]]='-> '+m[1];continue;}
  m=/^N ([0-9a-f]{64})  (\.\/.*)$/.exec(l);if(m){out['N '+m[2]]=m[1];continue;}
  m=/^C ((?:\.|\/).*)$/.exec(l);if(m){out['C '+m[1]]='1';continue;}
  m=/^M (\S+ \S+ \S)  (\..*)$/.exec(l);if(m){out['M '+m[2]]=m[1];continue;}
  m=/^([0-9a-f]{64})  (\.?\/.*)$/.exec(l);if(!m)throw Error(`unreadable list line: ${l.slice(0,80)}`);out[m[2]]=m[1];
 }
 return out;
}
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
// An --allow entry: server/<x>, or server/<x>=<sha256> (the content the file must have: its blob in the source tree).
export function parseAllow(allow){
 return allow.map(x=>{const m=/^(server\/[^=]+?)(?:=([0-9a-f]{64}))?$/.exec(x.trim());if(!m)throw Error(`--allow ${x}: not server/<path>[=<sha256>]`);return {key:'./'+m[1].replace(/^server\//,''),sha:m[2]??null};});
}
export function compareImages({oldFiles,newFiles,oldConfig,newConfig,allow}){
 const al=parseAllow(allow),allowed=new Set(al.map(x=>x.key)),changed=[],added=[],removed=[],stampOnly=[];
 const file=p=>!/^[NCM] /.test(p),name=p=>p.startsWith('C '),meta=p=>p.startsWith('M '),seen=p=>file(p)||name(p)||meta(p);
 const stamp=p=>STAMPS.includes(p.split('/').at(-1))&&('N '+p) in oldFiles&&('N '+p) in newFiles&&oldFiles['N '+p]===newFiles['N '+p];
 for(const [p,h] of Object.entries(newFiles)){if(!seen(p))continue;if(!(p in oldFiles))added.push(p);else if(oldFiles[p]!==h)(stamp(p)?stampOnly:changed).push(p);}
 for(const p of Object.keys(oldFiles))if(seen(p)&&!(p in newFiles))removed.push(p);
 const outside=[...changed,...added,...removed].filter(p=>!allowed.has(p)).sort();
 const config=CONFIG.filter(k=>!same(oldConfig[k],newConfig[k]));
 const ol=oldConfig.Labels??{},nl=newConfig.Labels??{},labels=[];
 for(const k of new Set([...Object.keys(ol),...Object.keys(nl)])){
  if(BUILD_LABELS.includes(k))continue;
  if(STUDIO_LABEL.test(k)&&!(k in ol))continue;
  if(ol[k]!==nl[k])labels.push(k);
 }
 // A correction file the image carries must be the source tree's (trilha C, I1): with a sha256 in --allow, its content is
 // compared with it; a different content fails like a file outside the correction.
 const wrongContent=al.filter(x=>x.sha&&x.key in newFiles&&newFiles[x.key]!==x.sha).map(x=>x.key).sort();
 const ok=!outside.length&&!config.length&&!labels.length&&!wrongContent.length;
 return {ok,wrongContent,files:Object.keys(newFiles).filter(file).length,compiledNames:Object.keys(newFiles).filter(name).length,stampOnly:stampOnly.sort(),changed:changed.sort(),added:added.sort(),removed:removed.sort(),outside,config,labels,
  allowedUnchanged:[...allowed].filter(p=>!changed.includes(p)&&!added.includes(p)&&!removed.includes(p)).sort()};
}

const docker=args=>cp.execFileSync(process.env.DOCKER_BIN??'docker',args,{encoding:'utf8',maxBuffer:512*1024*1024,env:{...process.env,MSYS_NO_PATHCONV:'1'}});
export function readImage(ref,run=docker){
 return {files:parseList(run(['run','--rm','--pull=never','--network','none','-u','0','--entrypoint','sh',ref,'-c',LIST])),
  config:JSON.parse(run(['image','inspect','-f','{{json .Config}}',ref]))};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const a={},rest=process.argv.slice(2);
 for(let i=0;i<rest.length;i+=2){if(!rest[i].startsWith('--')||rest[i+1]===undefined){console.error(`image-diff: unknown or incomplete argument ${rest[i]}`);process.exit(2);}a[rest[i].slice(2)]=rest[i+1];}
 try{
  if(!a.new||!a.old||a.allow===undefined||!a.out)throw Error('--new <ref> --old <ref> --allow <server/path=sha256,...> --out <file>');
  const missing=parseAllow(a.allow.split(',').filter(Boolean)).filter(x=>!x.sha).map(x=>x.key);
  if(missing.length)throw Error(`--allow needs the sha256 each correction file has in the source tree (server/<path>=<sha256>): ${missing.join(', ')}`);
  const n=readImage(a.new),o=readImage(a.old);
  const r={new:a.new,old:a.old,...compareImages({oldFiles:o.files,newFiles:n.files,oldConfig:o.config,newConfig:n.config,allow:a.allow.split(',').filter(Boolean)})};
  fs.writeFileSync(a.out,JSON.stringify(r,null,1)+'\n');
  const list=x=>x.length>8?x.slice(0,8).join(', ')+` (+${x.length-8})`:x.join(', ')||'none';
  console.log(`${r.files} files compared (and ${r.compiledNames} names of compiled files); changed ${list(r.changed)}; added ${list(r.added)}; removed ${list(r.removed)}`);
  if(r.stampOnly.length)console.log(`pnpm install time only (prunedAt / lastValidatedTimestamp): ${list(r.stampOnly)}`);
  if(r.allowedUnchanged.length)console.log(`correction files not in the image or unchanged (outside the image context?): ${list(r.allowedUnchanged)}`);
  if(!r.ok){console.log(`outside the correction: files ${list(r.outside)}; config ${list(r.config)}; labels ${list(r.labels)}; correction files not as in the source tree ${list(r.wrongContent)}`);console.log('IMAGE DIFF FAIL');process.exit(1);}
  console.log('IMAGE DIFF OK');
 }catch(e){console.error(`image-diff: ${e.message}`);process.exit(1);}
}
