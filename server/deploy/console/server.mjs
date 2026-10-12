// SSAM owner console ("Painel do dono"), entry point (DESIGN 1.2, 2.5): `node /console/server.mjs` in the ssam-console
// container (no network; unix socket CONSOLE_SOCKET) or `node server.mjs --tcp 127.0.0.1:<port>` for tests and local runs.
// Logs one JSON line per start, mutation, reader problem and uncaught error on stdout: codes only, never request bodies,
// headers, customer names, keys or secrets. A new access key is made at every start (after the socket is ours) and
// written to CONSOLE_STATE_DIR/access.key for painel-ssam.ps1. SIGTERM flushes the usage day files and the checkpoint.
import { createConsole } from './app.mjs';
import { loadConfig } from './config.mjs';
import { listen } from './listen.mjs';
import { cap, redact } from './texts.mjs';

const log = line => { try { process.stdout.write(redact(JSON.stringify(line)) + '\n'); } catch { /* stdout closed */ } };
const errorLine = (kind, error) => ({ console: kind, code: cap(String(error?.code ?? error?.name ?? 'ERRO'), 40), message: cap(redact(String(error?.message ?? '')), 200) });

let config;
try { config = loadConfig(); } catch (error) { log(errorLine('config-error', error)); process.exit(2); }

const app = await createConsole({ config, log });
let where;
try { where = await listen(app.server, config); } catch (error) { log(errorLine('listen-error', error)); process.exit(1); }
if (where.kind === 'already-running') { log({ console: 'already-running' }); process.exit(1); }
app.auth.rotate();
log({ console: 'listening', socket: where.kind === 'socket' ? where.path : `${where.host}:${where.port}`, capabilities: app.capabilities });
app.begin();
app.startTimers();

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  app.stop();
  log({ console: 'stopped', signal });
  const hard = setTimeout(() => process.exit(0), 3000);
  hard.unref();
  app.server.close(() => process.exit(0));
  app.server.closeAllConnections?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', error => { log(errorLine('error', error)); try { app.stop(); } finally { process.exit(1); } });
process.on('unhandledRejection', error => { log(errorLine('error', error)); });
