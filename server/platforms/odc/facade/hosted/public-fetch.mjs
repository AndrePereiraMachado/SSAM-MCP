// Where a hosted server may send a GET for a customer (servidor/fase4-24, finding 3 of the confinement review of the 24th
// release). A soap/rest op of a hosted job names its WSDL or OpenAPI document by URL, and integration-documents.mjs reads
// it FROM THE SERVER and pins it into the customer's workspace with its sha256 and size: without a rule a customer could
// make the server read its own loopback services, the private network around it or the cloud metadata address, and get
// the bytes back through the pinned copy. In hosted mode a document URL must reach a PUBLIC address:
//   - publicUrlProblem(url, {lookup}) -> null | {code, message}: before every GET and every redirect hop, the host (an IP
//     literal, or every address its name resolves to) must be public; a name that resolves to one address that is not is
//     refused whole;
//   - createPublicFetch({lookup}) -> the fetch of the hosted server: node:http/https with the same check AT CONNECT TIME
//     (the lookup of the socket itself), so a name that answers a public address to the first lookup and a private one
//     to the next (DNS rebinding) still never connects; redirects are never followed by it (the caller re-checks each).
// Not public: 0/8, 10/8, 100.64/10 (shared, Alibaba's metadata), 127/8, 169.254/16 (link-local, the AWS/GCP/Azure/OCI
// metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4,
// 240/4 and 168.63.129.16 (Azure's wire server); IPv6 ::/128, ::1, 100::/64, 2001::/23, 2001:db8::/32, fc00::/7 (also
// AWS fd00:ec2::254), fe80::/10, fec0::/10, ff00::/8, 64:ff9b:1::/48; an IPv6 address that carries an IPv4 one
// (::a.b.c.d, ::ffff:a.b.c.d, 64:ff9b::a.b.c.d, 2002:aabb:ccdd::) is judged by that IPv4 address.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const HOST_NOT_PUBLIC = 'DOCUMENT_HOST_NOT_PUBLIC';
export const MAX_REDIRECTS = 5;

const V4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4],
  ['240.0.0.0', 4], ['168.63.129.16', 32]];
const V6 = [['::', 128], ['::1', 128], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['64:ff9b:1::', 48]];
const BLOCKED = new net.BlockList();
for (const [network, prefix] of V4) BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of V6) BLOCKED.addSubnet(network, prefix, 'ipv6');

// The eight 16-bit groups of an IPv6 address (a trailing dotted IPv4 and '::' expanded; a zone index dropped), or null.
function groups6(ip) {
  let text = String(ip).toLowerCase().split('%')[0];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const b = dotted[2].split('.').map(Number);
    if (b.some(n => n > 255)) return null;
    text = dotted[1] + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail].map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return all.length === 8 && all.every(Number.isInteger) ? all : null;
}
const v4Of = (high, low) => [high >> 8, high & 255, low >> 8, low & 255].join('.');
// The IPv4 address an IPv6 one carries (IPv4-compatible, IPv4-mapped, NAT64 well-known prefix, 6to4), or null.
function embeddedV4(g) {
  if (g.slice(0, 5).every(n => n === 0) && (g[5] === 0 || g[5] === 0xffff)) return v4Of(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(n => n === 0)) return v4Of(g[6], g[7]);
  if (g[0] === 0x2002) return v4Of(g[1], g[2]);
  return null;
}

/** True when ip is not a public address (or not an address at all): the hosted server never connects there. */
export function blockedAddress(ip) {
  const family = net.isIP(String(ip ?? ''));
  try {
    if (family === 4) return BLOCKED.check(ip, 'ipv4');
    if (family !== 6) return true;
    const g = groups6(ip);
    if (!g) return true;
    const embedded = embeddedV4(g);
    if (embedded) return blockedAddress(embedded);
    return BLOCKED.check(String(ip).split('%')[0], 'ipv6');
  } catch { return true; }
}

