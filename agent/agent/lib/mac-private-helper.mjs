import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from './errors.mjs';

const FLAGS = new Set(['Mode', 'Scope', 'HostName', 'Kind', 'Entry', 'Subject', 'Rows', 'PromptStatusPath']);
const unavailable = () => new AgentError('CREDENTIAL_HELPER_UNAVAILABLE', 'This installation is missing its private macOS helper. Reinstall the SSAM Agent app.', { executed: false });

// The executable is installation-owned. No tool argument, environment override,
// or credential selects a program. Secrets travel only through its stdin pipe.
export function macPrivateCommand({ runtimeRoot, dataRoot, family, argv, input = '', files = fs }) {
  if (!['credential', 'users'].includes(family)) throw unavailable();
  const root = path.resolve(runtimeRoot);
  let executable;
  try {
    const pack = JSON.parse(files.readFileSync(path.join(root, 'pack.json'), 'utf8'));
    if (pack.nativeCore?.runtime !== 'native-aot' || pack.nativeCore?.path !== 'native/ssam-agent') throw unavailable();
    executable = path.join(root, 'native', 'ssam-agent');
    const real = files.realpathSync(executable), realRoot = files.realpathSync(root);
    const relative = path.relative(realRoot, real);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !files.statSync(real).isFile()) throw unavailable();
  } catch { throw unavailable(); }
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^-/, '');
    if (FLAGS.has(key)) options[key] = argv[++i];
  }
  if (!/^[a-f0-9]{32}$/.test(options.Scope ?? '') || !options.Mode || !options.HostName) throw unavailable();
  let request = {};
  if (input) {
    try { request = JSON.parse(family === 'users' ? Buffer.from(input, 'base64').toString('utf8') : input); }
    catch { throw unavailable(); }
  }
  const privateOptions = Object.fromEntries(['Kind', 'Entry', 'Subject', 'Rows', 'PromptStatusPath']
    .filter(key => options[key] !== undefined).map(key => [key[0].toLowerCase() + key.slice(1), options[key]]));
  const envelope = { version: 1, family, mode: options.Mode, scope: options.Scope, host: options.HostName,
    request, options: privateOptions, context: { dataRoot: path.resolve(dataRoot), runtimeRoot: root } };
  return { file: executable, args: ['private-helper'], input: JSON.stringify(envelope) };
}
