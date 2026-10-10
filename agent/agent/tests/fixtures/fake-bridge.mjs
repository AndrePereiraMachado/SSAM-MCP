// A fake O11 bridge for the agent tests (same shape as platforms/odc/facade/tests/fixtures/fake-o11-bridge.mjs, kept
// here because nothing in agent/ imports from platforms/): line-buffered JSON requests, one reply per line.
// handler(request) returns the reply object, or undefined to stay silent.
import net from 'node:net';
import { listenInRange } from './ports.mjs';

export async function fakeBridge(handler, { port } = {}) {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        const request = JSON.parse(line); seen.push(request);
        const reply = await handler(request);
        if (reply !== undefined && !socket.destroyed) socket.write(JSON.stringify(reply) + '\n');
      }
    });
    socket.on('error', () => {});
  });
  const bound = port ? await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(port)); })
    : await listenInRange(server);
  return { port: bound, seen, close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }) };
}
