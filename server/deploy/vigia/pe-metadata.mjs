// A minimal, read-only ECMA-335 reader for the feature toggles of an ODC Studio, from its assemblies alone (no .NET, no
// Studio run): PE -> CLI header -> metadata root -> streams (#~ or #-, #Strings, #Blob, #US) -> tables 0x00-0x0B (Module,
// TypeRef, TypeDef, FieldPtr, Field, MethodPtr, MethodDef, ParamPtr, Param, InterfaceImpl, MemberRef, Constant).
// Every read is bounded by the buffer, and the memory by what the caller keeps, never by the row count of a table: rows
// are read in place by index and filtered before anything is built; type names are compared byte by byte; a name is
// decoded only when it is kept (at most 1024 bytes, once per index, 32 MiB and 262144 names per file); a result holds at
// most 65536 entries; a file is at most 256 MiB. Anything that does not close is "unreadable metadata", never a guess.
import fs from 'node:fs';
export const FEATURES_VALUES={namespace:'ServiceStudio.Common.FeatureManagement',name:'FeaturesValues'};
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The return type of a getter signature (ELEMENT_TYPE_*) the feature provider has a kind for.
const KIND={0x02:'Boolean',0x08:'Integer',0x0e:'String'};
const unreadable=why=>Object.assign(Error(`unreadable metadata: ${why}`),{code:'unreadable-metadata'});
export const METADATA_LIMITS={fileBytes:256*1024*1024,nameBytes:1024,namesBytes:32*1024*1024,names:262144,results:65536};
const MiB=n=>`${n/1024/1024} MiB`;
export function readMetadata(input){
 const bytes=Buffer.isBuffer(input)?input.length:fs.statSync(input).size;
 if(bytes>METADATA_LIMITS.fileBytes)throw unreadable(`the file is larger than ${MiB(METADATA_LIMITS.fileBytes)}`);
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
 let q=T.start;const heap=u8(q+6),valid=b.readBigUInt64LE(need(q+8,8,'the table header')),sorted=b.readBigUInt64LE(need(q+16,8,'the table header'));q+=24;
 const rows=[];for(let i=0;i<64;i++){if((valid>>BigInt(i))&1n){rows[i]=u32(q,'a row count');q+=4;}else rows[i]=0;}
 if(heap&0x40)q+=4;
 const si=heap&1?4:2,gi=heap&2?4:2,bi=heap&4?4:2;
 const idx=t=>rows[t]<65536?2:4,coded=(tables,bits)=>Math.max(...tables.map(t=>rows[t]))<(1<<(16-bits))?2:4;
 const tdor=coded([0x02,0x01,0x1b],2),rs=coded([0x00,0x1a,0x23,0x01],2),mrp=coded([0x02,0x01,0x1a,0x06,0x1b],3),hc=coded([0x04,0x08,0x17],2);
 const size={0x00:2+si+gi*3,0x01:rs+si*2,0x02:4+si*2+tdor+idx(0x04)+idx(0x06),0x03:idx(0x04),0x04:2+si+bi,0x05:idx(0x06),0x06:4+2+2+si+bi+idx(0x08),0x07:idx(0x08),0x08:2+2+si,0x09:idx(0x02)+tdor,0x0a:mrp+si+bi,0x0b:2+hc+bi};
 const start={};for(let t=0;t<=0x0b;t++){start[t]=q;q+=size[t]*rows[t];}
 if(q>T.end)throw unreadable('the tables are larger than their stream');
 const rd=(o,n)=>n===2?u16(o,'a table cell'):u32(o,'a table cell');
 const row=(t,r)=>{if(!Number.isInteger(r)||r<1||r>rows[t])throw unreadable(`row ${r} of table ${t} does not exist`);return start[t]+(r-1)*size[t];};
 const strings=streams['#Strings'];
 // Whether the name at an index of #Strings is exactly (or starts with) an ASCII text, byte by byte: nothing is decoded.
 const nameIs=(i,text,{prefix=false}={})=>{
  const from=strings.start+i;if(from<strings.start||from+text.length+(prefix?0:1)>strings.end)return false;
  for(let k=0;k<text.length;k++)if(b[from+k]!==text.charCodeAt(k))return false;
  return prefix||b[from+text.length]===0;
 };
 // A name that is kept: at most nameBytes long, decoded once per index, within namesBytes and names per file.
 const names=new Map();let decoded=0;
 const name=i=>{
  const known=names.get(i);if(known!==undefined)return known;
  const from=strings.start+i;if(from>=strings.end)throw unreadable('a name is outside #Strings');
  const limit=Math.min(strings.end,from+METADATA_LIMITS.nameBytes+1);let o=from;while(o<limit&&b[o])o++;
  if(o>=strings.end)throw unreadable('a name does not end');
  if(o-from>METADATA_LIMITS.nameBytes)throw unreadable(`a name is longer than ${METADATA_LIMITS.nameBytes} bytes`);
  decoded+=o-from;if(decoded>METADATA_LIMITS.namesBytes)throw unreadable(`the names read exceed ${MiB(METADATA_LIMITS.namesBytes)}`);
  if(names.size>=METADATA_LIMITS.names)throw unreadable(`more than ${METADATA_LIMITS.names} names read`);
  const value=b.toString('utf8',from,o);names.set(i,value);return value;
 };
 const compressed=(o,end)=>{const x=u8(o);if((x&0x80)===0)return [x,1];if((x&0xc0)===0x80){if(o+2>end)throw unreadable('a length is cut');return [((x&0x3f)<<8)|u8(o+1),2];}if((x&0xe0)===0xc0){if(o+4>end)throw unreadable('a length is cut');return [((x&0x1f)<<24)|(u8(o+1)<<16)|(u8(o+2)<<8)|u8(o+3),4];}throw unreadable('an invalid compressed length');};
 // A #Blob entry as a view (no copy): its offset and length, read only when asked.
 const blob=i=>{const s=streams['#Blob'],o=s.start+i;if(o>=s.end)throw unreadable('an entry is outside #Blob');const [length,used]=compressed(o,s.end);if(o+used+length>s.end)throw unreadable('an entry is cut in #Blob');return b.subarray(o+used,o+used+length);};
 const blobLength=i=>{const s=streams['#Blob'],o=s.start+i;if(o>=s.end)throw unreadable('an entry is outside #Blob');const [length,used]=compressed(o,s.end);if(o+used+length>s.end)throw unreadable('an entry is cut in #Blob');return length;};
 const fieldAt=i=>rows[0x03]?rd(row(0x03,i),idx(0x04)):i,methodAt=i=>rows[0x05]?rd(row(0x05,i),idx(0x06)):i;
 const typeDefLists=r=>{const o=row(0x02,r);return [rd(o+4+si*2+tdor,idx(0x04)),rd(o+4+si*2+tdor+idx(0x04),idx(0x06))];};
 // The first TypeDef row that is the type (0 when none): rows are compared in place, nothing is kept.
 const findTypeDef=({namespace,name:typeName})=>{for(let r=1;r<=rows[0x02];r++){const o=row(0x02,r);if(nameIs(rd(o+4,si),typeName)&&nameIs(rd(o+4+si,si),namespace))return r;}return 0;};
 // The field and method lists a TypeDef owns, as index intervals [from, to) of the Field/FieldPtr and MethodDef/MethodPtr
 // lists (up to the next TypeDef's lists, or the end of the list).
 const ownedRanges=r=>{
  const [fieldList,methodList]=typeDefLists(r),next=r<rows[0x02]?typeDefLists(r+1):null;
  const lastF=(rows[0x03]||rows[0x04])+1,lastM=(rows[0x05]||rows[0x06])+1;
  return {fields:[Math.max(1,fieldList),Math.min(next?next[0]:lastF,lastF)],methods:[Math.max(1,methodList),Math.min(next?next[1]:lastM,lastM)]};
 };
 const fieldNameIndex=r=>rd(row(0x04,r)+2,si);
 const methodIndexes=r=>{const o=row(0x06,r);return {nameIndex:rd(o+8,si),signatureIndex:rd(o+8+si,bi)};};
 // Is TypeRef row r the type (in place)?
 const typeRefIs=(r,{namespace,name:typeName})=>{if(r<1||r>rows[0x01])return false;const o=row(0x01,r);return nameIs(rd(o+rs,si),typeName)&&nameIs(rd(o+rs+si,si),namespace);};
 // Every MemberRef row, read in place: fn(parentTag, parentRow, nameIndex).
 const eachMemberRef=fn=>{for(let r=1;r<=rows[0x0a];r++){const o=row(0x0a,r),parent=rd(o,mrp);fn(parent&7,parent>>>3,rd(o+mrp,si));}};
 // Every Constant row, read in place: fn(type, parentTag, parentRow, valueIndex).
 const eachConstant=fn=>{for(let r=1;r<=rows[0x0b];r++){const o=row(0x0b,r),parent=rd(o+2,hc);fn(u8(o),parent&3,parent>>>2,rd(o+2+hc,bi));}};
 // The Constant row of a parent (HasConstant tag, row) by binary search: the Constant table is sorted by Parent.
 const constantOf=(tag,parentRow)=>{
  if(!((sorted>>0x0bn)&1n))throw unreadable('the Constant table is not sorted');
  const want=parentRow*4+tag;let lo=1,hi=rows[0x0b];
  while(lo<=hi){const mid=(lo+hi)>>>1,o=row(0x0b,mid),parent=rd(o+2,hc);if(parent===want)return {type:u8(o),valueIndex:rd(o+2+hc,bi)};if(parent<want)lo=mid+1;else hi=mid-1;}
  return null;
 };
 // The user strings (#US: UTF-16 literals of ldstr, each with its trailing flag byte) of exactly chars characters, read
 // one by one: fn(text). The others are skipped without being decoded.
 const eachUserString=(chars,fn)=>{const s=streams['#US'];if(!s)return;for(let o=s.start+1;o<s.end;){if(b[o]===0){o++;continue;}const [length,used]=compressed(o,s.end);if(o+used+length>s.end)throw unreadable('a user string is cut');if(length===chars*2+1)fn(b.toString('utf16le',o+used,o+used+length-1));o+=used+length;}};
 return {rows,name,nameIs,blob,blobLength,fieldAt,methodAt,findTypeDef,ownedRanges,fieldNameIndex,methodIndexes,typeRefIs,eachMemberRef,eachConstant,constantOf,eachUserString,hasFieldPointers:rows[0x03]>0};
}
// The return type of a method signature: calling convention, parameter count, custom modifiers, then the type.
function returnKind(signature){
 let o=1;if(signature[0]&0x10)o+=signature[o]&0x80?((signature[o]&0xc0)===0x80?2:4):1;
 o+=signature[o]&0x80?((signature[o]&0xc0)===0x80?2:4):1;
 while(signature[o]===0x1f||signature[o]===0x20){o++;o+=signature[o]&0x80?((signature[o]&0xc0)===0x80?2:4):1;}
 if(o>=signature.length)throw unreadable('a getter signature is cut');
 return KIND[signature[o]]??null;
}
const keep=(map,key,value,what)=>{if(!map.has(key)&&map.size>=METADATA_LIMITS.results)throw unreadable(`more than ${METADATA_LIMITS.results} ${what}`);map.set(key,value);};
// The feature toggles a ServiceStudio.Common.dll defines: name -> {key (lowercase GUID), kind}, from the string constants
// of FeaturesValues' *Key fields and the return type of its get_<name> getters. A key without a getter of one of the
// provider's kinds is left out.
export function featureCatalog(commonDll){
 const m=readMetadata(commonDll);
 const type=m.findTypeDef(FEATURES_VALUES);
 if(!type)throw unreadable(`${FEATURES_VALUES.namespace}.${FEATURES_VALUES.name} is not defined there`);
 const {fields:[fieldFrom,fieldTo],methods:[methodFrom,methodTo]}=m.ownedRanges(type);
 const keys=new Map();
 // A string constant of 36 characters (72 bytes) on an owned field whose name ends with Key: one feature key.
 const consider=(type,valueIndex,fieldRow)=>{
  if(type!==0x0e||m.blobLength(valueIndex)!==72)return;
  const field=m.name(m.fieldNameIndex(fieldRow));if(field.length<=3||!field.endsWith('Key'))return;
  const value=m.blob(valueIndex).toString('utf16le');if(GUID.test(value))keep(keys,field.slice(0,-3),value.toLowerCase(),'feature keys');
 };
 if(!m.hasFieldPointers)m.eachConstant((type,tag,parentRow,valueIndex)=>{if(tag===0&&parentRow>=fieldFrom&&parentRow<fieldTo)consider(type,valueIndex,parentRow);});
 else for(let i=fieldFrom;i<fieldTo;i++){const r=m.fieldAt(i),c=m.constantOf(0,r);if(c)consider(c.type,c.valueIndex,r);}
 const kinds=new Map();
 for(let i=methodFrom;i<methodTo;i++){
  const {nameIndex,signatureIndex}=m.methodIndexes(m.methodAt(i));if(!m.nameIs(nameIndex,'get_',{prefix:true}))continue;
  const getter=m.name(nameIndex).slice(4);if(keys.has(getter)&&!kinds.has(getter))kinds.set(getter,returnKind(m.blob(signatureIndex)));
 }
 const catalog=new Map();
 for(const [name,key] of [...keys].sort(([a],[b])=>a.localeCompare(b)))if(kinds.get(name))catalog.set(name,{key,kind:kinds.get(name)});
 return catalog;
}
// The feature getters an assembly calls on ServiceStudio.Common.FeatureManagement.FeaturesValues (MemberRef rows whose
// parent is that TypeRef), sorted. Only the names of those rows are decoded.
export function featureReads(dll){
 const m=readMetadata(dll),out=new Map();
 m.eachMemberRef((tag,parentRow,nameIndex)=>{
  if(tag!==1||!m.nameIs(nameIndex,'get_',{prefix:true})||!m.typeRefIs(parentRow,FEATURES_VALUES))return;
  const name=m.name(nameIndex).slice(4);if(!out.has(name))keep(out,name,true,'feature reads');
 });
 return [...out.keys()].sort();
}
// Every GUID literal of an assembly's user strings, lowercase (the model features of OutSystems.Model.dll are declared
// with Guid.Parse("...")).
export function userStringGuids(dll){
 const out=new Map();
 readMetadata(dll).eachUserString(36,text=>{if(GUID.test(text)){const key=text.toLowerCase();if(!out.has(key))keep(out,key,true,'GUID literals');}});
 return new Set(out.keys());
}
