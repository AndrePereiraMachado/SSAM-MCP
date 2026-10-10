import path from 'node:path';
import crypto from 'node:crypto';

export const serverName = 'odc3';

export function registrationCommand(nodePath, entryPath) {
  if (![nodePath, entryPath].every(value => typeof value === 'string' && path.isAbsolute(value) && !/[\r\n]/.test(value))) {
    throw new Error('Node and ODC3 entry must be absolute local paths.');
  }
  return ['mcp', 'add', serverName, '--', nodePath, entryPath];
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function unrelatedServersDigest(entries) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(entries.filter(entry => entry.name !== serverName)
    .sort((a, b) => a.name.localeCompare(b.name))))).digest('hex');
}

export function matchesRegistration(entry, nodePath, entryPath) {
  return entry?.enabled === true && entry.transport?.type === 'stdio'
    && typeof entry.transport.command === 'string'
    && path.resolve(entry.transport.command) === path.resolve(nodePath)
    && entry.transport.args?.length === 1 && typeof entry.transport.args[0] === 'string'
    && path.resolve(entry.transport.args[0]) === path.resolve(entryPath)
    && !Object.keys(entry.transport.env ?? {}).length;
}

export function safeRegistrationSummary(entries) {
  return entries.map(entry => ({ name: entry.name, enabled: entry.enabled, transport: entry.transport?.type }));
}

// The CLI uses TOML-aware edits. Independently verify every non-target line is
// preserved except spacing. Never log the resulting text: it may contain secrets.
export function nonTargetConfigDigest(text) {
  let inTarget = false;
  const outside = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      const name = header[1].replace(/['"]/g, '');
      inTarget = name === `mcp_servers.${serverName}` || name.startsWith(`mcp_servers.${serverName}.`);
    }
    if (!inTarget && line.trim()) outside.push(line.trim());
  }
  return crypto.createHash('sha256').update(outside.join('\n')).digest('hex');
}
