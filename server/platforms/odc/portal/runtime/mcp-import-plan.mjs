import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

const invalid = () => fail('PORTAL_CONTRACT_CHANGED', 'MCP import metadata is incomplete or inconsistent; no import was attempted.');
const rows = value => {
  const result = Array.isArray(value) ? value : value?.List;
  if (!Array.isArray(result)) invalid();
  return result;
};
const string = (value, required = false) => {
  if (typeof value !== 'string' || (required && !value.trim())) invalid();
  return value;
};
const bool = value => { if (typeof value !== 'boolean') invalid(); return value; };
const name = row => string(row?.OriginalName || row?.Name, true);
const fields = ['Description', 'DataType', 'OriginalDataType', 'DefaultDataType', 'DefaultValue'];
const flags = ['IsArrayOfPrimitive', 'IsNotSupported', 'IsMandatory'];
function parameterFields(row, idKey) {
  const out = { [idKey]: string(row?.[idKey] ?? row?.Id),
    Name: string(row?.Name || row?.OriginalName, true), OriginalName: name(row) };
  for (const key of fields) out[key] = string(row[key]);
  for (const key of flags) out[key] = bool(row[key]);
  return out;
}
function action(row, connectionId) {
  if (row?.ConnectionId !== connectionId) invalid();
  return { ActionId: string(row.ActionId ?? row.Id), ConnectionId: connectionId,
    Name: string(row.Name || row.OriginalName, true), OriginalName: name(row),
    Description: string(row.Description), IsSelected: true, IsNotSupported: bool(row.IsNotSupported),
    Parameters: { List: rows(row.Parameters).map(parameter => ({
      ...parameterFields(parameter, 'ParameterId'), ParameterType: string(parameter.ParameterType, true),
      ChangeStatus: string(parameter.ChangeStatus, true),
      Fields: { List: rows(parameter.Fields).map(field => parameterFields(field, 'FieldId')) },
    })) } };
}
function indexed(value) {
  const map = new Map();
  for (const row of rows(value)) {
    const key = name(row);
    if (map.has(key)) invalid();
    map.set(key, row);
  }
  return map;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function mcpSelectionHash(connectionId, actions) {
  const byName = indexed(actions);
  const definition = value => {
    if (Array.isArray(value)) return value.map(definition);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['ActionId', 'ParameterId', 'FieldId', 'ChangeStatus'].includes(key))
      .map(([key, item]) => [key, definition(item)]));
    return value;
  };
  // The service may assign record IDs and clear change markers on import.
  // Compare the actual definition, not those transport bookkeeping fields.
  return createHash('sha256').update(JSON.stringify(canonical([...byName.keys()].sort()
    .map(key => definition(action(byName.get(key), connectionId)))))).digest('hex');
}

// Internal only: payload contains native schemas/default values. Only preview is
// suitable for the public tool response. Planning never invokes a remote tool.
export function buildMcpImportPlan({ connectionId, toolNames, readiness, connectionUpdateTimestamp,
  selectedObjectCount, availableActions, selectedActions }) {
  if (typeof connectionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(connectionId)
    || !Array.isArray(toolNames) || !toolNames.length || toolNames.some(v => typeof v !== 'string' || !v.trim())
    || new Set(toolNames).size !== toolNames.length)
    fail('INPUT_INVALID', 'Provide a connectionId and distinct explicit toolNames.');
  if (readiness?.ok !== true || readiness.readyForToolImport !== true
    || readiness.connection?.connectionId !== connectionId || readiness.connection?.providerId !== 'mcp'
    || selectedObjectCount !== 0) invalid();
  if (typeof connectionUpdateTimestamp !== 'string' || !Number.isFinite(Date.parse(connectionUpdateTimestamp))
    || connectionUpdateTimestamp.startsWith('1900-01-01')) invalid();
  const available = indexed(availableActions), selected = indexed(selectedActions);
  const sameNames = (summary, map) => Array.isArray(summary) && summary.length === map.size
    && summary.every(item => map.has(item.name));
  if (!sameNames(readiness.availableActions, available) || !sameNames(readiness.selectedActions, selected)) invalid();
  for (const key of toolNames) {
    if (!available.has(key)) fail('INPUT_INVALID', 'A requested MCP tool is absent from the available metadata.');
    if (available.get(key).IsNotSupported !== false) fail('INPUT_INVALID', 'A requested MCP tool is not confirmed supported.');
  }
  // Preserve existing definitions, including customized parameter names/defaults.
  // Never substitute a fresh available definition for an imported definition.
  const additions = toolNames.filter(key => !selected.has(key)).sort();
  const merged = [...selected.keys()].sort().map(key => action(selected.get(key), connectionId));
  for (const key of additions) merged.push(action(available.get(key), connectionId));
  const payload = { inputParameters: { ConnectionId: connectionId,
    ConnectionOriginalUpdateTimestamp: connectionUpdateTimestamp,
    DatabaseObjects: { Entities: { List: [] }, Actions: { List: merged } } },
    screenVariables: { ConnectionId: connectionId, _connectionIdInDataFetchStatus: 1,
      Source: '', _sourceInDataFetchStatus: 1, ForceRefreshFail: false, _forceRefreshFailInDataFetchStatus: 1,
      ForceSupportBoth: false, _forceSupportBothInDataFetchStatus: 1 } };
  const sha256 = createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
  return { payload, selectionSha256: mcpSelectionHash(connectionId, merged), preview: { connectionId, requestedTools: [...toolNames].sort(),
    preservedTools: [...selected.keys()].sort(), addedTools: additions,
    noOp: additions.length === 0, planSha256: sha256, connectionUpdateTimestamp } };
}
