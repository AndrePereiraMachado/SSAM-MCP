// The app's own log (not the agent's agent.log): one JSON line per event in the app's user data folder, kept under
// about 1 MB (the previous file is moved to app.log.1). Never a credential: the app never has one in memory for long
// and never logs what the panel sends.
import fs from 'node:fs';

const ROTATE_BYTES = 1024 * 1024;

export function createAppLog(file) {
  const write = (event, fields = {}) => {
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n';
    try {
      let size = 0;
      try { size = fs.statSync(file).size; } catch { size = 0; }
      if (size > ROTATE_BYTES) { try { fs.renameSync(file, file + '.1'); } catch { /* keep writing to the same file */ } }
      fs.appendFileSync(file, line);
    } catch { /* an unwritable log never stops the app */ }
  };
  // The logger shape electron-updater takes.
  const updaterLogger = { info: message => write('updater', { level: 'info', message: String(message) }), warn: message => write('updater', { level: 'warn', message: String(message) }),
    error: message => write('updater', { level: 'error', message: String(message) }), debug: () => {} };
  return { file, write, updaterLogger };
}
