// A fake O11 bridge for tests, on an ephemeral loopback port: line-buffered JSON requests, one reply per line.
// handler(request, socket) returns the reply object (or a raw string, or undefined to stay silent).
import net from 'node:net';

export async function fakeBridge(handler) {
  const seen = []; const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        const request = JSON.parse(line); seen.push(request);
        const reply = await handler(request, socket);
        if (reply !== undefined && !socket.destroyed) socket.write(typeof reply === 'string' ? reply : JSON.stringify(reply) + '\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, seen, // close ends the open connections too, like a Studio that exits: a client that keeps listening for a late answer of an
    // abandoned call (o11-bridge.mjs flights) sees the end.
    close: () => new Promise(resolve => { server.close(resolve); for (const s of sockets) s.destroy(); }) };
}
