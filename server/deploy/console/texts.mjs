// pt-BR texts of the owner console (DESIGN 4.1 errors, 4.4 event texts, 6.6 number formats). Every string the owner sees
// that the API builds comes from here or from alerts.mjs. Values that a customer controls (MCP client, user agent,
// machine name and user, customer names, warm notes) are capped with cap() before they reach a text.

const nf = (min, max) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max });
const NF0 = nf(0, 0), NF1 = nf(1, 1), NF01 = nf(0, 1), NF2 = nf(2, 2);
const pad2 = n => String(n).padStart(2, '0');

// A customer-controlled value as text of at most n characters (control characters removed).
export const cap = (value, n) => value == null ? null : String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);

export const fmt = {
  int: n => NF0.format(n),
  dec2: n => NF2.format(n),
  // Percent as in 6.6: integer, one decimal below 1. Floor, so a value shown at a threshold has really reached it.
  pct: v => v == null || Number.isNaN(v) ? '—' : v > 0 && v < 1 ? NF1.format(Math.floor(v * 10) / 10) : NF0.format(Math.floor(v)),
  duration(ms) {
    ms = Math.max(0, Math.round(Number(ms) || 0));
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60000) return `${NF1.format(Math.floor(ms / 100) / 10)} s`;
    const s = Math.floor(ms / 1000);
    if (s < 3600) return `${Math.floor(s / 60)} min ${pad2(s % 60)} s`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ${pad2(Math.floor((s % 3600) / 60))} min`;
    return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
  },
  bytes(n) {
    n = Math.max(0, Number(n) || 0);
    if (n < 1024) return `${Math.round(n)} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? NF01.format(Math.floor(v * 10) / 10) : NF0.format(Math.floor(v))} ${units[i]}`;
  },
  lanes: lanes => ['odc', 'o11'].filter(l => Array.isArray(lanes) && lanes.includes(l)).map(l => l.toUpperCase()).join(', ') || '—',
  plural: (n, one, many) => `${NF0.format(n)} ${n === 1 ? one : many}`,
};

// ---- API errors (4.1)
const REFUSED = 'Acesso recusado: o painel só atende pelo túnel em localhost.';
export const ERRORS = {
  BAD_JSON: [400, 'Corpo da requisição não é JSON válido.'],
  INVALID_FIELD: [400, 'Campo inválido: {campo} ({regra}).'],
  CONFIRM_MISMATCH: [400, 'A confirmação não confere: digite exatamente o nome do cliente.'],
  NO_CHANGE: [400, 'Nada mudou: as faixas escolhidas são as atuais.'],
  KEY_REQUIRED: [401, 'Falta a chave de acesso. Abra o painel pelo painel-ssam.ps1.'],
  KEY_INVALID: [401, 'Chave de acesso inválida ou trocada. Rode painel-ssam.ps1 de novo.'],
  HOST_REFUSED: [403, REFUSED],
  ORIGIN_REFUSED: [403, REFUSED],
  FETCH_SITE_REFUSED: [403, REFUSED],
  NOT_FOUND: [404, 'Não encontrado.'],
  UNKNOWN_TOKEN: [404, 'Licença {id} não existe.'],
  METHOD_NOT_ALLOWED: [405, 'Método não permitido.'],
  STALE: [409, 'A licença mudou desde que a página foi carregada. Recarregue e confira.'],
  TOKEN_REVOKED: [409, 'A licença está revogada; emita uma nova.'],
  ALREADY_REVOKED: [409, 'A licença já estava revogada.'],
  TOKEN_NOT_ACTIVE: [409, 'Só uma licença ativa pode trocar a credencial do agente.'],
  NO_EXPIRY: [409, 'Licença sem validade: não há o que renovar.'],
  EXPIRY_TOO_FAR: [409, 'A validade passaria de 3650 dias a partir de hoje.'],
  BODY_TOO_LARGE: [413, 'Requisição grande demais.'],
  CONTENT_TYPE: [415, 'Use Content-Type: application/json.'],
  RATE_LIMITED: [429, 'Muitas ações seguidas. Tente de novo em {n} s.'],
  NOT_SUPPORTED: [501, 'Indisponível nesta imagem do servidor (chega com o 24º envio).'],
  STORE_UNREADABLE: [503, 'O arquivo de licenças não pode ser lido agora ({código}).'],
  STORE_WRITE_FAILED: [500, 'Não foi possível gravar a licença ({código}). Nada foi alterado.'],
  INTERNAL: [500, 'Erro interno do painel ({código}).'],
};
export const fill = (template, vars = {}) => template.replace(/\{([^}]+)\}/g, (m, k) => vars[k] != null ? String(vars[k]) : m);

export class ApiError extends Error {
  constructor(code, vars = {}, { field = null, retryAfter = null } = {}) {
    const known = Object.hasOwn(ERRORS, code) ? code : 'INTERNAL';
    const [status, template] = ERRORS[known];
    super(fill(template, known === code ? vars : { código: code }));
    this.status = status;
    this.apiCode = known;
    this.field = field;
    this.retryAfter = retryAfter;
  }
}
export const invalidField = (campo, regra) => new ApiError('INVALID_FIELD', { campo, regra }, { field: campo });

// ---- reasons (4.4)
export const SESSION_CLOSE = {
  'client-delete': 'o cliente encerrou', 'transport-closed': 'a conexão caiu', idle: 'inativa por 60 min',
  replaced: 'substituída (limite de 8 sessões)', 'token-revoked': 'licença revogada', 'token-expired': 'licença vencida',
  'token-unknown': 'licença desconhecida', 'server-stop': 'servidor parou',
};
export const AGENT_CLOSE = {
  replaced: 'outra instância assumiu', rotated: 'credencial trocada', revoked: 'licença revogada', expired: 'licença vencida',
  'server-stop': 'servidor parou', 'protocol-error': 'erro de protocolo', ended: 'canal encerrado',
};
export const AGENT_DERIVED = { dead: 'sem sinal', unaccepted: 'chamada não aceita' };
const CONTEXT_CLOSE = { revoked: 'licença revogada', expired: 'licença vencida', 'server-stop': 'servidor parou' };
export const sessionReason = r => SESSION_CLOSE[r] ?? cap(r ?? 'motivo desconhecido', 40);
export const agentReason = r => AGENT_CLOSE[r] ?? cap(r ?? 'motivo desconhecido', 40);

const machineText = m => m && m.name ? `${m.name} (${m.user ?? '?'})` : 'máquina desconhecida';
const OTHER_FIELD = {
  'agent-blob-mismatch': e => e.transfer, 'agent-unknown-message': () => null, 'agent-unknown-id': e => e.type,
  'agent-route-refused': e => e.route, 'agent-transfers-expired': e => e.count,
};

// ---- event texts (4.4); c = customer name (or token id when unknown)
export const eventText = {
  listening: e => `Servidor iniciado (pid ${e.pid ?? '?'}, modo ${cap(e.mode ?? '?', 20)}).`,
  sessionOpened: (c, e) => `${c} abriu sessão MCP (${cap(e.client, 80) || 'cliente sem nome'}, IP ${cap(e.ip ?? '?', 64)}).`,
  sessionClosed: (c, e) => `${c}: sessão MCP encerrada (${sessionReason(e.reason)}).`,
  callOk: (c, tool, ms) => `${c} chamou ${tool}: ok em ${fmt.duration(ms)}.`,
  callFailed: (c, tool, code, ms) => `${c} chamou ${tool}: falhou com ${code} em ${fmt.duration(ms)}.`,
  agentConnected: (c, e) => `Agente de ${c} conectou (versão ${cap(e.agent ?? '?', 32)}, ${machineText(e.machine)}, IP ${cap(e.ip ?? '?', 64)}).`,
  agentResumed: c => `Agente de ${c} retomou o canal.`,
  agentClosed: (c, reason) => `Agente de ${c} desconectou (${reason}).`,
  agentDead: c => `Agente de ${c} ficou 45 s sem sinal.`,
  agentReplaced: c => `Outra instância do agente de ${c} assumiu o canal.`,
  agentCallFailed: (c, e) => `Chamada ${cap(e.kind ?? '?', 40)} ao agente de ${c} falhou: ${cap(e.code ?? 'AGENT_ERROR', 64)}.`,
  agentUnaccepted: (c, e) => `O agente de ${c} não aceitou ${cap(e.kind ?? '?', 40)} em 15 s.`,
  machinePinned: (c, m) => `Máquina registrada para ${c}: ${m?.name ?? '?'} (${m?.user ?? '?'}).`,
  machineChanged: (c, m) => `Credencial do agente de ${c} usada em outra máquina: ${m?.name ?? '?'} (${m?.user ?? '?'}).`,
  agentOther(c, e) {
    const field = OTHER_FIELD[e.event]?.(e);
    return field == null ? `Agente de ${c}: ${e.event}.` : `Agente de ${c}: ${e.event} (${cap(field, 40)}).`;
  },
  tokensUnreadable: () => 'O servidor não conseguiu ler o arquivo de licenças.',
  serverError: e => `Erro interno do servidor (${e.event}: ${cap(e.error ?? '?', 64)}).`,
  contextClosed: (c, e) => `Contexto hospedado de ${c} fechado (${CONTEXT_CLOSE[e.reason] ?? cap(e.reason ?? '?', 40)}).`,
  restarted: service => `${service} reiniciou.`,
  health: (before, after) => `Saúde do ssam-server: ${before} → ${after}.`,
  collectorBack: () => 'Coletor da VPS voltou.',
  collectorStopped: () => 'Coletor da VPS parou.',
  resolved: title => `Resolvido: ${title}`,
  rotatedLost: () => 'Parte do server.log girado não pôde ser lida.',
};

export const HEALTH_WORD = { healthy: 'saudável', unhealthy: 'com falha', starting: 'iniciando' };
export const healthWord = h => HEALTH_WORD[h] ?? (h ? cap(h, 20) : 'sem verificação');
export const DOCKER_STATE = { running: 'rodando', exited: 'parado', restarting: 'reiniciando', paused: 'pausado', created: 'criado', dead: 'morto', removing: 'sendo removido' };
export const dockerState = s => DOCKER_STATE[s] ?? (s ? cap(s, 20) : 'ausente');

// License texts (console action or external change). dmy formats a date as dd/mm/aaaa in the display time zone.
const ACTION_NOUN = { issue: 'Emissão', renew: 'Renovação', lanes: 'Mudança de faixas', 'agent-rotate': 'Troca da credencial do agente', revoke: 'Revogação' };
export function licenseText({ action, customer, result, code, detail = {}, external = false }, dmy) {
  const c = customer ?? '?';
  let text;
  if (result === 'error') text = `${ACTION_NOUN[action] ?? action} de ${c} falhou (${code ?? 'ERRO'}).`;
  else if (action === 'issue') text = `Licença emitida para ${c} (${fmt.lanes(detail.lanes)}, ${detail.expiresAt ? 'até ' + dmy(detail.expiresAt) : 'sem validade'}).`;
  else if (action === 'renew') text = `Validade de ${c} estendida até ${detail.expiresAt ? dmy(detail.expiresAt) : 'sem validade'}.`;
  else if (action === 'lanes') text = `Faixas de ${c}: ${fmt.lanes(detail.previousLanes)} → ${fmt.lanes(detail.lanes)}.`;
  else if (action === 'agent-rotate') text = `Credencial do agente de ${c} trocada.`;
  else if (action === 'revoke') text = `Licença de ${c} revogada.`;
  else text = `${action}: ${c}.`;
  return external ? text.replace(/\.$/, '') + ' (fora do painel).' : text;
}

// Never let a secret-shaped string reach a log line, a state file or the console-audit file.
export const SECRET_PATTERN = /ssam_[A-Za-z0-9_-]{20,}/g;
export const redact = text => String(text).replace(SECRET_PATTERN, 'ssam_[removido]');
