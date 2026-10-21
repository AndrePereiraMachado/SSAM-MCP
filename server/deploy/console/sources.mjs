import {studioVersions} from './studio-versions.mjs';
import {runtimeDirectories} from '../../platforms/odc/facade/hosted/storage.mjs';
// Small read-only sources of the state volume (DESIGN 3.1): machine-pins.json and kernel.json (re-read on mtime change),
// the access alert lines of access-alerts.jsonl (kept for 30 days, counted per token) and the sizes of server.log*,
// audit-*, quality-* (DESIGN-QUALIDADE 4.1) and console-audit.jsonl (stat every 60 s). Customer-controlled fields are
// capped here.
import fs from 'node:fs';
import path from 'node:path';
import { cap } from './texts.mjs';

const DAY_MS = 86400000;
const TOKEN = /^tok_[0-9a-f]{12}$/;

function onChange(file, parse) {
  let stamp = null, value = null;
  return () => {
    let st;
    try { st = fs.statSync(file); } catch { stamp = null; value = null; return value; }
    const s = `${st.mtimeMs}:${st.size}`;
    if (s !== stamp) {
      stamp = s;
      try { value = parse(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))); } catch { value = null; }
    }
    return value;
  };
}
const machine = m => (m && typeof m === 'object' ? { id: cap(m.id ?? null, 32), name: cap(m.name ?? null, 64), user: cap(m.user ?? null, 64), at: typeof m.at === 'string' ? m.at : null } : null);

export function createSources({ serverDir, now = Date.now }) {
  const pinReaders=new Map();
  const pins=()=>{
    const out={};
    for(const dir of runtimeDirectories(serverDir)){
      if(!pinReaders.has(dir))pinReaders.set(dir,onChange(path.join(dir,'machine-pins.json'),data=>data));
      const data=pinReaders.get(dir)();
      if(data&&typeof data==='object')for(const [tok,m]of Object.entries(data))if(TOKEN.test(tok)&&(!out[tok]||m.at<out[tok].at))out[tok]=machine(m);
    }
    return out;
  };
  const legacyKernel = onChange(path.join(serverDir, 'kernel.json'), data => (data && typeof data === 'object' ? {
    o11: data.o11 ?? null, odc: data.odc ?? null, odcBridge: data.odcBridge ?? null, o11Hook: data.o11Hook ?? null,
    odcBridgeAccepted: Array.isArray(data.odcBridgeAccepted) ? data.odcBridgeAccepted.map(String) : null,
  } : null));

  const kernels=new Map();
  const kernel=()=>{
    const current=studioVersions(serverDir).rows.find(r=>r.status==='default'&&r.backend!=='legacy');
    if(current){const file=path.join(serverDir,'versions',current.backend,'kernel.json');if(!kernels.has(file))kernels.set(file,onChange(file,data=>data));const data=kernels.get(file)();if(data)return data;}
    return legacyKernel();
  };
  let access = [];               // lines of the last 30 days
  let accessCounts = {};         // token -> lines seen (all retained)
  let accessOrigins = {};
  function addAccess(line, origin = '.') {
    const token = typeof line.token === 'string' && TOKEN.test(line.token) ? line.token : null;
    if (!token) return;
    accessCounts[token] = (accessCounts[token] ?? 0) + 1;
    const counts = accessOrigins[origin] ??= {}; counts[token] = (counts[token] ?? 0) + 1;
    access.push({ origin, time: line.time, token, customer: cap(line.customer ?? null, 64), first: machine(line.first), machine: machine(line.machine), ip: cap(line.ip ?? null, 64) });
    const floor = now() - 30 * DAY_MS;
    access = access.filter(a => Date.parse(a.time) >= floor).slice(-1000);
  }
  function resetAccess(origin) {
    if(origin === undefined){access=[];accessCounts={};accessOrigins={};return;}
    for(const [token,n] of Object.entries(accessOrigins[origin]??{})){accessCounts[token]=Math.max(0,(accessCounts[token]??0)-n);}
    delete accessOrigins[origin];access=access.filter(a=>(a.origin??'.')!==origin);
  }

  let sizes = { serverLogB: 0, rotatedCount: 0, rotatedB: 0, auditFiles: 0, auditB: 0, qualityFiles: 0, qualityB: 0, consoleAuditB: 0, at: 0 };
  function statFiles(force = false) {
    if (!force && now() - sizes.at < 60000) return sizes;
    const next = { serverLogB: 0, rotatedCount: 0, rotatedB: 0, auditFiles: 0, auditB: 0, qualityFiles: 0, qualityB: 0, consoleAuditB: 0, at: now() };
    for(const runtime of runtimeDirectories(serverDir)){
    let names = [];
    try { names = fs.readdirSync(runtime); } catch { /* unreadable: zeros */ }
    for (const name of names) {
      let size = 0;
      const kind = name === 'server.log' ? 'log' : /^server\.log\..+/.test(name) ? 'rotated' : /^audit-\d{8}\.jsonl(\.gz)?$/.test(name) ? 'audit'
        : /^quality-\d{8}\.jsonl(\.gz)?$/.test(name) ? 'quality' : name === 'console-audit.jsonl' ? 'console' : null;
      if (!kind) continue;
      try { size = fs.statSync(path.join(runtime, name)).size; } catch { continue; }
      if (kind === 'log') next.serverLogB += size;
      else if (kind === 'rotated') { next.rotatedCount++; next.rotatedB += size; }
      else if (kind === 'audit') { next.auditFiles++; next.auditB += size; }
      else if (kind === 'quality') { next.qualityFiles++; next.qualityB += size; }
      else next.consoleAuditB = size;
    }
    }
    sizes = next;
    return sizes;
  }

  return {
    studioVersions:()=>studioVersions(serverDir), pins, kernel, addAccess, resetAccess, statFiles,
    access: () => { const floor = now() - 30 * DAY_MS; return access.filter(a => Date.parse(a.time) >= floor).map(({origin,...entry})=>entry); },
    accessCount: token => accessCounts[token] ?? 0,
    toJSON: () => ({ access, accessCounts, accessOrigins }),
    restore(saved) { access = Array.isArray(saved?.access) ? saved.access : []; accessCounts = saved?.accessCounts ?? {}; accessOrigins = saved?.accessOrigins ?? {'.':{...accessCounts}}; },
  };
}
