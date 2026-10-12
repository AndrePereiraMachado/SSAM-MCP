import { fail } from './errors.mjs';

const list = value => Array.isArray(value) ? value : Array.isArray(value?.List) ? value.List : null;
const text = value => typeof value === 'string' && value.trim() ? value : null;
const changed = () => fail('PORTAL_CONTRACT_CHANGED', 'MCP connection metadata could not be verified; no import was attempted.');

function actions(data) {
  if (text(data?.ErrorMessage)) return { error: true, items: [] };
  const rows = list(data?.ActionList);
  if (!rows) changed();
  const names = new Set();
  return { error: false, items: rows.map(row => {
    const name = text(row?.OriginalName) ?? text(row?.Name);
    if (!name || names.has(name)) changed();
    names.add(name);
    return { name, supported: typeof row.IsNotSupported === 'boolean' ? !row.IsNotSupported : null };
  }) };
}

// Reads only. Identity is established by the typed detail projection and checked
// again after metadata reads. No raw configuration, action schema or error text
// leaves this helper: those fields may contain credentials or external payloads.
export async function readMcpConnectionReadiness({ connectionId }, read) {
  if (typeof connectionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(connectionId))
    fail('INPUT_INVALID', 'An existing connectionId is required.');
  const detailInput = { connectionId, providerId: 'mcp' };
  const before = await read('connections.detail', detailInput);
  if (!before.ok) return before;
  if (before.data?.NotFound === true) return { ok: true, connectionId, exists: false,
    readyForToolImport: false, blockedReasons: ['connection-not-found'] };
  const connection = before.data?.Connection;
  if (!connection || connection.connectionId !== connectionId || connection.providerId !== 'mcp') changed();
  const screenVariables = { ConnectionId: connectionId, _connectionIdInDataFetchStatus: 1,
    Source: '', _sourceInDataFetchStatus: 1, ForceRefreshFail: false, _forceRefreshFailInDataFetchStatus: 1,
    ForceSupportBoth: false, _forceSupportBothInDataFetchStatus: 1 };
  const metadata = await read('connections.connection', { screenVariables });
  if (!metadata.ok) return metadata;
  const availableRead = await read('connections.actions', { screenVariables });
  if (!availableRead.ok) return availableRead;
  const selectedRead = await read('connections.selectedActions', { screenVariables });
  if (!selectedRead.ok) return selectedRead;
  const available = actions(availableRead.data), selected = actions(selectedRead.data);
  const after = await read('connections.detail', detailInput);
  if (!after.ok) return after;
  const current = after.data?.Connection;
  const consistent = !after.data?.NotFound && current?.connectionId === connectionId && current?.providerId === 'mcp'
    && text(connection.updatedOn) !== null && connection.updatedOn === current.updatedOn;
  const timestamp = text(metadata.data?.LastSuccessfulMetadataUpdateTimestamp);
  const metadataUpdated = timestamp !== null && Number.isFinite(Date.parse(timestamp)) && !timestamp.startsWith('1900-01-01');
  const selectedCount = connection.externalMetadata?.selectedActionCount;
  const selectedCountVerified = Number.isSafeInteger(selectedCount) && selectedCount >= 0
    && selectedCount === selected.items.length && current?.externalMetadata?.selectedActionCount === selectedCount;
  const reasons = [];
  if (!consistent) reasons.push('connection-version-unverified-or-changed');
  if (!metadataUpdated) reasons.push('successful-metadata-update-unverified');
  if (available.error) reasons.push('available-actions-error');
  if (selected.error) reasons.push('selected-actions-error');
  if (!selectedCountVerified) reasons.push('selected-action-count-unverified');
  if (!available.items.length) reasons.push('no-available-actions');
  if (available.items.some(row => row.supported === null)) reasons.push('action-support-unverified');
  if (!available.items.some(row => row.supported === true)) reasons.push('no-supported-actions');
  return { ok: true, exists: true, connection: { connectionId, name: connection.name, providerId: 'mcp',
    updatedOn: connection.updatedOn ?? null }, lastSuccessfulMetadataUpdateTimestamp: metadataUpdated ? timestamp : null,
    availableActions: available.items, selectedActions: selected.items,
    availableActionCount: available.items.length, selectedActionCount: selected.items.length,
    hasImportedTools: selected.error || !selectedCountVerified ? null : selected.items.length > 0,
    readyForToolImport: reasons.length === 0, blockedReasons: reasons,
    consistency: { versionUnchanged: Boolean(consistent), selectedCountVerified, atomic: false },
    note: 'Read-only observation; does not invoke tools, refresh metadata or import actions.' };
}
