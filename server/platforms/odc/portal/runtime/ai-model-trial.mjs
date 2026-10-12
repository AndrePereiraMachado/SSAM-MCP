import fs from 'node:fs';
import { authorizationContext } from '../../facade/authorization-context.mjs';
import { fail } from './errors.mjs';
import { isUuid, sha256 } from './write-journal.mjs';

export const AI_TRIAL_CREATE = 'aiModels.trialCreate', AI_TRIAL_DELETE = 'aiModels.trialDelete';
const bad = () => fail('AUTHORIZATION_CONTEXT_INVALID', 'Trial model operation requires an exact owned-fixture proposal and verified inventory. Nothing was sent.');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
export const aiModelInventoryInput = portfolioKey => ({
  screenVariables: { ActivePortfolioKey: portfolioKey, portfolioid: portfolioKey, _portfolioidInDataFetchStatus: 1, StartIndex: 0 },
  clientVariables: { AIModelListSearchValue: '', ProviderSelectionListSearchValue: '', ProviderSelectionListFilter: '' },
});
export function aiModelInventory(result, portfolioKey) {
  const list = result?.data?.AIModelList?.List, raw = result?.data?.TotalCount, total = Number(raw);
  if (result?.ok !== true || !(typeof raw === 'number' || typeof raw === 'string' && /^\d+$/.test(raw))
    || !Array.isArray(list) || !Number.isSafeInteger(total) || total < 0 || total !== list.length
    || list.some(x => !isUuid(x.Id) || !(x.PortfolioKey === portfolioKey || x.PortfolioKey === '' && x.IsTrial === true)
      || typeof x.Name !== 'string' || !x.Name || typeof x.IsTrial !== 'boolean')
    || new Set(list.map(x => x.Id)).size !== list.length)
    fail('AI_MODEL_INVENTORY_INCOMPLETE', 'A complete AI model inventory for the exact portfolio is required.');
  return list;
}
export async function aiModelTrialApproval({ file, words, host, operationId, raw, lookup, read }) {
  if (!file || Object.keys(raw.screenVariables).length || Object.keys(raw.clientVariables).length) bad();
  let constraints;
  try { if (fs.statSync(file).size > 32768) bad(); constraints = JSON.parse(fs.readFileSync(file, 'utf8')).constraints; } catch { bad(); }
  if (!isUuid(constraints?.portfolioKey)) bad();
  const portfolioKey = constraints.portfolioKey, p = raw.inputParameters;
  const list = aiModelInventory(await read('aiModels.list', aiModelInventoryInput(portfolioKey)), portfolioKey);
  if (operationId === AI_TRIAL_CREATE) {
    if (!exact(p, 'TrialId') || typeof p.TrialId !== 'string' || !p.TrialId || p.TrialId.length > 100) bad();
    if (list.length) fail('AI_MODEL_BASELINE_NOT_EMPTY', 'Trial creation is limited to an empty verified inventory so an existing default model cannot change. Nothing was sent.');
    const trials = await read('aiModels.trials', { screenVariables: { SearchKeyword: '', _searchKeywordInDataFetchStatus: 1 } });
    const matches = trials?.data?.AIModelTrials?.List?.filter(x => x.Id === p.TrialId);
    if (trials?.ok !== true || !matches || matches.length !== 1 || matches[0].CurrentAIModelId !== '')
      fail('AI_TRIAL_ALREADY_CONFIGURED_OR_UNAVAILABLE', 'The exact trial must be available and unconfigured. Nothing was sent.');
    const approval = authorizationContext(file, words, { lane: 'odc', host, operation: operationId, targets: [p.TrialId],
      constraints: { portfolioKey, inputSha256: sha256(JSON.stringify(p)), expectedInventorySha256: sha256(JSON.stringify(list)) } });
    if (!approval) bad();
    return approval;
  }
  if (operationId !== AI_TRIAL_DELETE || !exact(p, 'AIModelId') || !isUuid(p.AIModelId) || !isUuid(constraints.originOperationUuid)) bad();
  const origin = lookup(constraints.originOperationUuid);
  if (!origin || !['accepted', 'confirmed'].includes(origin.state) || origin.identity?.tenant !== host
    || origin.identity.operationId !== AI_TRIAL_CREATE || origin.response?.AIModelId !== p.AIModelId
    || origin.reconciliation?.aiModelTrial?.portfolioKey !== portfolioKey || !origin.authorization?.source) bad();
  const found = list.find(x => x.Id === p.AIModelId);
  if (!found || found.IsTrial !== true) bad();
  const detail = await read('aiModels.detail', { screenVariables: { id: found.Id, _idInDataFetchStatus: 1, ActivePortfolioKey: portfolioKey } });
  if (!modelDetailMatches(detail, found, portfolioKey)) bad();
  const approval = authorizationContext(file, words, { lane: 'odc', host, operation: operationId, targets: [found.Name],
    constraints: { portfolioKey, originOperationUuid: constraints.originOperationUuid, aiModelId: p.AIModelId,
      expectedModelSha256: sha256(JSON.stringify(found)), inputSha256: sha256(JSON.stringify(p)) } });
  if (!approval || approval.wordsSha256 !== origin.authorization.wordsSha256 || approval.proposalSha256 !== origin.authorization.proposalSha256
    || approval.source.threadId !== origin.authorization.source.threadId || approval.source.messageId !== origin.authorization.source.messageId) bad();
  return approval;
}
function modelDetailMatches(detail, found, portfolioKey) {
  const model = detail?.data?.AIModel;
  return detail?.ok === true && detail.data.NotFound === false && model?.Id === found.Id && model.AssetKey === found.Id
    && model.PortfolioKey === portfolioKey && model.Name === found.Name && model.IsTrial === true;
}
export function aiModelTrialObservation(receipt, result, detail) {
  const scope = receipt.reconciliation?.aiModelTrial;
  const list = aiModelInventory(result, scope?.portfolioKey);
  const id = scope?.key ?? receipt.response?.AIModelId;
  if (!isUuid(id)) return { verified: false, reason: 'creation-identity-unavailable' };
  const found = list.find(x => x.Id === id);
  return { verified: receipt.identity.operationId === AI_TRIAL_DELETE ? !found : !!found && modelDetailMatches(detail, found, scope.portfolioKey),
    aiModelId: id, exists: !!found, portfolioKey: scope.portfolioKey };
}
export async function observeAiModelTrial(receipt, read) {
  const scope = receipt.reconciliation?.aiModelTrial;
  const result = await read('aiModels.list', aiModelInventoryInput(scope?.portfolioKey));
  const id = scope?.key ?? receipt.response?.AIModelId;
  const detail = receipt.identity.operationId === AI_TRIAL_CREATE && isUuid(id)
    ? await read('aiModels.detail', { screenVariables: { id, _idInDataFetchStatus: 1, ActivePortfolioKey: scope.portfolioKey } }) : null;
  return aiModelTrialObservation(receipt, result, detail);
}
