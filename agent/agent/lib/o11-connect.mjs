// O11 connection on the agent (docs/FASE2-AGENTE.md 4.9): the same steps as studio-connect.mjs connectO11, with the
// pack's prebuilt binaries and nothing compiled here. describe -> copy the runtime hook beside its .json -> attach ->
// wait for the bridge -> authenticate with private\authority\bridge.key -> write private\o11-connection.json.
// One lock per port (private\runtime-connect\port-<port>.lock); an attach that may have executed is never repeated,
// and a Studio that already has Anvil loaded is never given another DLL.
// A pack with the release hook (pack.json o11Hook "h1", docs/O11-BRIDGE-FINA.md 13) attaches studio\o11\hook\
// Anvil.Hook.h1.dll in place instead: before the single attach the agent checks that release.sig.jws covers every file of
// studio\o11\bridge\b1 and the hook, then writes request-b1.json in the hook's exchange folder (the runtime contract,
// %USERPROFILE%\.ssam-hybrid\data\o11\runtime-connect\<pid>-<start ms>); the hook checks the signature and the files
// again, loads the bridge in its own load context and writes receipt-b1.json. Either way the bridge is used only after
// the version handshake: bridge_manifest says flavor "thin", the Studio pid and the sha256 of the very file the pack
// carries (and, with h1, bridgeId b1 and hookAbi h1); otherwise BRIDGE_VERSION_MISMATCH and nothing more is sent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bridgeRequest } from './o11-wire.mjs';
import { AgentError } from './errors.mjs';

const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const fail = (message, executed = false) => new AgentError('ATTACH_FAILED', message, { executed });

export const connectionFile = root => path.join(root, 'private', 'o11-connection.json');
export const bridgeKeyFile = root => path.join(root, 'private', 'authority', 'bridge.key');
export const connectorDll = root => path.join(root, 'bin', 'o11', 'connect', 'Anvil.Connect.dll');

export const HOOK_ABI = 'h1';
export const RELEASE_BRIDGE_ID = 'b1';
export const hookH1Dll = root => path.join(root, 'studio', 'o11', 'hook', 'Anvil.Hook.h1.dll');
export const releaseBridgeDir = root => path.join(root, 'studio', 'o11', 'bridge', RELEASE_BRIDGE_ID);
// The bridge log of a release-hook load (<dataDir>\bridge-<port>.log): private, never read by the server.
export const bridgeDataDir = root => path.join(root, 'private', 'o11-bridge');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const mismatch = (message, executed) => new AgentError('BRIDGE_VERSION_MISMATCH', message, { executed });

// The exchange folder of the release hook h1 for one Studio process, the rule of RuntimeContract.HookExchangeDir (the
// USERPROFILE variable first): <profile>\.ssam-hybrid\data\o11\runtime-connect\<pid>-<start time in Unix ms>.
export function hookExchangeDir(pid, startedUtc, env = process.env) {
  const ms = Date.parse(startedUtc);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ms) || ms <= 0) throw fail('The Studio start time is unknown; the release hook cannot be addressed.');
  const profile = env.USERPROFILE ? path.resolve(env.USERPROFILE) : os.homedir();
  return path.join(profile, '.ssam-hybrid', 'data', 'o11', 'runtime-connect', pid + '-' + ms);
}

// Before the single attach of a release-hook pack: release.json above the bridge and release.sig.jws whose payload
// (ssam-release/1) lists every file of studio\o11\bridge\b1 and the hook with their size and sha256. The hook checks the
// signature chain itself (roots compiled into it); this check keeps a tampered or half-copied pack from burning the
// one attach this Studio start allows.
export function verifyReleaseCoverage(root) {
  if (!fs.existsSync(path.join(root, 'release.json'))) throw fail('This pack declares the release hook but has no release.json; reinstall the pack.');
  let payload;
  try {
    const parts = fs.readFileSync(path.join(root, 'release.sig.jws'), 'utf8').trim().split('.');
    if (parts.length !== 3) throw new Error('not a compact JWS');
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (error) { throw fail('The signed manifest of this pack (release.sig.jws) is missing or unreadable (' + error.message + '); reinstall the pack.'); }
  if (payload?.typ !== 'ssam-release/1' || !Array.isArray(payload.files)) throw fail('release.sig.jws of this pack is not an ssam-release/1 manifest; reinstall the pack.');
  const listed = new Map(payload.files.map(entry => [String(entry?.path ?? '').toLowerCase(), entry]));
  const files = [hookH1Dll(root)];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else files.push(full);
  } };
  if (!fs.existsSync(releaseBridgeDir(root))) throw fail('This pack declares the release hook but has no studio\\o11\\bridge\\' + RELEASE_BRIDGE_ID + '; reinstall the pack.');
  walk(releaseBridgeDir(root));
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const entry = listed.get(rel.toLowerCase());
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { throw fail(`${rel} is missing from this pack; reinstall the pack. Nothing was attached.`); }
    if (!entry) throw fail(`release.sig.jws does not list ${rel} (added after signing?); reinstall the pack. Nothing was attached.`);
    if (Number(entry.size) !== bytes.length || entry.sha256 !== sha256(bytes)) throw fail(`${rel} does not match release.sig.jws (changed after signing); reinstall the pack. Nothing was attached.`);
  }
  return { version: payload.version ?? null, files: files.length };
}

