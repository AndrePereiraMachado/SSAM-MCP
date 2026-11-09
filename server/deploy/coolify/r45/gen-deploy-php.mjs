// node gen-deploy-php.mjs --option a|c --pin <rev> --out <dir> [--c6-file <compose>] [--after <sha256>] [--allow-images]
// (normally run by kit.mjs; R45_REPO = the SSAM-MCP checkout to read the pin from, default C:/t/r5/wt-capacity)
// Builds <out>/{deploy-coolify.php, export-coolify-raw.php, rollback-coolify.php, read-labels.php, expected-delta.json,
// kit.env} for one option of the capacity release (RESULTADO-R3.md):
//   C5 = compose.coolify.yml of fb3be56 (= main ce86718; the r44 compose in production, stored raw sha256 ceff8bc9...),
//   C6 = compose.coolify.yml of the pin (a commit of server/capacity-hot-pair[-c] or of main after the merge), or --c6-file
//        (a local file: only for a rehearsal of the generator; never deploy a kit made from a file).
// Option (c): the delta must be exactly the 38 sizing paths and no image may change. Option (a) (--allow-images): the delta
// is the 38 sizing paths plus the images of the services and the ssam.image.digest labels of the backends, and each new
// image must be the one C6 pins (pin-images-r45.mjs wrote it from the registry digests); volumes, networks and the served
// lists never move.
// The PHP refuses unless the stored compose is the r44 production one (raw sha256), differs from C5 only by the known
// production-only paths, and the C5->C6 delta is exactly the sizing paths (limits, cpu_shares, pool env, tier labels). It
// applies that delta onto the stored compose (every production-only value kept, never printed), checks the result both ways,
// that no image changed and that every sized value is literal, and in a dry run prints the would-be raw sha256. Run the dry
// run first (read-only); then set AFTER (argv[3]) to the dry run's afterRawSha256 and generate again: the apply refuses any
// other result and the export records it as the release sha the rollback accepts.
// Reuses the class map and checks of the r44 kit (php-classes.mjs beside this file, a copy of subida-r44/tests).
import fs from 'node:fs';import cp from 'node:child_process';import crypto from 'node:crypto';import path from 'node:path';
import {CLASSES,SERVICE_READ,SERVICE_WRITE,runtimeCheck,checkGenerated} from './php-classes.mjs';
const git=process.env.R45_GIT??'C:/Program Files/Git/cmd/git.exe',wt=process.env.R45_REPO??'C:/t/r5/wt-capacity';
const argv=process.argv.slice(2),opt=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:undefined;};
const OPTION=opt('--option');if(!['a','c'].includes(OPTION))throw new Error('--option a|c');
const ALLOW_IMAGES=argv.includes('--allow-images');
if((OPTION==='a')!==ALLOW_IMAGES)throw new Error('option (a) changes the images (--allow-images); option (c) never does');
const pin=opt('--pin')??'HEAD',c6File=opt('--c6-file');
const out=opt('--out');if(!out)throw new Error('--out <dir>');fs.mkdirSync(out,{recursive:true});
const AFTER_RAW_SHA256=opt('--after')??'unknown-run-the-dry-run-first';
const show=rev=>cp.execFileSync(git,['-C',wt,'show',rev+':server/deploy/coolify/compose.coolify.yml'],{encoding:'utf8'});
const pinShort=c6File?'file':cp.execFileSync(git,['-C',wt,'rev-parse','--short',pin],{encoding:'utf8'}).trim();
const c6Text=c6File?fs.readFileSync(c6File,'utf8'):show(pin);
const c5=show('fb3be56').replace(/^#.*\n/,''),c6=c6Text.replace(/^#.*\n/,'');
const C5=JSON.parse(c5),C6=JSON.parse(c6);
const b64=s=>Buffer.from(s).toString('base64');
const PRODUCTION_RAW_SHA256='ceff8bc99b93a8c13e75af8a532829e45b840a9d628b1899e0ee3ff2a10cd439';
const MARK=`r45-${OPTION}-${pinShort}`;
const isMap=x=>x&&typeof x==='object'&&!Array.isArray(x);
const diff=(x,y,p='',o=[])=>{if(isMap(x)&&isMap(y)){for(const k of new Set([...Object.keys(x),...Object.keys(y)])){if(!(k in x))o.push(p+'/'+k+' (added)');else if(!(k in y))o.push(p+'/'+k+' (removed)');else diff(x[k],y[k],p+'/'+k,o);}return o;}if(JSON.stringify(x)!==JSON.stringify(y))o.push(p);return o;};
const delta=diff(C5,C6);
const get=(o,p)=>p.replace(/ \((added|removed)\)$/,'').split('/').slice(1).reduce((n,k)=>n?.[k],o);
// The delta must be the sizing family only, every value literal (review R2 M3').
const SIZED=/^\/services\/(ssam-server-v[1-5]\/(deploy\/resources\/limits\/(cpus|memory)|environment\/(SSAM_BUILD_WORKERS|SSAM_O11_WORKERS_MAX)|environment\/SSAM_BUILD_QUEUE_MS \(added\)|labels\/ssam\.sizing \(added\)|cpu_shares \(added\))|ssam-router\/(deploy\/resources\/limits\/(cpus|memory)|labels\/ssam\.sizing \(added\)))$/;
// Option (a) only: the image of a service, the digest label of a backend.
const IMAGE=/^\/services\/[a-z0-9-]+\/(image|labels\/ssam\.image\.digest)$/;
const foreign=delta.filter(p=>!SIZED.test(p)&&!(ALLOW_IMAGES&&IMAGE.test(p)));
if(foreign.length)throw new Error('C5->C6 delta outside the '+(ALLOW_IMAGES?'sizing and image':'sizing')+' paths: '+foreign.join(', '));
const sized=delta.filter(p=>SIZED.test(p)),imaged=delta.filter(p=>IMAGE.test(p));
if(sized.length!==38)throw new Error('expected 38 sizing paths, got '+sized.length);
if(ALLOW_IMAGES){
 for(const n of Object.keys(C6.services).filter(n=>/^ssam-server-v[1-5]$/.test(n)))if(!imaged.includes(`/services/${n}/image`))throw new Error(`option (a) rebuilds every pair: ${n} keeps its image`);
 for(const p of imaged.filter(p=>p.endsWith('/image'))){const v=get(C6,p);if(!/^docker\.io\/andrepereiramachado\/ssam-server:prod-\d{8}-r45-[0-9a-f]{7}-o\d+-odc\d+$/.test(v))throw new Error('not an r45 image of the private repository: '+p+' '+v);}
}
for(const p of delta){const v=get(C6,p);if(typeof v==='string'&&v.includes('${')&&!p.endsWith('ssam.sizing (added)'))throw new Error('a sized value is not literal: '+p);}
const php=`<?php
// deploy-coolify.php (r45 capacity, option (${OPTION}), generated by deploy-r45/gen-deploy-php.mjs from fb3be56 and the pin ${pinShort}).
// Default: DRY RUN, read-only. Writes only with SSAM_RELEASE_APPLY=${MARK}. Prints key paths, hashes and images, never a value.
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(${CLASSES.kernel}::class)->bootstrap();
const UUID = 'ksqommjgowjjilpgpbmf7cdo';
const PRODUCTION_RAW_SHA256 = '${PRODUCTION_RAW_SHA256}';
const EXPECTED_AFTER_RAW_SHA256 = '${AFTER_RAW_SHA256}';
const IMAGES_CHANGE = ${ALLOW_IMAGES?'true':'false'};
$apply = getenv('SSAM_RELEASE_APPLY') === '${MARK}';
function stop($m) { fwrite(STDERR, "STOP: $m\\n"); exit(2); }
${runtimeCheck([...SERVICE_READ, ...SERVICE_WRITE, [CLASSES.yaml, 'parse']])}
$C5 = json_decode(base64_decode('${b64(c5)}'), false, 512, JSON_THROW_ON_ERROR);
$C6 = json_decode(base64_decode('${b64(c6)}'), false, 512, JSON_THROW_ON_ERROR);
// The paths where production differs from the committed r44 compose (the r44 list, v5 included).
$PRODUCTION_ONLY = ['/networks/coolify','/services/ssam-admin/networks/coolify','/services/ssam-console/environment/CONSOLE_GITHUB_CLIENT_ID',
 '/services/ssam-console/environment/CONSOLE_GITHUB_CLIENT_SECRET','/services/ssam-console/environment/CONSOLE_SESSION_SECRET',
 '/services/ssam-console/environment/CONSOLE_TOKEN_MODULE','/services/ssam-console/networks/coolify','/services/ssam-ops/networks',
 '/services/ssam-router/environment/SSAM_DATABASE_URL','/services/ssam-router/labels/traefik.http.routers.ssam.rule',
 '/services/ssam-router/labels/traefik.http.routers.ssam-http.rule','/services/ssam-router/labels/traefik.http.routers.ssam-console.rule',
 '/services/ssam-router/labels/traefik.http.routers.ssam-console-http.rule','/services/ssam-router/networks/coolify'];
foreach (['v1','v2','v3','v4','v5'] as $v) { $PRODUCTION_ONLY[] = "/services/ssam-server-$v/environment/SSAM_DATABASE_URL"; $PRODUCTION_ONLY[] = "/services/ssam-server-$v/networks/coolify"; }
// The C5->C6 delta, exactly (anything else is refused): the capacity sizing of the five backends and the router.
$EXPECTED_DELTA = json_decode(base64_decode('${b64(JSON.stringify(delta))}'), true, 512, JSON_THROW_ON_ERROR);
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
function put(&$root, $path, $value) { $parts = array_slice(explode('/', $path), 1); $last = array_pop($parts); $node = &$root; foreach ($parts as $k) { if (!isMap($node) || !property_exists($node, $k)) stop("missing parent of $path"); $node = &$node->$k; } $node->$last = $value; }
function deep($x) { return json_decode(json_encode($x), false, 512, JSON_THROW_ON_ERROR); }
function fmt($x) {
  $j = json_encode($x, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR);
  return preg_replace_callback('/^((?:    )+)/m', fn($m) => str_repeat(' ', strlen($m[1]) / 2), $j);
}
$s = ${CLASSES.service}::where('uuid', UUID)->sole();
$raw = $s->docker_compose_raw;
$before = hash('sha256', $raw);
if ($before !== PRODUCTION_RAW_SHA256) stop("the stored compose is not the r44 production compose (sha256 $before)");
$nl = strpos($raw, "\\n"); $first = substr($raw, 0, $nl); $body = substr($raw, $nl + 1);
if (!str_starts_with($first, '#')) stop('the stored compose has no comment line');
if (!str_ends_with($body, "\\n")) stop('the stored compose has no final newline');
$P = json_decode($body, false, 512, JSON_THROW_ON_ERROR);
if (fmt($P) . "\\n" !== $body) stop('the formatter does not reproduce the stored compose byte for byte; nothing written');
// 1. production = committed r44 except the known production-only paths.
$prod = diff($C5, $P);
$unknown = array_values(array_diff(array_map('strip', $prod), $PRODUCTION_ONLY));
if ($unknown) stop('production differs from the committed r44 compose outside the known paths: ' . implode(', ', $unknown));
// 2. the release delta is exactly the sizing.
$delta = diff($C5, $C6);
if ($delta !== $EXPECTED_DELTA) stop('the capacity compose delta is not exactly the sizing paths: ' . implode(', ', $delta));
// 3. apply it onto production.
$R = deep($P);
foreach ($delta as $path) put($R, strip($path), deep(get($C6, strip($path))));
// 4. verify the result both ways; no image, volume, network or served list moved; every sized value literal.
$vsC6 = array_values(array_diff(array_map('strip', diff($C6, $R)), $PRODUCTION_ONLY));
if ($vsC6) stop('the result differs from the capacity compose outside the production-only paths: ' . implode(', ', $vsC6));
$change = diff($P, $R);
$sorted = function ($x) { sort($x); return $x; };
// Same set of paths (production keeps its own service order: the router before v5).
if ($sorted($change) !== $sorted($EXPECTED_DELTA)) stop('the change to production is not exactly the sizing paths: ' . implode(', ', $change));
$tiers = []; $images = [];
foreach ($R->services as $name => $svc) {
  $was = $P->services->$name;
  foreach (['volumes','networks'] as $k) if (!same($svc->$k ?? null, $was->$k ?? null)) stop("$name $k changed");
  // Option (c): no image moves. Option (a): every image and digest label is the one the capacity compose pins.
  $want = IMAGES_CHANGE ? $C6->services->$name : $was;
  if (!same($svc->image ?? null, $want->image ?? null)) stop("$name image is not the " . (IMAGES_CHANGE ? 'pinned r45 one' : 'live one'));
  if (!same($svc->environment->SSAM_SERVED_VERSIONS ?? null, $was->environment->SSAM_SERVED_VERSIONS ?? null)) stop("$name served list changed");
  if (!same($svc->labels->{'ssam.image.digest'} ?? null, $want->labels->{'ssam.image.digest'} ?? null)) stop("$name digest is not the " . (IMAGES_CHANGE ? 'pinned' : 'live') . ' one');
  if ($svc->image !== $was->image) $images[$name] = $svc->image;
  if (str_starts_with($name, 'ssam-server-v')) {
    $l = $svc->deploy->resources->limits;
    foreach ([$l->cpus, $l->memory, $svc->environment->SSAM_BUILD_WORKERS, $svc->environment->SSAM_O11_WORKERS_MAX, $svc->environment->SSAM_BUILD_QUEUE_MS] as $v) if (!is_string($v) || str_contains($v, '\${')) stop("$name has a sized value that is not literal");
    $tiers[$name] = ['tier' => $svc->labels->{'ssam.sizing'}, 'cpus' => $l->cpus, 'memory' => $l->memory, 'cpu_shares' => $svc->cpu_shares, 'buildWorkers' => $svc->environment->SSAM_BUILD_WORKERS, 'o11WorkersMax' => $svc->environment->SSAM_O11_WORKERS_MAX];
  }
}
if (count(array_filter($tiers, fn($t) => $t['tier'] === 'hot')) !== 1) stop('not exactly one hot backend');
$sizing = json_decode($R->services->{'ssam-router'}->labels->{'ssam.sizing'}, true, 512, JSON_THROW_ON_ERROR);
$next = $first . "\\n" . fmt($R) . "\\n";
if (${CLASSES.yaml}::parse($next) != json_decode(fmt($R), true)) stop('the new compose does not parse as YAML to the same document');
$after = hash('sha256', $next);
$report = ['mode' => $apply ? 'apply' : 'dry-run', 'uuid' => UUID, 'beforeRawSha256' => $before, 'afterRawSha256' => $after, 'expectedAfterRawSha256' => EXPECTED_AFTER_RAW_SHA256,
  'bytes' => [strlen($raw), strlen($next)], 'productionOnlyPathsKept' => count($prod), 'changedPaths' => count($change), 'tiers' => $tiers,
  'router' => ['cpus' => $R->services->{'ssam-router'}->deploy->resources->limits->cpus, 'memory' => $R->services->{'ssam-router'}->deploy->resources->limits->memory],
  'hotPair' => $sizing['hotPair'] ?? null, 'usage' => $sizing['usage'] ?? null, 'option' => '${OPTION}', 'imagesChanged' => $images];
if (!$apply) { echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\\n"; exit(0); }
if ($after !== EXPECTED_AFTER_RAW_SHA256) stop("the computed capacity compose is not the reviewed one (sha256 $after)");
// APPLY: the stored compose before, for rollback (holds secrets: written only inside this container, 0600).
$saved = ['uuid' => UUID, 'docker_compose_raw' => $raw, 'beforeRawSha256' => $before, 'releaseRawSha256' => $after, 'at' => gmdate('c')];
$file = '/tmp/ssam-r45-coolify-before.json';
umask(077); if (file_put_contents($file, json_encode($saved, JSON_UNESCAPED_SLASHES)) === false) stop('could not save the rollback copy');
chmod($file, 0600);
$s->docker_compose_raw = $next; $s->save();
$s = ${CLASSES.service}::where('uuid', UUID)->sole();
if (hash('sha256', $s->docker_compose_raw) !== $after) stop('the saved compose is not the computed one');
echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\\n";
`;
// The apply writes the compose only: the owner (or the integrator, in the agreed window) presses Redeploy in Coolify, so
// the moment every MCP session drops is chosen, never a side effect of this file (review R2 M4.6).
const rollback=`<?php
// rollback-coolify.php (r45 capacity): puts back the stored compose saved before the capacity release (the export of step 3,
// copied into the container as /tmp/ssam-r45-coolify-before.json, or the apply's own copy). Default: CHECK only
// (read-only). Writes only with SSAM_RELEASE_ROLLBACK=${MARK}; the Redeploy is pressed in Coolify afterwards.
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(${CLASSES.kernel}::class)->bootstrap();
function stop($m) { fwrite(STDERR, "STOP: $m\\n"); exit(2); }
${runtimeCheck([...SERVICE_READ, [CLASSES.service, 'save']])}
$go = getenv('SSAM_RELEASE_ROLLBACK') === '${MARK}';
$s = ${CLASSES.service}::where('uuid', 'ksqommjgowjjilpgpbmf7cdo')->sole();
$now = hash('sha256', $s->docker_compose_raw);
$file = '/tmp/ssam-r45-coolify-before.json';
if (!is_file($file)) { echo json_encode(['mode' => 'check', 'saved' => false, 'currentRawSha256' => $now, 'isProductionBefore' => $now === '${PRODUCTION_RAW_SHA256}', 'isRelease' => $now === '${AFTER_RAW_SHA256}']), "\\n"; if ($go) stop('no saved compose in this container'); exit(0); }
$saved = json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
if ($saved['uuid'] !== 'ksqommjgowjjilpgpbmf7cdo' || hash('sha256', $saved['docker_compose_raw']) !== $saved['beforeRawSha256'] || $saved['beforeRawSha256'] !== '${PRODUCTION_RAW_SHA256}' || $saved['releaseRawSha256'] !== '${AFTER_RAW_SHA256}') stop('wrong or damaged rollback copy');
if ($now !== $saved['releaseRawSha256'] && $now !== $saved['beforeRawSha256']) stop('the compose changed after the release; review before rollback');
$report = ['mode' => $go ? 'rollback' : 'check', 'saved' => true, 'currentRawSha256' => $now, 'restoresRawSha256' => $saved['beforeRawSha256']];
if (!$go) { echo json_encode($report), "\\n"; exit(0); }
$s->docker_compose_raw = $saved['docker_compose_raw']; $s->save();
$s = ${CLASSES.service}::where('uuid', 'ksqommjgowjjilpgpbmf7cdo')->sole();
if (hash('sha256', $s->docker_compose_raw) !== $saved['beforeRawSha256']) stop('the restored compose is not the saved one');
echo json_encode($report), "\\n";
`;
const exportRaw=`<?php
// export-coolify-raw.php (r45 capacity): READ-ONLY. Prints the rollback copy of the stored compose (the format
// rollback-coolify.php reads) only when it is the r44 production compose. Holds secrets: the caller writes it 0600 and
// never prints it.
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(${CLASSES.kernel}::class)->bootstrap();
function stop($m) { fwrite(STDERR, "STOP: $m\\n"); exit(2); }
${runtimeCheck(SERVICE_READ)}
$s = ${CLASSES.service}::where('uuid', 'ksqommjgowjjilpgpbmf7cdo')->sole();
$raw = $s->docker_compose_raw; $before = hash('sha256', $raw);
if ($before !== '${PRODUCTION_RAW_SHA256}') stop("the stored compose is not the r44 production compose (sha256 $before)");
echo json_encode(['uuid' => 'ksqommjgowjjilpgpbmf7cdo', 'docker_compose_raw' => $raw, 'beforeRawSha256' => $before, 'releaseRawSha256' => '${AFTER_RAW_SHA256}', 'at' => gmdate('c'), 'source' => 'export-coolify-raw.php'], JSON_UNESCAPED_SLASHES), "\\n";
`;
// read-labels.php: READ-ONLY proof that the stored compose carries the sizing the watcher reads back (router ssam.sizing and
// each backend's tier label, limits and pools); no secret is printed.
const labels=`<?php
// read-labels.php (r45 capacity): READ-ONLY. Prints the router's ssam.sizing label and each backend's tier, limits, cpu_shares
// and pool sizes from the stored compose; nothing else (no environment value besides the pools, no secret).
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(${CLASSES.kernel}::class)->bootstrap();
function stop($m) { fwrite(STDERR, "STOP: $m\\n"); exit(2); }
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
const problems=[['deploy-coolify.php',php],['rollback-coolify.php',rollback],['export-coolify-raw.php',exportRaw],['read-labels.php',labels]].flatMap(([n,t])=>checkGenerated(n,t));
if(problems.length)throw new Error(['generated PHP refused:',...problems].join('\n'));
const files={'deploy-coolify.php':php,'rollback-coolify.php':rollback,'export-coolify-raw.php':exportRaw,'read-labels.php':labels};
for(const [n,t] of Object.entries(files))fs.writeFileSync(path.join(out,n),t);
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
fs.writeFileSync(path.join(out,'expected-delta.json'),JSON.stringify(delta,null,1)+'\n');
// kit.env: what r45-window.sh reads (no secret).
fs.writeFileSync(path.join(out,'kit.env'),[`OPTION=${OPTION}`,`PIN=${pinShort}`,`MARK=${MARK}`,`BEFORE=${PRODUCTION_RAW_SHA256}`,`AFTER=${AFTER_RAW_SHA256}`,`LABEL=r45-${OPTION}-${pinShort}`,`IMAGES_CHANGE=${ALLOW_IMAGES?1:0}`,''].join('\n'));
console.log(JSON.stringify({option:OPTION,pin:pinShort,mark:MARK,after:AFTER_RAW_SHA256,delta:delta.length,sized:sized.length,images:imaged.length,c5:sha(show('fb3be56')),c6:sha(c6Text),...Object.fromEntries(Object.entries(files).map(([n,t])=>[n,sha(t)]))},null,1));
