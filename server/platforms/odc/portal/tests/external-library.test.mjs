// External Library pieces of the portal runtime (lane extlib), pure and offline: the uploaders (the PUT never carries
// an Authorization, a redirect is never followed, no URL ever comes back), the bridge's portal-upload answers mapped to
// the receipt states, the plan-versus-generation comparison, the breaking changes, the tag and the derived step UUIDs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { bridgeAnswer, bridgeUploader, checkTarget, stageUpload, vaultUploader } from '../runtime/external-library-upload.mjs';
import { ExternalLibraryDeployer, OPS, PUBLISH_ROUTE, breakingChanges, contentsDifferences, nextPatch, publishKeyOf, stepUuid } from '../runtime/external-library.mjs';
import { PORTAL_WRITES } from '../runtime/portal-routes.mjs';
import { Catalog } from '../runtime/catalog.mjs';

const HOST = 'personal-test.outsystems.dev';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'odc-extlib-unit-'));
function packageFile(dir) {
  const file = path.join(dir, 'SSAMTextTools-0123456789abcdef.zip');
  const bytes = Buffer.from('PK package bytes');
  fs.writeFileSync(file, bytes);
  return { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes };
}
function fakeFetch(answers) {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push({ url: String(url), ...options, headers: { ...(options.headers ?? {}) } }); return answers(String(url), options); };
  return { fetchImpl, seen };
}
const schema = () => Response.json({ uploadUrl: 'https://bucket.s3.amazonaws.com/up?X-Amz-Signature=s1', downloadUrl: 'https://bucket.s3.amazonaws.com/down?X-Amz-Signature=s2' });

test('own fixture publication rechecks job identity, complete inventory, revision and consumers after upload',async()=>{
 for(const changed of ['job','inventory','revision','consumers']){
  let writes=0;
  const receipt={operationUuid:'root',identity:{tenant:HOST},progress:{authorization:{context:{}},library:{key:'asset',name:'Proof',revision:1,isNew:false},generation:{ready:true,libraryKey:'asset'}}};
  const access={receipts:{settle:(r,p)=>Object.assign(r,p)},resolvePublic:async()=>({ok:true}),
   dependentsOf:async()=>({ok:true,consumers:changed==='consumers'?[{name:'Other'}]:[]}),
   portalWrite:async()=>{writes++;assert.fail('must refuse before publish');},
   read:async({operationId})=>operationId===OPS.job?{ok:true,data:{status:'ReadyForReview',libraryName:'Proof',libraryKey:changed==='job'?'other':'asset',isNewLibrary:false}}:
    {ok:true,data:{results:[{name:'Proof',assetType:'ExternalLibrary',assetKey:'asset',revision:changed==='revision'?2:1}],page:{totalResults:changed==='inventory'?2:1}}}};
  const result=await new ExternalLibraryDeployer({access}).publish({name:'Proof'},receipt,{host:HOST,publicAuth:'api-client'},'job');
  assert.equal(result.ok,false);assert.equal(result.step,'pre-publication');assert.equal(writes,0);
  assert.equal(result.code,changed==='consumers'?'EXTERNAL_LIBRARY_HAS_CONSUMERS':changed==='inventory'?'ASSET_INVENTORY_UNAVAILABLE':'EXTERNAL_LIBRARY_CHANGED');
 }
});

test('library status cannot turn failed job, revision or metadata reads into successful empty results', async () => {
  for (const exists of [false, true]) {
    for (const [failedOp, failedRead] of [[OPS.jobs, 'generation-jobs'], [OPS.revisions, 'revisions'], [OPS.revisionMetadata, 'revision-metadata']]) {
      if (!exists && failedOp !== OPS.jobs) continue;
      const access = {
        pickTenant: async () => HOST,
        read: async ({ operationId }) => {
          if (operationId === failedOp) return { ok: false, status: 503, error: { code: 'UNAVAILABLE' } };
          if (operationId === OPS.assets) return { ok: true, data: exists ? [{ name: 'Proof', assetType: 'ExternalLibrary', assetKey: 'lib-1', revision: 1 }] : [] };
          if (operationId === OPS.jobs || operationId === OPS.revisions) return { ok: true, data: [] };
          assert.fail('unexpected read: ' + operationId);
        },
      };
      const result = await new ExternalLibraryDeployer({ access }).status({ tenant: HOST, library: 'Proof' });
      assert.equal(result.ok, false);
      assert.equal(result.status, 503);
      assert.equal(result.exists, exists);
      assert.equal(result.incomplete, true);
      assert.equal(result.failedRead, failedRead);
      if (failedOp === OPS.jobs) assert.equal(result.jobs, null);
    }
  }
});

