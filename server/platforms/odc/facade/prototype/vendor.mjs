// CDN scripts of a prototype (docs/PROTOTIPO-NATIVO.md 2.1): only allowlisted hosts, only from the content-addressed
// cache %USERPROFILE%\.ssam-hybrid\prototype-vendor\<sha256>. The facade may download into the cache outside the child
// process (GET, no cookies, <= 5 MB); without cache and network, or for another host, the capture refuses with the
// mapping.vendor patch. The IR keeps URL and sha256; determinism comes from the hash.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sha256 } from './ir.mjs';

export const VENDOR_HOSTS = Object.freeze(['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'esm.sh', 'cdn.tailwindcss.com', 'code.jquery.com', 'cdn.skypack.dev']);
export const VENDOR_MAX_BYTES = 5 * 1024 * 1024;

export function defaultVendorCache() {
  return path.join(process.env.USERPROFILE || os.homedir(), '.ssam-hybrid', 'prototype-vendor');
}

export function isRemote(url) { return /^https?:\/\//i.test(String(url)) && !String(url).startsWith('http://prototype.ssam'); }

export function vendorHostAllowed(url) {
  try { return VENDOR_HOSTS.includes(new URL(url).hostname.toLowerCase()); } catch { return false; }
}

function readIndex(cacheDir) {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8')); } catch { return {}; }
}

function fromCache(cacheDir, url) {
  const index = readIndex(cacheDir);
  const hash = index[url];
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  let data;
  try { data = fs.readFileSync(path.join(cacheDir, hash)); } catch { return null; }
  return sha256(data) === hash ? data : null;
}

export function storeInCache(cacheDir, url, data) {
  const hash = sha256(data);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, hash), data);
  const index = readIndex(cacheDir);
  index[url] = hash;
  fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify(index, null, 2));
  return hash;
}

// Default downloader (facade side, never in the child): GET without cookies, capped at 5 MB.
export async function downloadVendor(url) {
  const response = await fetch(url, { method: 'GET', credentials: 'omit', redirect: 'follow' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > VENDOR_MAX_BYTES) throw new Error('larger than 5 MB');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Subresource integrity (integrity="sha384-..."): whether the bytes are the ones the page pinned (no integrity: true).
export function integrityMatches(data, integrity) {
  const pins = String(integrity ?? '').trim().split(/\s+/).filter(Boolean).map(token => /^(sha256|sha384|sha512)-(.+)$/.exec(token)).filter(Boolean);
  if (!pins.length) return true;
  return pins.some(([, algorithm, digest]) => createHash(algorithm).update(data).digest('base64') === digest);
}

// A copy of a CDN script inside the prototype folder: <source>/vendor/<file name> (where the mapping.vendor patch points) or
// <source>/<file name>, accepted when the page's integrity pins it (or, without integrity, by its place in vendor/).
function fromFolder(source, url, integrity) {
  if (!source) return null;
  let name = null;
  try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''); } catch { return null; }
  if (!name) return null;
  for (const [file, needsPin] of [[path.join(source, 'vendor', name), false], [path.join(source, name), true]]) {
    let data;
    try { data = fs.readFileSync(file); } catch { continue; }
    if ((needsPin && !integrity) || !integrityMatches(data, integrity)) continue;
    return { data, file };
  }
  return null;
}

// Resolves every remote script URL: mapping.vendor (local file) > cache > a copy in the prototype folder > download (never in
// the hosted SSAM: download null). A pinned integrity (SRI) is checked on whatever bytes are found: a cache or a download
// that does not match is never run. Problems are returned, never thrown.
export async function resolveVendors(urls, { mapping = {}, cacheDir = defaultVendorCache(), download = null, source, integrity = {} } = {}) {
  const vendors = new Map(), problems = [];
  for (const url of [...new Set(urls)].sort()) {
    const local = mapping.vendor?.[url];
    if (local) {
      const file = path.isAbsolute(local) ? local : path.resolve(source ?? '.', local);
      try {
        const data = fs.readFileSync(file);
        vendors.set(url, { url, sha256: sha256(data), text: data.toString('utf8'), from: 'mapping' });
      } catch (error) {
        problems.push({ url, reason: 'mapping-file', message: 'mapping.vendor["' + url + '"] = ' + local + ' cannot be read: ' + error.message });
      }
      continue;
    }
    if (!vendorHostAllowed(url)) {
      problems.push({ url, reason: 'host', message: 'script ' + url + ' comes from a host outside the CDN allowlist (' + VENDOR_HOSTS.join(', ') + ')' });
      continue;
    }
    const pin = integrity[url] ?? null;
    let data = fromCache(cacheDir, url);
    let from = 'cache';
    if (data && !integrityMatches(data, pin)) data = null;
    if (!data) { const local = fromFolder(source, url, pin); if (local) { data = local.data; from = 'folder'; } }
    if (!data && typeof download === 'function') {
      try {
        data = await download(url);
        if (data.length > VENDOR_MAX_BYTES) throw new Error('larger than 5 MB');
        if (!integrityMatches(data, pin)) throw new Error('the bytes downloaded do not match the integrity ' + pin + ' the page pins');
        storeInCache(cacheDir, url, data);
        from = 'download';
      } catch (error) {
        problems.push({ url, reason: 'download', message: 'script ' + url + ' is not in the vendor cache and could not be downloaded: ' + error.message });
        continue;
      }
    }
    if (!data) { problems.push({ url, reason: 'offline', message: 'script ' + url + ' is not in the vendor cache ' + cacheDir + ' and there is no network' }); continue; }
    vendors.set(url, { url, sha256: sha256(data), text: data.toString('utf8'), from });
  }
  return { vendors, problems };
}

// Suggested local file for the mapping.vendor patch: <source>\vendor\<file name of the URL>.
export function suggestedVendorPath(source, url) {
  let name = 'script.js';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || name); } catch { /* keep default */ }
  return path.join(source, 'vendor', name.replace(/[^A-Za-z0-9._@-]/g, '_'));
}
