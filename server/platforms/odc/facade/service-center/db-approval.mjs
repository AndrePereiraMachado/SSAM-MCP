import { authorizationContext } from '../authorization-context.mjs';
import { ProtocolError } from './errors.mjs';

export const DB_APPROVAL_ACTIONS = ['db-connection-create', 'db-connection-test', 'db-connection-delete'];

export function approveDatabasePlan(file, words, plan) {
  if (!DB_APPROVAL_ACTIONS.includes(plan.action) || !plan.parameters || plan.usedBy?.length)
    throw new ProtocolError('Database approval requires an unchanged direct SQL endpoint and no consuming extensions.');
  const match = /^([^,\\\s]+)(?:,(\d+))?$/.exec(plan.parameters.server ?? '');
  if (!match || Object.keys(plan.parameters).some(k => !['server', 'database'].includes(k))
      || !plan.parameters.database || plan.dbms !== 'SQL Server')
    throw new ProtocolError('Database approval does not cover this connection provider or endpoint.');
  return authorizationContext(file, words, { lane: 'o11', host: plan.host, operation: plan.action,
    targets: [plan.connection], constraints: { server: match[1], port: Number(match[2] ?? 1433), database: plan.parameters.database,
      noDdl: true, noDataWrites: true, noBusinessDataReads: true, deleteTemporaryConnections: true, requiresTestedHeadlessTransport: true } });
}
