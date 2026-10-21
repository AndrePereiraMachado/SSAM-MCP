// Each version has one writer. Readers merge the newest observation per token.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { threePart, studioVersions } from './studio-identity.mjs';
export function versionStateDir(dir, version = process.env.SSAM_BACKEND_NAME) {
  if (!version) return path.join(dir, 'state');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(version)) throw new Error('Invalid backend name');
  return path.join(dir, 'versions', version, 'state');
}
const empty = () => ({schema:1, updated:null, tokens:{}, unserved:{odc:{},o11:{}}});
function read(file) {
  try { return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return empty(); throw e; }
}
function summarize(data) {
  data.unserved = {odc:{},o11:{}};
  for (const [id,token] of Object.entries(data.tokens)) for (const lane of ['odc','o11']) {
    const value = token[lane];
    if (!value?.unserved || !threePart(value.installed)) continue;
    const entry = data.unserved[lane][threePart(value.installed)] ??= {tokens:[],first:value.first,last:token.seen};
    entry.tokens.push(id);
    if (value.first < entry.first) entry.first = value.first;
    if (token.seen > entry.last) entry.last = token.seen;
  }
  return data;
}
export function recordStudioVersions(dir, state, compatible, seen, version = process.env.SSAM_BACKEND_NAME) {
  const folder = versionStateDir(dir, version);
  fs.mkdirSync(folder, {recursive:true});
  const file = path.join(folder, 'studio-versions.json');
  const data = read(file);
  const token = {customer:state.customer, seen, agent:threePart(state.hello?.agent?.version),
    packBridges:[state.hello?.pack?.odcBridge, state.hello?.pack?.o11BuiltFor].filter(v => typeof v === 'string' && /^[v\d.]+$/.test(v))};
  const versions = studioVersions(state.hello?.studios);
  for (const lane of ['odc','o11']) {
    const identity = compatible?.[lane]?.studio;
    const installed = identity?.installed ?? versions[lane];
    const unserved = !!identity && (identity.relation === 'newer' || !identity.ok);
    const previous = data.tokens[state.tokenId]?.[lane];
    token[lane] = {installed,running:[],unserved,
      first: previous?.installed === installed && previous?.unserved === unserved ? previous.first : seen};
  }
  data.tokens[state.tokenId] = token; data.updated = seen;
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(summarize(data)) + '\n', {mode:0o600});
    fs.renameSync(temp,file);
  } finally { fs.rmSync(temp,{force:true}); }
}
export function readStudioVersions(dir) {
  const files = [path.join(dir,'state','studio-versions.json')];
  try { for (const entry of fs.readdirSync(path.join(dir,'versions'),{withFileTypes:true})) {
    if (entry.isDirectory()) files.push(path.join(versionStateDir(dir,entry.name),'studio-versions.json'));
  } } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const result = empty();
  for (const file of files) {
    const data = read(file);
    for (const [id,token] of Object.entries(data.tokens)) {
      if (!result.tokens[id] || result.tokens[id].seen < token.seen) result.tokens[id] = token;
    }
    if (!result.updated || data.updated > result.updated) result.updated = data.updated;
  }
  return summarize(result);
}
