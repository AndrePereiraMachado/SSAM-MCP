import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { o11DebugAuthTarget, validateO11PublicationProof, reconcileO11DebugAuth, exchangeO11DebugToken } from '../debug-o11-auth.mjs';

const now = Date.now();
const input = { operationId: '12345678-1234-4234-8234-123456789abc', pid: 1234, host: 'fixture.outsystemscloud.com', module: 'Producer', moduleKey: 'A'.repeat(22),
  applicationKey: 'B'.repeat(22), publishedVersionId: 10, sessionId: 'c'.repeat(32), publishedProof: { path: fileURLToPath(new URL('./fixture.json', import.meta.url)), sha256: 'd'.repeat(64) } };
const binding = o11DebugAuthTarget(input);
const proof = () => ({ host: input.host, capturedAtUtc: new Date(now).toISOString(), modules: [
  { Name: input.module, Key: input.moduleKey, ApplicationKey: input.applicationKey, VersionId: 10, IsActive: true },
] });

test('O11 debugger authority requires an explicit app key and published module identity; no scope is guessed', () => {
  assert.deepEqual(binding, { pid: input.pid, host: input.host, module: input.module, moduleKey: input.moduleKey, applicationKey: input.applicationKey, publishedVersionId: 10, sessionId: input.sessionId });
  for (const key of ['applicationKey', 'moduleKey', 'publishedVersionId', 'publishedProof', 'pid', 'host']) assert.throws(() => o11DebugAuthTarget({ ...input, [key]: undefined }), /contract_missing_/);
  for (const override of [{ host: 'user:password@fixture.outsystemscloud.com' }, { host: 'fixture.outsystemscloud.com/Other' }, { moduleKey: 'not-a-key' }, { sessionId: 'another-session' }, { operationId: '../reuse' }])
    assert.throws(() => o11DebugAuthTarget({ ...input, ...override }));
});

test('published inventory proof binds host, key, name, app and exact version for closed modules', () => {
  assert.equal(validateO11PublicationProof(binding, proof(), now), true);
  for (const override of [{ Name: 'Other' }, { Key: 'E'.repeat(22) }, { ApplicationKey: 'E'.repeat(22) }, { VersionId: 11 }, { IsActive: false }]) {
    const changed = proof(); Object.assign(changed.modules[0], override);
    assert.throws(() => validateO11PublicationProof(binding, changed, now), /scope_mismatch/);
  }
  assert.throws(() => validateO11PublicationProof(binding, { ...proof(), host: 'other.outsystemscloud.com' }, now));
  assert.throws(() => validateO11PublicationProof(binding, { ...proof(), capturedAtUtc: new Date(now - 901000).toISOString() }, now), /proof_stale/);
  assert.throws(() => validateO11PublicationProof(binding, { ...proof(), capturedAtUtc: new Date(now + 31000).toISOString() }, now), /proof_stale/);
});

test('cross-module entry requires its own app key, identity and published proof', () => {
  const entry = { module: 'Entry', moduleKey: 'E'.repeat(22), applicationKey: 'F'.repeat(22), publishedVersionId: 20 };
  const combined = o11DebugAuthTarget({ ...input, entry });
  assert.throws(() => validateO11PublicationProof(combined, proof(), now), /scope_mismatch/);
  const complete = proof(); complete.modules.push({ Name: entry.module, Key: entry.moduleKey, ApplicationKey: entry.applicationKey, VersionId: 20, IsActive: true });
  assert.equal(validateO11PublicationProof(combined, complete, now), true);
  assert.throws(() => o11DebugAuthTarget({ ...input, entry: { ...entry, applicationKey: undefined } }), /scope_missing/);
});

test('attach reconciliation never resubmits uncertain or already-consumed authentication', () => {
  const journal = { binding, phase: 'attaching' };
  assert.deepEqual(reconcileO11DebugAuth(journal, null, binding), { state: 'uncertain', error: 'debug_o11_token_attach_uncertain' });
  assert.throws(() => reconcileO11DebugAuth(journal, { phase: 'consumed' }, binding), /already_consumed/);
  assert.deepEqual(reconcileO11DebugAuth(journal, { phase: 'failed', error: 'private-token-from-sdk' }, binding), { state: 'failed', error: 'debug_o11_token_exchange_unavailable' });
  assert.throws(() => reconcileO11DebugAuth(journal, null, { ...binding, host: 'other.outsystemscloud.com' }), /scope_mismatch/);
  for (const phase of ['authenticating', 'preflighting', 'minting', 'delivered-unconfirmed', 'uncertain'])
    assert.deepEqual(reconcileO11DebugAuth(journal, { phase }, binding), { state: 'uncertain', error: 'debug_o11_token_attach_uncertain' });
});

