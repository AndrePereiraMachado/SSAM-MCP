import {fail} from './errors.mjs';

export const CONNECTION_NAME_AVAILABILITY_READS = new Set([
  'connections.relationalNameAvailability',
  'connections.azureSearchNameAvailability',
  'connections.customSearchNameAvailability',
]);

export function connectionNameAvailabilityInput(raw) {
  const p = raw.inputParameters;
  if (!p || typeof p.ConnectionName !== 'string' || !p.ConnectionName.trim()
      || typeof p.ConnectionId !== 'string'
      || Object.keys(p).some(k => !['ConnectionName', 'ConnectionId'].includes(k)))
    fail('INPUT_INVALID', 'Connection name availability requires ConnectionName and ConnectionId (empty for a new connection).');
  return raw;
}

export function connectionNameAvailabilityResult(raw, data) {
  connectionNameAvailabilityInput(raw);
  if (typeof data?.IsNameAvailable !== 'boolean')
    fail('PORTAL_RESPONSE_INVALID', 'Connection name availability did not return a boolean IsNameAvailable.');
  return {name: raw.inputParameters.ConnectionName, connectionId: raw.inputParameters.ConnectionId,
    available: data.IsNameAvailable, reservationMade: false,
    scope: 'queried-name-at-read-time'};
}
