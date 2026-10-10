import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serverName, registrationCommand, unrelatedServersDigest, matchesRegistration,
  safeRegistrationSummary, nonTargetConfigDigest } from './registration.mjs';

// Operator CLI only; not an MCP tool. Uses the official Codex config writer and
// never prints env values, tokens, URLs, headers or the complete configuration.
const argumentsList = process.argv.slice(2);
const mode = argumentsList.shift() ?? 'inspect';
const getArg = name => {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : undefined;
};
try {
  if (!['inspect', 'install', 'remove'].includes(mode)) throw new Error('Use inspect, install or remove.');
  const codexPath = getArg('--codex');
  if (!codexPath || !path.isAbsolute(codexPath) || !fs.existsSync(codexPath)) throw new Error('An explicit existing Codex executable path is required.');
  const nodePath = process.execPath;
  const entryPath = fileURLToPath(new URL('./odc3-host.mjs', import.meta.url));
  const taskConfigDirectory = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const configPath = path.join(taskConfigDirectory, 'config.toml');
  if (!fs.existsSync(configPath)) throw new Error('Existing Codex config.toml was not found; no configuration was created.');
  const cli = args => execFileSync(codexPath, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const list = () => JSON.parse(cli(['mcp', 'list', '--json']));
  const before = list();
  const priorEntry = before.find(entry => entry.name === serverName);
  const matching = matchesRegistration(priorEntry, nodePath, entryPath);
  if (mode === 'inspect') {
    console.log(JSON.stringify({ mode, configPath, existingServers: safeRegistrationSummary(before),
      proposedServer: serverName, entryPath, nodePath, alreadyMatches: matching, entryExists: fs.existsSync(entryPath) }));
  } else if (mode === 'install' && matching) {
    console.log(JSON.stringify({ mode, changed: false, server: serverName, reason: 'Already registered to this exact entry.' }));
  } else {
    if (!fs.existsSync(entryPath)) throw new Error('ODC3 entry does not exist; registration was not changed.');
    if (mode === 'install' && priorEntry) throw new Error('An ODC3 registration already exists with a different configuration; automatic overwrite is refused.');
    if (mode === 'remove' && !matching) throw new Error('Only this exact ODC3 registration can be removed; no other configuration was changed.');
    const original = fs.readFileSync(configPath);
    const originalHash = crypto.createHash('sha256').update(original).digest('hex');
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + crypto.randomBytes(3).toString('hex');
    const backupDirectory = path.join(taskConfigDirectory, 'backups', 'odc3-mcp');
    fs.mkdirSync(backupDirectory, { recursive: true });
    const backupPath = path.join(backupDirectory, `config-before-${mode}-${stamp}.toml`);
    fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
    if (crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex') !== originalHash) throw new Error('Backup verification failed; configuration was not changed.');
    if (crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex') !== originalHash) throw new Error('Configuration changed during preflight; operation was not sent.');
    cli(mode === 'install' ? registrationCommand(nodePath, entryPath) : ['mcp', 'remove', serverName]);
    const after = list();
    const current = fs.readFileSync(configPath);
    const targetVerified = mode === 'install' ? matchesRegistration(after.find(entry => entry.name === serverName), nodePath, entryPath)
      : !after.some(entry => entry.name === serverName);
    const unrelatedServersPreserved = unrelatedServersDigest(before) === unrelatedServersDigest(after);
    const unrelatedConfigPreserved = nonTargetConfigDigest(original.toString('utf8')) === nonTargetConfigDigest(current.toString('utf8'));
    const receipt = { mode, changed: true, server: serverName, configPath, backupPath,
      targetVerified, unrelatedServersPreserved, unrelatedConfigPreserved,
      beforeSha256: originalHash, afterSha256: crypto.createHash('sha256').update(current).digest('hex'),
      registeredButNotProofOfClientReload: mode === 'install',
    };
    const receiptPath = path.join(backupDirectory, `receipt-${mode}-${stamp}.json`);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ ...receipt, receiptPath }));
    if (!targetVerified || !unrelatedServersPreserved || !unrelatedConfigPreserved) process.exitCode = 2;
  }
} catch {
  // Deliberately avoid printing raw CLI errors/config fragments or env values.
  process.stderr.write('ODC3 registration did not complete or could not be verified. No raw configuration or credentials were logged. Inspect the specific registration and backup before retrying.\n');
  process.exitCode = 1;
}