test('publication without a response key uses the deploy start even when the response arrives after publication', async () => {
  const start = Date.parse('2026-10-09T03:38:00Z');
  let now = start + 18000;
  let sends = 0;
  const access = {
    receipts: { settle: (receipt, patch) => Object.assign(receipt, patch) },
    portalWrite: async () => { sends++; now = start + 20000; return { ok: true, data: {}, receipt: { state: 'accepted' } }; },
    read: async request => {
      assert.equal(request.operationId, OPS.publishOps);
      assert.equal(request.query.createdDateSince, new Date(start).toISOString());
      return { ok: true, data: [{ key: 'publication-1', createdAt: new Date(start + 18437).toISOString() }] };
    },
    operationStatus: async request => {
      assert.equal(request.operationKey, 'publication-1');
      return { ok: true, terminal: true, status: 'Finished', data: { revision: 1 } };
    },
  };
  const deployer = new ExternalLibraryDeployer({ access, now: () => now });
  const receipt = { operationUuid: crypto.randomUUID(), progress: { startedAt: new Date(start).toISOString(), library: { key: 'library-1' } } };
  assert.equal(await deployer.publish({ name: 'Proof' }, receipt, { host: HOST }, 'job-1'), null);
  assert.equal(sends, 1);
  assert.equal(receipt.progress.publish.startedAt, new Date(start + 18000).toISOString());
  assert.equal(receipt.progress.publish.done, true);
});

test('accepted or uncertain publication without a key is read on every resume and never resent', async () => {
  for (const state of ['accepted', 'uncertain']) {
    let visible = false;
    let reads = 0;
    let continued = 0;
    const access = {
      receipts: { settle: (receipt, patch) => Object.assign(receipt, patch) },
      portalWrite: async () => assert.fail('publication must not be resent'),
      read: async request => {
        reads++;
        assert.equal(request.operationId, OPS.publishOps);
        return { ok: true, data: visible ? [{ key: 'publication-1' }] : [] };
      },
    };
    const deployer = new ExternalLibraryDeployer({ access });
    deployer.run = async (_plan, receipt) => { continued++; assert.equal(receipt.progress.publish.operationKey, 'publication-1'); return { ok: true }; };
    const receipt = { identity: { tenant: HOST }, operationUuid: crypto.randomUUID(), progress: { library: { key: 'library-1' }, publish: { state } } };
    for (let i = 0; i < 3; i++) {
      const result = await deployer.resume({ name: 'Proof' }, receipt, { host: HOST });
      assert.equal(result.code, 'UNCERTAIN');
      assert.equal(result.step, 'publish');
    }
    assert.equal(continued, 0);
    visible = true;
    assert.equal((await deployer.resume({ name: 'Proof' }, receipt, { host: HOST })).ok, true);
    assert.equal(reads, 4);
    assert.equal(continued, 1);
  }
});

test('vault uploader: GET /uploads and POST with the API Client token, the PUT with no Authorization and no redirect, no URL in the answer', async () => {
  const dir = tmp(); const pkg = packageFile(dir);
  const { fetchImpl, seen } = fakeFetch((url, o) => o.method === 'GET' ? schema() : o.method === 'PUT' ? new Response(null, { status: 200 }) : Response.json({ operationKey: 'job-7' }));
  const uploader = vaultUploader({ bridge: { config: { origin: 'https://' + HOST }, auth: { getToken: async () => 'tok' } }, fetchImpl });
  const out = await uploader.upload({ host: HOST, file: pkg.file, sha256: pkg.sha256, fileName: path.basename(pkg.file) });
  assert.deepEqual(out, { ok: true, operationKey: 'job-7', bytes: pkg.bytes.length, sha256: pkg.sha256, fileName: path.basename(pkg.file), auth: 'vault' });
  assert.deepEqual(seen.map(s => s.method), ['GET', 'PUT', 'POST']);
  assert.equal(seen[0].url, 'https://' + HOST + '/api/external-libraries/v1/uploads'); assert.equal(seen[0].headers.authorization, 'Bearer tok');
  assert.equal(seen[1].headers.authorization, undefined); assert.equal(seen[1].redirect, 'manual'); assert.equal(seen[1].headers['content-type'], 'application/zip');
  assert.equal(JSON.parse(seen[2].body).highCodeBinaryUri, 'https://bucket.s3.amazonaws.com/down?X-Amz-Signature=s2');
  assert.doesNotMatch(JSON.stringify(out), /amazonaws|X-Amz/);
});

