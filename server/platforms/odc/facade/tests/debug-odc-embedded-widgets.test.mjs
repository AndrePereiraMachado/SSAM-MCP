import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {findOdcEmbeddedWidgetRegions,createOdcEmbeddedWidgetsInspector} from '../debug-odc-embedded-widgets.mjs';
const source=`import {c as interop,f as packages} from './_oschunk-CORE.js';import {a as react} from './_oschunk-UI.js';
var appBefore=0;var widgets=interop(react());var version='6.28.0';packages.registerPackage('client-runtime-widgets',version);var appAfter=1;`;
test('region candidates use complete statement boundaries and retain their actual hash',()=>{
 const r=findOdcEmbeddedWidgetRegions(source);assert.equal(r.candidates.length,1);
 const region=r.candidates[0];assert.equal(region.version,'6.28.0');assert.equal(region.versionInsideRegion,true);
 assert.equal(region.regionSha256,createHash('sha256').update(source.slice(region.start,region.end)).digest('hex'));
 assert.equal(source.slice(region.start,region.end).includes('appBefore'),false);
 assert.equal(source.slice(region.start,region.end).includes('appAfter'),false);
 assert.deepEqual(r.imports.interop,{file:'./_oschunk-CORE.js',export:'c'});
});
test('duplicate markers, computed versions and shadowed native builtins are refused',()=>{
 for(const s of [source+"packages.registerPackage('client-runtime-widgets',version);",
  source.replace("version='6.28.0'",'version=getVersion()'),source+'var Object={};',source+'class RegExp {}'])
  assert.throws(()=>findOdcEmbeddedWidgetRegions(s),/embedded_widgets_/);
});
test('a matching package name and version do not qualify unreviewed executable code',()=>{
 for(const s of [source,source.replace('var version=',"send();var version=")]){
  const inspector=createOdcEmbeddedWidgetsInspector({'_oschunk-VIEW.js':s});
  assert.throws(()=>inspector({chunk:'_oschunk-VIEW.js'}),/runtime_unreviewed/);
 }
});
test('version declarations outside the region are explicit, not silently treated as part of it',()=>{
 const r=findOdcEmbeddedWidgetRegions(source.replace("var widgets=interop(react());var version='6.28.0';","var version='6.28.0';var widgets=interop(react());"));
 assert.equal(r.candidates[0].versionInsideRegion,false);
});
