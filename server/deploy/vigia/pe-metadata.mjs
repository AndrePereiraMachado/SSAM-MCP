// A minimal, read-only ECMA-335 reader for the feature toggles of an ODC Studio, from its assemblies alone (no .NET, no
// Studio run): PE -> CLI header -> metadata root -> streams (#~ or #-, #Strings, #Blob, #US) -> tables 0x00-0x0B (Module,
// TypeRef, TypeDef, FieldPtr, Field, MethodPtr, MethodDef, ParamPtr, Param, InterfaceImpl, MemberRef, Constant).
// Every read is bounded by the buffer; anything that does not close is "unreadable metadata", never a guess.
import fs from 'node:fs';
export const FEATURES_VALUES={namespace:'ServiceStudio.Common.FeatureManagement',name:'FeaturesValues'};
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The return type of a getter signature (ELEMENT_TYPE_*) the feature provider has a kind for.
const KIND={0x02:'Boolean',0x08:'Integer',0x0e:'String'};
const unreadable=why=>Object.assign(Error(`unreadable metadata: ${why}`),{code:'unreadable-metadata'});
export function readMetadata(input){
 const b=Buffer.isBuffer(input)?input:fs.readFileSync(input);
 const need=(o,n,what)=>{if(!Number.isInteger(o)||o<0||o+n>b.length)throw unreadable(`${what} is outside the file`);return o;};
 const u8=(o,what='a byte')=>b[need(o,1,what)],u16=(o,what='a field')=>b.readUInt16LE(need(o,2,what)),u32=(o,what='a field')=>b.readUInt32LE(need(o,4,what));
 if(b.length<0x40||u16(0)!==0x5a4d)throw unreadable('not a PE file');
 const pe=u32(0x3c);if(u32(pe,'the PE header')!==0x4550)throw unreadable('no PE signature');
 const sections=u16(pe+6),optionalSize=u16(pe+20),optional=pe+24,magic=u16(optional,'the optional header');
 if(magic!==0x10b&&magic!==0x20b)throw unreadable('unknown optional header');
 const count=u32(optional+(magic===0x20b?108:92)),directories=optional+(magic===0x20b?112:96);
 if(count<15)throw unreadable('no CLI header directory');
 const table=optional+optionalSize,spans=[];
 for(let i=0;i<sections;i++){const s=need(table+i*40,40,'the section table');spans.push({va:u32(s+12),size:Math.max(u32(s+8),u32(s+16)),rawSize:u32(s+16),raw:u32(s+20)});}
 const at=(rva,n,what)=>{for(const s of spans)if(rva>=s.va&&rva+n<=s.va+s.size&&rva-s.va+n<=s.rawSize)return need(rva-s.va+s.raw,n,what);throw unreadable(`${what} is outside every section`);};
 const cliRva=u32(directories+14*8);if(!cliRva)throw unreadable('not a .NET assembly');
 const cli=at(cliRva,72,'the CLI header'),mdSize=u32(cli+12),md=at(u32(cli+8),mdSize,'the metadata root');
 if(u32(md)!==0x424a5342)throw unreadable('no metadata signature');
 const versionLength=u32(md+12);let p=md+16+versionLength+2;const streamCount=u16(p,'the stream count');p+=2;
 const streams={};
 for(let i=0;i<streamCount;i++){
  const offset=u32(p),size=u32(p+4);p+=8;let name='';
  for(let n=0;n<32&&u8(p,'a stream name');n++)name+=String.fromCharCode(b[p++]);
  if(u8(p,'a stream name')!==0)throw unreadable('a stream name does not end');
  p=((p+1)+3)&~3;
  if(offset+size>mdSize)throw unreadable(`stream ${name} is outside the metadata`);
  streams[name]={start:md+offset,end:md+offset+size};
 }
 const T=streams['#~']??streams['#-'];if(!T||!streams['#Strings']||!streams['#Blob'])throw unreadable('a metadata stream is missing');
 let q=T.start;const heap=u8(q+6),valid=b.readBigUInt64LE(need(q+8,8,'the table header'));q+=24;
 const rows=[];for(let i=0;i<64;i++){if((valid>>BigInt(i))&1n){rows[i]=u32(q,'a row count');q+=4;}else rows[i]=0;}
 if(heap&0x40)q+=4;
 const si=heap&1?4:2,gi=heap&2?4:2,bi=heap&4?4:2;
 const idx=t=>rows[t]<65536?2:4,coded=(tables,bits)=>Math.max(...tables.map(t=>rows[t]))<(1<<(16-bits))?2:4;
 const tdor=coded([0x02,0x01,0x1b],2),rs=coded([0x00,0x1a,0x23,0x01],2),mrp=coded([0x02,0x01,0x1a,0x06,0x1b],3),hc=coded([0x04,0x08,0x17],2);
 const size={0x00:2+si+gi*3,0x01:rs+si*2,0x02:4+si*2+tdor+idx(0x04)+idx(0x06),0x03:idx(0x04),0x04:2+si+bi,0x05:idx(0x06),0x06:4+2+2+si+bi+idx(0x08),0x07:idx(0x08),0x08:2+2+si,0x09:idx(0x02)+tdor,0x0a:mrp+si+bi,0x0b:2+hc+bi};
 const start={};for(let t=0;t<=0x0b;t++){start[t]=q;q+=size[t]*rows[t];}
 if(q>T.end)throw unreadable('the tables are larger than their stream');
 const rd=(o,n)=>n===2?u16(o,'a table cell'):u32(o,'a table cell');
 const row=(t,r)=>{if(r<1||r>rows[t])throw unreadable(`row ${r} of table ${t} does not exist`);return start[t]+(r-1)*size[t];};
 const str=i=>{let o=streams['#Strings'].start+i,s='';if(o>=streams['#Strings'].end)throw unreadable('a name is outside #Strings');for(;o<streams['#Strings'].end&&b[o];o++)s+=String.fromCharCode(b[o]);if(o>=streams['#Strings'].end)throw unreadable('a name does not end');return Buffer.from(s,'latin1').toString('utf8');};
 const compressed=(o,end)=>{const x=u8(o);if((x&0x80)===0)return [x,1];if((x&0xc0)===0x80){if(o+2>end)throw unreadable('a length is cut');return [((x&0x3f)<<8)|u8(o+1),2];}if((x&0xe0)===0xc0){if(o+4>end)throw unreadable('a length is cut');return [((x&0x1f)<<24)|(u8(o+1)<<16)|(u8(o+2)<<8)|u8(o+3),4];}throw unreadable('an invalid compressed length');};
 const heapBlob=(stream,i)=>{const s=streams[stream],o=s.start+i;if(o>=s.end)throw unreadable(`an entry is outside ${stream}`);const [length,used]=compressed(o,s.end);if(o+used+length>s.end)throw unreadable(`an entry is cut in ${stream}`);return b.subarray(o+used,o+used+length);};
 const blob=i=>heapBlob('#Blob',i);
 const fieldAt=r=>rows[0x03]?rd(row(0x03,r),idx(0x04)):r,methodAt=r=>rows[0x05]?rd(row(0x05,r),idx(0x06)):r;
 const typeDefs=()=>{const out=[];for(let r=1;r<=rows[0x02];r++){const o=row(0x02,r);out.push({row:r,name:str(rd(o+4,si)),namespace:str(rd(o+4+si,si)),fieldList:rd(o+4+si*2+tdor,idx(0x04)),methodList:rd(o+4+si*2+tdor+idx(0x04),idx(0x06))});}return out;};
 // The field and method rows a type owns (FieldList/MethodList up to the next type's, through the Ptr tables when present).
 const members=type=>{
  const all=typeDefs(),next=all[type.row]??null,ptrF=rows[0x03]||rows[0x04],ptrM=rows[0x05]||rows[0x06];
  const range=(from,to,last,map)=>{const out=[];for(let r=from;r<to&&r<=last;r++)out.push(map(r));return out;};
  return {fields:range(type.fieldList,next?next.fieldList:ptrF+1,ptrF,fieldAt),methods:range(type.methodList,next?next.methodList:ptrM+1,ptrM,methodAt)};
 };
 const field=r=>{const o=row(0x04,r);return {row:r,name:str(rd(o+2,si))};};
 const method=r=>{const o=row(0x06,r);return {row:r,name:str(rd(o+8,si)),signature:blob(rd(o+8+si,bi))};};
 const typeRef=r=>{const o=row(0x01,r);return {row:r,name:str(rd(o+rs,si)),namespace:str(rd(o+rs+si,si))};};
 const memberRefs=()=>{const out=[];for(let r=1;r<=rows[0x0a];r++){const o=row(0x0a,r),parent=rd(o,mrp);out.push({row:r,parentTag:parent&7,parentRow:parent>>3,name:str(rd(o+mrp,si))});}return out;};
 const constants=()=>{const out=[];for(let r=1;r<=rows[0x0b];r++){const o=row(0x0b,r),parent=rd(o+2,hc);out.push({type:u8(o),parentTag:parent&3,parentRow:parent>>2,value:blob(rd(o+2+hc,bi))});}return out;};
 // The user strings (#US: UTF-16 literals of ldstr), each with its trailing flag byte.
 const userStrings=()=>{const s=streams['#US'],out=[];if(!s)return out;for(let o=s.start+1;o<s.end;){if(b[o]===0){o++;continue;}const [length,used]=compressed(o,s.end);if(o+used+length>s.end)throw unreadable('a user string is cut');if(length>1)out.push(b.toString('utf16le',o+used,o+used+length-1));o+=used+length;}return out;};
 return {rows,typeDefs,members,field,method,typeRef,memberRefs,constants,userStrings};
}
// The return type of a method signature: calling convention, parameter count, custom modifiers, then the type.
function returnKind(signature){
 let o=1;if(signature[0]&0x10)o+=signature[o]&0x80?((signature[o]&0xc0)===0x80?2:4):1;
 o+=signature[o]&0x80?((signature[o]&0xc0)===0x80?2:4):1;
 while(signature[o]===0x1f||signature[o]===0x20){o++;o+=signature[o]&0x80?((signature[o]&0xc0)===0x80?2:4):1;}
 if(o>=signature.length)throw unreadable('a getter signature is cut');
 return KIND[signature[o]]??null;
}
// The feature toggles a ServiceStudio.Common.dll defines: name -> {key (lowercase GUID), kind}, from the string constants
// of FeaturesValues' *Key fields and the return type of its get_<name> getters. A key without a getter of one of the
// provider's kinds is left out.
export function featureCatalog(commonDll){
 const m=readMetadata(commonDll);
 const type=m.typeDefs().find(t=>t.namespace===FEATURES_VALUES.namespace&&t.name===FEATURES_VALUES.name);
 if(!type)throw unreadable(`${FEATURES_VALUES.namespace}.${FEATURES_VALUES.name} is not defined there`);
 const {fields,methods}=m.members(type),own=new Set(fields);
 const keys=new Map();
 for(const c of m.constants()){
  if(c.type!==0x0e||c.parentTag!==0||!own.has(c.parentRow))continue;
  const name=m.field(c.parentRow).name,value=c.value.toString('utf16le');
  if(name.length>3&&name.endsWith('Key')&&GUID.test(value))keys.set(name.slice(0,-3),value.toLowerCase());
 }
 const kinds=new Map();
 for(const r of methods){const x=m.method(r);if(!x.name.startsWith('get_'))continue;const name=x.name.slice(4);if(keys.has(name)&&!kinds.has(name))kinds.set(name,returnKind(x.signature));}
 const catalog=new Map();
 for(const [name,key] of [...keys].sort(([a],[b])=>a.localeCompare(b)))if(kinds.get(name))catalog.set(name,{key,kind:kinds.get(name)});
 return catalog;
}
// The feature getters an assembly calls on ServiceStudio.Common.FeatureManagement.FeaturesValues (MemberRef rows whose
// parent is that TypeRef), sorted.
export function featureReads(dll){
 const m=readMetadata(dll),refs=new Set();
 for(let r=1;r<=m.rows[0x01];r++){const t=m.typeRef(r);if(t.namespace===FEATURES_VALUES.namespace&&t.name===FEATURES_VALUES.name)refs.add(r);}
 const out=new Set();
 if(refs.size)for(const x of m.memberRefs())if(x.parentTag===1&&refs.has(x.parentRow)&&x.name.startsWith('get_'))out.add(x.name.slice(4));
 return [...out].sort();
}
// Every GUID literal of an assembly's user strings, lowercase (the model features of OutSystems.Model.dll are declared
// with Guid.Parse("...")).
export function userStringGuids(dll){return new Set(readMetadata(dll).userStrings().filter(s=>GUID.test(s)).map(s=>s.toLowerCase()));}