// The sha256 the pack.json of this pack records for its thin bridge, or null when it records none.
export function expectedBridgeSha256(pack) {
  if (typeof pack?.o11Bridge?.sha256 === 'string') return pack.o11Bridge.sha256;
  const entry = (pack?.files ?? []).find(f => f?.path === (pack?.o11Hook === HOOK_ABI ? 'studio/o11/bridge/' + RELEASE_BRIDGE_ID + '/Anvil.Bridge.dll' : 'bin/o11/bridge/Anvil.Bridge.dll'));
  return typeof entry?.sha256 === 'string' ? entry.sha256 : null;
}

// The version handshake over the bridge_manifest of a bridge that answers for this Studio: it must be the pack's own file
// (bridgeSha256), and with the release hook the release bridge b1 loaded by h1. A mismatch leaves the bridge loaded and
// unused: nothing else is sent to it.
export function handshake(manifest, { pack, port, executed }) {
  const problems = [];
  const expected = expectedBridgeSha256(pack);
  if (expected && manifest?.bridgeSha256 !== expected) problems.push('its file is ' + (manifest?.bridgeSha256 ?? 'not reported') + ', the pack carries ' + expected);
  if (pack?.o11Hook === HOOK_ABI) {
    if (manifest?.hookAbi !== HOOK_ABI) problems.push('hookAbi ' + (manifest?.hookAbi ?? 'none') + ', the pack needs ' + HOOK_ABI);
    if (manifest?.bridgeId !== RELEASE_BRIDGE_ID) problems.push('bridgeId ' + (manifest?.bridgeId ?? 'none') + ', the pack loads ' + RELEASE_BRIDGE_ID);
  }
  if (problems.length) throw mismatch(`The thin bridge on port ${port} is not the one of this pack (${problems.join('; ')}). It stays loaded but unused; restart Service Studio to load the pack's bridge.`, executed);
}

export function readConnection(root) {
  try { const record = readJson(connectionFile(root)); return Number.isInteger(record?.port) && Number.isInteger(record?.pid) ? record : null; }
  catch { return null; }
}
export function readBridgeKey(root) {
  try { return fs.readFileSync(bridgeKeyFile(root), 'utf8').trim() || null; } catch { return null; }
}

// `dotnet bin\o11\connect\Anvil.Connect.dll <args>` -> its JSON answer ({ok:false, error} throws).
export function connector(root, { run = exec } = {}) {
  return async args => {
    let stdout;
    try { ({ stdout } = await run('dotnet', [connectorDll(root), ...args.map(String)], { windowsHide: true, timeout: 30000 })); }
    catch (error) { stdout = error.stdout; if (!stdout) throw fail('Anvil.Connect failed: ' + error.message, args[0] === 'attach' ? null : false); }
    let result;
    try { result = JSON.parse(String(stdout).trim()); } catch { throw fail('Anvil.Connect answered no JSON', args[0] === 'attach' ? null : false); }
    if (!result.ok) throw fail(result.error ?? 'Anvil.Connect refused', args[0] === 'attach' ? null : false);
    return result;
  };
}

// A state with no event to wait on, polled with backoff (250 ms doubling to 2 s) up to a deadline.
export async function pollWithBackoff(check, { deadlineMs = 30000, initialMs = 250, maxMs = 2000, sleep = delay, now = Date.now } = {}) {
  const deadline = now() + deadlineMs;
  for (let wait = initialMs; ; wait = Math.min(maxMs, wait * 2)) {
    const value = await check();
    if (value) return value;
    const left = deadline - now();
    if (left <= 0) return null;
    await sleep(Math.min(wait, left));
  }
}

