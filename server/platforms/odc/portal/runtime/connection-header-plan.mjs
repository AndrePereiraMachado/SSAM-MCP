import {createHash} from 'node:crypto';
import {fail} from './errors.mjs';
import {connectionDetailInput, projectConnectionDetail} from './connection-detail.mjs';

const nullFields = ['NullWriteBehavior', 'Boolean', 'Date', 'Time', 'DateTime', 'Integer', 'LongInteger', 'Decimal', 'Text'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Internal preparation only. Dispatch still requires contextual ownership approval
// and a new read of the same timestamp. No stage configuration or vault access.
export function connectionHeaderPlan(data, identity, patch, expectedUpdatedOn) {
  connectionDetailInput(identity);
  const reject = () => fail('PORTAL_CONTRACT_CHANGED', 'Connection header edit requires a complete current relational baseline.');
  const projected = projectConnectionDetail(data, identity);
  if (projected.NotFound) fail('CONNECTION_NOT_FOUND', 'The requested connection does not exist; no header edit can be prepared.');
  const current = data.Connection;
  if (identity.providerId !== 'mssql' || current.variant !== 'vanilla'
      || typeof current.description !== 'string' || typeof current.updatedOn !== 'string'
      || !/^\d{4}-\d\d-\d\dT/.test(current.updatedOn)
      || !Number.isFinite(Date.parse(current.updatedOn)) || current.updatedOn.startsWith('1900-01-01')) reject();
  if (typeof expectedUpdatedOn !== 'string' || current.updatedOn !== expectedUpdatedOn)
    fail('CONNECTION_CHANGED', 'Connection changed since the reviewed baseline; prepare a new plan.');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || !Object.keys(patch).length || Object.keys(patch).some(key => !['name', 'description'].includes(key))
      || ('name' in patch && (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 100))
      || ('description' in patch && (typeof patch.description !== 'string' || patch.description.length > 500)))
    fail('INPUT_INVALID', 'Header edit accepts only name and description.');
  const source = current.NullValueHandling;
  if (!source || typeof source !== 'object' || Array.isArray(source)
      || Object.keys(source).some(key => !nullFields.includes(key))
      || nullFields.some(key => typeof source[key] !== 'string')) reject();
  const nullHandling = Object.fromEntries(nullFields.map(key => [key, source[key]]));
  const header = {ConnectionName: patch.name ?? current.name,
    ConnectionDescription: patch.description ?? current.description, PortfolioKey: current.portfolioKey};
  const input = {inputParameters: {ConnectionDetails: {
    ConnectionDetail_StageConfig: {List: []}, ConnectionDetails_Header: header, NullValueHandling: nullHandling},
    ConnectionId: current.connectionId, ConnectionOriginalUpdateTimestamp: current.updatedOn,
    ProviderId: current.providerId, Variant: current.variant, ForceErrorOnMetadataStatus: false}};
  const baseline = {...projected.Connection, description: current.description, variant: current.variant, NullValueHandling: nullHandling};
  const {name, description, updatedOn, ...preserved} = baseline;
  return {operationId: 'connections.relationalSave', input,
    baselineSha256: digest(baseline), bodySha256: digest(input),
    planSha256: digest({baseline,input}), preservedSha256: digest(preserved), baseline,
    changed: header.ConnectionName !== current.name || header.ConnectionDescription !== current.description,
    requiresNameAvailability: header.ConnectionName !== current.name,
    restores: {name: current.name, description: current.description},
    stageConfigurationIncluded: false, sent: false};
}
