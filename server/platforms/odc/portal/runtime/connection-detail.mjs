import { fail } from './errors.mjs';
import { temporaryTlsPolicy } from './connection-tls-policy.mjs';
import {fingerprint} from './write-journal.mjs';
import {a2aDiscoveryOutcome} from './a2a-discovery.mjs';

const list = value => Array.isArray(value) ? value : Array.isArray(value?.List) ? value.List : null;
const denied = () => fail('PORTAL_CONTRACT_CHANGED', 'Connection detail did not prove the requested identity and configuration shape. Raw values were withheld.');
export function connectionDetailInput(input) {
  if (!input || Object.keys(input).some(key => !['connectionId', 'providerId'].includes(key))
      || typeof input.connectionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.connectionId)
      || typeof input.providerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.providerId))
    fail('INPUT_INVALID', 'connections.detail requires the existing connectionId and its native providerId (for SQL Server: mssql).');
  return { screenVariables: { ConnectionId: input.connectionId, _connectionIdInDataFetchStatus: 1,
    ProviderId: input.providerId, _providerIdInDataFetchStatus: 1, Variant: '', _variantInDataFetchStatus: 1,
    IsEdit: false, _isEditInDataFetchStatus: 1 } };
}

// The wire detail contains key/value configuration records, including secrets.
// Never return that dictionary or arbitrary fields, even after generic redaction.
export function projectConnectionDetail(data, input) {
  if (!data || typeof data.NotFound !== 'boolean') denied();
  if (data.NotFound) return { NotFound: true, Connection: null };
  const connection = data.Connection;
  if (!connection || connection.connectionId !== input.connectionId || connection.providerId !== input.providerId
      || typeof connection.name !== 'string' || !connection.name || typeof connection.portfolioKey !== 'string') denied();
  const stages = list(connection.StageConfigurations);
  if (!stages) denied();
  const configured = stages.map(stage => {
    if (typeof stage.StageKey !== 'string' || !stage.StageKey) denied();
    const values = list(stage.configurationValues);
    if (!values || values.some(entry => typeof entry.key !== 'string' || typeof entry.value !== 'string')
        || new Set(values.map(entry => entry.key)).size !== values.length) denied();
    const lookup = new Map(values.map(entry => [entry.key, entry.value]));
    let a2a,customSearch;
    if(connection.providerId==='customAISearch'){
      const emptyJsonList=key=>{
        const value=lookup.get(key);if(value===undefined)return null;
        try{const decoded=JSON.parse(value);return Array.isArray(decoded)?decoded.length===0:null;}catch{return null;}
      };
      // Exact native CustomAISearch enum keys. Never expose the header dictionary
      // or hash nonempty credentials; absent/malformed fields stay inconclusive.
      customSearch={endpointSha256:lookup.get('endpointURL')?fingerprint(lookup.get('endpointURL')):null,
        headersEmpty:emptyJsonList('headers'),headerNamesEmpty:emptyJsonList('headerNames')};
    }
    if(connection.providerId==='a2a'){
      const cards=list(connection.Embedded?.AgentCards);
      if(cards&&cards.some(card=>typeof card.StageKey!=='string'))denied();
      if(cards&&new Set(cards.map(card=>card.StageKey)).size!==cards.length)denied();
      const embedded=cards?.find(card=>card.StageKey===stage.StageKey)?.AgentCard;
      let cardHash=null,normalizedCardHash=null;
      if(embedded!==undefined&&embedded!==''){
        if(typeof embedded!=='string'||embedded.length>131072)denied();
        try{const card=JSON.parse(embedded);if(!card||typeof card!=='object'||Array.isArray(card))denied();cardHash=fingerprint(card);}catch{denied();}
        try{normalizedCardHash=a2aDiscoveryOutcome({AgentCard:embedded}).cardSha256;}catch{/* Unsupported cards remain readable, never verified as no_auth. */}
      }
      const configurationType=lookup.get('configurationType'),authType=lookup.get('authType');
      a2a={configurationType:['json','url'].includes(configurationType)?configurationType:null,
        authType:['no_auth','oauth_client_credentials','api_key','basic','bearer','other','openIdConnectSecurityScheme'].includes(authType)?authType:null,
        agentCardSha256:cardHash,normalizedAgentCardSha256:normalizedCardHash,agentUrlSha256:lookup.get('agentUrl')?fingerprint(lookup.get('agentUrl')):null,
        hasCredentialValues:['clientId','clientSecret','scope','accessTokenUrl','apiKeySecret','apiKeyName','username','password','bearerToken','securityScheme'].some(key=>Boolean(lookup.get(key)))};
    }
    return { stageKey: stage.StageKey, ...(a2a?{a2a}:{}), ...(customSearch?{customSearch}:{}), host: lookup.get('host') ?? null, port: lookup.get('port') ?? null,
      database: lookup.get('database') ?? null, hasAdditionalParameters: Boolean(lookup.get('connectionString')),
      ...(temporaryTlsPolicy(lookup.get('connectionString')) ? {tlsMode:temporaryTlsPolicy(lookup.get('connectionString'))} : {}),
      privateGatewayPort: lookup.get('privateGatewayPort') ?? null };
  });
  if (new Set(configured.map(stage => stage.stageKey)).size !== configured.length) denied();
  const count = value => {
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) denied();
    return Number(value);
  };
  return { NotFound: false, Connection: {
    connectionId: connection.connectionId, name: connection.name, providerId: connection.providerId, portfolioKey: connection.portfolioKey,
    ...(['a2a','customAISearch'].includes(connection.providerId)?{description:typeof connection.description==='string'?connection.description:null}:{}),
    updatedOn: typeof connection.updatedOn === 'string' ? connection.updatedOn : null,
    stageConfigurations: configured, externalMetadata: { selectedObjectCount: count(connection.ExternalMetadata?.selectedObjectCount),
      selectedActionCount: count(connection.ExternalMetadata?.selectedActionCount) }
  } };
}

