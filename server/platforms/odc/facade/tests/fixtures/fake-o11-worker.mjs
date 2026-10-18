// A fake O11 resident worker for tests (CX16 r4, review cx16-3 M3): the anvil-worker-1 protocol, one JSON line per request
// and per reply over TCP on 127.0.0.1, as kernel WorkerServer.cs serves it: ping is answered at once, outside the queue;
// every other command waits in ONE first-in-first-out queue and runs on one loop, one at a time; a command whose client is
// gone still runs (its reply is lost). handlers: {verb: async args => envelope}. events: every command that ran, with its
// times (performance.now() of this process, so a test compares them with its own clocks). Synthetic values only.
import net from 'node:net';

export async function fakeO11Worker({ handlers = {}, studio = null } = {}) {
  const events = []; const queue = []; let running = null;
  const status = () => ({ protocol: 'anvil-worker-1', instanceId: 'fake-o11-worker', pid: process.pid, busy: running != null, currentCommand: running,
    queued: queue.length, recycling: false, authenticatedWorker: true, ...(studio ? { studio } : {}) });
  const pump = async () => {
    if (running != null) return;
    const item = queue.shift();
    if (!item) return;
    running = item.verb; item.start = performance.now();
    let reply;
    try { reply = await (handlers[item.verb] ?? (() => ({ ok: false, command: item.verb, error: 'not in this test: ' + item.verb })))(item.args); }
    catch (error) { reply = { ok: false, command: item.verb, error: String(error?.message ?? error) }; }
    item.end = performance.now(); running = null;
    const delivered = !item.socket.destroyed && item.socket.writable;
    if (delivered) item.socket.write(JSON.stringify(reply) + '\n');
    events.push({ verb: item.verb, received: item.received, start: item.start, end: item.end, delivered });
    pump();
  };
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        let request;
        try { request = JSON.parse(line); } catch { socket.write(JSON.stringify({ ok: false, command: '?', error: 'bad line' }) + '\n'); continue; }
        const args = Array.isArray(request.args) ? request.args.map(String) : [];
        const verb = args[0] ?? '?';
        if (verb === 'ping') { socket.write(JSON.stringify({ ok: true, command: 'ping', elapsedMs: 0, data: status() }) + '\n'); continue; }
        queue.push({ verb, args, socket, received: performance.now() });
        pump();
      }
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = new Set();
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return {
    port: server.address().port, events,
    // until the queue is empty and nothing runs (the commands a gone client left behind included)
    idle: async (ms = 20000) => { const end = Date.now() + ms; while ((running != null || queue.length) && Date.now() < end) await new Promise(r => setTimeout(r, 20)); },
    close: async () => { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(() => resolve())); },
  };
}