const hostOf = url => url.hostname.replace(/^\[|\]$/g, '');
const notPublic = url => ({ code: HOST_NOT_PUBLIC,
  message: `${url} is not a public address of the internet (loopback, private network, link-local, reserved or cloud metadata): a hosted SSAM server reads documents only from public addresses` });
// dns.lookup with every address of the name, as {address, family}[].
const lookupAll = (lookup, host) => new Promise((resolve, reject) =>
  lookup(host, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }]))));

/**
 * Whether a hosted server may GET this URL: null, or {code, message} (DOCUMENT_HOST_NOT_PUBLIC, UNSUPPORTED_DOCUMENT_SCHEME,
 * DOCUMENT_NOT_FOUND when the name does not resolve). lookup: dns.lookup's signature (tests pass their own).
 */
export async function publicUrlProblem(url, { lookup = dns.lookup, blocked = blockedAddress } = {}) {
  let target;
  try { target = new URL(url); } catch { return { code: 'UNSUPPORTED_DOCUMENT_SCHEME', message: `'${url}' is not a URL` }; }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return { code: 'UNSUPPORTED_DOCUMENT_SCHEME', message: `'${url}' is not an http or https URL` };
  const host = hostOf(target);
  if (net.isIP(host)) return blocked(host) ? notPublic(url) : null;
  let addresses;
  try { addresses = await lookupAll(lookup, host); } catch { return { code: 'DOCUMENT_NOT_FOUND', message: `GET ${url} failed: the name ${host} does not resolve` }; }
  if (!addresses.length || addresses.some(a => blocked(a?.address))) return notPublic(url);
  return null;
}

/**
 * The fetch of a hosted server: GET over node:http/https whose socket lookup refuses any address that is not public (at
 * connect time, so DNS rebinding never connects), an IP literal checked before connecting, redirects never followed (a
 * 3xx is answered as it is), and the body cut after maxBytes (the caller sees more than its limit and refuses).
 * Answers the subset of a fetch Response the document reader uses: {ok, status, headers.get, arrayBuffer(), body.cancel()}.
 */
export function createPublicFetch({ lookup = dns.lookup, blocked = blockedAddress, maxBytes = Infinity } = {}) {
  const checkedLookup = (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    lookup(hostname, { ...(options ?? {}), all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (!list.length || list.some(a => blocked(a?.address)))
        return callback(Object.assign(new Error(`${hostname} resolves to an address that is not public`), { code: HOST_NOT_PUBLIC }));
      if (options?.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
  return (url, { method = 'GET', headers = {}, signal } = {}) => new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (error) { reject(error); return; }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') { reject(Object.assign(new Error(`'${url}' is not an http or https URL`), { code: 'UNSUPPORTED_DOCUMENT_SCHEME' })); return; }
    const host = hostOf(target);
    if (net.isIP(host) && blocked(host)) { reject(Object.assign(new Error(notPublic(url).message), { code: HOST_NOT_PUBLIC })); return; }
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(target, { method, headers, signal, lookup: checkedLookup, agent: false }, response => {
      const status = response.statusCode ?? 0;
      resolve({
        ok: status >= 200 && status < 300, status, url: String(url),
        headers: { get: name => { const value = response.headers[String(name).toLowerCase()]; return value === undefined ? null : Array.isArray(value) ? value.join(', ') : String(value); } },
        body: { cancel: async () => { response.destroy(); } },
        arrayBuffer: () => new Promise((done, fail) => {
          const chunks = [];
          let size = 0, settled = false;
          const finish = () => { if (settled) return; settled = true; const all = Buffer.concat(chunks); done(all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength)); };
          response.on('data', chunk => {
            if (settled) return;
            chunks.push(chunk); size += chunk.length;
            if (size > maxBytes) { finish(); response.destroy(); }
          });
          response.on('end', finish);
          response.on('error', error => { if (!settled) { settled = true; fail(error); } });
          response.on('aborted', () => { if (!settled) { settled = true; fail(Object.assign(new Error('aborted'), { name: 'AbortError' })); } });
        }),
      });
    });
    request.on('error', reject);
    request.end();
  });
}