test('vault uploader refusals: another tenant, a changed package, a target that is not plain https, a redirect, a lost POST', async () => {
  const dir = tmp(); const pkg = packageFile(dir);
  const bridge = { config: { origin: 'https://' + HOST }, auth: { getToken: async () => 'tok' } };
  const args = { host: HOST, file: pkg.file, sha256: pkg.sha256, fileName: path.basename(pkg.file) };
  assert.equal((await vaultUploader({ bridge: { ...bridge, config: { origin: 'https://other.outsystems.dev' } }, fetchImpl: async () => { throw new Error('no'); } }).upload(args)).code, 'HOST_MISMATCH');
  assert.equal((await vaultUploader({ bridge, fetchImpl: async () => { throw new Error('no'); } }).upload({ ...args, sha256: 'b'.repeat(64) })).code, 'PACKAGE_CHANGED');
  const http = fakeFetch((url, o) => o.method === 'GET' ? Response.json({ uploadUrl: 'http://bucket/up', downloadUrl: 'https://bucket/down' }) : new Response(null, { status: 200 }));
  const insecure = await vaultUploader({ bridge, fetchImpl: http.fetchImpl }).upload(args);
  assert.equal(insecure.code, 'UPLOAD_TARGET_REFUSED'); assert.equal(insecure.state, 'not-sent'); assert.deepEqual(http.seen.map(s => s.method), ['GET']);
  const moved = fakeFetch((url, o) => o.method === 'GET' ? schema() : new Response(null, { status: 307, headers: { location: 'https://elsewhere/' } }));
  const redirect = await vaultUploader({ bridge, fetchImpl: moved.fetchImpl }).upload(args);
  assert.equal(redirect.code, 'UPLOAD_REJECTED'); assert.equal(redirect.state, 'not-sent'); assert.deepEqual(moved.seen.map(s => s.method), ['GET', 'PUT']);
  const lost = fakeFetch((url, o) => { if (o.method === 'POST') throw new Error('socket hang up'); return o.method === 'GET' ? schema() : new Response(null, { status: 200 }); });
  const uncertain = await vaultUploader({ bridge, fetchImpl: lost.fetchImpl }).upload(args);
  assert.equal(uncertain.state, 'uncertain'); assert.equal(uncertain.code, 'UNCERTAIN');
  for (const value of ['https://u:p@x.example/a', 'https://x.example:444/a', 'ftp://x.example/a', 'nonsense']) assert.equal(checkTarget(value, 'uploadUrl').ok, false, value);
});

test('bridge uploader: the package staged in journal/portal/uploads, the request names it by path and sha256, the answers mapped to states', async () => {
  const dir = tmp(); const pkg = packageFile(dir); const uploads = path.join(dir, 'journal', 'portal', 'uploads');
  const requests = []; const studio = { call: async args => { assert.equal(args[0], 'portal-upload'); assert.deepEqual(args.slice(2), ['--tenant', HOST]); return { ok: true, operationKey: 'job-3', bytes: 16, sha256: pkg.sha256, fileName: 'f.zip' }; } };
  const uploader = bridgeUploader({ studio, requestFile: json => { requests.push(json); return 'req-1'; }, stage: stageUpload(uploads) });
  const out = await uploader.upload({ host: HOST, file: pkg.file, sha256: pkg.sha256, fileName: path.basename(pkg.file), operationUuid: crypto.randomUUID(), authorizeSha256: 'a'.repeat(64) });
  assert.equal(out.ok, true); assert.equal(out.operationKey, 'job-3');
  assert.equal(path.dirname(requests[0].file), uploads); assert.equal(requests[0].sha256, pkg.sha256); assert.equal(requests[0].confirmTenant, HOST);
  assert.deepEqual(Object.keys(requests[0]).sort(), ['authorizeSha256', 'confirmTenant', 'file', 'fileName', 'operationUuid', 'sha256']);
  assert.equal(bridgeAnswer({ ok: false, code: 'UNCERTAIN' }).state, 'uncertain');
  assert.equal(bridgeAnswer({ ok: false, code: 'NOT_ALLOWED', gate: 'retry_refused' }).state, 'uncertain');
  assert.equal(bridgeAnswer({ ok: false, code: 'REMOTE_ERROR', status: 400 }).state, 'rejected');
  assert.equal(bridgeAnswer({ ok: false, code: 'UPLOAD_REJECTED', gate: 'upload_redirect' }).state, 'not-sent');
  assert.equal(bridgeAnswer({ ok: false, outcome: 'gate_refused', gate: 'studio_busy' }).code, 'STUDIO_BUSY');
  const thrown = await bridgeUploader({ studio: { call: async () => { throw new Error('pipe'); } }, requestFile: () => 'r', stage: stageUpload(uploads) })
    .upload({ host: HOST, file: pkg.file, sha256: pkg.sha256, fileName: path.basename(pkg.file), operationUuid: crypto.randomUUID(), authorizeSha256: 'a'.repeat(64) });
  assert.equal(thrown.state, 'uncertain');
});

