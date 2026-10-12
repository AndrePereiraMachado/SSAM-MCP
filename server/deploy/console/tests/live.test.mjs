// DESIGN 3.3, 4.4 and 7.2 "live": every session close reason, the agent resume ordering (channel-closed ended before
// agent-resumed keeps the agent connected), clean shutdown, dead, unaccepted, rotated, revoked, the o11 JSON string,
// unknown events ignored, `listening` resets and per-token last activity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLive } from '../live.mjs';
import { createTz } from '../tz.mjs';

const TOK = 'tok_0000000a1fa0';
function setup(nowIso = '2026-10-12T15:00:00Z') {
  const events = [];
  const tz = createTz('America/Sao_Paulo');
  const names = { [TOK]: 'Cliente Alfa' };
  const live = createLive({ tz, now: () => Date.parse(nowIso), nameOf: t => names[t] ?? null, emit: e => events.push(e) });
  let s = 0;
  const at = () => new Date(Date.parse('2026-10-12T14:00:00Z') + (s++) * 1000).toISOString();
  const apply = e => live.apply({ time: at(), ...e });
  return { live, events, apply, texts: () => events.map(e => e.text) };
}

test('every session close reason is counted today and worded in pt-BR', () => {
  const { live, apply, texts } = setup();
  apply({ event: 'listening', pid: 7, mode: 'hosted', publicHosts: ['ssam.example.com'] });
  const reasons = { 'client-delete': 'o cliente encerrou', 'transport-closed': 'a conexão caiu', idle: 'inativa por 60 min',
    replaced: 'substituída (limite de 8 sessões)', 'token-revoked': 'licença revogada', 'token-expired': 'licença vencida',
    'token-unknown': 'licença desconhecida', 'server-stop': 'servidor parou' };
  let i = 0;
  for (const reason of Object.keys(reasons)) {
    apply({ event: 'session-opened', session: `s-${i}`, token: TOK, customer: 'Cliente Alfa', ip: '192.0.2.1', client: null });
    apply({ event: 'session-closed', session: `s-${i}`, token: TOK, reason });
    i++;
  }
  assert.equal(live.sessions.size, 0);
  assert.deepEqual(live.closedToday(), Object.fromEntries(Object.keys(reasons).map(r => [r, 1])));
  for (const [, word] of Object.entries(reasons)) assert.ok(texts().includes(`Cliente Alfa: sessão MCP encerrada (${word}).`), word);
  assert.ok(texts().includes('Cliente Alfa abriu sessão MCP (cliente sem nome, IP 192.0.2.1).'));
});

test('sessions: calls, last tool, bytes; listening resets sessions and agents', () => {
  const { live, apply } = setup();
  apply({ event: 'listening', pid: 7, mode: 'hosted' });
  apply({ event: 'session-opened', session: 'abc', token: TOK, ip: '192.0.2.1', ua: 'ua', client: 'claude-code 2.1.281' });
  apply({ event: 'mcp-response-flushed', session: 'abc', token: TOK, tools: ['studio_inspect', 'odc_read'], bytes: 100, ms: 5 });
  apply({ event: 'mcp-response-flushed', session: 'abc', token: TOK, tools: [], bytes: 10, ms: 5 });
  const s = live.sessions.get('abc');
  assert.equal(s.calls, 2);
  assert.equal(s.lastTool, 'studio_inspect, odc_read');
  assert.equal(s.bytes, 110);
  apply({ event: 'agent-connected', token: TOK, agent: '0.2.0', ip: '192.0.2.1', machine: { id: 'm', name: 'PC-TESTE-01', user: 'teste' } });
  apply({ event: 'listening', pid: 8, mode: 'hosted' });
  assert.equal(live.sessions.size, 0);
  assert.equal(live.agents.size, 0);
  assert.equal(live.server.pid, 8);
  const known = live.agentKnown(TOK);
  assert.equal(known.state, 'disconnected');
  assert.equal(known.closedReason, 'servidor parou');
  assert.equal(live.lastActivity[TOK].kind, 'agent');
});

test('agent resume ordering: channel-closed ended then agent-resumed keeps it connected with the first since', () => {
  const { live, apply, texts } = setup();
  apply({ event: 'listening', pid: 7 });
  apply({ event: 'agent-connected', token: TOK, agent: '0.2.0', ip: '192.0.2.1', machine: null, o11: null });
  const since = live.agents.get(TOK).since;
  apply({ event: 'agent-stream-opened', token: TOK });
  apply({ event: 'agent-channel-closed', token: TOK, reason: 'ended' });
  apply({ event: 'agent-resumed', token: TOK, agent: '0.2.0', ip: '192.0.2.1', machine: null, o11: null });
  const a = live.agents.get(TOK);
  assert.equal(a.state, 'connected');
  assert.equal(a.since, since);
  assert.equal(a.closedReason, null);
  assert.ok(texts().includes('Agente de Cliente Alfa retomou o canal.'));
});

