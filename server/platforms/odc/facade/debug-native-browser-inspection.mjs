// Private browser bundle of the same inspector core. No app expression
// evaluator is added: reads and steps remain calls to OutSystemsDebugger.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
const require=createRequire(import.meta.url),directory=path.dirname(fileURLToPath(import.meta.url));
const fail=()=>{throw new Error('debug_native_browser_inspector_dependency_invalid');};
function plainModule(file,allowedImport){
  const source=fs.readFileSync(path.join(directory,file),'utf8');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),exports=[];
  const body=ast.body.map(node=>{
    if(node.type==='ImportDeclaration'){
      if(node.source.value!==allowedImport)fail();
      return '';
    }
    if(node.type==='ExportNamedDeclaration'){
      if(!node.declaration)fail();
      const d=node.declaration;
      if(d.type==='FunctionDeclaration')exports.push(d.id.name);
      else if(d.type==='VariableDeclaration')for(const v of d.declarations){if(v.id.type!=='Identifier')fail();exports.push(v.id.name);}
      else fail();
      return source.slice(d.start,d.end);
    }
    return source.slice(node.start,node.end);
  }).join('\n');
  return {body,exports,sha256:createHash('sha256').update(source).digest('hex')};
}
export function nativeBrowserInspectionBundle(){
  // Existing Cognito dependency, Apache-2.0; no new package or vendored copy.
  // These two unmodified modules implement synchronous SHA-256, necessary
  // while Chromium is paused (an async WebCrypto job cannot be awaited there).
  const cognito=createRequire(require.resolve('amazon-cognito-identity-js'));
  const cryptoRoot=path.dirname(path.dirname(cognito.resolve('@aws-crypto/sha256-js')));
  const pkg=JSON.parse(fs.readFileSync(path.join(cryptoRoot,'package.json'),'utf8'));
  if(pkg.name!=='@aws-crypto/sha256-js'||pkg.version!=='1.2.2'||pkg.license!=='Apache-2.0')fail();
  const constants=fs.readFileSync(path.join(cryptoRoot,'build/constants.js'),'utf8');
  const raw=fs.readFileSync(path.join(cryptoRoot,'build/RawSha256.js'),'utf8');
  const license=fs.readFileSync(path.join(cryptoRoot,'LICENSE'),'utf8');
  if(!license.includes('Apache License')||!license.includes('Version 2.0'))fail();
  const wire=plainModule('debug-native-return-wire.mjs');
  const core=plainModule('debug-native-client-inspection-core.mjs','./debug-native-return-wire.mjs');
  const source=`(function(){
    const bundledHashLicense=${JSON.stringify(license)};
    const constants=(function(exports){${constants}\nreturn exports;})({});
    const hashModule=(function(exports,require){${raw}\nreturn exports;})({},function(name){if(name!=='./constants')throw new Error('hash_dependency_invalid');return constants;});
    const wire=(function(){${wire.body}\nreturn {${wire.exports.join(',')}};})();
    const {${wire.exports.join(',')}}=wire;
    ${core.body}
    const encoder=new TextEncoder();
    const utilities={
      token:()=>Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join(''),
      byteLength:value=>encoder.encode(value).length,
      digest:value=>{const hash=new hashModule.RawSha256();hash.update(encoder.encode(JSON.stringify(value)));return Array.from(hash.digest(),b=>b.toString(16).padStart(2,'0')).join('');}
    };
    return {create:options=>createNativeClientInspectionCore({...options,globalObject:globalThis,debuggerObject:globalThis.OutSystemsDebugger,
      redact:value=>redactNativeClientValue(value,options.privateValues??[])},utilities)};
  })()`;
  parse(source,{ecmaVersion:'latest'});
  return {source,sourceSha256:createHash('sha256').update(source).digest('hex'),
    coreSha256:core.sha256,wireSha256:wire.sha256,
    hashDependency:{name:pkg.name,version:pkg.version,license:pkg.license,
      licenseSha256:createHash('sha256').update(license).digest('hex'),
      rawSha256:createHash('sha256').update(raw).digest('hex'),constantsSha256:createHash('sha256').update(constants).digest('hex')},
    // Browser capture must be paired with the host-side privateChannel in
    // connectNativeClientInspector. The browser itself never persists values.
    privateCaptureSupported:true,privateChannelSupported:false};
}
