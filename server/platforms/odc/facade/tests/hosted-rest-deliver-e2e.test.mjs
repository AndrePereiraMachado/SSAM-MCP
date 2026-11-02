// fase4-28 r4-rest-hosted (C2 of PLANO-11H): a full REST job on a hosted server, consume plus deliver, end to end. The real
// hosted server (runServed: HTTP, hub, gate, AgentExecutor), the real agent in this process, and the fake Studios of the
// process e2e (fixtures/fake-studios-process.mjs: the thin O11 bridge's wire contract, the kernel's blank-service module
// open, a merge that replaces the open module's bytes with the candidate's). One o11_deliver carries:
//   - rest-consume with every input inline (its hosted input mode: each GET method with its sample);
//   - the op rest written by hand ({client, methods}: davi's case of 27/10, which applied its writes and then failed the
//     delivery checks with PATH_OUTSIDE_WORKSPACE three times);
//   - rest-expose (an exposed REST method mapped to a server action of the same job);
//   - one check per element the job writes (find_element: on the thin bridge, a snapshot_module into the kernel's TEMP).
// The server's kernel CLI applies the job over the capture, the relay carries snapshot_module and merge_from_oml to the
// agent, and the checks run over a capture of the delivered module. With and without SSAM_BACKEND_NAME (the production
// servers set it: on 27/10 the kernel's TEMP was outside the agent mirror there, the cause of davi's failure, fixed by
// 3f0eb175 hostedTempDir). The global fetch fails the test if anything asks for the network. Never a real Studio: the fake
// pipe and bridge use unlikely pids; the kernel loads the installed Service Studio's assemblies headless (no process).
// Needs the kernel's O11 CLI (kernel/.local/cli/anvil.dll or SSAM_E2E_O11_CLI) and an installed Service Studio 11; skips
// with the reason otherwise.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ODC_BRIDGE } from './fixtures/odc-bridge-version.mjs';

const facade = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repo = path.resolve(facade, '..', '..', '..');
const kernel = path.join(repo, 'kernel');
const AGENT_ENTRY = path.join(repo, 'agent', 'ssam-agent.mjs');
const CLI = process.env.SSAM_E2E_O11_CLI || path.join(kernel, '.local', 'cli', 'anvil.dll');
const STUDIO = process.env.ANVIL_STUDIO_DIR || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OutSystems', 'Service Studio 11', 'Service Studio');
const skip = !fs.existsSync(AGENT_ENTRY) ? 'the agent box is not beside this server box (' + AGENT_ENTRY + ')'
  : !fs.existsSync(CLI) ? 'the kernel O11 CLI is not built (' + CLI + ')'
  : !fs.existsSync(STUDIO) ? 'no Service Studio 11 installed for the kernel to load headless (' + STUDIO + ')' : false;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(100); } return null; };
const recorded = name => JSON.parse(fs.readFileSync(path.join(kernel, 'tests', 'fixtures', 'rest-consume', name + '.json'), 'utf8'));
async function freePort() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const port = 7400 + Math.floor(Math.random() * 100);
    const free = await new Promise(resolve => { const s = net.createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
    if (free) return port;
  }
  throw new Error('no free port in 7400-7499');
}

// The job: what a model writes for "consume these APIs, and expose a lookup", every input inline.
const O11_MODULE = { oml: path.join(kernel, 'tests', 'fixtures', 'blank-service.oml'), name: 'Headless_CS', key: 'Kawk_WFx5USxo7qFAB0lCQ',
  environment: 'thin-e2e.outsystemscloud.com', systemKey: 'uXCIR2Atc0+es3zYuZSnNw' };
