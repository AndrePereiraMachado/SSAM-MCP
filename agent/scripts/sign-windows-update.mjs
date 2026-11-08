// Signs the update statement of a Windows build (app 0.2.8), the step between `npm run dist:win` and publishing dist/ to
// https://dist.ssam.pro/u/ssam-agent. Run it through scripts/sign-windows-update.ps1, which reads the vigia vault's
// manifestPrivateKey (DPAPI, the account that ran server/deploy/vigia/set-secrets.ps1) and gives it on stdin:
//   node scripts/sign-windows-update.mjs --dist <dist folder> [--expect-public-key <the pinned public key PEM>]
// stdin: the Ed25519 private key PEM, nothing else. It is never an argument, an environment variable or a file of this script,
// and it is never printed. The statement binds the app, win32/x64, channel latest, the version of latest.yml (which must be
// this package's version), the installer's file name, size and sha512 (measured on the file, and equal to latest.yml); it is
// written next to the installer as <installer>.ed25519.json and verified again with the public key of the signing key, which
// must be the pinned one when --expect-public-key is given. Publish it with latest.yml and the installer (README-APP.md).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { statementFor, signStatement, readStatement, updateStatementProblem, installerName, statementName, parseVersion } from '../src/main/core/update-signature.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yaml = createRequire(path.join(app, 'package.json'))('js-yaml');

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!['--dist', '--expect-public-key', '--app'].includes(name)) throw new Error('unknown option: ' + name);
    if (i + 1 >= argv.length) throw new Error('missing the value of ' + name);
    options[{ '--dist': 'dist', '--expect-public-key': 'expectPublicKey', '--app': 'app' }[name]] = argv[++i];
  }
  if (!options.dist) throw new Error('give the build output with --dist <folder with latest.yml and the installer>');
  return options;
}

// The statement of the build in dist, checked against latest.yml, the installer bytes and the app version.
export function statementOfDist(dist, { appVersion, now = new Date() } = {}) {
  const latest = yaml.load(fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8'));
  const installers = (latest?.files ?? []).filter(f => installerName(f?.url));
  if (installers.length !== 1) throw new Error('latest.yml must announce exactly one installer');
  const file = installerName(installers[0].url);
  if (!parseVersion(latest.version)) throw new Error('latest.yml version is not x.y.z: ' + latest.version);
  if (appVersion && latest.version !== appVersion) throw new Error(`latest.yml is version ${latest.version}, but this app is ${appVersion}: sign the build of this checkout`);
  const bytes = fs.readFileSync(path.join(dist, file));
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  if (installers[0].sha512 !== sha512 || (installers[0].size !== undefined && installers[0].size !== bytes.length)) throw new Error('the installer in dist is not the one latest.yml announces');
  if (latest.sha512 !== undefined && latest.sha512 !== sha512) throw new Error('latest.yml sha512 differs from its installer');
  return { latest, file, statement: statementFor({ version: latest.version, file, size: bytes.length, sha512, createdAt: now.toISOString() }) };
}

// Writes <installer>.ed25519.json in dist and proves it with the public half of the key; returns what to publish.
export function signDist(dist, privateKeyPem, { appVersion, expectPublicKey, now } = {}) {
  let privateKey;
  try { privateKey = createPrivateKey(privateKeyPem); } catch { throw new Error('the signing key on stdin is not a private key'); }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the signing key must be the Ed25519 manifest key of the vigia vault');
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  if (expectPublicKey) {
    const pinned = createPublicKey(fs.readFileSync(expectPublicKey, 'utf8')).export({ type: 'spki', format: 'der' });
    if (!pinned.equals(spki)) throw new Error('the vault key is not the pinned public key: the installed apps would refuse this statement');
  }
  const { latest, file, statement } = statementOfDist(dist, { appVersion, now });
  const text = signStatement(statement, privateKey);
  const read = readStatement(text, publicKey);
  if (read.problem) throw new Error('the written statement does not verify: ' + read.problem.message);
  const problem = updateStatementProblem({ text, publicKey, info: latest, downloaded: { sha512: statement.sha512, size: statement.size }, current: '0.0.0' });
  if (problem) throw new Error('the written statement would be refused: ' + problem.message);
  const out = path.join(dist, statementName(file));
  fs.writeFileSync(out + '.tmp', text, { flag: 'w' }); fs.renameSync(out + '.tmp', out);
  return { file, statement: statementName(file), version: statement.version, size: statement.size, keySpkiSha256: createHash('sha256').update(spki).digest('hex') };
}

async function readStdin() { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8'); }

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const appVersion = JSON.parse(fs.readFileSync(path.join(options.app ?? app, 'package.json'), 'utf8')).version;
  let key = await readStdin();
  try {
    const result = signDist(path.resolve(options.dist), key, { appVersion, expectPublicKey: options.expectPublicKey });
    // Public facts only: the file names, the version and the fingerprint of the public key.
    console.log(JSON.stringify({ ok: true, ...result, publish: ['latest.yml', result.file, result.file + '.blockmap', result.statement] }));
  } finally { key = null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error => { console.error('Error: ' + error.message); process.exit(1); });
