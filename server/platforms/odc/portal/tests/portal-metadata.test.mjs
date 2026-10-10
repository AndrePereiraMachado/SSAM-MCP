import test from 'node:test';
import assert from 'node:assert/strict';
import { PortalMetadata } from '../runtime/portal-metadata.mjs';
const origin = 'https://wrightflood.outsystems.dev';
function fixture(chunk) {
  const visited = [];
  const request = async url => {
    visited.push(url); const path = new URL(url).pathname;
    if (path.endsWith('moduleversioninfo')) return { text: '{"versionToken":"module-now"}' };
    if (path === '/monitoring/') return { text: '<script src="scripts/_osbundle-monitoring.index.js"></script>' };
    if (path.endsWith('.index.js')) return { text: 'screenName:"logs.logs",lazyComponentInfo:{importer:function(){return import("./view.js")}}' };
    if (path.endsWith('/view.js')) return { text: chunk };
    throw new Error('Unexpected fetch');
  };
  return { metadata: new PortalMetadata({ origin, request }), visited };
}
test('current view resolves exact wire action/version and caches bounded public metadata without executing JS', async () => {
  const { metadata, visited } = fixture('call("screenservices/monitoring/logs/logs/ActionLogSearch_Wrapper","api-now");');
  const args = ['monitoring','logs.logs','monitoring/logs/logs/ActionLogSearch_Wrapper'];
  const result = await metadata.resolve(...args);
  assert.equal(result.moduleVersion, 'module-now'); assert.equal(result.apiVersion, 'api-now'); assert.equal(result.remapped, false);
  const count = visited.length; await metadata.resolve(...args); assert.equal(visited.length, count);
});
test('similarly named actions in another block are not substituted for app runtime logs', async () => {
  let f = fixture('call("screenservices/monitoring/logs/AgentsLogs/ActionLogSearch_Wrapper","api-now");');
  await assert.rejects(f.metadata.resolve('monitoring','logs.logs','monitoring/logs/logs/ActionLogSearch_Wrapper'), error => error.code === 'PORTAL_CONTRACT_CHANGED');
  f = fixture('call("screenservices/monitoring/logs/A/ActionLogSearch_Wrapper","a");call("screenservices/monitoring/logs/B/ActionLogSearch_Wrapper","b");');
  await assert.rejects(f.metadata.resolve('monitoring','logs.logs','monitoring/logs/logs/ActionLogSearch_Wrapper'), error => error.code === 'PORTAL_CONTRACT_CHANGED');
});