function fakePeer(onWrite) {
  const peer = new EventEmitter();
  peer.setEncoding = () => {};
  peer.destroy = () => {};
  peer.write = (line, callback) => { onWrite(JSON.parse(line), peer); callback?.(); };
  return peer;
}
const exchangeInput = { pipeName: 'fixture-private-pipe', operationId: input.operationId, binding, receiptPath: input.publishedProof.path };
const privateReply = () => ({ ok: true, operationId: input.operationId, binding, newAuthentication: true, path: 'oauth', token: 'synthetic-private-bearer',
  soapUser: 'synthetic-sso-user', soapSecret: 'synthetic-private-sso-id-token', preflight: { pingSucceeded: true, inDebug: true, debuggerVersion: 1 } });

test('private exchange waits for the same hook before sending exactly one request and requires consumed confirmation', async () => {
  let connections = 0, requests = 0, acknowledgements = 0;
  const connect = () => {
    const peer = fakePeer((message, current) => {
      if (message.binding) {
        requests++;
        queueMicrotask(() => current.emit('data', JSON.stringify(privateReply()) + '\n'));
      } else {
        acknowledgements++;
        assert.deepEqual(message, { operationId: input.operationId });
        queueMicrotask(() => current.emit('data', JSON.stringify({ ok: true, phase: 'consumed', operationId: input.operationId }) + '\n'));
      }
    });
    connections++;
    queueMicrotask(() => connections === 1 ? peer.emit('error', { code: 'ENOENT' }) : peer.emit('connect'));
    return peer;
  };
  assert.deepEqual(await exchangeO11DebugToken(exchangeInput, { connect, timeoutMs: 1000 }), privateReply());
  assert.equal(connections, 2); assert.equal(requests, 1); assert.equal(acknowledgements, 1);
});

test('private exchange never reconnects or resends after an uncertain submitted request', async () => {
  let connections = 0, requests = 0;
  const connect = () => {
    connections++;
    const peer = fakePeer(() => { requests++; queueMicrotask(() => peer.emit('error', { code: 'ECONNREFUSED' })); });
    queueMicrotask(() => peer.emit('connect'));
    return peer;
  };
  await assert.rejects(exchangeO11DebugToken(exchangeInput, { connect, timeoutMs: 200 }), /^Error: debug_o11_token_exchange_uncertain$/);
  assert.equal(connections, 1); assert.equal(requests, 1);
});

test('lost consumption confirmation remains uncertain and never returns or repeats the captured bearer', async () => {
  let connections = 0, requests = 0, acknowledgements = 0;
  const connect = () => {
    connections++;
    const peer = fakePeer(message => {
      if (message.binding) { requests++; queueMicrotask(() => peer.emit('data', JSON.stringify(privateReply()) + '\n')); }
      else { acknowledgements++; queueMicrotask(() => peer.emit('end')); }
    });
    queueMicrotask(() => peer.emit('connect'));
    return peer;
  };
  await assert.rejects(exchangeO11DebugToken(exchangeInput, { connect, timeoutMs: 200 }), /^Error: debug_o11_token_exchange_uncertain$/);
  assert.equal(connections, 1); assert.equal(requests, 1); assert.equal(acknowledgements, 1);
});

test('duplicate bearer response is refused instead of sending a second acknowledgement', async () => {
  let writes = 0;
  const connect = () => {
    const peer = fakePeer(message => {
      writes++;
      if (message.binding) queueMicrotask(() => peer.emit('data', JSON.stringify(privateReply()) + '\n' + JSON.stringify(privateReply()) + '\n'));
    });
    queueMicrotask(() => peer.emit('connect'));
    return peer;
  };
  await assert.rejects(exchangeO11DebugToken(exchangeInput, { connect, timeoutMs: 200 }), /^Error: debug_o11_token_response_invalid$/);
  assert.equal(writes, 2);
});

