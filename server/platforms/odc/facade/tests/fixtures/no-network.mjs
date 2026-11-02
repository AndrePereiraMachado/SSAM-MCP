// fase4-28 r4-rest-hosted (review B4): "nothing was fetched" watches every way this process reaches the network, not only
// globalThis.fetch: node:http and node:https (request, get; the hosted public-only client uses them with its own lookup),
// node:net connect, and DNS (dns.lookup, dns.promises.lookup). While watching, each attempt is recorded and fails; the named
// ESM exports follow (syncBuiltinESMExports). allow(url|host) lets a call through (the test's own loopback server).
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

export function watchNetwork({ allow = () => false } = {}) {
  const asked = [];
  const saved = { fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get,
    lookup: dns.lookup, promisesLookup: dns.promises.lookup, connect: net.connect, createConnection: net.createConnection };
  const deny = (kind, target) => { asked.push(kind + ' ' + target); return new Error('the network was asked (' + kind + '): ' + target); };
  const target = args => { const first = args[0]; return typeof first === 'string' || first instanceof URL ? String(first) : first?.host ?? first?.hostname ?? JSON.stringify(first ?? null); };
  globalThis.fetch = async (url, options) => { if (allow(String(url))) return saved.fetch(url, options); throw deny('fetch', String(url)); };
  for (const [module, key, kind] of [[http, 'request', 'http.request'], [http, 'get', 'http.get'], [https, 'request', 'https.request'], [https, 'get', 'https.get']]) {
    const original = module[key];
    module[key] = (...args) => { if (allow(target(args))) return original.apply(module, args); throw deny(kind, target(args)); };
  }
  for (const key of ['connect', 'createConnection']) {
    const original = net[key];
    net[key] = (...args) => {
      const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : null;
      if (options?.path) return original.apply(net, args); // a named pipe or a socket file of this machine
      const t = options ? String(options.host ?? 'localhost') + ':' + String(options.port ?? '') : String(args[1] ?? 'localhost') + ':' + String(args[0]);
      if (allow(t)) return original.apply(net, args);
      throw deny('net.' + key, t);
    };
  }
  dns.lookup = (host, ...rest) => { if (allow(String(host))) return saved.lookup.call(dns, host, ...rest); const cb = rest.find(r => typeof r === 'function'); const error = deny('dns.lookup', String(host)); if (cb) return process.nextTick(() => cb(error)); throw error; };
  dns.promises.lookup = async host => { if (allow(String(host))) return saved.promisesLookup.call(dns.promises, host); throw deny('dns.promises.lookup', String(host)); };
  syncBuiltinESMExports();
  return {
    asked,
    restore() {
      globalThis.fetch = saved.fetch; http.request = saved.httpRequest; http.get = saved.httpGet; https.request = saved.httpsRequest; https.get = saved.httpsGet;
      dns.lookup = saved.lookup; dns.promises.lookup = saved.promisesLookup; net.connect = saved.connect; net.createConnection = saved.createConnection;
      syncBuiltinESMExports();
    },
  };
}
