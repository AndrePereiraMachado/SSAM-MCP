// Only this exact encrypted, per-connection exception has a typed approval path.
// Other connection strings stay opaque and cannot use the temporary cleanup gate.
export function temporaryTlsPolicy(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const pairs=value.split(';').map(v=>v.trim()).filter(Boolean).map(v=>v.split('=').map(s=>s.trim().toLowerCase()));
  if (pairs.length!==2 || pairs.some(p=>p.length!==2) || new Set(pairs.map(p=>p[0])).size!==2) return null;
  const map=new Map(pairs);
  return map.get('encrypt')==='true' && map.get('trustservercertificate')==='true' ? 'encrypted-unverified-server' : null;
}
