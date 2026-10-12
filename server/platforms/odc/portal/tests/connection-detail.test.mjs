import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionDetailInput, projectConnectionDetail, projectConnectionTestStatus } from '../runtime/connection-detail.mjs';
import {fingerprint} from '../runtime/write-journal.mjs';

test('A2A detail hashes embedded cards and never exposes credential or card content',()=>{
 const data=detail();data.Connection.providerId='a2a';data.Connection.description='Fixture';
 const card={url:'https://example.test/rpc',description:'private-card-content'};
 data.Connection.Embedded={AgentCards:{List:[{StageKey:'dev',AgentCard:JSON.stringify(card)}]}};
 data.Connection.StageConfigurations.List[0].configurationValues.List.push({key:'configurationType',value:'json'},{key:'authType',value:'no_auth'});
 const args={...input,providerId:'a2a'},projected=projectConnectionDetail(data,args);
 assert.equal(projected.Connection.stageConfigurations[0].a2a.agentCardSha256,fingerprint(card));
 assert.equal(projected.Connection.stageConfigurations[0].a2a.hasCredentialValues,true);
 assert.doesNotMatch(JSON.stringify(projected),/private-|example.test/);
 data.Connection.Embedded.AgentCards.List.push({StageKey:'dev',AgentCard:'{}'});
 assert.throws(()=>projectConnectionDetail(data,args),{code:'PORTAL_CONTRACT_CHANGED'});
 data.Connection.Embedded.AgentCards.List=[{StageKey:'dev',AgentCard:'invalid-json'}];
 assert.throws(()=>projectConnectionDetail(data,args),{code:'PORTAL_CONTRACT_CHANGED'});
 delete data.Connection.Embedded;
 assert.equal(projectConnectionDetail(data,args).Connection.stageConfigurations[0].a2a.agentCardSha256,null);
});
const input = { connectionId: '12345678-abcd-4321-abcd-123456789abc', providerId: 'mssql' };
test('URL card readback shares discovery normalization while preserving raw hash and refusing authentication equivalence',()=>{
 const data=detail();data.Connection.providerId='a2a';
 const card={protocolVersion:'0.3.0',name:'Proof',description:'Private card',version:'1',url:'https://example.test/rpc',
  capabilities:{streaming:false},defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],
  skills:[{id:'proof',name:'Proof',description:'Constant',tags:['test']}]};
 const native=structuredClone(card);native.security=null;native.securitySchemes=null;native.skills[0].security=null;native.capabilities.stateTransitionHistory=null;
 native.skills[0].inputModes=null;native.skills[0].outputModes=null;native.skills[0].examples=null;
 const entry={StageKey:'dev',AgentCard:JSON.stringify(native)};data.Connection.Embedded={AgentCards:[entry]};
 const args={...input,providerId:'a2a'},read=()=>projectConnectionDetail(data,args).Connection.stageConfigurations[0].a2a;
 assert.equal(read().normalizedAgentCardSha256,fingerprint(card));assert.equal(read().agentCardSha256,fingerprint(native));
 native.capabilities.streaming=true;entry.AgentCard=JSON.stringify(native);assert.notEqual(read().normalizedAgentCardSha256,fingerprint(card));
 native.security=[{bearer:[]}];entry.AgentCard=JSON.stringify(native);assert.equal(read().normalizedAgentCardSha256,null);
 assert.doesNotMatch(JSON.stringify(read()),/Private card|example.test|bearer/);
});
function detail() { return { NotFound: false, Connection: { connectionId: input.connectionId, providerId: 'mssql', name: 'Fixture', portfolioKey: 'portfolio',
  unknown: 'private-extra', ExternalMetadata: { selectedObjectCount: '0', selectedActionCount: '0' },
  StageConfigurations: { List: [{ StageKey: 'dev', configurationValues: { List: [{ key: 'host', value: 'db.test' }, { key: 'port', value: '1433' },
    { key: 'database', value: 'TestDb' }, { key: 'password', value: 'private-password' }, { key: 'user', value: 'private-user' },
    { key: 'connectionString', value: 'private-parameters' }, { key: 'unexpected', value: 'private-new-field' }] } }] } } }; }
