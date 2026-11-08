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
    if (/\.(dll|exe)$/i.test(f.path) && !['owner','microsoft'].includes(f.signer)) throw Error('Bridge executable signer is invalid.');
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
// What an offered bridge needs of the agent that runs it, by lane and first protocol number. From ODC bridge v106 on (U1 of the
// line) a merge may return before the bridge's verification ran (verification-not-started.json), and the server verifies it with
// reconcile-merge before any content proof: an agent that refuses that command leaves the merge MERGE_UNCERTAIN, with no way out
// but a manual publication in the Studio. So v106 and later go only to an agent whose hello lists reconcile-merge (agent.odcCommands,
// agent 0.3.6 and 0.4.3-native); an older agent keeps its own bridge, or is offered an older accepted one.
export const AGENT_NEEDS = Object.freeze([Object.freeze({ lane: 'odc', from: 106, commands: Object.freeze(['reconcile-merge']) })]);
const protocolNumber = protocol => /^[vd]\d+$/.test(protocol ?? '') ? Number(protocol.slice(1)) : -1;
// The commands the agent's hello declares for a lane (agent.odcCommands); none for an agent that predates the list.
const agentCommands = (hello, lane) => (lane === 'odc' && Array.isArray(hello?.agent?.odcCommands) ? hello.agent.odcCommands.filter(c => typeof c === 'string') : []);
// Whether the agent of this hello runs what the bridge of this lane and protocol needs.
export function agentRuns(hello, lane, protocol) {
  const have = agentCommands(hello, lane);
  return AGENT_NEEDS.filter(n => n.lane === lane && protocolNumber(protocol) >= n.from).every(n => n.commands.every(c => have.includes(c)));
}
// A bridge is built for one Studio runtime: never offer it to a Studio whose hello reports another (a net8 v107 is never the
// offer of a net10 1.7.30, where it would also turn the v106 into a downgrade of the pair). A hello without the runtime is not
// filtered here: the agent itself refuses a bridge of another runtime before installing it.
const sameRuntime = (hello, lane, manifest) => {
  const runtime = hello?.studios?.[lane]?.installed?.runtime;
  return typeof runtime !== 'string' || !runtime || manifest.runtime === runtime;
};
export function createBridgeStore({root = process.env.SSAM_BRIDGES_DIR || '/app/bridges', publicKey,
    keyFile = process.env.SSAM_BRIDGES_PUBLIC_KEY || '/app/bridges/public-key.pem'} = {}) {
  const key = publicKey || (()=>{try{return fs.readFileSync(keyFile);}catch{return null;}})();
  const cache = new Map();
  function read(lane, studioVersion, protocol) {
    if (!key || !['odc','o11'].includes(lane) || !version.test(studioVersion) || !/^(v\d+|d\d+)$/.test(protocol)) return null;
    try {
      const directory=path.join(root,lane,studioVersion,protocol);
      // Include each covered file and directory identity: an atomic replacement or
      // a changed byte count/mtime invalidates the cached verification.
      const fingerprint=dir=>fs.readdirSync(dir).sort().map(name=>{
        const file=path.join(dir,name),s=fs.lstatSync(file);
        if(s.isSymbolicLink())throw Error('Bridge link refused.');
        return name+':'+s.ino+':'+s.size+':'+s.mtimeMs+':'+s.ctimeMs+(s.isDirectory()?fingerprint(file):'');
      }).join('|');
      // The signed manifest and its signature (at most 256 KiB, read anyway to verify) also enter by content: a rewrite
      // of the same size inside one timestamp tick (a re-signed sequence or signer) is never served from the cache.
      // The covered files stay identified by their metadata (re-hashed only when it changes).
      const signed=['manifest.json','manifest.sig'].map(name=>{try{return sha(fs.readFileSync(path.join(directory,name)));}catch{return '-';}}).join(':');
      const stamp=signed+'|'+fingerprint(directory),prior=cache.get(directory);
      const value=prior?.stamp===stamp?prior.value:verifyBridge(directory,key);
      cache.set(directory,{stamp,value});
      return value.manifest.lane === lane && value.manifest.studioVersion === studioVersion && value.manifest.protocol === protocol ? value : null;
    } catch { return null; }
  }
  return {
    // hello: the agent's (agent-hub.mjs compatibility); without one, as before (no need and no runtime is checked).
    offer(lane, studioVersion, accepted, reports=[], hello=undefined) {
      let protocols=[];try{protocols=fs.readdirSync(path.join(root,lane,studioVersion));}catch{return null;}
      for(const protocol of protocols.filter(p=>accepted.includes(p)).sort((a,b)=>Number(b.slice(1))-Number(a.slice(1)))) {
        if(hello!==undefined&&!agentRuns(hello,lane,protocol))continue;
        const b=read(lane,studioVersion,protocol);
        if(b&&hello!==undefined&&!sameRuntime(hello,lane,b.manifest))continue;
        if(b&&!reports.some(r=>['failed','refused'].includes(r.status)&&r.lane===lane&&r.studioVersion===studioVersion&&r.protocol===protocol&&r.sequence>=b.manifest.sequence))return {lane,studioVersion,protocol,manifest:b.text,signature:b.signature};
      }
      return null;
    },
    file(lane, studioVersion, protocol, digest) {
      if(!/^[a-f0-9]{64}$/.test(digest))return null;
      return read(lane,studioVersion,protocol)?.files.get(digest) ?? null;
    }
  };
}
