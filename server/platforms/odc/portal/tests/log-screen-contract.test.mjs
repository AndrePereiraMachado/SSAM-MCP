import test from 'node:test';
import assert from 'node:assert/strict';
import { readLogScreenservice } from '../runtime/log-screen-contract.mjs';
import { createLogScreenDefaults } from '../runtime/log-screen-defaults.mjs';
import { PortalReadAdapter } from '../runtime/portal-read.mjs';
import { OdcError } from '../runtime/errors.mjs';

function fixture(change = () => {}) {
  const { screen } = createLogScreenDefaults();
  const environment = { Key: 'stage', Name: 'Development', Hostname: 'dev.example.test', Purpose: 'Development', PortfolioKey: 'portfolio' };
  change(environment);
  const calls = [];
  const action = async (_module, _view, name, _input, variables, _signal, clientVariables) => {
    calls.push({ name, variables: structuredClone(variables), clientVariables: structuredClone(clientVariables) });
    if (name.endsWith('DataActionGetSettings')) return { data: screen.GetSettings };
    if (name.endsWith('DataActionGetFilter_Stages')) return { data: { EnvironmentList: { List: [{ Environment: environment }] } } };
    return { data: { LogsList: { List: [] } } };
  };
  const request = { module: 'monitoring', view: 'logs.logs', action: 'monitoring/logs/logs/DataActionLogSearch',
    clientVariables: { StageId: 'stage', ApplicationId: 'app', DateTimeStart: '2026-10-21T09:02:00.000Z', DateTimeEnd: '2026-10-22T09:02:00.000Z' },
    screenVariables: { SelectedEnviroment: { Key: 'stage' }, Page: { Limit: '5', Offset: '10' }, SeverityList: { List: ['Error'] } } };
  return { action, calls, request, screen };
}

test('log search accepts projected environment records without optional native members', async () => {
  const f = fixture();
  await readLogScreenservice(f.action, f.request);
  assert.equal(f.calls.length, 3);
  const search = f.calls.at(-1);
  assert.equal(search.variables.SelectedEnviroment.Key, 'stage');
  assert.equal(search.variables.ActivePortfolioKey, 'portfolio');
  assert.equal(search.variables.SelectedEnviroment.IsConfigured, false);
  assert.equal(search.variables.SelectedEnviroment.isDeployedToCluster, false);
  assert.equal(search.variables.Page.Offset, '10');
  assert.deepEqual(search.variables.SeverityList.List, ['Error']);
  assert.equal(search.clientVariables.ApplicationId, 'app');
  assert.equal(search.variables.ScreenPermissions_logs.UsersData, 'NoAccess');
});

test('missing environment identity and invalid supplied optional members stop before log search', async () => {
  for (const change of [e => { delete e.Name; }, e => { delete e.Hostname; }, e => { delete e.Purpose; }, e => { delete e.PortfolioKey; }, e => { e.PortfolioKey = ''; }, e => { e.IsConfigured = 'true'; }, e => { e.Order = 1.5; }]) {
    const f = fixture(change);
    await assert.rejects(readLogScreenservice(f.action, f.request), e => e.code === 'PORTAL_CONTRACT_CHANGED' && e.details.diagnosticStage === 'log-stage');
    assert.equal(f.calls.length, 2);
  }
});

test('log search rejects a different or duplicate stage instead of using local defaults', async () => {
  for (const duplicate of [false, true]) {
    const f = fixture();
    const action = async (...args) => {
      const result = await f.action(...args);
      if (args[2].endsWith('DataActionGetFilter_Stages')) {
        const list = result.data.EnvironmentList.List;
        if (duplicate) list.push(structuredClone(list[0]));
        else list[0].Environment.Key = 'different-stage';
      }
      return result;
    };
    await assert.rejects(readLogScreenservice(action, f.request), e => e.code === 'PORTAL_ACCESS_DENIED' && e.details.diagnosticStage === 'log-stage');
    assert.equal(f.calls.length, 2);
  }
});

test('asynchronous search errors retain their safe stage and are never replayed', async () => {
  const f = fixture();
  const action = async (...args) => {
    await f.action(...args);
    if (args[2].endsWith('DataActionLogSearch')) throw new OdcError('PORTAL_REQUEST_FAILED', 'PRIVATE_ERROR', { status: 500 });
    return args[2].endsWith('DataActionGetSettings') ? { data: f.screen.GetSettings }
      : { data: { EnvironmentList: { List: [{ Environment: { ...f.screen.SelectedEnviroment, Key: 'stage', PortfolioKey: 'portfolio' } }] } } };
  };
  await assert.rejects(readLogScreenservice(action, f.request), e => e.code === 'PORTAL_REQUEST_FAILED' && e.details.diagnosticStage === 'log-search' && e.details.status === 500);
  assert.equal(f.calls.length, 3);
});

test('managed log failures expose only allowlisted diagnostic stages and field names', async () => {
  const origin = 'https://tenant.example.test';
  for (const [stage, field, expected] of [['log-stage', 'IsConfigured', 'IsConfigured'], ['log-settings', 'MaxNumberOfDays', 'MaxNumberOfDays'], ['log-stage', 'PRIVATE_SECRET', undefined], ['PRIVATE_SECRET', 'IsConfigured', undefined]]) {
    const broker = { target: 'odc3', origin, async readScreenservice() { throw new OdcError('PORTAL_CONTRACT_CHANGED', 'PRIVATE_SECRET', { diagnosticStage: stage, diagnosticField: field }); } };
    const adapter = new PortalReadAdapter({ target: 'odc3', origin, broker });
    const result = await adapter.execute({ operationId: 'monitoring.errors', input: { environmentKey: 'stage', applicationKey: 'app', since: '2026-10-21T09:02:00Z', until: '2026-10-22T09:02:00Z' } });
    assert.equal(result.error.diagnosticField, expected);
    assert.equal(JSON.stringify(result).includes('PRIVATE_SECRET'), false);
  }
});
