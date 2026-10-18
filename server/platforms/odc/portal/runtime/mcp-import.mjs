import { wordsGiven } from '../../facade/destructive-operations.mjs';
import { fail } from './errors.mjs';
import { readMcpConnectionReadiness } from './mcp-connection-readiness.mjs';
import { buildMcpImportPlan, mcpSelectionHash } from './mcp-import-plan.mjs';
import { isUuid } from './write-journal.mjs';

export async function observeMcpImport(input, read) {
  const observed = new Map();
  const readiness = await readMcpConnectionReadiness(input, async (operationId, request) => {
    const response = await read(operationId, request);
    observed.set(operationId, response.data);
    return response;
  });
  return { readiness, observed };
}
export function planMcpImport(input, { readiness, observed }) {
  return buildMcpImportPlan({ connectionId: input.connectionId, toolNames: input.toolNames, readiness,
    connectionUpdateTimestamp: observed.get('connections.connection')?.ConnectionUpdateTimestamp,
    selectedObjectCount: observed.get('connections.detail')?.Connection?.externalMetadata?.selectedObjectCount,
    availableActions: observed.get('connections.actions')?.ActionList,
    selectedActions: observed.get('connections.selectedActions')?.ActionList });
}
const receiptView = receipt => ({ operationUuid: receipt.operationUuid, state: receipt.state, file: receipt.receipt });
const importEvidence = receipt => receipt.reconciliation?.mcpImport ?? receipt.mcpImport;

// execute is a single attempt. An existing UUID takes the observation path,
// including when the first process died after reservation and before its reply.
export async function executeMcpImport(input, { read, write, receipts }) {
  const { tenant, connectionId, operationUuid, expectedPlanSha256, toolNames } = input;
  if (!isUuid(operationUuid) || !wordsGiven(input.authorize) // CX15 r7: one predicate
   
    || !/^[a-f0-9]{64}$/.test(expectedPlanSha256 ?? '') || !Array.isArray(toolNames) || !toolNames.length
    || toolNames.some(n => typeof n !== 'string' || !n.trim()) || new Set(toolNames).size !== toolNames.length)
    fail('INPUT_INVALID', 'Execution requires explicit distinct toolNames, authorization, operationUuid and expectedPlanSha256.');
  const identity = { kind: 'odc-portal', tenant, operationId: 'connections.importActions', target: { connectionId } };
  let receipt = receipts.lookup(operationUuid, identity), existingReceipt = Boolean(receipt);
  if (receipt && (importEvidence(receipt)?.planSha256 !== expectedPlanSha256
    || JSON.stringify(importEvidence(receipt)?.requestedTools) !== JSON.stringify([...toolNames].sort())))
    fail('OPERATION_UUID_REUSED', 'This receipt does not match the requested MCP import plan. Read the original receipt; do not resend.');
  if (!receipt) {
    const observation = await observeMcpImport(input, read);
    if (!observation.readiness.ok || !observation.readiness.readyForToolImport)
      return { ok: false, sent: false, readiness: observation.readiness };
    const plan = planMcpImport(input, observation);
    if (plan.preview.planSha256 !== expectedPlanSha256)
      fail('MCP_IMPORT_PLAN_CHANGED', 'The MCP import plan changed. Review a new plan before authorizing execution.');
    if (plan.preview.noOp) return { ok: true, sent: false, noOp: true, plan: plan.preview };
    const result = await write({ ...input, operationId: identity.operationId, target: identity.target, input: plan.payload },
      { preparedMcpImport: { planSha256: expectedPlanSha256, requestedTools: plan.preview.requestedTools,
        selectionSha256: plan.selectionSha256 } });
    receipt = receipts.lookup(operationUuid, identity);
    if (!receipt) return result;
  }
  if (!['accepted', 'uncertain'].includes(receipt.state))
    return { ok: receipt.state === 'confirmed', existingReceipt, receipt: receiptView(receipt), replayed: false };
  try {
    const { readiness, observed } = await observeMcpImport(input, read);
    const selection = observed.get('connections.selectedActions')?.ActionList;
    const count = observed.get('connections.detail')?.Connection?.externalMetadata?.selectedObjectCount;
    if (readiness.ok && readiness.readyForToolImport && count === 0
      && mcpSelectionHash(connectionId, selection) === importEvidence(receipt)?.selectionSha256) {
      receipt = receipts.reconcile(receipt, { state: 'confirmed', observation: {
        connectionId, selectionSha256: importEvidence(receipt).selectionSha256,
        versionUnchanged: readiness.consistency.versionUnchanged, selectedCountVerified: readiness.consistency.selectedCountVerified } });
      return { ok: true, existingReceipt, receipt: receiptView(receipt), selectionConfirmed: true, replayed: false };
    }
  } catch { /* A failed observation never erases or repeats the recorded send. */ }
  return { ok: false, existingReceipt, receipt: receiptView(receipt), selectionConfirmed: false, replayed: false,
    note: 'Import outcome remains unverified. Repeat this same request only to read and reconcile its receipt; no resend occurs.' };
}
