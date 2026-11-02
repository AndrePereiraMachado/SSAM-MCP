import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export const PREFER_FOREIGN = 'merge:prefer-foreign';
const offers = new WeakMap();

// Cache only a successfully read offer, scoped to the connection, never a failed probe.
export function offersPreferForeign(link) {
  if (!link || typeof link.info !== 'function') return false;
  try {
    const info = link.info();
    if (!info?.connected) return false;
    const key = JSON.stringify([info.instance, info.connectedAt, info.pack?.odcBridge, info.agentOdcCommands]);
    const cached = offers.get(link);
    if (cached?.key === key) return cached.value;
    const version = /^v(\d+)$/.exec(info.pack?.odcBridge ?? '');
    const value = !!version && Number(version[1]) >= 108
      && Array.isArray(info.agentOdcCommands) && info.agentOdcCommands.includes(PREFER_FOREIGN);
    offers.set(link, { key, value });
    return value;
  } catch { return false; }
}

export function preparePreferForeign(file, link) {
  if (!offersPreferForeign(link)) return false;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.preferForeign = true;
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    fs.renameSync(temporary, file);
    return true;
  } catch { return false; }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}

export function preferredNote(resolved) {
  if (!resolved || !Array.isArray(resolved.entries)) return null;
  const clip = v => String(v ?? '').replace(/[\r\n]/g, ' ').slice(0, 200);
  const group = conflict => resolved.entries.filter(e => e.conflict === conflict).slice(0, 5)
    .map(e => `${clip(e.element)} ${clip(e.property)}: the person's "${clip(e.user)}", now the delivery's "${clip(e.delivery)}"`).join('; ');
  return `The Studio resolved conflicts in this same merge for the delivery: ${resolved.conflicts ?? 0} value(s) the delivery also changed; ${resolved.others ?? 0} other edit(s) of the person. `
    + [group(true), group(false)].filter(Boolean).join('; ')
    + (resolved.truncated ? ' The receipt reports additional replaced values in its total.' : '');
}
