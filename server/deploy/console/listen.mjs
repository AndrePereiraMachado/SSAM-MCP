// Where the console listens (DESIGN 1.2, 7.2): the unix socket CONSOLE_SOCKET (production: no network at all, the host
// unit ssam-console-proxy.socket forwards 127.0.0.1:7320 to it) or --tcp on a loopback address (tests, local runs).
// A leftover socket file is removed only when it is a socket and nothing answers on it; when something answers, another
// console is running and this one stops. The socket is made 0600. These two calls on CONSOLE_SOCKET are the only file
// writes of this module.
import fs from 'node:fs';
import net from 'node:net';

const answers = socketPath => new Promise(resolve => {
  const probe = net.connect(socketPath);
  const done = value => { probe.destroy(); resolve(value); };
  probe.once('connect', () => done(true));
  probe.once('error', () => done(false));
  probe.setTimeout(1500, () => done(false));
});

const listenOn = (server, ...args) => new Promise((resolve, reject) => {
  const onError = error => reject(error);
  server.once('error', onError);
  server.listen(...args, () => { server.off('error', onError); resolve(); });
});

// -> { kind: 'tcp', host, port } | { kind: 'socket', path } | { kind: 'already-running' }
export async function listen(server, config) {
  if (config.tcp) {
    await listenOn(server, config.tcp.port, config.tcp.host);
    const address = server.address();
    return { kind: 'tcp', host: address.address, port: address.port };
  }
  const socketPath = config.socket;
  let st = null;
  try { st = fs.lstatSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (st) {
    if (!st.isSocket()) throw Object.assign(new Error('CONSOLE_SOCKET exists and is not a socket'), { code: 'NOT_A_SOCKET' });
    if (await answers(socketPath)) return { kind: 'already-running' };
    fs.unlinkSync(socketPath);
  }
  const previous = process.umask(0o177);
  try { await listenOn(server, socketPath); } finally { process.umask(previous); }
  fs.chmodSync(socketPath, 0o600);
  return { kind: 'socket', path: socketPath };
}