// Is an Anvil bridge (protocol 2, authenticated) listening on the port, and for which Studio pid. Only the thin bridge
// of the pack counts (docs/O11-BRIDGE-FINA.md 6.6): another Anvil bridge (the owner's full bridge, an older pack) is
// {connected:false, occupied:true, thin:false}.
export async function probeBridge(port, request = bridgeRequest) {
  try {
    const ping = await request({ port }, 'ping', {}, { timeoutMs: 2500 });
    if (ping?.success !== true || ping.data?.bridge !== 'anvil' || !Number.isInteger(ping.data.pid)) return { connected: false, occupied: true };
    const manifest = await request({ port }, 'bridge_manifest', {}, { timeoutMs: 2500 });
    if (manifest?.success !== true || manifest.data?.protocolVersion !== 2 || manifest.data?.authentication !== true) return { connected: false, occupied: true };
    if (manifest.data.flavor !== 'thin') return { connected: false, occupied: true, thin: false, pid: ping.data.pid };
    return { connected: true, pid: ping.data.pid, version: ping.data.version ?? null, manifest: manifest.data };
  } catch (error) {
    return { connected: false, occupied: error.code !== 'BRIDGE_NOT_LISTENING' };
  }
}

const nonThin = (port, executed = false) =>
  fail(`A non-thin Anvil bridge answers on port ${port}. The agent only talks to the thin bridge of its package; restart Service Studio.`, executed);

const failedReceipt = hook => { try { return readJson(hook + '.receipt.json').ok === false; } catch { return false; } };

