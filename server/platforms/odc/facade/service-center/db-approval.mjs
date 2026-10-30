import { approvalOf, WrittenAuthorizationError } from '../authorization-context.mjs';
import { ProtocolError } from './errors.mjs';
import { wordsGiven } from '../destructive-operations.mjs';

export const DB_APPROVAL_ACTIONS = ['db-connection-create', 'db-connection-test', 'db-connection-delete'];

// R2-I (owner's rule, 28/10): file = a context file (still accepted), or null: the user's written words naming the
// connection are the approval and SSAM records it on the plan itself (hashes only). The scope is the same either way.
export function approveDatabasePlan(file, words, plan) {
  if (!DB_APPROVAL_ACTIONS.includes(plan.action) || !plan.parameters || plan.usedBy?.length)
    throw new ProtocolError('Database approval requires an unchanged direct SQL endpoint and no consuming extensions.');
  const match = /^([^,\\\s]+)(?:,(\d+))?$/.exec(plan.parameters.server ?? '');
  if (!match || Object.keys(plan.parameters).some(k => !['server', 'database'].includes(k))
      || !plan.parameters.database || plan.dbms !== 'SQL Server')
    throw new ProtocolError('Database approval does not cover this connection provider or endpoint.');
  try {
    return approvalOf(file ?? null, words, { lane: 'o11', host: plan.host, operation: plan.action,
      targets: [plan.connection], constraints: { server: match[1], port: Number(match[2] ?? 1433), database: plan.parameters.database,
        noDdl: true, noDataWrites: true, noBusinessDataReads: true, deleteTemporaryConnections: true, requiresTestedHeadlessTransport: true } });
  } catch (error) {
    if (error instanceof WrittenAuthorizationError) throw new ProtocolError(error.message, error.code);
    throw error;
  }
}

// R2-I: the approval of a connection delete that cleans up after an uncertain connection test. A context file already on
// the plan stays; without one, the user's written words that name the connection (the page delete checked them against its
// preview) are recorded on the plan when the pending receipt of this target is a connection test and the plan qualifies.
// -> the approval, or null (the pending test keeps the target, and the write refuses as before).
export function connectionTestCleanupApproval(journal, identity, plan, words, targetOf) {
  if (plan.authorizationContext) return plan.authorizationContext;
  if (!journal || identity?.action !== 'db-connection-delete' || !wordsGiven(words)) return null;
  const held = journal.holder(targetOf(identity));
  if (!held || journal.lookup(held)?.identity?.action !== 'db-connection-test') return null;
  try { return approveDatabasePlan(null, words, plan); } catch (error) { if (error instanceof ProtocolError) return null; throw error; }
}