test('SOAP SSO context is required, separately bounded and control-free before an acknowledgement', async () => {
  for (const changed of [
    { soapUser: undefined }, { soapSecret: undefined }, { soapUser: '' }, { soapSecret: ' ' },
    { soapUser: 'user\r\nprivate' }, { soapSecret: 'id-token\u0085private' },
    { soapUser: 'a'.repeat(513) }, { soapSecret: 'a'.repeat(65537) },
    { soapSecret: '\u00e9'.repeat(32769) }, { token: '\u00e9'.repeat(32769) },
    { binding: { ...binding, sessionId: 'different-session' } }, { username: 'unexpected-private-value' },
  ]) {
    let requests = 0, acknowledgements = 0, connections = 0;
    const connect = () => {
      connections++;
      const peer = fakePeer(message => {
        if (message.binding) { requests++; queueMicrotask(() => peer.emit('data', JSON.stringify({ ...privateReply(), ...changed }) + '\n')); }
        else acknowledgements++;
      });
      queueMicrotask(() => peer.emit('connect')); return peer;
    };
    await assert.rejects(exchangeO11DebugToken(exchangeInput, { connect, timeoutMs: 200 }), error =>
      error.message === 'debug_o11_token_response_invalid' && !error.message.includes('synthetic-private'));
    assert.equal(connections, 1); assert.equal(requests, 1); assert.equal(acknowledgements, 0);
  }
});

const diagnostic = () => ({ decodeSucceeded: true, notBeforeValid: true, expirationValid: true, timeValid: true,
  allowDebugTarget: true, allowDebugEntry: false });

test('native diagnostic booleans can accompany the private SSO context without changing authority or exposing claims', async () => {
  const response = { ...privateReply(), diagnostics: diagnostic() };
  const connect = () => {
    const peer = fakePeer(message => queueMicrotask(() => peer.emit('data', JSON.stringify(message.binding ? response
      : { ok: true, operationId: input.operationId, phase: 'consumed' }) + '\n')));
    queueMicrotask(() => peer.emit('connect')); return peer;
  };
  assert.deepEqual(await exchangeO11DebugToken(exchangeInput, { connect, timeoutMs: 200 }), response);
  assert.deepEqual(o11DebugAuthTarget({ ...input, authDiagnostics: true }), binding);
  assert.throws(() => o11DebugAuthTarget({ ...input, authDiagnostics: 'private-claim' }), /contract_invalid/);
});

test('diagnostics reject claims, usernames, secrets, missing flags or nonboolean values before acknowledgement', async () => {
  for (const diagnostics of [null, [], 'raw-private-claims', { ...diagnostic(), claims: ['private-claim'] },
    { ...diagnostic(), soapSecret: 'private-id-token' }, { ...diagnostic(), allowDebugTarget: 'private-value' },
    Object.fromEntries(Object.entries(diagnostic()).filter(([key]) => key !== 'timeValid'))]) {
    let acknowledgements = 0;
    const connect = () => {
      const peer = fakePeer(message => {
        if (message.binding) queueMicrotask(() => peer.emit('data', JSON.stringify({ ...privateReply(), diagnostics }) + '\n'));
        else acknowledgements++;
      });
      queueMicrotask(() => peer.emit('connect')); return peer;
    };
    await assert.rejects(exchangeO11DebugToken(exchangeInput, { connect, timeoutMs: 200 }), /^Error: debug_o11_token_response_invalid$/);
    assert.equal(acknowledgements, 0);
  }
});

test('consumption confirmation remains metadata-only and cannot repeat a private SOAP field or bearer', async () => {
  for (const extra of [{ soapUser: 'private-user' }, { soapSecret: 'private-id-token' }, { token: 'private-bearer' }, { diagnostics: diagnostic() }]) {
    let requests = 0, acknowledgements = 0;
    const connect = () => {
      const peer = fakePeer(message => {
        if (message.binding) { requests++; queueMicrotask(() => peer.emit('data', JSON.stringify(privateReply()) + '\n')); }
        else { acknowledgements++; queueMicrotask(() => peer.emit('data', JSON.stringify({ ok: true, operationId: input.operationId, phase: 'consumed', ...extra }) + '\n')); }
      });
      queueMicrotask(() => peer.emit('connect')); return peer;
    };
    await assert.rejects(exchangeO11DebugToken(exchangeInput, { connect, timeoutMs: 200 }), /^Error: debug_o11_token_response_invalid$/);
    assert.equal(requests, 1); assert.equal(acknowledgements, 1);
  }
});

