import zlib from 'node:zlib';
import {fail} from './errors.mjs';

// Creation accepts a bounded PNG value, bound to the complete approved body.
// No local file or remote URL is fetched on behalf of this field.
export function validateAssetIcon(value){
 const bad=()=>fail('ASSET_ICON_INVALID','Asset icon must be a bounded, intact square RGB/RGBA PNG encoded as canonical base64.');
 if(typeof value!=='string'||!value.length||value.length>3*1024*1024)bad();
 const b=Buffer.from(value,'base64');
 if(b.toString('base64')!==value||b.length<57||!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))bad();
 let p=8,width,height,color,ended=false;const data=[];
 while(p+12<=b.length){
  const n=b.readUInt32BE(p),type=b.toString('ascii',p+4,p+8);
  if(n>b.length-p-12||(zlib.crc32(b.subarray(p+4,p+8+n))>>>0)!==b.readUInt32BE(p+8+n))bad();
  if(p===8){
   if(type!=='IHDR'||n!==13)bad();
   width=b.readUInt32BE(p+8);height=b.readUInt32BE(p+12);color=b[p+17];
   if(width<1||width>2048||height!==width||b[p+16]!==8||![2,6].includes(color)||b[p+18]||b[p+19]||b[p+20])bad();
  }else if(type==='IHDR')bad();
  if(type==='IDAT')data.push(b.subarray(p+8,p+8+n));
  p+=n+12;
  if(type==='IEND'){if(n!==0||p!==b.length)bad();ended=true;break;}
 }
 if(!ended||!data.length)bad();
 const stride=width*(color===2?3:4)+1,size=stride*height;
 let pixels;try{pixels=zlib.inflateSync(Buffer.concat(data),{maxOutputLength:size+1});}catch{bad();}
 if(pixels.length!==size)bad();
 for(let row=0;row<height;row++)if(pixels[row*stride]>4)bad();
 return {format:'png',width,height,byteLength:b.length};
}
