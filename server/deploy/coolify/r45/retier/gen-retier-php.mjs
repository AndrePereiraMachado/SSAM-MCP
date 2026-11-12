// node gen-retier-php.mjs --base <rev> --base-raw <sha256> --pin <rev> --out <dir> [--after <sha256>]
//                         [--base-file <compose> --c6-file <compose>]   (normally run by retier-kit.mjs)
// R45_REPO = the SSAM-MCP checkout holding both commits (default C:/t/r5/wt-capacity), R45_GIT = git.exe.
// The r45 RETIER: moves the capacity tiers of a compose that is ALREADY sized (the r45 release in production) to the tiers
// of a newer commit, in one compose write and one Redeploy. The r45 kit (../gen-deploy-php.mjs) only starts from the r44
// compose (ceff8bc9...): once r45 is stored its apply stops ("already applied"), so a hot-pair move would need a rollback to
// r44 and a second release (two Redeploys). This file keeps every guarantee of that kit, with the r45 compose as the start:
//   CB = compose.coolify.yml of --base (the commit the production kit was made from; its stored raw sha256 is --base-raw,
//        the AFTER of that kit), CN = compose.coolify.yml of --pin.
// The CB->CN delta must be tier values only (limits, cpu_shares, pool env, tier labels of the backends, the router's limits
// and its ssam.sizing label), nothing added or removed, no image, volume, network or served list; both sized with exactly
// one hot backend. The PHP refuses unless the stored compose is exactly --base-raw, differs from CB only by the known
// production-only paths (the r44 list), and CB->CN is exactly the recorded delta. It applies that delta onto the stored
// compose (production-only values kept, never printed), checks the result both ways, that no image moved and that every
// sized value is literal, that the hot backend is the one CN names and that the router label is CN's byte for byte, and
// in a dry run prints the would-be raw sha256. Dry run first (read-only); then generate again with --after <that sha>: the
// apply refuses any other result and its rollback copy (/tmp/ssam-r45h-coolify-before.json in the coolify container, 0600)
// records it as the release the rollback accepts. Nothing here touches the VPS.
// --base-file/--c6-file: local files instead of the commits, for the tests only; never deploy a kit made from files.
// --env-keys K1,K2|none (revision 2): besides the tier values, the delta may ADD environment keys to the backends (the perf
// switches of trilhas I and G), under strict rules: only the names of the list (given, or derived from the CB->CN diff when
// the option is absent; either way recorded in kit.env ENV_KEYS and printed for the review); each key added to EVERY
// backend (never the router, the console or another service), with the SAME value in all, of the form ${KEY:-default}
// (the default a plain token), byte for byte the pin's text; no existing key changed or removed; no tier, pool, served-list
// or tier-variable name. The PHP checks the same again on the Coolify and adds the keys where the pin lists them.
// Tier keys (revision 3, trilha I Revisão 7): SSAM_CODE_CHECKS and SSAM_CODE_CHECKS_PER_CUSTOMER of a backend are TIER
// values (gen-compose readersEnv: codeChecks / codeChecksPerCustomer of the backend's tier, literal), so they are their own
// change class, not added keys: on /services/ssam-server-v[1-9]/environment/ only, added, changed or removed; each value of
// the new compose a literal 1..16 equal to the field of that backend's tier in the router's ssam.sizing label of the new
// compose, and every backend of the new compose carries the key exactly when its tier's label has the field (so a 2 on an
// other backend, a hot without the value, or a removal while the label still names the field, are refused). Both names are
// forbidden as added keys. With no tier key in the delta every output is byte for byte the one of revision 2.
import fs from 'node:fs';import cp from 'node:child_process';import crypto from 'node:crypto';import path from 'node:path';
import {CLASSES,SERVICE_READ,SERVICE_WRITE,runtimeCheck,checkGenerated} from '../php-classes.mjs';
const git=process.env.R45_GIT??'C:/Program Files/Git/cmd/git.exe',wt=process.env.R45_REPO??'C:/t/r5/wt-capacity';
const argv=process.argv.slice(2),opt=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:undefined;};
const SHA=/^[0-9a-f]{64}$/;
const baseRaw=opt('--base-raw');if(!SHA.test(baseRaw??''))throw new Error('--base-raw <sha256 of the stored r45 compose>');
const out=opt('--out');if(!out)throw new Error('--out <dir>');
const baseFile=opt('--base-file'),c6File=opt('--c6-file');
if(!!baseFile!==!!c6File)throw new Error('--base-file and --c6-file go together (tests only)');
const files=!!baseFile,baseArg=opt('--base'),pinArg=opt('--pin');
if(!files&&(!baseArg||!pinArg))throw new Error('--base <rev> --pin <rev>');
const AFTER=opt('--after')??'unknown-run-the-dry-run-first';
if(AFTER!=='unknown-run-the-dry-run-first'&&!SHA.test(AFTER))throw new Error('--after <sha256>');
const g=(...a)=>cp.execFileSync(git,['-C',wt,...a],{encoding:'utf8',maxBuffer:64<<20});
const short=rev=>files?'file':g('rev-parse','--short',rev+'^{commit}').trim();
const composeOf=rev=>g('show',rev+':server/deploy/coolify/compose.coolify.yml');
const baseText=files?fs.readFileSync(baseFile,'utf8'):composeOf(baseArg),newText=files?fs.readFileSync(c6File,'utf8'):composeOf(pinArg);
const baseShort=short(baseArg),pinShort=short(pinArg);
const cb=baseText.replace(/^#.*\n/,''),cn=newText.replace(/^#.*\n/,'');
const CB=JSON.parse(cb),CN=JSON.parse(cn);
const MARK=`r45h-${pinShort}`;
const RETIER=/^\/services\/(ssam-server-v[1-9]\/(deploy\/resources\/limits\/(cpus|memory)|environment\/(SSAM_BUILD_WORKERS|SSAM_O11_WORKERS_MAX|SSAM_BUILD_QUEUE_MS)|labels\/ssam\.sizing|cpu_shares)|ssam-router\/(deploy\/resources\/limits\/(cpus|memory)|labels\/ssam\.sizing))$/;
const isMap=x=>x&&typeof x==='object'&&!Array.isArray(x);
const diff=(x,y,p='',o=[])=>{if(isMap(x)&&isMap(y)){for(const k of new Set([...Object.keys(x),...Object.keys(y)])){if(!(k in x))o.push(p+'/'+k+' (added)');else if(!(k in y))o.push(p+'/'+k+' (removed)');else diff(x[k],y[k],p+'/'+k,o);}return o;}if(JSON.stringify(x)!==JSON.stringify(y))o.push(p);return o;};
const get=(o,p)=>p.split('/').slice(1).reduce((n,k)=>n?.[k],o);
// Both composes are sized, with exactly one hot backend; the same services.
const backends=c=>Object.entries(c.services).filter(([,s])=>s.labels?.['ssam.backend']==='true');
const hotOf=(c,what)=>{const h=backends(c).filter(([,s])=>s.labels['ssam.sizing']==='hot').map(([n])=>n);
 if(typeof c.services['ssam-router']?.labels?.['ssam.sizing']!=='string')throw new Error(what+' is not sized (no ssam.sizing on the router)');
 if(h.length!==1)throw new Error(what+' has '+h.length+' hot backends, not one');
 for(const [n,s] of backends(c))if(!['hot','other'].includes(s.labels['ssam.sizing']))throw new Error(what+' '+n+' has no tier label');return h[0];};
const HOT_FROM=hotOf(CB,'the base compose'),HOT_TO=hotOf(CN,'the new compose');
if(JSON.stringify(Object.keys(CB.services))!==JSON.stringify(Object.keys(CN.services)))throw new Error('the services of the base and the new compose differ');
const delta=diff(CB,CN);
// Revision 2: environment keys added to the backends.
const ENV_ADD=/^\/services\/(ssam-server-v[1-9])\/environment\/([A-Za-z_][A-Za-z0-9_]*) \(added\)$/;
const ENV_FORBIDDEN=/^(SSAM_BUILD_WORKERS|SSAM_O11_WORKERS_MAX|SSAM_BUILD_QUEUE_MS|SSAM_CODE_CHECKS|SSAM_CODE_CHECKS_PER_CUSTOMER|SSAM_SERVED_VERSIONS|SSAM_CPUS|SSAM_MEMORY|SSAM_DATABASE_URL|SSAM_(HOT|OTHER|ROUTER)_.*)$/;
// Revision 3: tier keys (added, changed or removed), the field of the tier in the router label they mirror.
const TIER_KEY=/^\/services\/(ssam-server-v[1-9])\/environment\/(SSAM_CODE_CHECKS|SSAM_CODE_CHECKS_PER_CUSTOMER)( \((added|removed)\))?$/;
const TIER_KEY_FIELD={SSAM_CODE_CHECKS:'codeChecks',SSAM_CODE_CHECKS_PER_CUSTOMER:'codeChecksPerCustomer'};
const TIER_KEY_VALUE=/^([1-9]|1[0-6])$/;
// Revision 4: images (the pair images built from a signed main, IMAGENS.md 12-13). The image of a service and, for a backend,
// its ssam.image.digest label: same repository, another tag; a backend's image and digest move together (a 64-hex sha256);
// a service that is not a backend (router, console, admin, ops) runs the image of the default backend of the new compose
// (gen-compose). Any subset of the services may move (one backend first: the canary). Nothing else about a service moves
// with it: volumes, networks, served list and every other path stay the other classes' rules.
const IMAGE_PATH=/^\/services\/(ssam-[a-z0-9-]+)\/image$/,DIGEST_PATH=/^\/services\/(ssam-server-v[1-9])\/labels\/ssam\.image\.digest$/;
const imagePaths=delta.filter(p=>IMAGE_PATH.test(p)||DIGEST_PATH.test(p));
const IMAGES={};
if(imagePaths.length){
 const repoOf=i=>typeof i==='string'&&/^[a-z0-9.\/-]+:[A-Za-z0-9_.-]+$/.test(i)?i.slice(0,i.lastIndexOf(':')):null;
 const def=backends(CN).filter(([,s])=>s.labels?.['ssam.default']==='true');
 if(def.length!==1)throw new Error('images: the new compose has '+def.length+' default backends, not one');
 for(const p of imagePaths){
  const svc=(p.match(IMAGE_PATH)??p.match(DIGEST_PATH))[1],b=CB.services[svc],n=CN.services[svc],backend=n.labels?.['ssam.backend']==='true';
  if(IMAGES[svc])continue;
  if(!repoOf(n.image)||repoOf(n.image)!==repoOf(b.image))throw new Error(`images: ${svc} moves to ${n.image}, not another tag of ${b.image}`);
  if(n.image===b.image)throw new Error(`images: ${svc} changes its digest but keeps the tag ${n.image}`);
  if(backend){
   const d=n.labels['ssam.image.digest'];
   if(!/^sha256:[0-9a-f]{64}$/.test(d??''))throw new Error(`images: ${svc} digest label is not sha256:<64 hex>`);
   if(d===b.labels['ssam.image.digest'])throw new Error(`images: ${svc} moves to ${n.image} with the old digest`);
   IMAGES[svc]={from:b.image,to:n.image,digestFrom:b.labels['ssam.image.digest'],digestTo:d};
  }else{
   if(n.image!==def[0][1].image)throw new Error(`images: ${svc} runs ${n.image}, not the image of the default backend ${def[0][0]} (${def[0][1].image})`);
   IMAGES[svc]={from:b.image,to:n.image,digestFrom:null,digestTo:null};
  }
 }
 for(const [svc,i] of Object.entries(IMAGES))for(const p of [`/services/${svc}/image`,...(i.digestTo?[`/services/${svc}/labels/ssam.image.digest`]:[])])
  if(!delta.includes(p))throw new Error(`images: ${p} does not move with the rest of ${svc}`);
 // Review C A4: the services on the default backend's image (router, console, admin, ops: gen-compose gives them that image)
 // move with it, every one: a canary is never the default backend, and a hand-edited compose cannot move half of them.
 // (One of them moving without the default backend is already refused above: it would not run the default's image.)
 const defName=def[0][0],left=Object.entries(CB.services).filter(([s,x])=>x.labels?.['ssam.backend']!=='true'&&x.image===CB.services[defName].image&&!IMAGES[s]).map(([s])=>s);
 if(IMAGES[defName]&&left.length)throw new Error(`images: the default backend ${defName} moves, so ${left.join(', ')} (on its image) must move with it: a canary is never the default backend`);
}
// Review C A3: whether this kit moves images is said on the command line (retier-kit.mjs --images, required there), never
// only deduced from the delta: a tier kit regenerated from a pin that already carries new images is refused here.
const imagesArg=opt('--images');
if(imagesArg!==undefined){
 const want=imagesArg==='none'||imagesArg===''?[]:[...new Set(imagesArg.split(','))].sort(),got=Object.keys(IMAGES).sort();
 if(want.join()!==got.join())throw new Error(`images: --images ${imagesArg} but the base->new delta moves ${got.join(',')||'none'}`);
}
const foreign=delta.filter(p=>!RETIER.test(p)&&!ENV_ADD.test(p)&&!TIER_KEY.test(p)&&!IMAGE_PATH.test(p)&&!DIGEST_PATH.test(p));
if(foreign.length)throw new Error('base->new delta outside the tier paths and the added backend environment keys: '+foreign.join(', '));
const added=delta.filter(p=>ENV_ADD.test(p)&&!TIER_KEY.test(p)).map(p=>{const [,svc,key]=p.match(ENV_ADD);return {p,svc,key};});
const tierKeyPaths=delta.filter(p=>TIER_KEY.test(p));
const TIER_KEYS={};
{
 // Always (it only refuses, it writes nothing): a label that gains a field with no backend key is refused too.
 const sizing=JSON.parse(CN.services['ssam-router'].labels['ssam.sizing']);
 for(const p of tierKeyPaths){const [,svc]=p.match(TIER_KEY);if(CN.services[svc]?.labels?.['ssam.backend']!=='true')throw new Error(`tier key ${p} is not on a backend`);}
 // Every backend of the new compose: the key exactly when its tier's label names the field, with that value.
 for(const [n,s] of backends(CN))for(const [k,f] of Object.entries(TIER_KEY_FIELD)){
  const want=sizing[s.labels['ssam.sizing']]?.[f],has=s.environment?.[k];
  if(want===undefined){if(has!==undefined)throw new Error(`tier key ${k} on ${n} (${s.labels['ssam.sizing']}) but the router label has no ${s.labels['ssam.sizing']}.${f}: remove it, or name the field`);continue;}
  if(!Number.isInteger(want)||!TIER_KEY_VALUE.test(String(want)))throw new Error(`the router label's ${s.labels['ssam.sizing']}.${f} is not an integer 1..16`);
  if(has===undefined)throw new Error(`tier key ${k} missing on ${n} (${s.labels['ssam.sizing']}), whose tier names ${f} ${want}`);
  if(typeof has!=='string'||!TIER_KEY_VALUE.test(has))throw new Error(`tier key ${k} on ${n} is not a literal 1..16`);
  if(has!==String(want))throw new Error(`tier key ${k} on ${n} (${s.labels['ssam.sizing']}) is ${has}, the router label's ${s.labels['ssam.sizing']}.${f} is ${want}`);
 }
 for(const p of tierKeyPaths){const q=p.replace(/ \((added|removed)\)$/,'');TIER_KEYS[q]=p.endsWith(' (removed)')?null:get(CN,q);}
}
const envKeysArg=opt('--env-keys');
const ENV_KEYS=envKeysArg===undefined?[...new Set(added.map(a=>a.key))].sort():envKeysArg==='none'||envKeysArg===''?[]:[...new Set(envKeysArg.split(','))].sort();
for(const k of ENV_KEYS)if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))throw new Error('--env-keys: not a variable name: '+k);
const backendNames=backends(CN).map(([n])=>n);
const ENV_VALUES={};
for(const a of added)if(!ENV_KEYS.includes(a.key))throw new Error(`environment key ${a.key} added to ${a.svc} is not in the list (${ENV_KEYS.join(',')||'none'})`);
for(const k of ENV_KEYS){
 if(ENV_FORBIDDEN.test(k))throw new Error(`environment key ${k} is a tier, pool, served-list or tier-variable name: never added by the retier`);
 const missing=backendNames.filter(b=>!added.some(a=>a.key===k&&a.svc===b));
 if(missing.length)throw new Error(`environment key ${k} is not added to every backend (missing in ${missing.join(', ')})`);
 const vals=new Set(backendNames.map(b=>CN.services[b].environment[k]));
 if(vals.size!==1)throw new Error(`environment key ${k} has another value in some backend: one value for all is required`);
 const v=[...vals][0],m=typeof v==='string'&&v.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*):-([A-Za-z0-9._,:\/-]*)\}$/);
 if(!m||m[1]!==k)throw new Error(`environment key ${k} is not \${${k}:-default} with a plain default`);
 ENV_VALUES[k]={value:v,default:m[2]};
}
const envPaths=added.map(a=>a.p),tierPaths=delta.filter(p=>!envPaths.includes(p)&&!imagePaths.includes(p));
if(!delta.includes('/services/ssam-router/labels/ssam.sizing')&&!imagePaths.length)throw new Error('the router sizing label does not change: nothing to retier');
for(const p of delta){const v=get(CN,p);if(typeof v==='string'&&v.includes('${')&&p!=='/services/ssam-router/labels/ssam.sizing')throw new Error('a sized value is not literal: '+p);}
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const ROUTER_SIZING_SHA=sha(CN.services['ssam-router'].labels['ssam.sizing']),BASE_ROUTER_SIZING_SHA=sha(CB.services['ssam-router'].labels['ssam.sizing']);
const b64=s=>Buffer.from(s).toString('base64');
const boot=`require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(${CLASSES.kernel}::class)->bootstrap();
function stop($m) { fwrite(STDERR, "STOP: $m\\n"); exit(2); }`;
const php=`<?php
// deploy-retier.php (r45 retier, generated by r45/retier/gen-retier-php.mjs from the base ${baseShort} and the pin ${pinShort}).
// Moves the capacity tiers of the stored r45 compose to the pin's (hot ${HOT_FROM} -> ${HOT_TO}).
// Default: DRY RUN, read-only. Writes only with SSAM_RELEASE_APPLY=${MARK}. Prints key paths, hashes and tiers, never a value.
${boot}
const UUID = 'ksqommjgowjjilpgpbmf7cdo';
const BASE_RAW_SHA256 = '${baseRaw}';
const EXPECTED_AFTER_RAW_SHA256 = '${AFTER}';
const HOT_TO = '${HOT_TO}';
const ROUTER_SIZING_SHA256 = '${ROUTER_SIZING_SHA}';
$apply = getenv('SSAM_RELEASE_APPLY') === '${MARK}';
${runtimeCheck([...SERVICE_READ, ...SERVICE_WRITE, [CLASSES.yaml, 'parse']])}
$CB = json_decode(base64_decode('${b64(cb)}'), false, 512, JSON_THROW_ON_ERROR);
$CN = json_decode(base64_decode('${b64(cn)}'), false, 512, JSON_THROW_ON_ERROR);
// The paths where production differs from the committed compose (the r44 list, v5 included; the r45 release kept them).
$PRODUCTION_ONLY = ['/networks/coolify','/services/ssam-admin/networks/coolify','/services/ssam-console/environment/CONSOLE_GITHUB_CLIENT_ID',
 '/services/ssam-console/environment/CONSOLE_GITHUB_CLIENT_SECRET','/services/ssam-console/environment/CONSOLE_SESSION_SECRET',
 '/services/ssam-console/environment/CONSOLE_TOKEN_MODULE','/services/ssam-console/networks/coolify','/services/ssam-ops/networks',
 '/services/ssam-router/environment/SSAM_DATABASE_URL','/services/ssam-router/labels/traefik.http.routers.ssam.rule',
 '/services/ssam-router/labels/traefik.http.routers.ssam-http.rule','/services/ssam-router/labels/traefik.http.routers.ssam-console.rule',
 '/services/ssam-router/labels/traefik.http.routers.ssam-console-http.rule','/services/ssam-router/networks/coolify'];
foreach (['v1','v2','v3','v4','v5'] as $v) { $PRODUCTION_ONLY[] = "/services/ssam-server-$v/environment/SSAM_DATABASE_URL"; $PRODUCTION_ONLY[] = "/services/ssam-server-$v/networks/coolify"; }
// The base->new delta, exactly (anything else is refused): tier values of the backends and the router.
$EXPECTED_DELTA = json_decode(base64_decode('${b64(JSON.stringify(delta))}'), true, 512, JSON_THROW_ON_ERROR);
// Revision 2: environment keys ADDED to every backend (names ENV_KEYS), path => the pin's exact text \${KEY:-default}.
const ENV_KEYS = ${JSON.stringify(ENV_KEYS).replace(/"/g,"'")};
$ENV_ADDED = json_decode(base64_decode('${b64(JSON.stringify(Object.fromEntries(envPaths.map(p=>[p.replace(/ \(added\)$/,''),ENV_VALUES[p.match(ENV_ADD)[2]].value]))))}'), true, 512, JSON_THROW_ON_ERROR);
function isMap($x) { return is_object($x); }
function same($a, $b) { return json_encode($a) === json_encode($b); }
function diff($a, $b, $p = '', &$out = []) {
  if (isMap($a) && isMap($b)) {
    $keys = array_unique(array_merge(array_keys(get_object_vars($a)), array_keys(get_object_vars($b))));
    foreach ($keys as $k) {
      $ia = property_exists($a, $k); $ib = property_exists($b, $k);
      if (!$ia) $out[] = "$p/$k (added)"; elseif (!$ib) $out[] = "$p/$k (removed)"; else diff($a->$k, $b->$k, "$p/$k", $out);
    }
    return $out;
  }
  if (!same($a, $b)) $out[] = $p;
  return $out;
}
function strip($path) { return preg_replace('/ \\((added|removed)\\)$/', '', $path); }
function get($root, $path) { $n = $root; foreach (array_slice(explode('/', $path), 1) as $k) { if (!isMap($n) || !property_exists($n, $k)) return null; $n = $n->$k; } return $n; }
function put(&$root, $path, $value) { $parts = array_slice(explode('/', $path), 1); $last = array_pop($parts); $node = &$root; foreach ($parts as $k) { if (!isMap($node) || !property_exists($node, $k)) stop("missing parent of $path"); $node = &$node->$k; } if (!isMap($node) || !property_exists($node, $last)) stop("missing $path"); $node->$last = $value; }
function add(&$root, $path, $value) { $parts = array_slice(explode('/', $path), 1); $last = array_pop($parts); $node = &$root; foreach ($parts as $k) { if (!isMap($node) || !property_exists($node, $k)) stop("missing parent of $path"); $node = &$node->$k; } if (!isMap($node) || property_exists($node, $last)) stop("$path already exists in production: not added"); $node->$last = $value; }
function deep($x) { return json_decode(json_encode($x), false, 512, JSON_THROW_ON_ERROR); }
function fmt($x) {
  $j = json_encode($x, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR);
  return preg_replace_callback('/^((?:    )+)/m', fn($m) => str_repeat(' ', strlen($m[1]) / 2), $j);
}
$s = ${CLASSES.service}::where('uuid', UUID)->sole();
$raw = $s->docker_compose_raw;
$before = hash('sha256', $raw);
if ($before !== BASE_RAW_SHA256) stop("the stored compose is not the r45 one this kit starts from (sha256 $before)");
$nl = strpos($raw, "\\n"); $first = substr($raw, 0, $nl); $body = substr($raw, $nl + 1);
if (!str_starts_with($first, '#')) stop('the stored compose has no comment line');
if (!str_ends_with($body, "\\n")) stop('the stored compose has no final newline');
$P = json_decode($body, false, 512, JSON_THROW_ON_ERROR);
if (fmt($P) . "\\n" !== $body) stop('the formatter does not reproduce the stored compose byte for byte; nothing written');
// 1. production = the committed base compose except the known production-only paths.
$prod = diff($CB, $P);
$unknown = array_values(array_diff(array_map('strip', $prod), $PRODUCTION_ONLY));
if ($unknown) stop('production differs from the committed base compose outside the known paths: ' . implode(', ', $unknown));
// 2. the retier delta is exactly the recorded tier paths (none added or removed).
$delta = diff($CB, $CN);
if ($delta !== $EXPECTED_DELTA) stop('the retier delta is not exactly the recorded tier paths: ' . implode(', ', $delta));
$envSvcs = [];
foreach ($delta as $path) {
  if ($path === strip($path)) continue;
  $p = strip($path);
  if (!str_ends_with($path, ' (added)') || !array_key_exists($p, $ENV_ADDED)) stop("the retier adds or removes $path");
  if (!preg_match('#^/services/(ssam-server-v[1-9])/environment/([A-Za-z_][A-Za-z0-9_]*)$#', $p, $m) || !in_array($m[2], ENV_KEYS, true)) stop("$path is not an environment key of the list");
  if (($CN->services->{$m[1]}->labels->{'ssam.backend'} ?? null) !== 'true') stop("$path is not on a backend");
  $v = get($CN, $p);
  if (!is_string($v) || $v !== $ENV_ADDED[$p] || !preg_match('/^\\$\\{' . $m[2] . ':-[A-Za-z0-9._,:\\/-]*\\}$/', $v)) stop("$path is not the recorded \\\${KEY:-default} text");
  $envSvcs[$m[1]] = true;
}
if (count($ENV_ADDED) !== count(array_filter($delta, fn($x) => str_ends_with($x, ' (added)')))) stop('the added environment keys are not exactly the recorded ones');
foreach ($CN->services as $name => $svc) if (($svc->labels->{'ssam.backend'} ?? null) === 'true') foreach (ENV_KEYS as $k) if (!array_key_exists("/services/$name/environment/$k", $ENV_ADDED)) stop("$k is not added to $name");
// 3. apply it onto production (tier values replaced; environment keys added, in the order the pin lists them).
$R = deep($P);
foreach ($delta as $path) { if ($path === strip($path)) put($R, $path, deep(get($CN, $path))); else add($R, strip($path), $ENV_ADDED[strip($path)]); }
foreach (array_keys($envSvcs) as $name) {
  $e = $R->services->$name->environment; $o = new \\stdClass();
  foreach (array_keys(get_object_vars($CN->services->$name->environment)) as $k) if (property_exists($e, $k)) $o->$k = $e->$k;
  foreach (get_object_vars($e) as $k => $v) if (!property_exists($o, $k)) $o->$k = $v;
  $R->services->$name->environment = $o;
}
foreach ($ENV_ADDED as $p => $v) if (get($R, $p) !== $v) stop("$p is not the pin's text after the apply");
// 4. verify the result both ways; no image, digest, volume, network or served list moved; every sized value literal.
$vsCN = array_values(array_diff(array_map('strip', diff($CN, $R)), $PRODUCTION_ONLY));
if ($vsCN) stop('the result differs from the new compose outside the production-only paths: ' . implode(', ', $vsCN));
$change = diff($P, $R);
$sorted = function ($x) { sort($x); return $x; };
if ($sorted($change) !== $sorted($EXPECTED_DELTA)) stop('the change to production is not exactly the tier paths: ' . implode(', ', $change));
$tiers = [];
foreach ($R->services as $name => $svc) {
  $was = $P->services->$name;
  foreach (['volumes','networks','image'] as $k) if (!same($svc->$k ?? null, $was->$k ?? null)) stop("$name $k changed");
  if (!same($svc->environment->SSAM_SERVED_VERSIONS ?? null, $was->environment->SSAM_SERVED_VERSIONS ?? null)) stop("$name served list changed");
  if (!same($svc->labels->{'ssam.image.digest'} ?? null, $was->labels->{'ssam.image.digest'} ?? null)) stop("$name digest changed");
  if (($svc->labels->{'ssam.backend'} ?? null) === 'true') {
    $l = $svc->deploy->resources->limits;
    foreach ([$l->cpus, $l->memory, $svc->environment->SSAM_BUILD_WORKERS, $svc->environment->SSAM_O11_WORKERS_MAX, $svc->environment->SSAM_BUILD_QUEUE_MS] as $v) if (!is_string($v) || str_contains($v, '\${')) stop("$name has a sized value that is not literal");
    $tiers[$name] = ['tier' => $svc->labels->{'ssam.sizing'} ?? null, 'was' => $was->labels->{'ssam.sizing'} ?? null, 'cpus' => $l->cpus, 'memory' => $l->memory, 'cpu_shares' => $svc->cpu_shares ?? null, 'buildWorkers' => $svc->environment->SSAM_BUILD_WORKERS, 'o11WorkersMax' => $svc->environment->SSAM_O11_WORKERS_MAX];
  }
}
$hot = array_keys(array_filter($tiers, fn($t) => $t['tier'] === 'hot'));
if ($hot !== [HOT_TO]) stop('the hot backend is not ' . HOT_TO . ': ' . implode(',', $hot));
$label = $R->services->{'ssam-router'}->labels->{'ssam.sizing'};
if (hash('sha256', $label) !== ROUTER_SIZING_SHA256) stop('the router sizing label is not the new one');
$sizing = json_decode($label, true, 512, JSON_THROW_ON_ERROR);
$next = $first . "\\n" . fmt($R) . "\\n";
if (${CLASSES.yaml}::parse($next) != json_decode(fmt($R), true)) stop('the new compose does not parse as YAML to the same document');
$after = hash('sha256', $next);
$report = ['mode' => $apply ? 'apply' : 'dry-run', 'kind' => 'retier', 'uuid' => UUID, 'beforeRawSha256' => $before, 'afterRawSha256' => $after, 'expectedAfterRawSha256' => EXPECTED_AFTER_RAW_SHA256,
  'bytes' => [strlen($raw), strlen($next)], 'productionOnlyPathsKept' => count($prod), 'changedPaths' => count($change), 'tierPaths' => count($change) - count($ENV_ADDED), 'envAddedPaths' => count($ENV_ADDED),
  'envAddedKeys' => implode(',', ENV_KEYS), 'envAddedBackends' => count($envSvcs), 'hot' => ['from' => '${HOT_FROM}', 'to' => HOT_TO], 'tiers' => $tiers,
  'router' => ['cpus' => $R->services->{'ssam-router'}->deploy->resources->limits->cpus, 'memory' => $R->services->{'ssam-router'}->deploy->resources->limits->memory],
  'hotPair' => $sizing['hotPair'] ?? null, 'usage' => $sizing['usage'] ?? null, 'imagesChanged' => []];
if (!$apply) { echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\\n"; exit(0); }
if ($after !== EXPECTED_AFTER_RAW_SHA256) stop("the computed compose is not the reviewed one (sha256 $after)");
// APPLY: the stored compose before, for rollback (holds secrets: written only inside this container, 0600).
$saved = ['uuid' => UUID, 'docker_compose_raw' => $raw, 'beforeRawSha256' => $before, 'releaseRawSha256' => $after, 'at' => gmdate('c')];
$file = '/tmp/ssam-r45h-coolify-before.json';
umask(077); if (file_put_contents($file, json_encode($saved, JSON_UNESCAPED_SLASHES)) === false) stop('could not save the rollback copy');
chmod($file, 0600);
$s->docker_compose_raw = $next; $s->save();
$s = ${CLASSES.service}::where('uuid', UUID)->sole();
if (hash('sha256', $s->docker_compose_raw) !== $after) stop('the saved compose is not the computed one');
echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\\n";
`;
// Revision 3: the tier-key parts of deploy-retier.php, patched into the text above ONLY when the delta has a tier key
// (each needle must be there exactly once), so a kit without tier keys is byte for byte the one of revision 2.
let phpOut=php;
if(tierKeyPaths.length){
 const once=(needle,repl)=>{const n=phpOut.split(needle).length-1;if(n!==1)throw new Error(`tier keys: the PHP needle is there ${n} times, not once: ${needle}`);phpOut=phpOut.replace(needle,()=>repl);};
 once(`\nfunction isMap($x)`,`
// Revision 3: tier keys (SSAM_CODE_CHECKS, SSAM_CODE_CHECKS_PER_CUSTOMER) added, changed or removed on the backends, path =>
// the pin's literal value (null: removed); each must be the field of the backend's tier in the router label.
$TIER_KEYS = json_decode(base64_decode('${b64(JSON.stringify(TIER_KEYS))}'), true, 512, JSON_THROW_ON_ERROR);
const TIER_KEY_FIELDS = ['SSAM_CODE_CHECKS' => 'codeChecks', 'SSAM_CODE_CHECKS_PER_CUSTOMER' => 'codeChecksPerCustomer'];
function isMap($x)`);
 once(`\nfunction deep($x)`,`
function del(&$root, $path) { $parts = array_slice(explode('/', $path), 1); $last = array_pop($parts); $node = &$root; foreach ($parts as $k) { if (!isMap($node) || !property_exists($node, $k)) stop("missing parent of $path"); $node = &$node->$k; } if (!isMap($node) || !property_exists($node, $last)) stop("missing $path"); unset($node->$last); }
function deep($x)`);
 once(`$envSvcs = [];\n`,`$envSvcs = []; $tierSvcs = [];\n`);
 once(`  $p = strip($path);\n`,`  $p = strip($path);
  if (array_key_exists($p, $TIER_KEYS)) {
    if (!preg_match('#^/services/(ssam-server-v[1-9])/environment/(SSAM_CODE_CHECKS|SSAM_CODE_CHECKS_PER_CUSTOMER)$#', $p, $m) || ($CN->services->{$m[1]}->labels->{'ssam.backend'} ?? null) !== 'true') stop("$path is not a tier key of a backend");
    if (str_ends_with($path, ' (removed)') !== ($TIER_KEYS[$p] === null)) stop("$path is not the recorded tier key change");
    $tierSvcs[$m[1]] = true; continue;
  }
`);
 once(`if (count($ENV_ADDED) !== count(array_filter($delta, fn($x) => str_ends_with($x, ' (added)'))))`,`if (count($ENV_ADDED) !== count(array_filter($delta, fn($x) => str_ends_with($x, ' (added)') && !array_key_exists(strip($x), $TIER_KEYS))))`);
 once(`else add($R, strip($path), $ENV_ADDED[strip($path)]); }`,`elseif (array_key_exists(strip($path), $TIER_KEYS)) { if ($TIER_KEYS[strip($path)] === null) del($R, strip($path)); else add($R, strip($path), $TIER_KEYS[strip($path)]); } else add($R, strip($path), $ENV_ADDED[strip($path)]); }`);
 once(`foreach (array_keys($envSvcs) as $name) {`,`foreach (array_keys($envSvcs + $tierSvcs) as $name) {`);
 once(`foreach ($ENV_ADDED as $p => $v) if (get($R, $p) !== $v) stop("$p is not the pin's text after the apply");\n`,`foreach ($ENV_ADDED as $p => $v) if (get($R, $p) !== $v) stop("$p is not the pin's text after the apply");
// Every backend carries each tier key exactly when its tier in the router label names the field, with that literal value.
$sz = json_decode($R->services->{'ssam-router'}->labels->{'ssam.sizing'}, true, 512, JSON_THROW_ON_ERROR);
foreach ($R->services as $name => $svc) if (($svc->labels->{'ssam.backend'} ?? null) === 'true') foreach (TIER_KEY_FIELDS as $k => $f) {
  $want = $sz[$svc->labels->{'ssam.sizing'} ?? ''][$f] ?? null; $has = $svc->environment->$k ?? null;
  if ($want === null ? $has !== null : (!is_string($has) || !preg_match('/^([1-9]|1[0-6])$/', $has) || $has !== (string)$want)) stop("$name $k is not the value of its tier in the router label");
}
`);
 once(`'envAddedKeys' => implode(',', ENV_KEYS),`,`'envAddedKeys' => implode(',', ENV_KEYS), 'tierKeyPaths' => count($TIER_KEYS),`);
}
// Revision 4: the image parts, patched in ONLY when the delta moves an image (each needle exactly once), so a kit without
// images is byte for byte the one of revisions 2 and 3. The image and digest paths are plain value paths of the delta (put),
// already held to the recorded delta both ways; here each service may move only to the recorded image and digest.
if(imagePaths.length){
 const once=(needle,repl)=>{const n=phpOut.split(needle).length-1;if(n!==1)throw new Error(`images: the PHP needle is there ${n} times, not once: ${needle}`);phpOut=phpOut.replace(needle,()=>repl);};
 once(`\nfunction isMap($x)`,`
// Revision 4: the services whose image moves, service => {from, to, digestFrom, digestTo} (digests only for the backends).
$IMAGES = json_decode(base64_decode('${b64(JSON.stringify(IMAGES))}'), true, 512, JSON_THROW_ON_ERROR);
const IMAGE_PATH_COUNT = ${imagePaths.length};
function isMap($x)`);
 once(`$tiers = [];\n`,`$tiers = []; $imagesChanged = [];\n`);
 once(`  foreach (['volumes','networks','image'] as $k) if (!same($svc->$k ?? null, $was->$k ?? null)) stop("$name $k changed");\n`,`  foreach (['volumes','networks'] as $k) if (!same($svc->$k ?? null, $was->$k ?? null)) stop("$name $k changed");
  $img = $IMAGES[$name] ?? null;
  if ($img === null) { if (!same($svc->image ?? null, $was->image ?? null)) stop("$name image changed"); }
  elseif (($was->image ?? null) !== $img['from'] || ($svc->image ?? null) !== $img['to']) stop("$name image is not the recorded move");
  else $imagesChanged[$name] = ['from' => $img['from'], 'to' => $img['to'], 'digest' => $img['digestTo']];
`);
 once(`  if (!same($svc->labels->{'ssam.image.digest'} ?? null, $was->labels->{'ssam.image.digest'} ?? null)) stop("$name digest changed");\n`,`  if ($img === null || $img['digestTo'] === null) { if (!same($svc->labels->{'ssam.image.digest'} ?? null, $was->labels->{'ssam.image.digest'} ?? null)) stop("$name digest changed"); }
  elseif (($was->labels->{'ssam.image.digest'} ?? null) !== $img['digestFrom'] || ($svc->labels->{'ssam.image.digest'} ?? null) !== $img['digestTo']) stop("$name digest is not the recorded move");
`);
 once(`if ($hot !== [HOT_TO])`,`if (count($imagesChanged) !== count($IMAGES)) stop('not every recorded image moved');
if ($hot !== [HOT_TO])`);
 // imagePaths after envAddedPaths: retier-window.sh dry_keys greps "changedPaths","tierPaths","envAddedPaths" side by side.
 once(`'tierPaths' => count($change) - count($ENV_ADDED), 'envAddedPaths' => count($ENV_ADDED),`,`'tierPaths' => count($change) - count($ENV_ADDED) - IMAGE_PATH_COUNT, 'envAddedPaths' => count($ENV_ADDED), 'imagePaths' => IMAGE_PATH_COUNT,`);
 // imageNames: retier-window.sh holds it to IMAGES of kit.env (review C A3); only image kits carry it.
 once(`'imagesChanged' => []];`,`'imagesChanged' => $imagesChanged, 'imageNames' => implode(',', array_keys($imagesChanged))];`);
}
const rollback=`<?php
// rollback-retier.php (r45 retier): puts back the stored r45 compose saved before the retier (the export of the window,
// copied into the container as /tmp/ssam-r45h-coolify-before.json, or the apply's own copy). Default: CHECK only
// (read-only). Writes only with SSAM_RELEASE_ROLLBACK=${MARK}; the Redeploy is pressed in Coolify afterwards.
${boot}
${runtimeCheck([...SERVICE_READ, [CLASSES.service, 'save']])}
$go = getenv('SSAM_RELEASE_ROLLBACK') === '${MARK}';
$s = ${CLASSES.service}::where('uuid', 'ksqommjgowjjilpgpbmf7cdo')->sole();
$now = hash('sha256', $s->docker_compose_raw);
$file = '/tmp/ssam-r45h-coolify-before.json';
if (!is_file($file)) { echo json_encode(['mode' => 'check', 'saved' => false, 'currentRawSha256' => $now, 'isBase' => $now === '${baseRaw}', 'isRelease' => $now === '${AFTER}']), "\\n"; if ($go) stop('no saved compose in this container'); exit(0); }
$saved = json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
if ($saved['uuid'] !== 'ksqommjgowjjilpgpbmf7cdo' || hash('sha256', $saved['docker_compose_raw']) !== $saved['beforeRawSha256'] || $saved['beforeRawSha256'] !== '${baseRaw}' || $saved['releaseRawSha256'] !== '${AFTER}') stop('wrong or damaged rollback copy');
if ($now !== $saved['releaseRawSha256'] && $now !== $saved['beforeRawSha256']) stop('the compose changed after the retier; review before rollback');
$report = ['mode' => $go ? 'rollback' : 'check', 'saved' => true, 'currentRawSha256' => $now, 'restoresRawSha256' => $saved['beforeRawSha256']];
if (!$go) { echo json_encode($report), "\\n"; exit(0); }
$s->docker_compose_raw = $saved['docker_compose_raw']; $s->save();
$s = ${CLASSES.service}::where('uuid', 'ksqommjgowjjilpgpbmf7cdo')->sole();
if (hash('sha256', $s->docker_compose_raw) !== $saved['beforeRawSha256']) stop('the restored compose is not the saved one');
echo json_encode($report), "\\n";
`;
const exportRaw=`<?php
// export-retier-raw.php (r45 retier): READ-ONLY. Prints the rollback copy of the stored compose (the format
// rollback-retier.php reads) only when it is the r45 compose this kit starts from. Holds secrets: the caller writes it
// 0600 and never prints it.
${boot}
${runtimeCheck(SERVICE_READ)}
$s = ${CLASSES.service}::where('uuid', 'ksqommjgowjjilpgpbmf7cdo')->sole();
$raw = $s->docker_compose_raw; $before = hash('sha256', $raw);
if ($before !== '${baseRaw}') stop("the stored compose is not the r45 one this kit starts from (sha256 $before)");
echo json_encode(['uuid' => 'ksqommjgowjjilpgpbmf7cdo', 'docker_compose_raw' => $raw, 'beforeRawSha256' => $before, 'releaseRawSha256' => '${AFTER}', 'at' => gmdate('c'), 'source' => 'export-retier-raw.php'], JSON_UNESCAPED_SLASHES), "\\n";
`;
// read-labels.php: the same read-only proof as the r45 kit's (router ssam.sizing, each backend's tier, limits and pools).
const labels=`<?php
// read-labels.php (r45 retier): READ-ONLY. Prints the router's ssam.sizing label and each backend's tier, limits, cpu_shares
// and pool sizes from the stored compose; nothing else (no environment value besides the pools, no secret).
${boot}
${runtimeCheck(SERVICE_READ)}
$s = ${CLASSES.service}::where('uuid', 'ksqommjgowjjilpgpbmf7cdo')->sole();
$raw = $s->docker_compose_raw; $nl = strpos($raw, "\\n");
$P = json_decode(substr($raw, $nl + 1), false, 512, JSON_THROW_ON_ERROR);
$out = ['rawSha256' => hash('sha256', $raw), 'routerSizing' => $P->services->{'ssam-router'}->labels->{'ssam.sizing'} ?? null, 'backends' => []];
foreach ($P->services as $name => $svc) if (($svc->labels->{'ssam.backend'} ?? null) === 'true') $out['backends'][$name] = ['odc' => $svc->labels->{'ssam.odc'}, 'o11' => $svc->labels->{'ssam.o11'},
  'image' => $svc->image, 'tier' => $svc->labels->{'ssam.sizing'} ?? null, 'cpus' => $svc->deploy->resources->limits->cpus ?? null, 'memory' => $svc->deploy->resources->limits->memory ?? null, 'cpu_shares' => $svc->cpu_shares ?? null,
  'SSAM_BUILD_WORKERS' => $svc->environment->SSAM_BUILD_WORKERS ?? null, 'SSAM_O11_WORKERS_MAX' => $svc->environment->SSAM_O11_WORKERS_MAX ?? null];
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\\n";
`;
const generated={'deploy-retier.php':phpOut,'rollback-retier.php':rollback,'export-retier-raw.php':exportRaw,'read-labels.php':labels};
const problems=Object.entries(generated).flatMap(([n,t])=>checkGenerated(n,t));
if(problems.length)throw new Error(['generated PHP refused:',...problems].join('\n'));
fs.mkdirSync(out,{recursive:true});
for(const [n,t] of Object.entries(generated))fs.writeFileSync(path.join(out,n),t);
fs.writeFileSync(path.join(out,'expected-delta.json'),JSON.stringify(delta,null,1)+'\n');
// env-added.json: the added keys, their compose text and default, the backends (read by retier-kit.mjs for env-check.sh).
fs.writeFileSync(path.join(out,'env-added.json'),JSON.stringify({keys:ENV_VALUES,backends:ENV_KEYS.length?backendNames:[]},null,1)+'\n');
// tier-keys.json (revision 3, only with tier keys): per backend, the tier keys the new and the base compose give it (absent:
// null), read by retier-kit.mjs for env-keys-check.mjs --tier (a key the compose no longer lists must not reach the container).
const tierState=c=>Object.fromEntries(backends(c).map(([n,s])=>[n,Object.fromEntries(Object.keys(TIER_KEY_FIELD).map(k=>[k,s.environment?.[k]??null]))]));
if(tierKeyPaths.length)fs.writeFileSync(path.join(out,'tier-keys.json'),JSON.stringify({after:tierState(CN),base:tierState(CB)},null,1)+'\n');
// kit.env: what retier-window.sh reads (no secret).
fs.writeFileSync(path.join(out,'kit.env'),[`KIND=retier`,`PIN=${pinShort}`,`BASE=${baseShort}`,`MARK=${MARK}`,`BEFORE=${baseRaw}`,`AFTER=${AFTER}`,`LABEL=${MARK}`,
 `IMAGES_CHANGE=${imagePaths.length?1:0}`,`HOT_FROM=${HOT_FROM}`,`HOT_TO=${HOT_TO}`,`ROUTER_SIZING_SHA=${ROUTER_SIZING_SHA}`,`BASE_ROUTER_SIZING_SHA=${BASE_ROUTER_SIZING_SHA}`,`ENV_KEYS=${ENV_KEYS.join(',')}`,...(tierKeyPaths.length?[`TIER_KEY_PATHS=${tierKeyPaths.length}`]:[]),...(imagePaths.length?[`IMAGE_PATHS=${imagePaths.length}`,`IMAGES=${Object.keys(IMAGES).join(',')}`]:[]),''].join('\n'));
console.log(JSON.stringify({kind:'retier',base:baseShort,pin:pinShort,mark:MARK,before:baseRaw,after:AFTER,delta:delta.length,tierPaths:tierPaths.length,
 envKeys:ENV_KEYS,envKeysFrom:envKeysArg===undefined?'derived from the diff':'--env-keys',envAddedPaths:envPaths.length,...(tierKeyPaths.length?{tierKeyPaths:tierKeyPaths.length}:{}),...(imagePaths.length?{imagePaths:imagePaths.length,images:IMAGES}:{}),hot:{from:HOT_FROM,to:HOT_TO},
 cb:sha(baseText),cn:sha(newText),...Object.fromEntries(Object.entries(generated).map(([n,t])=>[n,sha(t)]))},null,1));