export async function connectO11({ root, runtimeRoot = root, pid, port, studioVersion = null, describe, attach, probe = probeBridge, request = bridgeRequest,
  sleep = delay, now = Date.now, pack = null, env = process.env, warning = null }) {
  const folder = path.join(root, 'private', 'runtime-connect');
  fs.mkdirSync(folder, { recursive: true });
  const lock = path.join(folder, 'port-' + port + '.lock');
  const releaseHook = pack?.o11Hook === HOOK_ABI;
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch { throw fail(`Another connection attempt holds port ${port}. Wait for its result; do not restart the Studio.`); }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date(now()).toISOString() }));
    const target = await describe(pid);
    let probed = await probe(port);
    if (probed.thin === false) throw nonThin(port);
    const reused = probed.connected && probed.pid === target.pid;
    if ((probed.connected && !reused) || (!probed.connected && probed.occupied))
      throw fail(`Bridge port ${port} is already occupied${probed.pid ? ' by Studio ' + probed.pid : ''}. The Studio was not changed.`);
    if (reused) handshake(probed.manifest, { pack, port, executed: false });
    if (!reused) {
      if (!target.diagnosticsAvailable) throw fail('The Studio diagnostics endpoint is unavailable. Check process permissions; the Studio remains open.');
      if (target.bridgePath || target.corePath)
        throw fail(`Anvil is already loaded in this Studio but its bridge did not respond on port ${port}. Loading another DLL is refused.`);
      const pending = path.join(folder, createHash('sha256').update(target.pid + ':' + target.startedUtc + ':' + port).digest('hex') + '.json');
      if (fs.existsSync(pending)) throw fail('A previous attach of this Studio may already have executed; it is never repeated. Restart Service Studio to connect again.');
      const id = randomUUID().replaceAll('-', '');
      let hook, receiptFile = null, exchange = null;
      if (releaseHook) {
        // The release hook is attached in place (it writes nothing beside its DLL); its request goes to the exchange folder.
        verifyReleaseCoverage(runtimeRoot);
        exchange = hookExchangeDir(target.pid, target.startedUtc, env);
        receiptFile = path.join(exchange, 'receipt-' + RELEASE_BRIDGE_ID + '.json');
        if (fs.existsSync(receiptFile)) throw fail('The release hook already answered for this Studio (' + receiptFile + '); a load is never repeated. Restart Service Studio to connect again.');
        hook = hookH1Dll(runtimeRoot);
      } else {
        const evidence = path.join(folder, id);
        fs.mkdirSync(evidence, { recursive: true });
        hook = path.join(evidence, 'Anvil.RuntimeHook.Agent.dll');
        fs.copyFileSync(path.join(runtimeRoot, 'bin', 'o11', 'hook', 'Anvil.RuntimeHook.Agent.dll'), hook);
        fs.writeFileSync(hook + '.json', JSON.stringify({ pid: target.pid, startedUtc: target.startedUtc, port,
          bridgePath: path.join(runtimeRoot, 'bin', 'o11', 'bridge', 'Anvil.Bridge.dll'), authorityDir: path.join(root, 'private', 'authority') }));
      }
      // Identity and port again after preparing, right before the single attach request.
      const current = await describe(target.pid);
      if (current.startedUtc !== target.startedUtc || current.bridgePath || current.corePath) throw fail('The Studio changed while preparing the connector. No hook was sent.');
      probed = await probe(port);
      if (probed.thin === false) throw nonThin(port);
      if (probed.connected || probed.occupied) throw fail('The bridge port became occupied while preparing the connector. No hook was sent.');
      if (releaseHook) {
        fs.mkdirSync(exchange, { recursive: true });
        const requestFile = path.join(exchange, 'request-' + RELEASE_BRIDGE_ID + '.json');
        const staged = requestFile + '.' + process.pid + '.tmp';
        fs.writeFileSync(staged, JSON.stringify({ pid: target.pid, startedUtc: target.startedUtc, bridgeId: RELEASE_BRIDGE_ID, bridgeDir: releaseBridgeDir(runtimeRoot),
          port, dataDir: bridgeDataDir(root), authorityDir: path.join(root, 'private', 'authority') }));
        fs.renameSync(staged, requestFile);
      }
      fs.writeFileSync(pending, JSON.stringify({ evidence: id, pid: target.pid, startedUtc: target.startedUtc, hook: releaseHook ? HOOK_ABI : 'dev' }));
      let attachError = null;
      try { await attach(target.pid, target.startedUtc, hook); } catch (error) { attachError = error.message; }
      const refusedReceipt = () => { try { const receipt = readJson(receiptFile); return receipt.ok === false ? receipt : null; } catch { return null; } };
      await pollWithBackoff(async () => {
        probed = await probe(port);
        return probed.connected || probed.thin === false || (releaseHook ? refusedReceipt() !== null : failedReceipt(hook));
      }, { deadlineMs: 30000, sleep, now });
      if (probed.thin === false) throw nonThin(port, null);
      const refusal = releaseHook && !probed.connected ? refusedReceipt() : null;
      if (refusal) throw fail('The release hook refused the bridge of this pack: ' + (refusal.error ?? 'no reason') + '. It is not repeated; reinstall the pack and restart Service Studio.', null);
      if (!probed.connected || probed.pid !== target.pid) throw fail('Attach not confirmed; do not repeat it. ' + (attachError ?? ''), null);
      handshake(probed.manifest, { pack, port, executed: null });
    }
    // The bridge creates the key when it starts (BridgeAccess.Initialize) in the authority folder the hook gave it.
    const key = readBridgeKey(root);
    if (!key) throw fail('The bridge answered but private\\authority\\bridge.key is missing; the agent cannot authenticate.', null);
    const alive = await request({ port, authorization: key }, 'ui_alive', { timeout_ms: 1000 }, { timeoutMs: 6000 }).catch(error => ({ success: false, error: error.message }));
    if (alive?.success !== true) throw fail('The bridge did not accept the agent key: ' + (alive?.error ?? 'refused'), null);
    const confirmed = await describe(target.pid);
    if (confirmed.startedUtc !== target.startedUtc) throw fail('The Studio changed before the connection was confirmed.', null);
    const record = { ok: true, lane: 'o11', connected: true, reused, pid: target.pid, startedUtc: target.startedUtc,
      studioVersion: studioVersion ?? target.version ?? null, port, uiResponsive: alive.data?.alive === true, connectedAt: new Date(now()).toISOString(),
      hook: releaseHook ? HOOK_ABI : 'dev', bridgeId: probed.manifest?.bridgeId ?? null, bridgeSha256: probed.manifest?.bridgeSha256 ?? null,
      ...(warning ? { warning } : {}) };
    const file = connectionFile(root);
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2));
    fs.renameSync(temporary, file);
    return record;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

// o11.selected: is the recorded Studio still the one behind the bridge (ping + describe)? Never changes anything.
export async function selectedO11({ root, describe, request = bridgeRequest }) {
  const record = readConnection(root);
  if (!record) return { connected: false, pid: null, startedUtc: null, version: null };
  const gone = { connected: false, pid: record.pid, startedUtc: record.startedUtc, version: record.studioVersion ?? null };
  try {
    const ping = await request({ port: record.port }, 'ping', {}, { timeoutMs: 2500 });
    if (ping?.success !== true || ping.data?.pid !== record.pid) return gone;
    const actual = await describe(record.pid);
    if (actual.startedUtc !== record.startedUtc) return gone;
  } catch { return gone; }
  return { connected: true, pid: record.pid, startedUtc: record.startedUtc, version: record.studioVersion ?? null };
}
