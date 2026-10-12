import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dbConnectionApproval, dbDeleteApproval } from '../runtime/db-connection-approval.mjs';

test('database approval binds endpoint, database, single stage and exact temporary name', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-approval-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true }); });
  const file = path.join(dir, 'approval.json'), proposal = path.join(dir, 'proposal.md'), words = 'Autorizo este escopo.';
  fs.writeFileSync(proposal, 'Create/test/delete only Fixture on host.test against db.test:1433/TestDb in stage-a. No DDL, business data or permissions.');
  fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-authorization-context/1', decision: 'approved', words,
    source: { kind: 'human-conversation', threadId: randomUUID(), messageId: randomUUID(), question: 'Authorize this exact proposal?' },
    proposal: { file: proposal, sha256: createHash('sha256').update(fs.readFileSync(proposal)).digest('hex') },
    scope: ['connections.relationalTest', 'connections.delete'].map(operation => ({ lane: 'odc', host: 'host.test', operation, targets: ['Fixture'], environmentKey: 'stage-a' })),
    constraints: { server: 'db.test', port: 1433, database: 'TestDb', noDdl: true, noDataWrites: true, noBusinessDataReads: true,
      deleteTemporaryConnections: true, requiresTestedHeadlessTransport: true } }));
  const config = { TenantStage: { Key: 'stage-a' }, ConnectionDetails_Common: { ConnectionUsername: '', ConnectionPassword: '',
    ConnectionServer: 'db.test', ConnectionServerPort: 1433, ConnectionDatabase: 'TestDb', AdvancedConnectionString: '', IsPrivateGateway: false, PrivateGatewayPort: 0 } };
  const input = { ConnectionId: '', ProviderId: 'mssql', ForceErrorOnStageKeys: '', IsEditConnection: false, IsConfigChanged: true, Variant: 'vanilla',
    ConnectionDetails_Header: { ConnectionName: 'Fixture', PortfolioKey: '' }, ValidStageConfigs: { List: [config] }, EditedStageConfigs: { List: [config] } };
  const approve = raw => dbConnectionApproval(file, words, { host: 'host.test', operationId: 'connections.relationalTest', raw: { inputParameters: raw }, target: { connectionName: 'Fixture' } });
  assert.equal(approve(input).constraints.database, 'TestDb');
  const detail = { NotFound: false, Connection: { connectionId: 'connection-a', name: 'Fixture', providerId: 'mssql',
    externalMetadata: { selectedObjectCount: 0, selectedActionCount: 0 },
    stageConfigurations: [{ stageKey: 'stage-a', host: 'db.test', port: '1433', database: 'TestDb', hasAdditionalParameters: false, privateGatewayPort: null }] } };
  const origin = { state: 'accepted', identity: { kind: 'odc-portal', tenant: 'host.test', operationId: 'connections.relationalTest', target: { connectionName: 'Fixture' } },
    response: { Out_ConnectionId: 'connection-a' }, authorization: { proposalSha256: approve(input).proposalSha256 } };
  const deleteApproval = (seen = detail, receipt = origin) => dbDeleteApproval(file, words, { host: 'host.test', detail: seen, origin: receipt });
  assert.equal(deleteApproval().operation, 'connections.delete');
  for (const change of [data => data.Connection.connectionId = 'foreign', data => data.Connection.name = 'Other',
    data => data.Connection.externalMetadata.selectedObjectCount = 1, data => data.Connection.externalMetadata.selectedActionCount = 1,
    data => data.Connection.stageConfigurations[0].host = 'other.test', data => data.Connection.stageConfigurations[0].hasAdditionalParameters = true]) {
    const changed = structuredClone(detail); change(changed); assert.throws(() => deleteApproval(changed), { code: 'AUTHORIZATION_CONTEXT_INVALID' });
  }
  assert.throws(() => deleteApproval(detail, { ...origin, state: 'uncertain' }), { code: 'AUTHORIZATION_CONTEXT_INVALID' });
  assert.throws(() => deleteApproval(detail, { ...origin, authorization: {} }), { code: 'AUTHORIZATION_CONTEXT_INVALID' });
  for (const [field, value] of [['ConnectionServer', 'other.test'], ['ConnectionServerPort', 1434], ['ConnectionDatabase', 'OtherDb'],
    ['AdvancedConnectionString', 'Server=other.test'], ['IsPrivateGateway', true], ['ConnectionPassword', 'inline']]) {
    const changed = structuredClone(input);
    changed.ValidStageConfigs.List[0].ConnectionDetails_Common[field] = value;
    changed.EditedStageConfigs = structuredClone(changed.ValidStageConfigs);
    assert.throws(() => approve(changed), { code: 'AUTHORIZATION_CONTEXT_INVALID' });
  }
  const tlsInput=structuredClone(input);
  tlsInput.ValidStageConfigs.List[0].ConnectionDetails_Common.AdvancedConnectionString='encrypt=true;trustServerCertificate=true';
  tlsInput.EditedStageConfigs=structuredClone(tlsInput.ValidStageConfigs);
  assert.throws(()=>approve(tlsInput), {code:'AUTHORIZATION_CONTEXT_INVALID'});
  const approvalRecord=JSON.parse(fs.readFileSync(file,'utf8'));
  approvalRecord.constraints.encryptedTransport=true;approvalRecord.constraints.trustServerCertificate=true;
  fs.writeFileSync(file,JSON.stringify(approvalRecord));
  const tlsApproval=approve(tlsInput);
  assert.equal(tlsApproval.constraints.trustServerCertificate,true);
  const tlsDetail=structuredClone(detail);
  tlsDetail.Connection.stageConfigurations[0].hasAdditionalParameters=true;
  tlsDetail.Connection.stageConfigurations[0].tlsMode='encrypted-unverified-server';
  assert.equal(dbDeleteApproval(file,words,{host:'host.test',detail:tlsDetail,
    origin:{...origin,authorization:{proposalSha256:tlsApproval.proposalSha256}}}).constraints.encryptedTransport,true);
  for(const invalid of ['trustServerCertificate=true','encrypt=false;trustServerCertificate=true',
    'encrypt=true;trustServerCertificate=true;password=x','encrypt=true;encrypt=true;trustServerCertificate=true']) {
    const changed=structuredClone(tlsInput);changed.ValidStageConfigs.List[0].ConnectionDetails_Common.AdvancedConnectionString=invalid;
    changed.EditedStageConfigs=structuredClone(changed.ValidStageConfigs);
    assert.throws(()=>approve(changed),{code:'AUTHORIZATION_CONTEXT_INVALID'});
  }

  for (const change of [raw => raw.ValidStageConfigs.List.push(structuredClone(config)),
    raw => { raw.ValidStageConfigs.List[0].TenantStage.Key = 'stage-b'; raw.EditedStageConfigs = structuredClone(raw.ValidStageConfigs); },
    raw => raw.ConnectionDetails_Header.ConnectionName = 'Another', raw => raw.IsEditConnection = true]) {
    const changed = structuredClone(input); change(changed); assert.throws(() => approve(changed), { code: 'AUTHORIZATION_CONTEXT_INVALID' });
  }
});