test('native public-area and protocol preflight must pass before any private context acknowledgement', async () => {
  for (const preflight of [undefined, null, [], {}, { pingSucceeded: false, inDebug: true, debuggerVersion: 1 },
    { pingSucceeded: true, inDebug: false, debuggerVersion: 1 }, { pingSucceeded: true, inDebug: true, debuggerVersion: 2 },
    { pingSucceeded: true, inDebug: true, debuggerVersion: '1' },
    { pingSucceeded: true, inDebug: true, debuggerVersion: 1, hash: 'private-runtime-hash' }]) {
    let requests = 0, acknowledgements = 0;
    const connect = () => {
      const peer = fakePeer(message => {
        if (message.binding) { requests++; queueMicrotask(() => peer.emit('data', JSON.stringify({ ...privateReply(), preflight }) + '\n')); }
        else acknowledgements++;
      });
      queueMicrotask(() => peer.emit('connect')); return peer;
    };
    await assert.rejects(exchangeO11DebugToken(exchangeInput, { connect, timeoutMs: 200 }), /^Error: debug_o11_token_response_invalid$/);
    assert.equal(requests, 1); assert.equal(acknowledgements, 0);
  }
});

test('addon has only private IPC, bounded leases and metadata receipts; no Studio password or replacement bridge', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../../../kernel/tools/Anvil.DebugTokenHook/StartupHook.cs', import.meta.url)), 'utf8');
  const project = fs.readFileSync(fileURLToPath(new URL('../../../../kernel/tools/Anvil.DebugTokenHook/Anvil.DebugTokenHook.csproj', import.meta.url)), 'utf8');
  assert.match(source, /PipeOptions\.CurrentUserOnly/);
  assert.match(source, /GetNamedPipeClientProcessId/);
  assert.match(source, /client\.StartTime\.ToUniversalTime\(\)\.ToString\("O"\)/);
  assert.match(source, /strictScopeMatch: true/);
  assert.match(source, /debug_o11_legacy_authentication_unsupported/);
  assert.match(source, /ValidateLogin\(selected, binding\)/);
  assert.match(source, /selected\.Login is not LoginInfoWithTokens/);
  assert.match(source, /GetTokenForServerCall\(selected\.Login\)\.TokenInfo\.IdToken/);
  assert.match(source, /\["soapUser"\] = selected\.Username, \["soapSecret"\] = soapSecret/);
  assert.match(source, /c\.Type == "allow_debug" && c\.Value == target/);
  assert.match(source, /c\.Type == "allow_debug" && c\.Value == entry/);
  assert.match(source, /GetMethod\("ReadJwtToken", new\[\] \{ typeof\(string\) \}\)/);
  assert.match(source, /finally \{ token = null; soapSecret = null; \}/);
  assert.match(source, /consumed \? "consumed" : uncertain \? "uncertain" : "failed"/);
  assert.match(source, /var uncertain = mintSubmitted \|\| authenticationSubmitted && !authenticationCompleted/);
  assert.match(source, /preflightSubmitted && !preflightCompleted && error is not AuthFailure/);
  assert.match(source, /request\.AllowAutoRedirect = false/);
  assert.match(source, /GetPageUri\(entryName, false, "_ping\.aspx", false, null, null, CancellationToken\.None\)/);
  assert.match(source, /GetAssemblyInfo\(selected\.Username, soapSecret, preflight\.TargetKey, preflight\.EntryName, false, preflight\.DefaultPersonalArea\)/);
  assert.match(source, /if \(info\.DebuggerVersion != 1\)/);
  assert.ok(source.indexOf('CheckAssembly(selected, preflight, soapSecret)') < source.indexOf('Mint(selected, binding)'));
  assert.doesNotMatch(source, /\.PingESpace\s*\(|\.SafeDo\s*\(|\.SafeDoAuthenticatedOperation\s*\(|TrustWhitelistCertificatePolicy/);
  assert.doesNotMatch(source, /GetSecretForWebServiceRequest\s*\(|LoginInfoWithPassword|Console\.|AssemblyLoadContext|SetEnvironmentVariable|Anvil\.Bridge\.|Anvil\.Core\./);
  assert.doesNotMatch(project, /ProjectReference|<Private>true<\/Private>/);
  const receipt = source.match(/File\.WriteAllText\(ReceiptPath,([^\n]+)/)?.[1];
  assert.ok(receipt); assert.doesNotMatch(receipt, /token|Login|Username|\.Message/);
});
