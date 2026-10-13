// The tool names the console shows (privacy re-check of 2026-10-12, low finding): a tool name is the client's own text,
// so only a tool of the image's hosted catalog is kept (CONSOLE_TOOLS_CATALOG, the image's
// /app/platforms/odc/facade/hosted/tools.json; in the SSAM-MCP box, server/platforms/odc/facade/hosted/tools.json). Any
// other name is '?'. Since the combined line the server writes '?' itself in the audit and in server.log; the console also
// closes the names of older lines (audit and server.log written by images up to prod-20261012-a857a1e). An unreadable
// catalog keeps no name (fail closed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const IMAGE_TOOLS_CATALOG = '/app/platforms/odc/facade/hosted/tools.json';
export const BOX_TOOLS_CATALOG = path.resolve(here, '..', '..', 'platforms', 'odc', 'facade', 'hosted', 'tools.json');
export const defaultToolsCatalog = (exists = fs.existsSync) => [IMAGE_TOOLS_CATALOG, BOX_TOOLS_CATALOG].find(f => exists(f)) ?? IMAGE_TOOLS_CATALOG;

export function loadToolNames(file, { readFile = fs.readFileSync } = {}) {
  try {
    const tools = JSON.parse(readFile(file, 'utf8'))?.tools;
    return new Set(tools && typeof tools === 'object' ? Object.keys(tools).filter(k => /^[a-z][a-z0-9_]{0,63}$/.test(k)) : []);
  } catch { return new Set(); }
}
export const toolOf = (name, tools) => (typeof name === 'string' && tools instanceof Set && tools.has(name) ? name : '?');
