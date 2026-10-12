// Shared paths and readers of the UI tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONSOLE = path.resolve(HERE, '..');
export const PUBLIC = path.join(CONSOLE, 'public');
export const MOCK = path.join(PUBLIC, 'mock');

export const pub = (rel) => pathToFileURL(path.join(PUBLIC, ...rel.split('/'))).href;

export function readPublic(rel) {
  return fs.readFileSync(path.join(PUBLIC, ...rel.split('/')), 'utf8');
}

export function fixture(scenario, name) {
  return JSON.parse(fs.readFileSync(path.join(MOCK, scenario, `${name}.json`), 'utf8'));
}

/** Every file under public/ (relative, forward slashes). */
export function publicFiles() {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(PUBLIC, '');
  return out.sort();
}
