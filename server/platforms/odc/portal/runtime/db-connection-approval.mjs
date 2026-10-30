import { authorizationContext } from '../../facade/authorization-context.mjs';
import { approvalOf, sameGrant } from './written-approval.mjs';
import { fail } from './errors.mjs';
import { temporaryTlsPolicy } from './connection-tls-policy.mjs';

// Contextual DB approval binds the actual DTO, not only a display name. This is
// intentionally limited to a single stage and direct relational connection.
export function dbConnectionApproval(file, words, { host, operationId, raw, target }) {
  if (!file) return null;
  const reject = () => fail('AUTHORIZATION_CONTEXT_INVALID', 'Database approval does not cover this exact connection, endpoint and stage. Nothing was sent.');
  const input = raw?.inputParameters;
  if (input?.ProviderId !== 'mssql' || input?.Variant !== 'vanilla') reject();
  let header, configs;
  if (operationId === 'connections.relationalTest') {
    header = input?.ConnectionDetails_Header;
    configs = input?.ValidStageConfigs?.List;
    if (input?.ConnectionId !== '' || input?.IsEditConnection !== false || input?.ForceErrorOnStageKeys !== ''
        || input?.IsConfigChanged !== true || JSON.stringify(configs) !== JSON.stringify(input?.EditedStageConfigs?.List)) reject();
  } else if (operationId === 'connections.relationalSave') {
    header = input?.ConnectionDetails?.ConnectionDetails_Header;
    configs = input?.ConnectionDetails?.ConnectionDetail_StageConfig?.List;
    if (!input?.ConnectionId || input?.ForceErrorOnMetadataStatus !== false || input?.ConnectionOriginalUpdateTimestamp !== '1900-01-01T00:00:00') reject();
  } else reject();
  if (typeof header?.ConnectionName !== 'string' || header.ConnectionName !== target?.connectionName
      || header.PortfolioKey !== '' || !Array.isArray(configs) || configs.length !== 1) reject();
  const stage = configs[0].TenantStage?.Key, common = configs[0].ConnectionDetails_Common;
  if (!stage || !common || common.ConnectionUsername !== '' || common.ConnectionPassword !== ''
      || (common.AdvancedConnectionString !== '' && !temporaryTlsPolicy(common.AdvancedConnectionString)) || common.IsPrivateGateway !== false || common.PrivateGatewayPort !== 0
      || typeof common.ConnectionServer !== 'string' || typeof common.ConnectionDatabase !== 'string'
      || !Number.isInteger(common.ConnectionServerPort)) reject();
  return authorizationContext(file, words, { lane: 'odc', host, operation: operationId, targets: [header.ConnectionName], environmentKey: stage,
    constraints: { server: common.ConnectionServer, port: common.ConnectionServerPort, database: common.ConnectionDatabase,
      ...(temporaryTlsPolicy(common.AdvancedConnectionString) ? {encryptedTransport:true,trustServerCertificate:true} : {}),
      noDdl: true, noDataWrites: true, noBusinessDataReads: true, deleteTemporaryConnections: true, requiresTestedHeadlessTransport: true } });
}

export function dbDeleteApproval(file, words, { host, detail, origin }) {
  return ownedConnectionApproval(file, words, { host, detail, origin, operation: 'connections.delete', empty: true });
}

// changed: the entities the write changes (a removal unselects them, a custom import selects them). With the written words
// alone they are targets too (each named; a removal's guard asks for them after the preview); a context file keeps its scope
// (the connection).
export function dbEntityApproval(file, words, { host, detail, origin, changed = [] }) {
  return ownedConnectionApproval(file, words, { host, detail, origin, operation: 'connections.importEntities', empty: false, changed });
}

function ownedConnectionApproval(file, words, { host, detail, origin, operation, empty, changed = [] }) {
  const reject = () => fail('AUTHORIZATION_CONTEXT_INVALID', 'Temporary connection deletion requires its exact creation receipt, unchanged endpoint, one approved stage and zero imported objects/actions. Nothing was sent.');
  const connection = detail?.Connection;
  if (!connection || detail.NotFound !== false || connection.providerId !== 'mssql'
      || !Number.isInteger(connection.externalMetadata?.selectedObjectCount) || connection.externalMetadata.selectedObjectCount < 0
      || (empty && connection.externalMetadata.selectedObjectCount !== 0) || connection.externalMetadata?.selectedActionCount !== 0
      || !Array.isArray(connection.stageConfigurations) || connection.stageConfigurations.length !== 1
      || origin?.identity?.kind !== 'odc-portal' || origin.identity.tenant !== host
      || !['connections.relationalTest', 'connections.relationalSave'].includes(origin.identity.operationId)
      || origin.identity.target?.connectionName !== connection.name
      || !['accepted', 'confirmed'].includes(origin.state)
      || (origin.response?.Out_ConnectionId ?? origin.response?.ConnectionId) !== connection.connectionId) reject();
  const stage = connection.stageConfigurations[0];
  if (!stage.host || !stage.database || !/^\d+$/.test(String(stage.port)) || (stage.hasAdditionalParameters && stage.tlsMode !== 'encrypted-unverified-server')
      || ![null, '', '0'].includes(stage.privateGatewayPort)) reject();
  const constraints = { server: stage.host, port: Number(stage.port), database: stage.database,
    ...(stage.hasAdditionalParameters ? {encryptedTransport:true,trustServerCertificate:true} : {}),
    noDdl: true, noDataWrites: true, noBusinessDataReads: true, deleteTemporaryConnections: true, requiresTestedHeadlessTransport: true };
  // R2-I: a context file of the creation's proposal, or the written words naming this own temporary connection (its own
  // creation receipt, unchanged endpoint and stage, zero objects/actions bind it as before).
  const targets = file ? [connection.name] : [...new Set([connection.name, ...changed.map(String)])];
  const approval = approvalOf(file, words, { lane: 'odc', host, operation, targets, environmentKey: stage.stageKey, constraints });
  if (!sameGrant(origin.authorization, approval, { proposal: true, conversation: false })) reject();
  return approval;
}
