// A fake resident Anvil worker for tests (kernel src/Anvil.Core/Hosting/WorkerServer.cs protocol) on a loopback port
// (ephemeral unless one is given): one JSON line {args, authorization} in, one envelope line out. `ping` needs no key
// and answers `status`; any other command without the key answers {ok:false, executed:false}, as the real worker.
// handler(request, socket) returns the envelope, 'drop' (close after reading the request, no reply) or undefined
// (stay silent). Nothing here starts a process.
import net from 'node:net';

export async function fakeWorker({ port = 0, key = null, status = {}, handler = request => ({ ok: true, command: request.args[0], elapsedMs: 1, data: {} }) } = {}) {
  const seen = []; const sockets = new Set();
  const state = { protocol: 'anvil-worker-1', instanceId: 'fake-instance', pid: 4242, busy: false, queued: 0, recycling: false, studio: null, ...status };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        const request = JSON.parse(line); seen.push(request);
        const command = request.args?.[0];
        const reply = command === 'ping' ? { ok: true, command: 'ping', elapsedMs: 0, data: { ...state } }
          : key !== null && request.authorization !== key ? { ok: false, command, error: 'Worker operation requires the trusted Hybrid controller', executed: false }
          : await handler(request, socket);
        if (reply === 'drop') { socket.destroy(); return; }
        if (reply !== undefined && !socket.destroyed) socket.write(JSON.stringify(reply) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: server.address().port, seen, state, requests: name => seen.filter(r => r.args?.[0] === name),
    close: () => new Promise(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }) };
}

// A loopback port nothing listens on right now (asked from the OS, then released).
export async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
