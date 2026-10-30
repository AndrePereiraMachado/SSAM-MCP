// The real hub (http-server.mjs + agent-hub.mjs) and a scripted agent that speaks ssam-agent/1 with fetch, for the tests of
// screen.render and ssam_render (fase4-28 r2-preview). The agent answers each call with its `answer(call, params)` (a value,
// {error}, {valueBlob: bytes} or 'silent'); params of a paramsBlob are downloaded first, as the agent does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { startHttpServer } from '../../http-server.mjs';
import { createTokenStore } from '../../server-tokens.mjs';

export const KERNEL = { o11: '11.55.91', odc: '1.7.28', odcBridge: 'v35' };
const hex = bytes => createHash('sha256').update(bytes).digest('hex');
export const BASE_KINDS = ['studio.processes', 'odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected', 'file.put', 'file.get', 'file.list', 'file.sync', 'net.probe'];

export async function startHub({ limits = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-render-hub-'));
  const handle = await startHttpServer({ createServer: async () => new McpServer({ name: 'none', version: '1.0.0' }), dir, port: 0,
    agents: { kernel: KERNEL, limits: { sweepMs: 50, ...limits } }, log: () => {} });
  const token = createTokenStore(dir).issue({ customer: 'Render' });
  return { dir, handle, token, base: handle.url.replace(/\/mcp$/, ''), link: () => handle.hub.link(token.id),
    close: async () => { await handle.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

export const helloOf = ({ kinds = null, instance = randomUUID(), version = '0.3.4' } = {}) => ({ t: 'hello', protocol: 'ssam-agent/1', instance,
  agent: { version, node: process.version, platform: 'win32', startedAt: new Date().toISOString(), ...(kinds ? { kinds } : {}) },
  pack: { id: 'pack-test', lanes: ['odc', 'o11'], odcBridge: 'v35', o11BuiltFor: '11.55.91' }, studios: null, o11Connection: null });

// One NDJSON stream: calls are handed to onCall as they arrive.
async function openStream(base, authorization, channel, onCall) {
  const response = await fetch(base + '/agent/v1/stream?channel=' + channel, { headers: { authorization } });
  if (response.status !== 200) throw new Error('stream ' + response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          if (line.trim()) { const message = JSON.parse(line); if (message.t === 'call') onCall(message); }
        }
      }
    } catch { /* cancelled */ }
  })();
  return { cancel: () => reader.cancel().catch(() => {}) };
}

// The scripted agent. kinds: its Hello's agent.kinds (null: an agent before 0.2.0). accept: false leaves calls unaccepted.
export function scriptedAgent(base, credential, { kinds = [...BASE_KINDS, 'screen.render'], answer = () => ({}), accept = true, instance = randomUUID() } = {}) {
  const authorization = 'Bearer ' + credential;
  const calls = [];
  let channel = null, stream = null;
  const post = messages => fetch(base + '/agent/v1/messages?channel=' + channel, { method: 'POST', headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ messages }) }).then(r => r.text());
  async function download(ref) {
    const chunks = [];
    for (let i = 0; i < ref.parts; i++) {
      const r = await fetch(base + '/agent/v1/blobs/' + ref.transfer + '/' + i + '?channel=' + channel, { headers: { authorization } });
      chunks.push(Buffer.from(await r.arrayBuffer()));
    }
    return Buffer.concat(chunks);
  }
  async function upload(bytes, partBytes = 4194304) {
    const transfer = randomBytes(16).toString('hex');
    const parts = Math.max(1, Math.ceil(bytes.length / partBytes));
    for (let i = 0; i < parts; i++) {
      const part = bytes.subarray(i * partBytes, (i + 1) * partBytes);
      const r = await fetch(base + '/agent/v1/blobs/' + transfer + '/' + i + '?channel=' + channel, { method: 'PUT', body: part,
        headers: { authorization, 'content-type': 'application/octet-stream', 'x-ssam-part-sha256': hex(part), 'x-ssam-total-sha256': hex(bytes),
          'x-ssam-total-size': String(bytes.length), 'x-ssam-parts': String(parts) } });
      await r.text();
      if (r.status !== 204) throw new Error('put ' + r.status);
    }
    return { transfer, sha256: hex(bytes), size: bytes.length, parts, partBytes };
  }
  async function onCall(call) {
    calls.push(call);
    if (!accept) return;
    await post([{ t: 'accepted', id: call.id }]);
    const params = call.paramsBlob ? JSON.parse((await download(call.paramsBlob)).toString('utf8')) : call.params;
    let reply;
    try { reply = await answer(call, params); } catch (error) { reply = { error: { code: error.code ?? 'AGENT_ERROR', message: error.message, executed: false } }; }
    if (reply === 'silent') return;
    if (reply?.error) return post([{ t: 'result', id: call.id, ok: false, error: reply.error }]);
    if (reply?.valueBlob) return post([{ t: 'result', id: call.id, ok: true, valueBlob: await upload(Buffer.from(JSON.stringify(reply.valueBlob), 'utf8')) }]);
    return post([{ t: 'result', id: call.id, ok: true, value: reply }]);
  }
  return {
    calls,
    async connect() {
      const r = await fetch(base + '/agent/v1/hello', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(helloOf({ kinds, instance })) });
      const body = await r.json();
      if (r.status !== 200) throw new Error('hello ' + r.status + ' ' + JSON.stringify(body));
      channel = body.channel;
      stream?.cancel();
      stream = await openStream(base, authorization, channel, call => { onCall(call); });
      return body;
    },
    close() { stream?.cancel(); },
  };
}

export const waitFor = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); }
};
