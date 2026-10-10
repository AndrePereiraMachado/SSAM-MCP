// Test servers listen on 127.0.0.1 in 7400-7499 (the test range of the phase-2 lanes), starting at a random port and
// moving on when one is taken, so lanes testing at the same time do not collide.
import net from 'node:net';

export async function listenInRange(server, { host = '127.0.0.1', from = 7400, to = 7499 } = {}) {
  const span = to - from + 1;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = from + ((start + i) % span);
    const ok = await new Promise(resolve => {
      const onError = () => { server.off('listening', onListening); resolve(false); };
      const onListening = () => { server.off('error', onError); resolve(true); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    if (ok) return port;
  }
  throw new Error(`No free port in ${from}-${to}`);
}

// A port of the range that nothing listens on right now.
export async function freePort() {
  const server = net.createServer();
  const port = await listenInRange(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}
