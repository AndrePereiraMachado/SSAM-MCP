// The code under test writes under the user's profile: this process's profile is a temporary folder.
import './fixtures/isolated-profile.mjs';
// The vault path of the Service Center tools (vault.mjs) with the real Windows PowerShell and a loopback HTTP server:
// the credential fragments are replaced by stubs (no Credential Manager is read), the login POST goes to 127.0.0.1 on
// an ephemeral port, and the test checks that the password reaches the server but never this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '../service-center/client.mjs';
import { ProtocolError } from '../service-center/errors.mjs';
import { Transport } from '../service-center/http.mjs';
import { CREDENTIAL, SCRIPTS, createPowerShellRunner, createVault, vaultLogin, vaultPresent } from '../service-center/vault.mjs';

process.env.ANVIL_WORKER = '0'; process.env.ANVIL_ODC_NO_WORKER = '1';
const HOST = 'vault.example.test';
const TARGET = `SSAM/O11/${HOST}/ServiceCenter`;
const SECRET = 'p&ss w<rd>!x';
const stub = (user, secret) => ({ setup: '', read: `$found = $true; $size = ${secret.length * 2}; $user = '${user}'; $secret = '${secret.replaceAll("'", "''")}'` });
const run = createPowerShellRunner({ timeoutMs: 60000 });
const windows = process.platform === 'win32';

async function loopback(handler) {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { seen.push({ method: request.method, url: request.url, headers: request.headers, body }); handler(request, response, body); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise(resolve => server.close(resolve)) };
}

test('the production fragments read Credential Manager only; the blob is decoded only for the login; answers never carry it', () => {
  assert.match(CREDENTIAL.setup, /CredReadW/);
  assert.match(CREDENTIAL.read, /if \(\$wantSecret/);
  assert.doesNotMatch(CREDENTIAL.setup + CREDENTIAL.read, /CredWrite|ConvertTo-Json|Write-/);
  assert.match(SCRIPTS.present, /\$wantSecret = \$false/);
  const answers = [...[SCRIPTS.present, SCRIPTS.login].join('\n').matchAll(/@\{([^}]*)\}\s*\|\s*ConvertTo-Json/g)].map(m => m[1]);
  assert.equal(answers.length, 5); // present; login unavailable, incomplete, answer, failure
  for (const fields of answers) assert.doesNotMatch(fields, /\$secret|\$user|\$plain|\$body/);
  assert.doesNotMatch(SCRIPTS.login, /Write-|Console\]::Out/);
});

test('the production setup compiles and its CREDENTIALW layout matches the native one (nothing is read)', { skip: !windows }, async () => {
  // Only the Add-Type block runs: DllImport binds at the first call, so Credential Manager is never touched.
  const script = `$ErrorActionPreference = 'Stop'; $null = [Console]::In.ReadToEnd()\n${CREDENTIAL.setup}\n@{ ok = $true; size = [Runtime.InteropServices.Marshal]::SizeOf([type][SsamO11VaultRead+Credential]); pointer = [IntPtr]::Size } | ConvertTo-Json -Compress`;
  const answer = await run(script, {});
  assert.equal(answer.ok, true);
  assert.equal(answer.size, answer.pointer === 8 ? 80 : 52);
});

test('the vault login: PowerShell adds the credential and posts; Node follows the redirect with the session cookies only', { skip: !windows }, async () => {
  const server = await loopback((request, response) => {
    if (request.method === 'GET' && request.url === '/ServiceCenter/Login.aspx') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'ASP.NET_SessionId=pre; path=/' });
      response.end('<form method="post" action="Login.aspx"><input type="hidden" name="__OSVSTATE" value="st ate"><input name="user"><input type="password" name="pass"><input type="submit" name="login" value="Log in"></form>');
    } else if (request.method === 'POST') {
      response.writeHead(302, { Location: 'Home.aspx', 'Set-Cookie': ['ASP.NET_SessionId=post; path=/; HttpOnly', 'osVisitor=v1; expires=Fri, 02 Oct 2099 00:00:00 GMT; path=/'] });
      response.end();
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<a href="Logout.aspx">Log out</a>');
    }
  });
  try {
    const vault = createVault(HOST, null, { present: async () => true, run, credential: stub('test-user', SECRET) });
    const client = new Client(vault, new Transport(HOST, { origin: server.origin }));
    await client.login();
    assert.equal(client.authenticated, true);
    const [get, post, after] = server.seen;
    assert.deepEqual([get.method, post.method, after.method, after.url], ['GET', 'POST', 'GET', '/ServiceCenter/Home.aspx']);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(post.body)), { __OSVSTATE: 'st ate', login: 'Log in', user: 'test-user', pass: SECRET });
    // The body Python's urlencode would post (quote_plus), in its field order.
    assert.equal(post.body, '__OSVSTATE=st+ate&login=Log+in&user=test-user&pass=p%26ss+w%3Crd%3E%21x');
    assert.equal(post.headers.cookie, 'ASP.NET_SessionId=pre');
    assert.equal(after.headers.cookie, 'ASP.NET_SessionId=post; osVisitor=v1');
    assert.ok(!JSON.stringify(client).includes(SECRET));
  } finally { await server.close(); }
});

test('every echo of the password is replaced before the answer reaches Node; a missing entry is refused', { skip: !windows }, async () => {
  const echo = [SECRET, 'p&amp;ss w&lt;rd&gt;!x', 'p%26ss%20w%3Crd%3E%21x', 'p%26ss+w%3Crd%3E%21x'];
  const server = await loopback((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<span class="ValidationMessage">' + echo.join(' | ') + '</span>');
  });
  try {
    const form = { url: server.origin + '/ServiceCenter/Login.aspx', body: '__OSVSTATE=x', userField: 'user', passwordField: 'pass', cookie: '', timeoutMs: 20000, limit: 1024 * 1024 };
    const answer = await vaultLogin(TARGET, form, { run, credential: stub('test-user', SECRET) });
    const text = answer.body.toString('utf8');
    assert.equal(answer.status, 200);
    for (const variant of echo) assert.ok(!text.includes(variant), variant);
    assert.equal(text.split('<redacted>').length - 1, 4);
    await assert.rejects(vaultLogin(TARGET, form, { run, credential: { setup: '', read: '$found = $false; $size = 0; $user = $null; $secret = $null' } }),
      e => e instanceof ProtocolError && /Credential unavailable/.test(e.message));
    await assert.rejects(vaultLogin(`SSAM/O11/${HOST}/DatabaseConnection/X`, form, { run }), e => e instanceof ProtocolError);
    assert.equal(server.seen.length, 1);
  } finally { await server.close(); }
});

test('status only: present() answers whether a nonempty entry exists, several targets in one run', { skip: !windows }, async () => {
  const read = { setup: '', read: "$found = $true; $size = $(if ($target -like '*LifeTime') { 0 } else { 8 })" };
  assert.equal(await vaultPresent(TARGET, { run, credential: read }), true);
  assert.deepEqual(await vaultPresent([TARGET, `SSAM/O11/${HOST}/LifeTime`], { run, credential: read }), [true, false]);
  await assert.rejects(vaultPresent('SSAM/ODC/x/Portal', { run }), e => e instanceof ProtocolError);
});
