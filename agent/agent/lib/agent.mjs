// The SSAM agent in one object: channel (I-5), outbox, the 9 kinds, files and the Studio facts of the Hello.
// createAgent({ root, config, deps }) — every machine touch point is injectable for tests (deps: processes, locate,
// fileVersion, describe, attachOdc, attachO11, fetch, now, setTimeout, clearTimeout, random, sleep, partMs).
// The channel's HTTP is net.mjs (fase4-24, docs/FASE2-AGENTE.md 2.9) unless deps.fetch replaces it; SSAM_AGENT_HTTP=fetch
// in the environment goes back to Node's built-in fetch (the part deadlines stay; the connection rules do not).
// config: { server, credential?, o11Port? }; without config.credential the agent reads private\credential.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createChannel, PROTOCOL } from './channel.mjs';
import { createOutbox } from './outbox.mjs';
import { createKinds, KINDS } from './kinds.mjs';
import { createWorkspace } from './workspace.mjs';
import { uploadBlob, downloadBlob, PART_BYTES, MAX_FILE_BYTES } from './blobs.mjs';
import { createHttp } from './net.mjs';
import { listProcesses, fileVersion, locateInstalled, installedStudios, macFileVersion, macLocate } from './studios.mjs';
import { attachOdc } from './odc-attach.mjs';
import { connector, readConnection } from './o11-connect.mjs';
import { createMacAttach } from './attach-unix.mjs';
import { createUnixPipe } from './odc-pipe-unix.mjs';
import { AgentError } from './errors.mjs';

// 0.2.0 (servidor/fase4): C03 (POST of 10 s, pong in its own POST, stream headers in 15 s), C26 (agent.root in the Hello),
// C14 (file.sync), the query-test command of the ODC bridge v45 and the process listing without PowerShell for known pids.
// 0.3.0 (24th release, ODC bridge v96): sc_http in o11.bridge, reference-producers in odc.pipe and the transport block of
// o11-bridge.mjs again. The hub logs this version at each connection (agent-connected), so the server log tells which
// customers still run an older pack (plan risk R7).
// 0.2.1 (fase4-24/agente-rede): net.mjs (idle reuse of 2 s, TCP keep-alive probes, fresh connection after a failure), a deadline per
// blob part with the retry on a fresh connection, the hello in 15 s.
// 0.3.1 (servidor/fase4-24): 0.3.0 and 0.2.1 together, plus the net.probe kind for ssam_doctor {network:true}.
// 0.3.2 (servidor/fase4-26 a8, the next agent pack): the English agent (server/english-agent) with the O11 thin bridge that
// runs the Studio's own Manage Dependencies by code (refresh_references:add); the kinds and the wire are those of 0.3.1.
// 0.3.3 (server/agent-mac): the macOS side (bundles, the diagnostic IPC attach, the Unix bridge pipe, POSIX paths,
// install.sh and ssam-agent.sh); Windows, the kinds and the wire are those of 0.3.2. The server only shows and logs this
// version (agent-hub.mjs info().agentVersion and agent-connected, 87e12565): no server change.
export const AGENT_VERSION = '0.3.3';
const INLINE_MAX_BYTES = 524288;
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const STUDIOS_REFRESH_MS = 5 * 60000;
const clip = text => String(text ?? '').slice(0, 4000);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

// The machine this agent runs on (owner test, 2026-10-08; disclosed in docs/AGENTE-CLIENTE.md): the computer name, the
// Windows user, and an id that is a hash of the Windows MachineGuid with both. Nothing else about the machine is sent.
// On macOS the id hashes the IOPlatformUUID of the Mac (ioreg) the same way, with the computer name and the macOS user.
export function machineIdentity({ platform = process.platform, run = execFileSync } = {}) {
  let guid = '';
  if (platform === 'darwin') {
    try { guid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 }))?.[1] ?? ''; }
    catch { /* no ioreg: the id still covers name and user */ }
  } else try {
    const out = run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    guid = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out)?.[1] ?? '';
  } catch { /* not Windows or no access: the id still covers name and user */ }
  let user = '';
  try { user = os.userInfo().username; } catch { /* no user info */ }
  const name = os.hostname();
  return { id: createHash('sha256').update([guid, name, user].join('|')).digest('hex').slice(0, 16), name: name.slice(0, 64), user: user.slice(0, 64) };
}

export const credentialFile = root => path.join(root, 'private', 'credential');
export const CREDENTIAL_PATTERN = /^ssam_agent_[A-Za-z0-9_-]{43}$/;