const JOB = { expectValid: true, ops: [
  { op: 'rest-consume', data: { name: 'Ibge', baseUrl: 'https://servicodados.ibge.gov.br/api/v1/localidades', methods: [
    { name: 'Estados', url: '/estados', resource: 'State', sample: recorded('ibge-estados') }] } },
  { op: 'rest', data: { client: { name: 'ViaCepApi', baseUrl: 'https://viacep.com.br' },
    methods: [{ name: 'GetAddressByCep', http: 'GET', path: '/ws/{CEP}/json/', inputs: [{ name: 'CEP', type: 'Text', in: 'url' }],
      response: { sample: { cep: '01001-000', logradouro: 'Praca da Se', uf: 'SP' } } }] } },
  { op: 'spec', data: { structures: [{ name: 'CepInfo', attributes: [{ name: 'Cep', type: 'Text' }, { name: 'Uf', type: 'Text' }] }] } },
  { op: 'logic', data: { actions: [{ name: 'CepInfo_Get', inputs: [{ name: 'Cep', type: 'Text' }], outputs: [{ name: 'Info', type: 'CepInfo' }],
    steps: [{ call: 'IRestAction:GetAddressByCep', as: 'GetAddress', args: { CEP: 'Cep' } }, { assign: { 'Info.Cep': 'Cep', 'Info.Uf': 'GetAddress.Response.uf' } }] }] } },
  { op: 'rest-expose', data: { service: { name: 'CepService' },
    methods: [{ name: 'GetCep', http: 'GET', path: '/cep/{Cep}', inputs: [{ name: 'Cep', type: 'Text', in: 'url' }],
      outputs: [{ name: 'Info', type: 'CepInfo' }], action: 'IServerAction:CepInfo_Get' }] } }] };
const CHECKS = ['Ibge', 'ViaCepApi', 'CepService'];
// SSAM_E2E_JOB=<file.json> {job, checks}: another job through the same path (the blind test of r4-rest-hosted uses it); the
// assertions are the same: delivered, every check found, nothing fetched, no server path.
const GIVEN = process.env.SSAM_E2E_JOB ? JSON.parse(fs.readFileSync(process.env.SSAM_E2E_JOB, 'utf8')) : null;
const RUN_JOB = GIVEN?.job ?? JOB, RUN_CHECKS = GIVEN?.checks ?? CHECKS;

function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return fn().finally(restore);
}

const verdicts = [];
test.after(() => { if (process.env.SSAM_E2E_VERDICT) fs.writeFileSync(process.env.SSAM_E2E_VERDICT, JSON.stringify(verdicts, null, 2)); });