// Classify native diagnostics without exposing free text that may echo a login.
export function connectionFailureCategory(row) {
  if (String(row?.Status).toLowerCase() !== 'error') return null;
  const text = ['ErrorMessage','Error','Message','ErrorDescription'].map(key =>
    typeof row[key] === 'string' ? row[key].slice(0,65536) : '').join(' ');
  // A concrete PKIX verification failure is more specific than JDBC URL
  // properties such as loginTimeout that may appear in the same diagnostic.
  if (/PKIX path building failed|unable to find valid certification path|certificate verify failed/i.test(text)) return 'tls-certificate';
  const categories = [
    ['tls-certificate', /PKIX|certificate|certification path|trust anchor/i],
    ['database-authentication', /login failed|authentication failed|password authentication|ORA-01017|error[^\d]*18456/i],
    ['network-timeout', /timed?\s*out|timeout/i],
    ['network-connectivity', /connection refused|no route to host|unknownhost|name or service not known|network-related/i],
    ['database-access', /cannot open database|database[^.]{0,100}does not exist/i]
  ].filter(([,pattern]) => pattern.test(text)).map(([name]) => name);
  return categories.length === 1 ? categories[0] : null;
}

export function projectConnectionTestStatus(data) {
  const rows = list(data?.Status?.Results);
  if (!rows) denied();
  return { Status: { Results: { List: rows.map(row => {
    if (typeof row.StageKey !== 'string' || !row.StageKey || typeof row.Status !== 'string' || !/^[A-Za-z_-]{1,32}$/.test(row.Status)) denied();
    const category=connectionFailureCategory(row);
    const message=typeof row.ErrorMessage==='string'?row.ErrorMessage.slice(0,65536):'';
    const diagnosticSignals=String(row.Status).toLowerCase()==='error'?[
      ['json-deserialization',/deserializ|cannot parse|could not parse|invalid json|json.*(?:invalid|unexpected)/i],
      ['json-rpc',/json.?rpc/i],['invalid-request',/invalid request/i],['method-not-found',/method not found/i],
      ['invalid-identifier',/(?:invalid|unexpected|convert)[^.\n]{0,80}(?:identifier|integer|request.?id)/i],
      ['http-400',/\b400\b|bad request/i],['http-404',/\b404\b|not found/i],['http-405',/\b405\b|method not allowed/i],
      ['http-500',/\b500\b|internal server error/i],['agent-card',/agent.?card/i],['unsupported-protocol',/unsupported.*(?:protocol|version)/i]
    ].filter(([,pattern])=>pattern.test(message)).map(([signal])=>signal):[];
    return { StageKey: row.StageKey, Status: row.Status, ...(category ? {diagnosticCategory:category} : {}),
      ...(diagnosticSignals.length?{diagnosticSignals}:{}),
      ...(typeof row.Errorcode === 'string' && /^OS-[A-Z0-9]{2,12}-\d{3,8}$/.test(row.Errorcode) ? { Errorcode: row.Errorcode } : {}) };
  }) } } };
}