test('agent close reasons: clean shutdown, dead, unaccepted, rotated, revoked, protocol error', () => {
  const cases = [
    [[], 'ended', 'canal encerrado'],
    [[{ event: 'agent-dead' }], 'ended', 'sem sinal'],
    [[{ event: 'agent-call-unaccepted', kind: 'odc_read', afterMs: 15000 }], 'ended', 'chamada não aceita'],
    [[{ event: 'agent-call-unaccepted', kind: 'odc_read' }, { event: 'agent-call', kind: 'odc_read', ok: false, code: 'AGENT_DISCONNECTED', ms: 1 }], 'ended', 'chamada não aceita'],
    [[], 'rotated', 'credencial trocada'],
    [[], 'revoked', 'licença revogada'],
    [[], 'expired', 'licença vencida'],
    [[], 'replaced', 'outra instância assumiu'],
    [[], 'server-stop', 'servidor parou'],
    [[], 'protocol-error', 'erro de protocolo'],
  ];
  for (const [before, reason, word] of cases) {
    const { live, apply, events } = setup();
    apply({ event: 'listening', pid: 7 });
    apply({ event: 'agent-connected', token: TOK, agent: '0.2.0', ip: '192.0.2.1' });
    for (const e of before) apply({ token: TOK, ...e });
    apply({ event: 'agent-channel-closed', token: TOK, reason });
    const a = live.agents.get(TOK);
    assert.equal(a.state, 'disconnected', word);
    assert.equal(a.closedReason, word);
    const last = events[events.length - 1];
    assert.equal(last.text, `Agente de Cliente Alfa desconectou (${word}).`);
    assert.equal(last.level, reason === 'protocol-error' ? 'warning' : 'info');
  }
  const { texts, apply } = setup();
  apply({ event: 'agent-dead', token: TOK });
  apply({ event: 'agent-call-unaccepted', token: TOK, kind: 'odc_read' });
  apply({ event: 'agent-replaced', token: TOK });
  apply({ event: 'agent-machine-changed', token: TOK, customer: 'Cliente Alfa', first: {}, machine: { id: 'x', name: 'PC-TESTE-02', user: 'teste' }, ip: '203.0.113.5' });
  apply({ event: 'agent-route-refused', token: TOK, route: 'files', status: 404, code: 'CHANNEL_UNKNOWN' });
  apply({ event: 'agent-transfers-expired', token: TOK, count: 3 });
  apply({ event: 'agent-unknown-message', token: TOK });
  assert.deepEqual(texts(), ['Agente de Cliente Alfa ficou 45 s sem sinal.', 'O agente de Cliente Alfa não aceitou odc_read em 15 s.',
    'Outra instância do agente de Cliente Alfa assumiu o canal.', 'Credencial do agente de Cliente Alfa usada em outra máquina: PC-TESTE-02 (teste).',
    'Agente de Cliente Alfa: agent-route-refused (files).', 'Agente de Cliente Alfa: agent-transfers-expired (3).', 'Agente de Cliente Alfa: agent-unknown-message.']);
});

test('o11 is parsed from its JSON string; bad values give null; pack is read when present', () => {
  const { live, apply } = setup();
  apply({ event: 'agent-connected', token: TOK, agent: '0.2.0', o11: JSON.stringify({ pid: 4321, startedUtc: 'x', port: 50123, studioVersion: '11.55.91' }),
    pack: { id: 'pack-1', odcBridge: 'v48', o11BuiltFor: '11.55.91', o11Hook: 'h1' } });
  assert.deepEqual(live.agents.get(TOK).o11, { version: '11.55.91', port: 50123, pid: 4321 });
  assert.deepEqual(live.agents.get(TOK).pack, { id: 'pack-1', odcBridge: 'v48', o11BuiltFor: '11.55.91' });
  apply({ event: 'agent-connected', token: TOK, agent: '0.2.0', o11: '{not json' });
  assert.equal(live.agents.get(TOK).o11, null);
  assert.equal(live.agents.get(TOK).pack, null);
});

