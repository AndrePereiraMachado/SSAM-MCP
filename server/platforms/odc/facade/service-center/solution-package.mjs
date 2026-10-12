import zlib from 'node:zlib';
import {ProtocolError} from './errors.mjs';

// Validate every entry without extracting paths or loading a module. This proves
// ZIP integrity only; module semantic validation belongs to the O11 platform.
export function validateSolutionPackage(body) {
  const invalid=()=>new ProtocolError('Solution download is not an intact supported ZIP package');
  try {
    if(!Buffer.isBuffer(body)||body.length<22||body.length>64*1024*1024)throw invalid();
    let end=-1;
    for(let i=body.length-22;i>=Math.max(0,body.length-65557);i--)
      if(body.readUInt32LE(i)===0x06054b50&&i+22+body.readUInt16LE(i+20)===body.length){end=i;break;}
    if(end<0||body.readUInt16LE(end+4)!==0||body.readUInt16LE(end+6)!==0)throw invalid();
    const count=body.readUInt16LE(end+10),size=body.readUInt32LE(end+12),offset=body.readUInt32LE(end+16);
    if(!count||count>20000||body.readUInt16LE(end+8)!==count||offset+size!==end)throw invalid();
    let p=offset,total=0;const names=new Set(),ranges=[];
    for(let i=0;i<count;i++){
      if(p+46>end||body.readUInt32LE(p)!==0x02014b50)throw invalid();
      const flags=body.readUInt16LE(p+8),method=body.readUInt16LE(p+10),crc=body.readUInt32LE(p+16);
      const compressed=body.readUInt32LE(p+20),length=body.readUInt32LE(p+24),nameLength=body.readUInt16LE(p+28);
      const next=p+46+nameLength+body.readUInt16LE(p+30)+body.readUInt16LE(p+32),local=body.readUInt32LE(p+42);
      if(next>end||(flags&1)||![0,8].includes(method)||body.readUInt16LE(p+34)!==0)throw invalid();
      const nameBytes=body.subarray(p+46,p+46+nameLength),name=nameBytes.toString('utf8');
      if(!name||name.includes('\\')||name.startsWith('/')||name.includes('\0')||name.includes(':')
          ||name.split('/').some(part=>part==='..'||part==='.')||names.has(name))throw invalid();
      names.add(name);total+=length;if(total>256*1024*1024)throw invalid();
      if(local+30>offset||body.readUInt32LE(local)!==0x04034b50||body.readUInt16LE(local+6)!==flags||body.readUInt16LE(local+8)!==method)throw invalid();
      const localNameLength=body.readUInt16LE(local+26),start=local+30+localNameLength+body.readUInt16LE(local+28);
      if(start+compressed>offset||!body.subarray(local+30,local+30+localNameLength).equals(nameBytes))throw invalid();
      if(!(flags&8)&&(body.readUInt32LE(local+14)!==crc||body.readUInt32LE(local+18)!==compressed||body.readUInt32LE(local+22)!==length))throw invalid();
      const raw=body.subarray(start,start+compressed);
      const output=method===0?raw:zlib.inflateRawSync(raw,{maxOutputLength:Math.max(1,length)});
      if(output.length!==length||(zlib.crc32(output)>>>0)!==crc)throw invalid();
      ranges.push([local,start+compressed]);p=next;
    }
    ranges.sort((a,b)=>a[0]-b[0]);
    if(p!==end||ranges.some((r,i)=>i&&r[0]<ranges[i-1][1]))throw invalid();
    return {format:'zip',entryCount:count,uncompressedBytes:total,crc32Verified:true,semanticValidation:false};
  } catch {throw invalid();}
}
