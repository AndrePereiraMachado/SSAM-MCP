// Immutable, signed client bridges. The public key belongs to the server image;
// an upload never supplies its own trust anchor. No filesystem paths leave here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, verify} from 'node:crypto';
const sha = b => createHash('sha256').update(b).digest('hex');
const version = /^\d+\.\d+\.\d+$/;
export function verifyBridge(directory, publicKey) {
  const bytes = fs.readFileSync(path.join(directory, 'manifest.json'));
  if (bytes.length > 256 * 1024) throw Error('Bridge manifest too large.');
  const signature = fs.readFileSync(path.join(directory, 'manifest.sig'));
  if (!verify(null, bytes, publicKey, signature)) throw Error('Bridge manifest signature is invalid.');
  const m = JSON.parse(bytes);
  if (m.schema !== 1 || !['odc','o11'].includes(m.lane) || !version.test(m.studioVersion) ||
      !/^(v\d+|d\d+)$/.test(m.protocol) || !Number.isSafeInteger(m.sequence) || m.sequence<1 || !/^net\d+\.\d+$/.test(m.runtime) ||
      !/^[a-fA-F0-9]{40}$/.test(m.authenticodeThumbprint) || !Array.isArray(m.files) || !m.files.length || m.files.length > 128)
    throw Error('Bridge manifest identity is invalid.');
  const files = new Map(), names = new Set();
  for (const f of m.files) {
    if (!/^(bridge|client|hook)\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(f.path) || names.has(f.path) ||
        !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 1 || f.size > 64 * 1024 * 1024)
      throw Error('Bridge file entry is invalid.');
    names.add(f.path);
    const file = path.join(directory, f.path), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== f.size || sha(fs.readFileSync(file)) !== f.sha256)
      throw Error('Bridge file integrity check failed.');
    const folder = fs.lstatSync(path.dirname(file));
    if (folder.isSymbolicLink()) throw Error('Bridge directory must not be a link.');
    files.set(f.sha256, file);
  }
  return {manifest:m, text:bytes.toString('utf8'), signature:signature.toString('base64'), files};
}
export function createBridgeStore({root = process.env.SSAM_BRIDGES_DIR || '/app/bridges', publicKey,
    keyFile = process.env.SSAM_BRIDGES_PUBLIC_KEY || '/app/bridges/public-key.pem'} = {}) {
  const key = publicKey || (()=>{try{return fs.readFileSync(keyFile);}catch{return null;}})();
  function read(lane, studioVersion, protocol) {
    if (!key || !['odc','o11'].includes(lane) || !version.test(studioVersion) || !/^(v\d+|d\d+)$/.test(protocol)) return null;
    try {
      const value = verifyBridge(path.join(root,lane,studioVersion,protocol),key);
      return value.manifest.lane === lane && value.manifest.studioVersion === studioVersion && value.manifest.protocol === protocol ? value : null;
    } catch { return null; }
  }
  return {
    offer(lane, studioVersion, accepted, reports=[]) {
      let protocols=[];try{protocols=fs.readdirSync(path.join(root,lane,studioVersion));}catch{return null;}
      for(const protocol of protocols.filter(p=>accepted.includes(p)).sort((a,b)=>Number(b.slice(1))-Number(a.slice(1)))) {
        const b=read(lane,studioVersion,protocol);
        if(b&&!reports.some(r=>r.status==='failed'&&r.lane===lane&&r.studioVersion===studioVersion&&r.protocol===protocol&&r.sequence>=b.manifest.sequence))return {lane,studioVersion,protocol,manifest:b.text,signature:b.signature};
      }
      return null;
    },
    file(lane, studioVersion, protocol, digest) {
      if(!/^[a-f0-9]{64}$/.test(digest))return null;
      return read(lane,studioVersion,protocol)?.files.get(digest) ?? null;
    }
  };
}
