// Source: raciocinio/scripts/15-consultas-repetidas.js; sha256: 3de7ae14589789a091be6e7633581bb4b0fb54c0a1fcd3f40bbf5efe58ceda96.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
export function queries(d) {
const per={};
for(const r of d.responses){const th=r.thread+(r.sub||"");for(const s of (r.sigs||[])){if(!/^ssam_reference/.test(s))continue;const c=s.replace(/\\"/g,'"');
 const kind=(c.match(/kind"?\s*:\s*"([^"]+)"/)||[])[1]||"?";const q=(c.match(/query"?\s*:\s*(\{[^}]*\}|"[^"]*")/)||[])[1]||"?";const key=kind+" "+q;
 const t=per[th]??={};(t[key]??=[]).push(r.ts.slice(11,19))}}

const values=Object.values(per).flatMap(t=>Object.values(t));return {per,total:values.reduce((n,v)=>n+v.length,0),repeated:values.reduce((n,v)=>n+Math.max(0,v.length-1),0)}; }