test('connection detail exposes only identity, endpoint and import counts; key/value secrets never escape', () => {
  const result = projectConnectionDetail(detail(), input);
  assert.equal(result.Connection.stageConfigurations[0].host, 'db.test');
  assert.equal(result.Connection.stageConfigurations[0].hasAdditionalParameters, true);
  assert.doesNotMatch(JSON.stringify(result), /private-|configurationValues/);
  assert.equal(connectionDetailInput(input).screenVariables.ProviderId, 'mssql');
});
test('empty IDs, mismatched identity, missing counts and duplicate configuration keys are inconclusive', () => {
  assert.throws(() => connectionDetailInput({ ...input, connectionId: '' }), { code: 'INPUT_INVALID' });
  for (const change of [data => data.Connection.connectionId = 'foreign', data => data.Connection.providerId = 'oracle',
    data => delete data.Connection.ExternalMetadata.selectedObjectCount,
    data => data.Connection.StageConfigurations.List[0].configurationValues.List.push({ key: 'host', value: 'other.test' })]) {
    const data = detail(); change(data); assert.throws(() => projectConnectionDetail(data, input), { code: 'PORTAL_CONTRACT_CHANGED' });
  }
  assert.deepEqual(projectConnectionDetail({ NotFound: true }, input), { NotFound: true, Connection: null });
});

test('database test status withholds free-text credential echoes and arbitrary response fields', () => {
  const data = projectConnectionTestStatus({ Status: { Results: { List: [{ StageKey: 'dev', Status: 'Error', ErrorMessage: 'private-database-password',
    Errorcode: 'private-error-value', ConnectionString: 'private-connection' }] } }, Internal: 'private-extra' });
  assert.deepEqual(data, { Status: { Results: { List: [{ StageKey: 'dev', Status: 'Error' }] } } });
});


test('known native database failure categories contain no provider message or credential',()=>{
  for(const [message,category] of [['PKIX certificate path failed: private-password','tls-certificate'],
    ['PKIX path building failed; loginTimeout=30; private-password','tls-certificate'],
    ['Login failed for user private-user','database-authentication'],['request timed out: private-host','network-timeout'],
    ['connection refused: private-host','network-connectivity'],['cannot open database private-db','database-access']]) {
    const value=projectConnectionTestStatus({Status:{Results:{List:[{StageKey:'dev',Status:'Error',ErrorMessage:message}]}}});
    assert.equal(value.Status.Results.List[0].diagnosticCategory,category);
    assert.ok(!JSON.stringify(value).includes('private-'));
  }
  const ambiguous=projectConnectionTestStatus({Status:{Results:{List:[{StageKey:'dev',Status:'Error',ErrorMessage:'certificate error then timed out'}]}}});
  assert.equal(ambiguous.Status.Results.List[0].diagnosticCategory,undefined);
});

test('connection protocol diagnostics expose fixed signals, never the error payload',()=>{
 const result=projectConnectionTestStatus({Status:{Results:{List:[{StageKey:'dev',Status:'Error',
  ErrorMessage:'HTTP 400 Bad Request: cannot parse JSON-RPC integer request id private-value https://private.test/'}]}}});
 assert.deepEqual(result.Status.Results.List[0].diagnosticSignals,['json-deserialization','json-rpc','http-400']);
 assert.doesNotMatch(JSON.stringify(result),/private|https/);
 const success=projectConnectionTestStatus({Status:{Results:[{StageKey:'dev',Status:'Success',ErrorMessage:'HTTP 500'}]}});
 assert.equal(success.Status.Results.List[0].diagnosticSignals,undefined);
});


test('only the exact encrypted TLS exception is projected as a typed policy',()=>{
  for(const [parameters,expected] of [['encrypt=true;trustServerCertificate=true','encrypted-unverified-server'],
    ['TrustServerCertificate=TRUE;Encrypt=true;','encrypted-unverified-server'],
    ['encrypt=false;trustServerCertificate=true',undefined],['encrypt=true;trustServerCertificate=true;user=private',undefined]]) {
    const data=detail();data.Connection.StageConfigurations.List[0].configurationValues.List.find(x=>x.key==='connectionString').value=parameters;
    const value=projectConnectionDetail(data,input);
    assert.equal(value.Connection.stageConfigurations[0].tlsMode,expected);
    assert.ok(!/private-|user=private/.test(JSON.stringify(value)));
  }
});

