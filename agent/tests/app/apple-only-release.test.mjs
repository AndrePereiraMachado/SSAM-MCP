import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse,withoutOffers,builderArgs,feedEntries,checkMacOutput,DEFAULT_UPDATE_URL,feedLabel} from '../../scripts/build.mjs';
import {assertBridgeTrust} from '../../scripts/bridge-trust-gate.mjs';
import {feedPinned,updateTrustProblem,updateFeedLabel,updateFeedRecordProblem,PRODUCTION_UPDATE_URL} from '../../src/main/core/update-model.mjs';
import {resolveUpdateUrl} from '../../src/main/core/settings.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
const args=['--platform','mac','--native','core','--notarize','--bundled-bridges-only'];
// Mac app 0.2.8: bundled bridges only (no remote bridge offer), but the app updates itself from the feed unless --no-updates.
test('Apple-only distribution keeps bundled bridges, updates the app from the feed, and rejects incompatible signing modes',()=>{
 const options=parse(args);assert.equal(options.noUpdates,false);assert.equal(options.bundledBridgesOnly,true);assert.equal(options.updateUrl,DEFAULT_UPDATE_URL);
 assert.equal(parse([...args,'--no-updates']).noUpdates,true);
 for(const extra of [['--test-unsigned'],['--pack-only'],['--cert-sha1','a'.repeat(40)],['--bridge-public-key','key.pem']]) assert.throws(()=>parse([...args,...extra]));
 assert.throws(()=>parse(args.filter(a=>a!=='--notarize')));
 assert.throws(()=>parse(args.map(a=>a==='mac'?'win':a)));
 assert.throws(()=>parse([...args,'--update-url','http://dist.example.com/u/x']),/https/);
});
test('a Mac app that updates itself must be notarized; --no-updates and the unsigned test app stay offline builds',()=>{
 assert.throws(()=>parse(['--platform','mac','--native','core']),/signed and notarized/);
 assert.equal(parse(['--platform','mac','--native','core','--no-updates']).noUpdates,true);
 assert.equal(parse(['--platform','mac','--native','core','--test-unsigned']).noUpdates,true);
 assert.equal(parse(['--platform','mac','--native','core','--pack-only']).packOnly,true);
});
test('electron-builder arguments: the feed of Windows (generic, dist.ssam.pro, latest), the app version, notarization; none of it offline',()=>{
 const updating=builderArgs(parse([...args,'--app-version','0.2.8']),{nativeMac:true,arch:'arm64',config:'c.json'});
 assert.deepEqual(updating,['--mac','dmg','zip','--arm64','--publish','never','--config','c.json','-c.publish.provider=generic','-c.publish.url=https://dist.ssam.pro/u/ssam-agent','-c.publish.channel=latest','-c.extraMetadata.version=0.2.8','-c.extraMetadata.ssamUpdateFeed=https://dist.ssam.pro/u/ssam-agent','-c.mac.notarize=true']);
 const offline=builderArgs(parse([...args,'--no-updates']),{nativeMac:true,arch:'arm64',config:'c.json'});
 assert.equal(offline.some(a=>a.startsWith('-c.publish')),false);assert.equal(offline.some(a=>a.startsWith('-c.extraMetadata')),false);
 assert.throws(()=>parse([...args,'--app-version','0.2']),/x\.y\.z/);
});
test('bundled-only pack preserves integrity data and disables remote offers',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-apple-only-'));try{
 const original={id:'fixture',files:[{path:'native/core',sha256:'a'}],odcBridge:'v108'};
 fs.writeFileSync(path.join(folder,'pack.json'),JSON.stringify(original));
 assert.deepEqual(withoutOffers(folder),{...original,bridgeOffer:false});
 }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
