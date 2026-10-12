// A TCP relay between the agent and a test server that can turn its connections into black holes, as a carrier-grade
// NAT does when the customer's public IP changes (production test of 2026-10-11): the connection stays open, the bytes
// sent are accepted and dropped, nothing comes back, no reset, no FIN. cut() does it to every connection open now;
// swallowNext makes the next N new connections black holes from the start. connections counts the TCP connections the
// relay accepted (a new one = the client did not reuse a pooled socket).
import net from 'node:net';
import { listenInRange } from './ports.mjs';

export async function faultyLink(targetPort, { host = '127.0.0.1' } = {}) {
  const open = new Set();
  const link = { connections: 0, swallowNext: 0, url: null };
  const server = net.createServer(client => {
    link.connections++;
    const entry = { client, upstream: null, dead: false };
    open.add(entry);
    client.on('error', () => {});
    client.on('close', () => { open.delete(entry); entry.upstream?.destroy(); });
    if (link.swallowNext > 0) { link.swallowNext--; entry.dead = true; client.on('data', () => {}); return; }
    const upstream = net.connect(targetPort, host);
    entry.upstream = upstream;
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => { if (!entry.dead) client.destroy(); });
    client.on('data', chunk => { if (!entry.dead) upstream.write(chunk); });
    upstream.on('data', chunk => { if (!entry.dead) client.write(chunk); });
  });
  const port = await listenInRange(server);
  link.url = 'http://127.0.0.1:' + port;
  link.cut = () => { for (const entry of open) entry.dead = true; };
  link.close = () => new Promise(resolve => {
    for (const entry of open) { entry.client.destroy(); entry.upstream?.destroy(); }
    server.close(resolve);
  });
  return link;
}