for (const backend of [undefined, 'o11-11.55.92-odc-1.7.28']) {
  test('hosted, full REST job (' + (backend ? 'backend ' + backend : 'single backend') + '): rest-consume with its samples inline, the op rest by hand and rest-expose, delivered through the gate, the relay, the agent and the thin bridge, checks found, no PATH_OUTSIDE_WORKSPACE, nothing fetched',
    { skip, timeout: 900000 }, async t => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-rest-e2e-'));
      t.after(() => fs.rmSync(base, { recursive: true, force: true }));
      const dir = path.join(base, 'server');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'kernel.json'), JSON.stringify({ o11: '11.55.92', odc: '1.7.28', odcBridge: ODC_BRIDGE }));
      await withEnv({ SSAM_SERVER_DIR: dir, SSAM_BACKEND_NAME: backend, ANVIL_STUDIO_DIR: STUDIO, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_ODC_OFFLINE: '1',
        SSAM_MODULE_INDEX_ROOT: path.join(base, 'module-index'), SSAM_READER_CACHE_ROOT: path.join(base, 'readers') }, async () => {
        const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
        const ssam = await import('../ssam.mjs');
        const { createTokenStore } = await import('../server-tokens.mjs');
        const { createAgent } = await import(pathToFileURL(AGENT_ENTRY).href);
        const port = await freePort();
        const handle = await ssam.runServed(['--port', String(port)]);
        t.after(() => handle.close());
        const issued = createTokenStore(dir).issue({ customer: 'RestE2E' });
        const workspace = path.join(dir, 'customers', issued.id);

        // The customer's machine: the agent root, its bridge key, and the fake Studios in their own process.
        const agentRoot = path.join(base, 'SSAM-Agent');
        for (const d of ['odc/snapshots', 'odc/journal', 'odc/lab', 'o11', 'inbox', 'private/authority']) fs.mkdirSync(path.join(agentRoot, d), { recursive: true });
        fs.writeFileSync(path.join(agentRoot, 'private', 'authority', 'bridge.key'), randomBytes(32).toString('base64url'));
        const moduleFile = path.join(base, 'o11-module.json');
        fs.writeFileSync(moduleFile, JSON.stringify(O11_MODULE));
        const studiosFile = path.join(base, 'studios.json');
        const o11Port = await freePort();
        const studios = spawn(process.execPath, [path.join(facade, 'tests', 'fixtures', 'fake-studios-process.mjs'), agentRoot, studiosFile, String(o11Port), '0', moduleFile],
          { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); // it ends when its stdin closes
        let studiosOut = '';
        studios.stdout.on('data', c => { studiosOut += c; }); studios.stderr.on('data', c => { studiosOut += c; });
        t.after(() => { try { studios.kill(); } catch { /* gone */ } });
        const fake = await waitFor(() => { try { return JSON.parse(fs.readFileSync(studiosFile, 'utf8')); } catch { return null; } }, 20000);
        assert.ok(fake, 'the fake Studios started: ' + studiosOut.slice(0, 400));
        const log = () => { try { return fs.readFileSync(studiosFile + '.log', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.studio === 'o11'); } catch { return []; } };

        fs.writeFileSync(path.join(agentRoot, 'pack.json'), JSON.stringify({ id: 'pack-rest-e2e', lanes: ['odc', 'o11'], odcBridge: ODC_BRIDGE, o11BuiltFor: '11.55.92', files: [] }));
        fs.writeFileSync(path.join(agentRoot, 'private', 'credential'), issued.agentCredential);
        const config = { server: `http://127.0.0.1:${port}`, o11Port };
        fs.writeFileSync(path.join(agentRoot, 'private', 'config.json'), JSON.stringify(config));
        const procs = { 'ODCStudio.exe': { pid: fake.odcPid, path: 'C:\\Fake\\ODC Studio\\ODCStudio.exe', version: fake.odcVersion },
          'ServiceStudio.exe': { pid: fake.o11Pid, path: 'C:\\Fake\\Service Studio\\ServiceStudio.exe', version: fake.o11Version } };
        const agent = await createAgent({ root: agentRoot, config, log: () => {}, deps: {
          processes: async image => (procs[image] ? [procs[image]] : []),
          locate: async kind => (kind === 'odc' ? 'C:\\Fake\\ODC Studio' : 'C:\\Fake\\Service Studio'),
          fileVersion: async exe => procs[path.basename(exe)]?.version ?? null,
          describe: async pid => ({ pid: Number(pid), startedUtc: '2026-10-04T10:00:00Z', version: fake.o11Version, diagnosticsAvailable: true, bridgePath: null, corePath: null }),
          attachOdc: async ({ pid }) => ({ ok: true, attached: true, pid, note: 'fake attach' }),
          attachO11: async () => { throw new Error('no attach expected'); },
          icacls: async () => ({ ok: true }),
        } });
        const running = Promise.resolve(agent.run());
        t.after(async () => { await agent.stop(); await running.catch(() => {}); });

        const client = new Client({ name: 'rest-e2e', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer ' + issued.token } } }));
        t.after(() => client.close().catch(() => {}));
        const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 880000 }); return r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? 'null'); };
        assert.ok(await waitFor(async () => (await call('ssam_doctor'))?.agent?.connected, 20000), 'the agent connected');
        const connected = await call('ssam_connect', { lane: 'o11' });
        assert.notEqual(connected?.ok, false, JSON.stringify(connected).slice(0, 600));

        // No request leaves the server process while the job runs (the kernel never reads the network either).
        const original = globalThis.fetch;
        const asked = [];
        globalThis.fetch = async (url, options) => { const text = String(url); if (text.startsWith(`http://127.0.0.1:${port}/`)) return original(url, options); asked.push(text); throw new Error('the network was asked: ' + text); };
        const started = Date.now();
        let answer;
        try { answer = await call('o11_deliver', { module: O11_MODULE.name, job: RUN_JOB, checks: RUN_CHECKS, authorize: 'pode entregar a integracao REST no Headless_CS' }); }
        finally { globalThis.fetch = original; }
        const ms = Date.now() - started;
        const shown = JSON.stringify(answer);
        const work = path.join(workspace, 'o11', 'work', 'deliver');
        const tasks = fs.existsSync(work) ? fs.readdirSync(work).filter(id => /^[0-9a-f]{32}$/i.test(id)) : [];
        const task = tasks.map(id => { try { const doc = JSON.parse(fs.readFileSync(path.join(work, id, 'task.json'), 'utf8').replace(/^\uFEFF/, '')); return typeof doc.payload === 'string' ? JSON.parse(doc.payload) : doc; } catch { return null; } })
          .filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;
        const seen = log();
        const verdict = { backend: backend ?? null, ms, result: answer?.result ?? null, code: answer?.code ?? null, delivered: task?.delivered ?? null, writeState: task?.writeState ?? null,
          stage: task?.stage ?? null, checks: (task?.checks ?? []).map(c => ({ query: c.query, count: c.count ?? null, error: c.error ? String(c.error).slice(0, 200) : null })),
          merges: seen.filter(e => e.method === 'merge_from_oml').length, snapshots: seen.filter(e => e.method === 'snapshot_module').length,
          integration: (task?.integration ?? task?.apply?.integration ?? []).map?.(r => r?.client?.name ?? r?.service?.name ?? r?.kind ?? null) ?? null };
        verdict.answer = GIVEN ? JSON.stringify(answer).slice(0, 4000) : undefined;
        verdicts.push(verdict);
        t.diagnostic(JSON.stringify(verdict));
        assert.deepEqual(asked, [], 'no request left the server');
        assert.doesNotMatch(shown, /PATH_OUTSIDE_WORKSPACE|GENERATOR_PENDING|DOCUMENT_FETCH_HOSTED_REFUSED/, shown.slice(0, 1500));
        assert.equal(answer?.ok, true, shown.slice(0, 1500) + ' task: ' + JSON.stringify({ stage: task?.stage, error: task?.error, failures: task?.failures }).slice(0, 1500));
        assert.equal(answer.result, 'delivered', shown.slice(0, 800));
        assert.equal(task?.delivered, true);
        assert.equal(task.writeState, 'applied');
        assert.equal(seen.filter(e => e.method === 'merge_from_oml' && e.merged).length, 1, 'one merge of the candidate');
        for (const name of RUN_CHECKS) {
          const found = task.checks.find(c => c.query === name);
          assert.ok(found && found.count >= 1 && !found.error, name + ': ' + JSON.stringify(found));
        }
        assert.ok(!seen.some(e => e.method === 'find_element'), 'the checks run on the server over a capture, never on the bridge');
        // No server path in the answer (the no-internals rule): ws: names only.
        assert.equal(shown.includes(dir) || shown.includes(dir.replace(/\\/g, '\\\\')) || shown.includes(base.replace(/\\/g, '\\\\')), false, 'no server path in the answer');
        // The kernel's TEMP of this customer is inside the workspace mirror (o11/tmp), never the shared state folders.
        const tmpRoot = path.join(workspace, 'o11', 'tmp');
        assert.ok(fs.existsSync(tmpRoot), 'the O11 TEMP of the customer is in the workspace');
        const versions = path.join(workspace, 'state', 'versions');
        const stateTemp = fs.existsSync(versions) && fs.readdirSync(versions).some(v => fs.existsSync(path.join(versions, v, 'o11', 'tmp')));
        assert.equal(stateTemp, false, 'no TEMP under state/versions (the folder of 27/10, outside the mirror)');
      });
    });
}