test('ordinary release still rejects absent bridge trust anchors',()=>{
 assert.throws(()=>assertBridgeTrust({publicKey:'',nativeKey:'',thumbprint:'',nativeThumbprint:''}),/must be configured/);
 assert.equal(parse(['--platform','mac','--notarize','--native','core','--no-updates']).bundledBridgesOnly,undefined);
});
// A packaged Mac app keeps the feed of its build: SSAM_UPDATE_URL or the setting cannot point it at another server (which
// could serve an older, genuinely signed release); Windows keeps its rule (publisherName or the pinned Ed25519 key).
test('feedPinned: every packaged macOS build keeps its own feed; Windows as before',()=>{
 const yml='provider: generic\nurl: https://dist.ssam.pro/u/ssam-agent\n';
 assert.equal(feedPinned({platform:'darwin',isPackaged:true,appUpdateYml:yml,updatePublicKey:''}),true);
 assert.equal(feedPinned({platform:'darwin',isPackaged:false,appUpdateYml:yml,updatePublicKey:''}),false);
 assert.equal(feedPinned({platform:'win32',isPackaged:true,appUpdateYml:yml,updatePublicKey:''}),false);
 assert.equal(feedPinned({platform:'win32',isPackaged:true,appUpdateYml:yml,updatePublicKey:'MCowBQYDK2VwAyEA'+'A'.repeat(43)+'='}),true);
 assert.equal(feedPinned({platform:'win32',isPackaged:true,appUpdateYml:yml+"publisherName: 'SSAM'\n",updatePublicKey:''}),true);
 assert.deepEqual(resolveUpdateUrl({env:{SSAM_UPDATE_URL:'https://elsewhere.example/u'},settings:{updateUrl:'https://other.example/u'},build:'https://dist.ssam.pro/u/ssam-agent',pinned:true}),{url:'https://dist.ssam.pro/u/ssam-agent',source:'build',pinned:true});
 assert.equal(updateTrustProblem({platform:'darwin',isPackaged:true,updatePublicKey:''}),null,'the Ed25519 update check is Windows-only');
});
// The Mac workflows (F4): app_version defaults to package.json's version, enable_updates reaches the build step, the hello
// expects the 0.2.8 pack, a release manifest is written, and nothing is ever published.
test('Mac workflows: app_version = package.json, enable_updates wired into build.mjs, the 0.2.8 hello, release-manifest.json, no publishing',()=>{
 const repo=path.resolve(import.meta.dirname,'..','..','..');const version=JSON.parse(fs.readFileSync(path.join(repo,'agent','package.json'),'utf8')).version;
 const lf=f=>fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n');const entry=lf(path.join(repo,'.github','workflows','agent-app-mac.yml'));const native=lf(path.join(repo,'.github','workflows','agent-native-release.yml'));
 for(const text of [entry,native]){
  const defaults=[...text.matchAll(/app_version:\n(?:\s+(?:description|type|required):.*\n)*\s+default:\s*'([^']+)'/g)].map(m=>m[1]);
  assert.ok(defaults.length>=1,'app_version has a default');for(const d of defaults) assert.equal(d,version);
  assert.match(text,/enable_updates:\n(?:\s+(?:description|type):.*\n)*\s+default: false/);
  assert.doesNotMatch(text,/gh release (create|upload|edit)|--publish always|softprops\/action-gh-release|dist\.ssam\.pro\/api/);
 }
 assert.match(entry,/app_version: \$\{\{ inputs\.app_version \}\}/);assert.match(entry,/enable_updates: \$\{\{ inputs\.enable_updates \}\}/);
 assert.match(native,/--app-version "\$APP_VERSION" --update-url "\$feed" \$updates --notarize --bundled-bridges-only/);
 // Review M4: the staging feed (its own app on the Update Server) for the first live test of the self-update; production stays
 // the default, and only a staging build may carry a version other than package.json's.
 for(const text of [entry,native]) assert.match(text,/update_feed:\n(?:\s+(?:description|type|options):.*\n)*\s+default: production/);
 assert.match(entry,/update_feed: \$\{\{ inputs\.update_feed \}\}/);
 assert.match(native,/feed=https:\/\/dist\.ssam\.pro\/u\/ssam-agent; if \[ "\$UPDATE_FEED" = staging \]; then feed=https:\/\/dist\.ssam\.pro\/u\/ssam-agent-staging; fi/);
 assert.match(native,/version !== own && process\.env\.ENABLE_UPDATES === "true" && feed === "production"\) throw Error/);
 assert.match(native,/manifest\.feed !== expectedFeed/);
 // Review M4-R2: the artifacts of a staging build are named so (workflow artifact and every DMG/ZIP), a production one never.
 assert.match(native,/name: ssam-agent-mac-arm64-\$\{\{ inputs\.sign_and_notarize && 'signed' \|\| 'unsigned' \}\}\$\{\{ inputs\.update_feed == 'staging' && '-staging' \|\| '' \}\}\n/);
 assert.match(native,/name: r40-mac-arm64-test-evidence\$\{\{ inputs\.update_feed == 'staging' && '-staging' \|\| '' \}\}\n/);
 assert.match(native,/if \(staged !== a\.name\.includes\('-staging-mac-arm64\.'\)\) throw new Error/);
 // Review M2: the three thins of the published Windows 0.2.8, 11.55.94 the default; no 11.55.95 thin.
 assert.match(native,/'\["11\.55\.94","11\.55\.93","11\.55\.92"\]' \|\| hello\.pack\.o11BuiltFor !== '11\.55\.94'/);
 assert.doesNotMatch(native,/"11\.55\.95"/);
 assert.match(native,/'\["v108","v109"\]'/);
 assert.match(native,/release-manifest\.json/);assert.match(native,/agent\/dist\/latest-mac\.yml/);
 // Review B4 and B5: an updating build carries package.json's version; the checkout keeps no token.
 assert.match(native,/if \(version !== own && process\.env\.ENABLE_UPDATES === "true"(?: && feed === "production")?\) throw Error/);
 assert.match(native,/- uses: actions\/checkout@v4\n\s+with:\n(?:\s+#.*\n)*\s+persist-credentials: false/);
});
// Review M3 of agent/mac-028: the CI SDK is pinned to 10.0.403 or newer, the resolved ILCompiler/runtime packs are checked to be
// 10.0.14 or newer after the Native AOT publish, and the NuGet audit is never turned off in the workflow.
test('Mac workflow: pinned .NET SDK, toolchain checks around the Native AOT publish, NU1903 never demoted',()=>{
 const repo=path.resolve(import.meta.dirname,'..','..','..');const native=fs.readFileSync(path.join(repo,'.github','workflows','agent-native-release.yml'),'utf8').replace(/\r\n/g,'\n');
 const sdk=/actions\/setup-dotnet@v4\n\s+with:\n\s+dotnet-version: (\S+)/.exec(native)?.[1];
 assert.equal(sdk,'10.0.403');
 assert.match(native,/node scripts\/check-native-toolchain\.mjs --sdk "\$\(dotnet --version\)"/);
 // Review B-R2-5: both checks pass only on their own "ok":true, never on an exit code alone; B-R3-5: a failure still prints the report.
 assert.equal([...native.matchAll(/out=\$\(node scripts\/check-native-toolchain\.mjs [^\n]+\) \|\| \{ echo "\$out"; exit 1; \}; echo "\$out"\n\s+case "\$out" in \*'"ok":true'\*\) ;; \*\) echo '::error::[^']+'; exit 1;; esac/g)].length,2);
 const publish=native.indexOf('dotnet publish native/Ssam.Agent/Ssam.Agent.csproj'),check=native.indexOf('node scripts/check-native-toolchain.mjs --assets native/Ssam.Agent/obj/project.assets.json --rid osx-arm64'),sign=native.indexOf('codesign --force');
 assert.ok(publish>0&&check>publish&&check<sign,'the toolchain check runs after the publish and before any signing');
 assert.doesNotMatch(native,/NuGetAudit\s*=\s*false|NuGetAudit=false|WarningsNotAsErrors[^\n]*NU1903|NoWarn[^\n]*NU1903/i);
});
// The output check of a Mac build (after electron-builder): app-update.yml and latest-mac.yml as the options say, the ZIP's
// sha512/size as latest-mac.yml states them (what electron-updater compares), the installed pack whole.
test('checkMacOutput: the updater files of a Mac release, and none in an offline build',()=>{
 const dist=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-mac-dist-'));try{
  const resources=path.join(dist,'mac-arm64','SSAM Agent.app','Contents','Resources');fs.mkdirSync(path.join(resources,'pack'),{recursive:true});
  const zip=Buffer.from('zip bytes');fs.writeFileSync(path.join(dist,'ssam-agent-app-0.2.8-mac-arm64.zip'),zip);
  const sha512=createHash('sha512').update(zip).digest('base64');
  const latest=`version: 0.2.8\nfiles:\n  - url: ssam-agent-app-0.2.8-mac-arm64.zip\n    sha512: ${sha512}\n    size: ${zip.length}\npath: ssam-agent-app-0.2.8-mac-arm64.zip\nsha512: ${sha512}\nreleaseDate: '2026-11-09T00:00:00.000Z'\n`;
  assert.deepEqual(feedEntries(latest),{version:'0.2.8',files:[{url:'ssam-agent-app-0.2.8-mac-arm64.zip',sha512,size:zip.length}]});
  const options=parse([...args,'--app-version','0.2.8']);const ok=()=>[];const recorded=()=>({ssamUpdateFeed:'https://dist.ssam.pro/u/ssam-agent'});
  assert.throws(()=>checkMacOutput(dist,options,{arch:'arm64',pack:ok,readAppPackage:recorded}),/app-update\.yml is missing.*latest-mac\.yml is missing/);
  fs.writeFileSync(path.join(resources,'app-update.yml'),'provider: generic\nurl: https://dist.ssam.pro/u/ssam-agent\nchannel: latest\nupdaterCacheDirName: ssam-agent-app-updater\n');
  fs.writeFileSync(path.join(dist,'latest-mac.yml'),latest);
  checkMacOutput(dist,options,{arch:'arm64',pack:ok,readAppPackage:recorded});
  // Review M4-R2: the app's package.json must record the feed of app-update.yml; a staging name in a production build is refused.
  assert.throws(()=>checkMacOutput(dist,options,{arch:'arm64',pack:ok,readAppPackage:()=>({ssamUpdateFeed:'https://dist.ssam.pro/u/ssam-agent-staging'})}),/records the update feed https:\/\/dist\.ssam\.pro\/u\/ssam-agent-staging, not https:\/\/dist\.ssam\.pro\/u\/ssam-agent/);
  assert.throws(()=>checkMacOutput(dist,options,{arch:'arm64',pack:ok,readAppPackage:()=>({})}),/records the update feed none/);
  assert.throws(()=>checkMacOutput(dist,options,{arch:'arm64',pack:ok,readAppPackage:()=>{throw new Error('no app.asar');}}),/records the update feed unreadable \(no app\.asar\)/);
  fs.writeFileSync(path.join(dist,'ssam-agent-app-0.2.8-staging-mac-arm64.dmg'),'dmg');
  assert.throws(()=>checkMacOutput(dist,options,{arch:'arm64',pack:ok,readAppPackage:recorded}),/ssam-agent-app-0\.2\.8-staging-mac-arm64\.dmg names a staging feed/);
  fs.rmSync(path.join(dist,'ssam-agent-app-0.2.8-staging-mac-arm64.dmg'));
  assert.throws(()=>checkMacOutput(dist,options,{arch:'arm64',pack:()=>['o11Builds[1] pins x'],readAppPackage:recorded}),/Resources\/pack: o11Builds\[1\] pins x/);
  assert.throws(()=>checkMacOutput(dist,parse([...args,'--app-version','0.2.9']),{arch:'arm64',pack:ok,readAppPackage:recorded}),/announces 0\.2\.8, not 0\.2\.9/);
  fs.writeFileSync(path.join(dist,'ssam-agent-app-0.2.8-mac-arm64.zip'),'changed');
  assert.throws(()=>checkMacOutput(dist,options,{arch:'arm64',pack:ok,readAppPackage:recorded}),/another sha512 or size/);
  assert.throws(()=>checkMacOutput(dist,parse([...args,'--no-updates']),{arch:'arm64',pack:ok}),/must not carry Resources\/app-update\.yml.*must not write dist\/latest-mac\.yml/);
  fs.rmSync(path.join(resources,'app-update.yml'));fs.rmSync(path.join(dist,'latest-mac.yml'));
  checkMacOutput(dist,parse([...args,'--no-updates']),{arch:'arm64',pack:ok});
 }finally{fs.rmSync(dist,{recursive:true,force:true});}
});
// Review M4-R2 of agent/mac-028: a staging build is told apart from a production one by its file names, the artifact name of the
// workflow, the feed recorded in the app, and the panel; the production feed keeps the names of before.
test('staging builds carry the feed in their names; production and offline builds do not',()=>{
 const staging=parse([...args,'--app-version','0.2.9','--update-url','https://dist.ssam.pro/u/ssam-agent-staging/']);
 assert.equal(feedLabel(staging),'staging');assert.equal(feedLabel(parse(args)),null);assert.equal(feedLabel(parse([...args,'--no-updates'])),null);
 assert.equal(feedLabel(parse(['--platform','mac','--native','core','--test-unsigned'])),null);
 assert.equal(DEFAULT_UPDATE_URL,PRODUCTION_UPDATE_URL);
 assert.deepEqual(builderArgs(staging,{nativeMac:true,arch:'arm64',config:'c.json'}).filter(a=>a.startsWith('-c.')),['-c.publish.provider=generic','-c.publish.url=https://dist.ssam.pro/u/ssam-agent-staging','-c.publish.channel=latest','-c.extraMetadata.version=0.2.9','-c.extraMetadata.ssamUpdateFeed=https://dist.ssam.pro/u/ssam-agent-staging','-c.mac.notarize=true']);
 assert.equal(builderArgs(staging,{nativeMac:false,config:'c.json'}).some(a=>a.includes('ssamUpdateFeed')),false,'only the Mac build records it');
 for(const [url,label] of [[PRODUCTION_UPDATE_URL,'production'],[PRODUCTION_UPDATE_URL+'/','production'],['https://dist.ssam.pro/u/ssam-agent-staging','staging'],['https://dist.ssam.pro/u/ssam-agent-QA_2','qa-2'],['https://updates.example.com/ssam-agent','feed-ssam-agent'],[null,null],['',null]])
  assert.equal(updateFeedLabel(url),label,String(url));
 const dist=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-mac-staging-'));try{
  const resources=path.join(dist,'mac-arm64','SSAM Agent.app','Contents','Resources');fs.mkdirSync(path.join(resources,'pack'),{recursive:true});
  fs.writeFileSync(path.join(resources,'app-update.yml'),'provider: generic\nurl: https://dist.ssam.pro/u/ssam-agent-staging\nchannel: latest\nupdaterCacheDirName: ssam-agent-app-updater\n');
  const zipName='ssam-agent-app-0.2.9-staging-mac-arm64.zip',zip=Buffer.from('zip');fs.writeFileSync(path.join(dist,zipName),zip);fs.writeFileSync(path.join(dist,'ssam-agent-app-0.2.9-staging-mac-arm64.dmg'),'dmg');
  const sha512=createHash('sha512').update(zip).digest('base64');
  fs.writeFileSync(path.join(dist,'latest-mac.yml'),`version: 0.2.9\nfiles:\n  - url: ${zipName}\n    sha512: ${sha512}\n    size: ${zip.length}\npath: ${zipName}\n`);
  const ok=()=>[],recorded=()=>({ssamUpdateFeed:'https://dist.ssam.pro/u/ssam-agent-staging'});
  checkMacOutput(dist,staging,{arch:'arm64',pack:ok,readAppPackage:recorded});
  fs.writeFileSync(path.join(dist,'ssam-agent-app-0.2.9-mac-arm64.dmg'),'dmg');
  assert.throws(()=>checkMacOutput(dist,staging,{arch:'arm64',pack:ok,readAppPackage:recorded}),/ssam-agent-app-0\.2\.9-mac-arm64\.dmg does not name the staging feed \(-staging-mac-\)/);
 }finally{fs.rmSync(dist,{recursive:true,force:true});}
 // The app at start (index.mjs): the feed recorded by the build against its app-update.yml.
 assert.equal(updateFeedRecordProblem({recorded:undefined,buildUrl:PRODUCTION_UPDATE_URL}),null);
 assert.equal(updateFeedRecordProblem({recorded:PRODUCTION_UPDATE_URL,buildUrl:PRODUCTION_UPDATE_URL+'/'}),null);
 assert.match(updateFeedRecordProblem({recorded:'https://dist.ssam.pro/u/ssam-agent-staging',buildUrl:PRODUCTION_UPDATE_URL}),/built for the update feed https:\/\/dist\.ssam\.pro\/u\/ssam-agent-staging \(staging\), but its app-update\.yml names https:\/\/dist\.ssam\.pro\/u\/ssam-agent \(production\)/);
 assert.match(updateFeedRecordProblem({recorded:PRODUCTION_UPDATE_URL,buildUrl:null}),/names no feed/);
});
