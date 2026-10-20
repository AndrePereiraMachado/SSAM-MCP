// pt-BR words of the console (DESIGN.md 4.4, 6.3, 6.5). One place, so views never spell a status twice.

export const SEVERITY = {
  critical: { word: 'Crítico', level: 'bad', order: 0 },
  warning: { word: 'Atenção', level: 'warn', order: 1 },
  info: { word: 'Info', level: 'info', order: 2 },
};

export const AREA = {
  servidor: 'Servidor', licencas: 'Licenças', uso: 'Uso', agentes: 'Agentes', vps: 'VPS', backup: 'Backup',
  tls: 'TLS', seguranca: 'Segurança', coletor: 'Coletor', painel: 'Painel',
};

export const SUMMARY_AREA = {
  servidor: 'Servidor SSAM', licencas: 'Licenças', uso: 'Uso hoje', agentes: 'Agentes', sessoes: 'Sessões MCP',
  vps: 'VPS', containers: 'Containers', backup: 'Backup', tls: 'Certificado TLS', coletor: 'Coletor',
};

export const SUMMARY_STATE = {
  ok: { word: 'ok', level: 'ok' },
  warning: { word: 'atenção', level: 'warn' },
  critical: { word: 'crítico', level: 'bad' },
  unknown: { word: 'desconhecido', level: 'muted' },
};

export const LICENSE_STATE = {
  active: { word: 'ativa', level: 'ok', order: 0 },
  expired: { word: 'vencida', level: 'warn', order: 1 },
  revoked: { word: 'revogada', level: 'muted', order: 2 },
};

export const EVENT_LEVEL = {
  info: { word: 'Info', level: 'muted' },
  warning: { word: 'Aviso', level: 'warn' },
  error: { word: 'Erro', level: 'bad' },
};

export const EVENT_GROUP = {
  sessao: 'Sessão', agente: 'Agente', chamada: 'Chamada', licenca: 'Licença', servidor: 'Servidor', vps: 'VPS',
  painel: 'Painel',
};

export const SESSION_CLOSE = {
  'client-delete': 'o cliente encerrou',
  'transport-closed': 'a conexão caiu',
  idle: 'inativa por 60 min',
  replaced: 'substituída (limite de 8 sessões)',
  'token-revoked': 'licença revogada',
  'token-expired': 'licença vencida',
  'token-unknown': 'licença desconhecida',
  'server-stop': 'servidor parou',
};

export const AGENT_CLOSE = {
  replaced: 'outra instância assumiu',
  rotated: 'credencial trocada',
  revoked: 'licença revogada',
  expired: 'licença vencida',
  'server-stop': 'servidor parou',
  'protocol-error': 'erro de protocolo',
  ended: 'canal encerrado',
};

export const HISTORY_ACTION = {
  issue: 'Emissão',
  renew: 'Renovação',
  lanes: 'Faixas',
  'agent-rotate': 'Credencial do agente',
  revoke: 'Revogação',
  'key-rotate': 'Chave do painel trocada',
  'alert-ack': 'Alerta silenciado',
  'alert-unack': 'Alerta reativado',
  // the GitHub sign-in (the painel on the Coolify VPS)
  signin: 'Entrada no painel',
  'signin-refused': 'Entrada recusada',
  signout: 'Saída do painel',
  // changes seen outside the console only (actor "externo")
  unrevoke: 'Revogação desfeita',
  removed: 'Licença removida',
  'expiry-shortened': 'Validade encurtada',
  rename: 'Nome do cliente',
};

export const SERVER_WORD = {
  up: { word: 'no ar', level: 'ok' },
  starting: { word: 'iniciando', level: 'warn' },
  down: { word: 'fora do ar', level: 'bad' },
  unknown: { word: 'desconhecido', level: 'muted' },
};

export const WARM_WORD = {
  warm: 'aquecido',
  partial: 'aquecimento parcial',
  warming: 'aquecendo',
  cold: 'não aquecido',
  unknown: 'aquecimento desconhecido',
};

export const HEALTH_WORD = {
  healthy: 'saudável',
  starting: 'iniciando',
  unhealthy: 'com falha',
};

export const CONTAINER_STATE = {
  running: { word: 'rodando', level: 'ok' },
  exited: { word: 'parado', level: 'bad' },
  restarting: { word: 'reiniciando', level: 'warn' },
  paused: { word: 'pausado', level: 'warn' },
  created: { word: 'criado', level: 'muted' },
  dead: { word: 'morto', level: 'bad' },
  removing: { word: 'removendo', level: 'warn' },
};

export const PROCESS_KIND = {
  server: { word: 'servidor', order: 0 },
  'odc-worker': { word: 'worker ODC', order: 1 },
  'o11-worker': { word: 'worker O11', order: 2 },
  builder: { word: 'builder', order: 3 },
  other: { word: 'outro', order: 4 },
};

/** A word of a table by a data key: own entries only (a reason named "constructor" stays as it is). */
export function wordOf(table, key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export function sessionCloseWord(reason) {
  return wordOf(SESSION_CLOSE, reason) || String(reason ?? '—');
}

export function agentCloseWord(reason) {
  if (reason == null) return '—';
  return wordOf(AGENT_CLOSE, reason) || String(reason);
}

export const VIEWS = [
  { id: 'visao', label: 'Visão geral' },
  { id: 'licencas', label: 'Licenças' },
  { id: 'uso', label: 'Uso' },
  { id: 'qualidade', label: 'Qualidade' },
  { id: 'agentes', label: 'Agentes e sessões' },
  { id: 'vps', label: 'VPS' },
  { id: 'eventos', label: 'Eventos' },
  { id: 'historico', label: 'Histórico' },
];

// ---- Qualidade (DESIGN-QUALIDADE 4.5)

/** Phase columns of the quality tables, in the order of the API (Fases da entrega, Para onde vai o tempo). */
export const PHASE_KEYS = ['queue', 'capture', 'compile', 'studio', 'verify', 'publish', 'environment', 'transfer', 'rest'];

export const PHASE_WORD = {
  queue: 'Fila',
  capture: 'Captura',
  compile: 'Compilação',
  studio: 'Studio',
  verify: 'Verificação',
  publish: 'Publicação',
  environment: 'Ambiente',
  transfer: 'Transferência',
  rest: 'Servidor',
};

/** Where the problems of a refusal were found (problems.byPhase). */
export const PROBLEM_PHASE_KEYS = ['preflight', 'base', 'apply', 'verify', 'other'];
export const PROBLEM_PHASE_WORD = {
  preflight: 'preflight',
  base: 'base',
  apply: 'apply',
  verify: 'verificação',
  other: 'outra',
};

/** MCP client families of the session lines. */
export const CLIENT_WORD = {
  'claude-code': 'Claude Code',
  'claude-ai': 'claude.ai',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  other: 'outro',
  unknown: 'sem nome',
};

/** What each normalization rule of the engine did (unknown rule: a dash). */
export const RULE_TEXT = {
  SORT_KEYS_SPLIT: 'ordenação escrita com vírgulas virou lista de chaves',
  LIST_ENTITY_SEGMENT_DROPPED: 'caminho com a entidade numa lista de registros foi encurtado',
  NULL_FUNCTION_REWRITTEN: 'NullDateTime() ou NullTime() trocado pelo nulo do tipo',
  PROPERTY_SET_DROPPED: 'propriedade de documentação sem escrita foi descartada, com aviso',
};