test('bridge uploader awaits local preparation and never sends after a local preparation failure', async () => {
  const seen = [];
  const studio = { call: async args => { seen.push(args); return { ok: true, operationKey: 'job-async' }; } };
  const stage = async () => 'staged.zip';
  const requestFile = async json => { assert.equal(json.file, 'staged.zip'); return 'request.json'; };
  assert.equal((await bridgeUploader({ studio, stage, requestFile }).upload({ host: HOST })).ok, true);
  assert.equal(seen[0][1], 'request.json');
  for (const step of ['stage', 'requestFile']) {
    seen.length = 0;
    const fail = async () => { throw Object.assign(new Error('private local detail'), { code: 'BRIDGE_ROOT_UNAVAILABLE' }); };
    const result = await bridgeUploader({ studio, stage, requestFile, [step]: fail }).upload({ host: HOST });
    assert.equal(result.state, 'not-sent');
    assert.equal(result.code, 'BRIDGE_ROOT_UNAVAILABLE');
    assert.equal(seen.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /private local detail/);
  }
});

test('plan versus generation: names and directions only; removed or updated elements are the breaking changes', () => {
  const plan = { actions: [{ name: 'Reverse', parameters: [{ name: 'Text', dataType: 'Text', direction: 'Input' }, { name: 'Result', dataType: 'Text', direction: 'Output' }] }], structures: [] };
  const same = { actions: [{ name: 'Reverse', changeType: 'Updated', parameters: [{ name: 'Text', dataType: 'string', parameterType: 'Input' }, { name: 'Result', dataType: 'string', parameterType: 'Output' }] },
    { name: 'Upper', changeType: 'Removed', parameters: [] }], structures: [] };
  assert.deepEqual(contentsDifferences(plan, same), []);
  assert.deepEqual(breakingChanges(same), [{ kind: 'action', name: 'Reverse', change: 'Updated' }, { kind: 'action', name: 'Upper', change: 'Removed' }]);
  const other = { actions: [{ name: 'Reverse', parameters: [{ name: 'Text', parameterType: 'Output' }] }, { name: 'Extra', parameters: [] }], structures: [] };
  const differences = contentsDifferences(plan, other);
  assert.ok(differences.some(d => /Text is generated as Output/.test(d)));
  assert.ok(differences.some(d => /Result is missing/.test(d)));
  assert.ok(differences.some(d => /Extra is generated but not planned/.test(d)));
});

test('tags, step UUIDs, publication keys and the operation ids the deployer reads exist in the pinned catalog', () => {
  assert.equal(nextPatch('1.0.3'), '1.0.4'); assert.equal(nextPatch('v2.1.9'), '2.1.10'); assert.equal(nextPatch(null), '1.0.0'); assert.equal(nextPatch('beta'), '1.0.0');
  const op = crypto.randomUUID();
  assert.equal(stepUuid(op, 'upload-1'), stepUuid(op.toUpperCase(), 'upload-1'));
  assert.notEqual(stepUuid(op, 'upload-1'), stepUuid(op, 'upload-2'));
  assert.match(stepUuid(op, 'publish-1'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(publishKeyOf({ Result: { PublicationKey: 'p-1' } }), 'p-1'); assert.equal(publishKeyOf({}), null);
  const catalog = new Catalog();
  for (const [name, id] of Object.entries(OPS)) assert.ok(catalog.operations.has(id), name + ' ' + id);
  assert.deepEqual(PORTAL_WRITES[PUBLISH_ROUTE.id].route, [PUBLISH_ROUTE.module, PUBLISH_ROUTE.view, PUBLISH_ROUTE.action]);
});