test('agent calls: per-minute window of the last hour, failures and last code', () => {
  const { live, apply, texts } = setup('2026-10-12T14:01:00Z');
  for (let i = 0; i < 12; i++) apply({ event: 'agent-call', token: TOK, kind: 'odc_read', ms: 5, ok: i % 3 !== 0, ...(i % 3 === 0 ? { code: 'AGENT_TIMEOUT' } : {}) });
  const w = live.agentWindow(TOK, 60);
  assert.equal(w.calls, 12);
  assert.equal(w.failures, 4);
  assert.equal(w.topCode, 'AGENT_TIMEOUT');
  assert.equal(live.agents.get(TOK).lastCode, 'AGENT_TIMEOUT');
  assert.equal(texts().filter(t => t === 'Chamada odc_read ao agente de Cliente Alfa falhou: AGENT_TIMEOUT.').length, 4);
});

test('unknown events and malformed records are ignored', () => {
  const { live, apply, events } = setup();
  apply({ event: 'relay-refused', token: TOK });
  apply({ event: 'something-new', token: TOK, x: 1 });
  apply({ event: 'session-opened', token: 'not-a-token', session: 'x' });
  apply({ event: 'session-opened', token: TOK });
  apply({ event: 'agent-connected', token: 'tok_bad' });
  apply({ event: 'mcp-response-flushed', session: 'unknown', token: TOK, tools: ['a'] });
  assert.equal(events.length, 0);
  assert.equal(live.sessions.size, 0);
  assert.equal(live.agents.size, 0);
  assert.equal(live.lastActivity[TOK].kind, 'call');
});

test('server errors of the last hour, tokens-unreadable, hosted context and the checkpoint round trip', () => {
  const { live, apply, texts } = setup('2026-10-12T14:30:00Z');
  apply({ event: 'request-failed', error: 'EPIPE' });
  apply({ event: 'audit-failed', error: 'ENOSPC' });
  apply({ event: 'tokens-unreadable' });
  apply({ event: 'hosted-context-closed', token: TOK, reason: 'revoked' });
  assert.equal(live.serverErrors().length, 2);
  assert.ok(live.tokensUnreadableAt);
  assert.deepEqual(texts(), ['Erro interno do servidor (request-failed: EPIPE).', 'Erro interno do servidor (audit-failed: ENOSPC).',
    'O servidor não conseguiu ler o arquivo de licenças.', 'Contexto hospedado de Cliente Alfa fechado (licença revogada).']);
  apply({ event: 'agent-call', token: TOK, kind: 'k', ok: false, code: 'X', ms: 1 });
  const copy = setup('2026-10-12T14:30:00Z');
  copy.live.restore(JSON.parse(JSON.stringify(live.toJSON())));
  assert.deepEqual(copy.live.toJSON(), JSON.parse(JSON.stringify(live.toJSON())));
  assert.equal(copy.live.agentWindow(TOK, 60).failures, 1);
});

test('close reasons and agent codes named __proto__ or constructor are plain keys and plain words', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  try { closeReasonsAsKeys(before); } finally {
    for (const k of Object.getOwnPropertyNames(Object.prototype)) if (!before.includes(k)) delete Object.prototype[k];
  }
});
function closeReasonsAsKeys(before) {
  const { live, apply, texts } = setup('2026-10-12T14:01:00Z');
  apply({ event: 'listening', pid: 7, mode: 'hosted' });
  for (const [i, reason] of ['__proto__', 'constructor', 'constructor', 'toString'].entries()) {
    apply({ event: 'session-opened', session: `p-${i}`, token: TOK, ip: '192.0.2.1' });
    apply({ event: 'session-closed', session: `p-${i}`, token: TOK, reason });
  }
  apply({ event: 'agent-call', token: TOK, kind: 'constructor', ok: false, code: '__proto__' });
  const counts = live.closedToday();
  assert.deepEqual(Object.entries(counts).sort(), [['__proto__', 1], ['constructor', 2], ['toString', 1]]);
  assert.ok(texts().includes('Cliente Alfa: sessão MCP encerrada (constructor).'));
  assert.ok(texts().includes('Cliente Alfa: sessão MCP encerrada (__proto__).'));
  assert.deepEqual(live.agentWindow(TOK, 15), { calls: 1, failures: 1, topCode: '__proto__', topTool: 'constructor' });
  const again = setup('2026-10-12T14:01:00Z').live;
  again.restore(JSON.parse(JSON.stringify(live.toJSON())));
  assert.deepEqual(Object.entries(again.closedToday()).sort(), [['__proto__', 1], ['constructor', 2], ['toString', 1]]);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
}
