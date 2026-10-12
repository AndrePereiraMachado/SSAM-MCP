// A fake agent hub (the server side of ssam-agent/1, docs/FASE2-AGENTE.md 2.3) for the agent tests. It answers hello
// with a welcome, keeps one NDJSON stream, records upstream messages and serves blob parts. Tests script everything
// else (calls, pings, closes, dropped POSTs, corrupted parts) through the returned object.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { listenInRange } from './ports.mjs';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const readBody = req => new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });

export async function fakeHub({ credential, kernel = { odc: '1.7.27', o11: '11.55.91', odcBridge: 'v35' }, welcome = {} } = {}) {
  const waiters = [];
  const hub = {
    hellos: [], messages: [], requests: [], posts: 0, deletes: 0, blobGets: 0, blobPuts: 0, streams: 0,
    helloStatus: [],       // statuses for the next hellos (else 200 + welcome)
    holdHellos: 0,         // the next N hellos are read and never answered
    dropPosts: 0,          // the next N POST /messages lose their connection without an answer
    holdPosts: 0,          // the next N POST /messages wait for release() and are then answered as the hub is by then
    holdStreams: 0,        // the next N stream GETs never get response headers (C03: a stream that does not open)
    held: [],
    corruptPuts: 0,        // the next N blob PUTs are answered 400 PART_HASH_MISMATCH
    holdPuts: 0,           // the next N blob PUTs are read and never answered (a stalled connection; the part is not kept)
    holdGets: 0,           // the next N blob GETs are never answered
    blobSockets: [],       // the client port of every blob request (a new port = a new connection)
    corruptParts: new Set(), // "transfer/index" served with wrong bytes (right header)
    stream: null, channel: null, instance: null,
    downloads: new Map(),  // transfer -> {buffer, partBytes}
    uploads: new Map(),    // transfer -> {parts: [], headers}
  };
  const notify = () => { for (const w of [...waiters]) if (w.check()) { waiters.splice(waiters.indexOf(w), 1); w.done(); } };
  hub.until = (check, ms = 15000) => new Promise((resolve, reject) => {
    if (check()) return resolve();
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('fake hub: condition not met in ' + ms + ' ms')); }, ms);
    const waiter = { check, done: () => { clearTimeout(timer); resolve(); } };
    waiters.push(waiter);
  });
  hub.results = id => hub.messages.filter(m => m.t === 'result' && m.id === id);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://hub');
    const body = await readBody(req);
    hub.requests.push({ method: req.method, path: url.pathname });
    if (req.headers.authorization !== 'Bearer ' + credential) { res.writeHead(401).end(); return; }
    const json = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.method === 'POST' && url.pathname === '/agent/v1/messages' && hub.holdPosts > 0) {
      hub.holdPosts--;
      await new Promise(resolve => { hub.held.push(resolve); notify(); });
    }
    if (req.method === 'POST' && url.pathname === '/agent/v1/hello' && hub.holdHellos > 0) { hub.holdHellos--; hub.heldHellos = (hub.heldHellos ?? 0) + 1; notify(); return; }
    if (req.method === 'POST' && url.pathname === '/agent/v1/hello') {
      const hello = JSON.parse(body.toString('utf8'));
      hub.hellos.push(hello); notify();
      const status = hub.helloStatus.shift();
      if (status) return json(status, { code: 'REFUSED' });
      const resumed = hub.instance === hello.instance;
      hub.instance = hello.instance;
      hub.channel = randomBytes(16).toString('hex');
      return json(200, { t: 'welcome', channel: hub.channel, customer: 'Cliente Teste', resumed, heartbeatMs: 15000, deadAfterMs: 45000,
        maxMessageBytes: 1048576, inlineMaxBytes: 524288, partBytes: 4194304, maxFileBytes: 536870912, kernel,
        compatible: { odc: { ok: true }, o11: { ok: true } }, ...welcome });
    }
    if (url.searchParams.get('channel') !== hub.channel) return json(404, { code: 'CHANNEL_UNKNOWN' });
    if (req.method === 'GET' && url.pathname === '/agent/v1/stream' && hub.holdStreams > 0) { hub.holdStreams--; hub.heldStreams = (hub.heldStreams ?? 0) + 1; notify(); return; }
    if (req.method === 'GET' && url.pathname === '/agent/v1/stream') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      res.flushHeaders();
      hub.stream = res; hub.streams++;
      req.on('close', () => { if (hub.stream === res) hub.stream = null; });
      notify();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/agent/v1/messages') {
      hub.posts++;
      if (hub.dropPosts > 0) { hub.dropPosts--; req.socket.destroy(); notify(); return; }
      const { messages } = JSON.parse(body.toString('utf8'));
      hub.messages.push(...messages);
      res.writeHead(204).end();
      notify();
      return;
    }
    const blob = /^\/agent\/v1\/blobs\/([0-9a-f]{32})\/(0|[1-9][0-9]{0,5})$/.exec(url.pathname);
    if (blob) hub.blobSockets.push(req.socket.remotePort);
    if (blob && req.method === 'PUT' && hub.holdPuts > 0) { hub.blobPuts++; hub.holdPuts--; notify(); return; }
    if (blob && req.method === 'GET' && hub.holdGets > 0) { hub.blobGets++; hub.holdGets--; notify(); return; }
    if (blob && req.method === 'PUT') {
      hub.blobPuts++;
      if (hub.corruptPuts > 0) { hub.corruptPuts--; return json(400, { code: 'PART_HASH_MISMATCH' }); }
      if (sha256(body) !== req.headers['x-ssam-part-sha256']) return json(400, { code: 'PART_HASH_MISMATCH' });
      const upload = hub.uploads.get(blob[1]) ?? { parts: [], total: req.headers['x-ssam-total-sha256'], size: Number(req.headers['x-ssam-total-size']), count: Number(req.headers['x-ssam-parts']) };
      upload.parts[Number(blob[2])] = body;
      hub.uploads.set(blob[1], upload);
      res.writeHead(204).end();
      notify();
      return;
    }
    if (blob && req.method === 'GET') {
      hub.blobGets++;
      const download = hub.downloads.get(blob[1]);
      const index = Number(blob[2]);
      if (!download) return json(404, { code: 'TRANSFER_INVALID' });
      const part = download.buffer.subarray(index * download.partBytes, (index + 1) * download.partBytes);
      const sent = hub.corruptParts.has(blob[1] + '/' + index) ? Buffer.concat([part.subarray(0, Math.max(0, part.length - 1)), Buffer.from([0x21])]) : part;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-ssam-part-sha256': sha256(part) }).end(sent);
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/agent/v1/channel') {
      hub.deletes++;
      res.writeHead(204).end();
      hub.endStream();
      notify();
      return;
    }
    json(404, { code: 'NOT_FOUND' });
  });
  const port = await listenInRange(server);
  hub.url = 'http://127.0.0.1:' + port;
  hub.send = message => { if (!hub.stream) throw new Error('fake hub: no stream'); hub.stream.write(JSON.stringify(message) + '\n'); };
  hub.endStream = () => { const stream = hub.stream; hub.stream = null; stream?.end(); };
  hub.release = () => { for (const resolve of hub.held.splice(0)) resolve(); };
  // The channel is gone on the server (network drop seen there): stream closed, its id answers 404 from now on.
  hub.invalidate = () => { hub.channel = null; hub.endStream(); };
  // A server -> agent file: registers the transfer and returns its BlobRef.
  hub.putBlob = (buffer, partBytes = 4194304) => {
    const transfer = randomBytes(16).toString('hex');
    hub.downloads.set(transfer, { buffer, partBytes });
    return { transfer, sha256: sha256(buffer), size: buffer.length, parts: Math.max(1, Math.ceil(buffer.length / partBytes)), partBytes };
  };
  // The file an agent -> server transfer assembled, checked against its BlobRef.
  hub.assembled = ref => {
    const upload = hub.uploads.get(ref.transfer);
    if (!upload || upload.parts.length !== ref.parts) return null;
    const buffer = Buffer.concat(upload.parts);
    return sha256(buffer) === ref.sha256 && buffer.length === ref.size ? buffer : null;
  };
  hub.close = () => new Promise(resolve => { hub.endStream(); server.closeAllConnections(); server.close(resolve); });
  return hub;
}