// pack.json of the extracted pack (I-9): {id, lanes, odcBridge, o11BuiltFor, o11Hook, o11Bridge, files}. o11Hook is
// "dev" (development hook) or "h1" (signed release layout); o11Bridge {id, hookAbi, path, sha256} is the thin bridge the
// version handshake compares with bridge_manifest. Packs before servidor/fase3 have neither (null).
export function readPack(root) {
  const bridgeOf = value => (value && typeof value === 'object' ? { id: value.id ?? null, hookAbi: value.hookAbi ?? null, path: value.path ?? null,
    sha256: typeof value.sha256 === 'string' ? value.sha256 : null } : null);
  try {
    const pack = readJson(path.join(root, 'pack.json'));
    return { id: pack.id ?? null, lanes: Array.isArray(pack.lanes) ? pack.lanes : [], odcBridge: pack.odcBridge ?? null, o11BuiltFor: pack.o11BuiltFor ?? null,
      o11Hook: typeof pack.o11Hook === 'string' ? pack.o11Hook : null, o11Bridge: bridgeOf(pack.o11Bridge) };
  } catch { return { id: null, lanes: [], odcBridge: null, o11BuiltFor: null, o11Hook: null, o11Bridge: null }; }
}

// deps.platform (tests): 'darwin' wires the macOS side (macos.mjs, attach-unix.mjs, odc-pipe-unix.mjs; deps.mac goes to
// createMacAttach); the default is this system.
export function createAgent({ root, runtimeRoot = root, config = {}, deps = {}, log = () => {}, onState = () => {} }) {
  const base = path.resolve(root);
  const platform = deps.platform ?? process.platform;
  const mac = platform === 'darwin' ? createMacAttach(deps.mac ?? {}) : null;
  const d = { processes: image => listProcesses(image, { platform }), fileVersion: mac ? macFileVersion : fileVersion,
    locate: kind => (mac ? macLocate(kind) : locateInstalled(kind)), describe: null, attachOdc: mac ? mac.attachOdc : attachOdc, attachO11: null,
    pipeCall: mac ? createUnixPipe({ folders: mac.pipeFolders }) : undefined,
    fetch: undefined, now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, random: Math.random,
    sleep: undefined, partMs: undefined, ...deps };
  const transport = d.fetch || process.env.SSAM_AGENT_HTTP === 'fetch' ? null : createHttp();
  d.fetch ??= transport ? transport.fetch : globalThis.fetch;
  const run = connector(path.resolve(runtimeRoot));
  // macOS: describe and attach of Service Studio through the diagnostic IPC (no Anvil.Connect, no .NET).
  d.describe ??= mac ? mac.describeO11 : pid => run(['describe', pid]);
  d.attachO11 ??= mac ? mac.attachO11 : (pid, startedUtc, hook) => run(['attach', pid, startedUtc, hook]);

  const credential = config.credential ?? fs.readFileSync(credentialFile(base), 'utf8').trim();
  const pack = readPack(runtimeRoot);
  const ws = createWorkspace(base, { platform });
  const outbox = createOutbox();
  const instance = randomUUID();
  const startedAt = new Date(d.now()).toISOString();
  const machine = deps.machine === undefined ? machineIdentity({ platform }) : deps.machine;
  let studios = null; let studiosAt = 0; let connection = null; let reported = null;

  const limits = () => {
    const welcome = channel.welcome();
    return { partBytes: welcome?.partBytes ?? PART_BYTES, maxFileBytes: welcome?.maxFileBytes ?? MAX_FILE_BYTES, inlineMaxBytes: welcome?.inlineMaxBytes ?? INLINE_MAX_BYTES,
      maxValueBytes: welcome?.maxValueBytes ?? MAX_VALUE_BYTES };
  };
  const blobs = {
    upload: source => uploadBlob(source, { put: channel.blobPut, partBytes: limits().partBytes, sleep: d.sleep, partMs: d.partMs, log }),
    download: (ref, dest) => downloadBlob(ref, dest, { get: channel.blobGet, limits: limits(), sleep: d.sleep, partMs: d.partMs, log }),
  };

  const view = record => (record ? { pid: record.pid, startedUtc: record.startedUtc, port: record.port, studioVersion: record.studioVersion ?? null } : null);
  // The recorded O11 connection, only while that Service Studio still runs.
  async function currentConnection() {
    const record = readConnection(base);
    if (!record) return null;
    const running = await d.processes('ServiceStudio.exe').catch(() => []);
    return running.some(p => Number(p.pid) === record.pid) ? view(record) : null;
  }
  async function refreshStudios() {
    studios = await installedStudios({ locate: d.locate, version: d.fileVersion, platform });
    studiosAt = d.now();
  }

  async function hello() {
    if (!studios) await refreshStudios();
    connection = await currentConnection();
    reported = JSON.stringify({ studios, o11Connection: connection });
    return { t: 'hello', protocol: PROTOCOL, instance,
      // root (C26): the folder of this agent, so the server names its inbox exactly; kinds: what this agent runs (file.sync
      // since 0.2.0), so the server never asks an older agent for a kind it does not have.
      agent: { version: AGENT_VERSION, node: process.version, platform, startedAt, root: base, kinds: [...KINDS], machine },
      pack: { id: pack.id, lanes: pack.lanes, odcBridge: pack.odcBridge, o11BuiltFor: pack.o11BuiltFor, o11Hook: pack.o11Hook },
      studios, o11Connection: connection };
  }

  // pong.versions only when something changed since the last report; installed Studios are looked up again every
  // 5 minutes, in the background (the next pong carries the change).
  function pongVersions() {
    if (d.now() - studiosAt >= STUDIOS_REFRESH_MS) { studiosAt = d.now(); refreshStudios().catch(() => {}); }
    const current = JSON.stringify({ studios, o11Connection: connection });
    if (current === reported) return undefined;
    reported = current;
    return { studios, o11Connection: connection };
  }

  // probe: the uploads of the network check (kind net.probe, net-probe.mjs); a kinds.mjs without that kind ignores it.
  const kinds = createKinds({ root: base, runtimeRoot: path.resolve(runtimeRoot), ws, pack, kernel: () => channel.welcome()?.kernel ?? null, deps: d, blobs, limits,
    o11Port: Number.isInteger(config.o11Port) ? config.o11Port : 4516, onConnection: record => { connection = view(record); },
    probe: (id, body, options) => channel.probePut(id, body, options), platform });

  // One call -> its result message. A value above inlineMaxBytes (measured on the whole serialized message) goes as
  // a blob, up to maxValueBytes (the server assembles a value in memory and refuses a larger one: VALUE_TOO_LARGE, sent
  // here without uploading it). Errors keep their code and what may have run (executed: false | null; sent for odc.pipe).
  async function execute(call) {
    const started = d.now();
    try {
      let params = call.params;
      if (call.paramsBlob) {
        const temporary = path.join(base, 'private', 'tmp', randomBytes(8).toString('hex') + '.json');
        try { await blobs.download(call.paramsBlob, temporary); params = readJson(temporary); }
        finally { fs.rmSync(temporary, { force: true }); }
      }
      const value = await kinds.execute(call.kind, params ?? {});
      let message = { t: 'result', id: call.id, ok: true, value };
      if (Buffer.byteLength(JSON.stringify(message)) > limits().inlineMaxBytes) {
        const bytes = Buffer.from(JSON.stringify(value));
        if (bytes.length > limits().maxValueBytes)
          throw new AgentError('VALUE_TOO_LARGE', `The result of ${call.kind} has ${bytes.length} bytes, above the ${limits().maxValueBytes} the server accepts for a value`, { executed: null });
        message = { t: 'result', id: call.id, ok: true, valueBlob: await blobs.upload(bytes) };
      }
      log('call', { id: call.id, kind: call.kind, ms: d.now() - started, ok: true });
      return message;
    } catch (error) {
      const known = error instanceof AgentError;
      const detail = { code: known ? error.code : 'AGENT_ERROR', message: clip(error.message), executed: known ? error.executed : null };
      if (known && error.sent !== undefined) detail.sent = error.sent;
      log('call', { id: call.id, kind: call.kind, ms: d.now() - started, ok: false, code: detail.code });
      return { t: 'result', id: call.id, ok: false, error: detail };
    }
  }

  function onCall(call) {
    const state = outbox.receive(call.id);
    channel.flush();
    if (state !== 'new') { log('call-repeated', { id: call.id, state }); return; }
    execute(call).then(result => { outbox.finish(call.id, result); channel.flush(); });
  }

  // deps.channel (tests): the channel's own timings (messagesMs, streamHeadersMs).
  const channel = createChannel({ server: config.server, credential, hello, onCall, outbox, pongVersions, fetch: d.fetch, now: d.now,
    setTimeout: d.setTimeout, clearTimeout: d.clearTimeout, random: d.random, log, onState, ...(d.channel ?? {}) });

  return {
    instance,
    run: () => channel.run(),
    // After the channel's own goodbye (DELETE /agent/v1/channel), the pooled connections are closed.
    stop: async () => { await channel.stop(); transport?.close(); },
    // One kind run locally exactly as a call would run it (tests, diagnostics): the result message.
    execute: (kind, params) => execute({ id: randomUUID(), kind, params }),
    outbox,
    channel,
  };
}
