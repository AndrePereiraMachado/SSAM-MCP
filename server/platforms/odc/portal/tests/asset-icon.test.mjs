import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {validateAssetIcon} from '../runtime/asset-icon.mjs';
function chunk(type,data){const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(zlib.crc32(b.subarray(4,-4))>>>0,b.length-4);return b;}
export function icon(){const h=Buffer.alloc(13);h.writeUInt32BE(1);h.writeUInt32BE(1,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(Buffer.from([0,20,30,40]))),chunk('IEND',Buffer.alloc(0))]);}
test('asset PNG validation rejects malformed base64, bad CRC, truncated streams and excess bytes',()=>{
 const b=icon();assert.equal(validateAssetIcon(b.toString('base64')).width,1);
 const corrupt=Buffer.from(b);corrupt[20]^=1;
 for(const value of ['https://example.test/icon','data:image/png;base64,'+b.toString('base64'),b.toString('base64')+'\n',corrupt.toString('base64'),b.subarray(0,-1).toString('base64'),Buffer.concat([b,Buffer.from([0])]).toString('base64'),'A'.repeat(3*1024*1024+1)])
  assert.throws(()=>validateAssetIcon(value),e=>e.code==='ASSET_ICON_INVALID');
});
