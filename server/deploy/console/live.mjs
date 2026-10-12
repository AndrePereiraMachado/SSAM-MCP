// Live state of the running server from server.log events (DESIGN 3.3): the server process, open MCP sessions, agent
// channels, sessions closed today and per-token last activity, plus the server events of the event ring (4.4). Events are
// applied once, in file order; the state goes into the checkpoint, so a restart resumes it instead of replaying the logs.
// `listening` resets sessions and agents: after a cold start the result is the state of the running process even when its
// `listening` line already sits in a rotated .gz. Agents seen by an earlier process stay known (disconnected) for the
// license view, so only tokens never seen in the retained logs show "sem registro".
import { inc } from './keys.mjs';
import { createMinutes } from './recent.mjs';
import { AGENT_DERIVED, agentReason, cap, eventText } from './texts.mjs';

const TOKEN = /^tok_[0-9a-f]{12}$/;
const AGENT_OTHER = new Set(['agent-blob-mismatch', 'agent-unknown-message', 'agent-unknown-id', 'agent-route-refused', 'agent-transfers-expired']);

const machineOf = m => m && typeof m === 'object' ? { name: cap(m.name ?? null, 64), user: cap(m.user ?? null, 64) } : null;
export function o11Of(value) {
  let v = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return { version: cap(v.studioVersion ?? null, 32), port: Number.isFinite(v.port) ? v.port : null, pid: Number.isFinite(v.pid) ? v.pid : null };
}
const packOf = p => p && typeof p === 'object'
  ? { id: cap(p.id ?? null, 64), odcBridge: cap(p.odcBridge ?? null, 32), o11BuiltFor: cap(p.o11BuiltFor ?? null, 32) } : null;

export function createLive({ tz, now = Date.now, nameOf = () => null, emit = () => {}, usage = null }) {
  let server = null;
  let sessions = new Map();
  let agents = new Map();
  let previous = new Map();       // token -> agent of an earlier server process (disconnected)
  const minutes = new Map();      // token -> per-minute agent calls (last hour)
  let closedToday = { day: null, counts: {} };
  let lastActivity = {};
  let logNames = {};
  let serverErrors = [];          // request-failed / audit-failed of the last hour
  let tokensUnreadableAt = null;
  let lastAgentEvent = {};        // token -> last agent event other than agent-call (derived close reasons)

  const customerOf = token => (token && (nameOf(token) ?? logNames[token])) || null;
  const who = token => customerOf(token) ?? token ?? '?';
  function touch(token, at, tool, kind) {
    if (!token) return;
    const current = lastActivity[token];
    if (!current || current.at < at) lastActivity[token] = { at, tool: tool ?? null, kind };
  }
  const event = (e, token, level, group, text, code = null) => emit({ time: e.time, level, group, token, customer: customerOf(token), text, code });
  function agentOf(token) {
    let a = agents.get(token);
    if (!a) {
      a = { token, state: 'disconnected', since: null, closedAt: null, closedReason: null, version: null, ip: null, machine: null,
        o11: null, pack: null, lastSignalAt: null, stream: false, lastCode: null };
      agents.set(token, a);
      previous.delete(token);
    }
    return a;
  }
  const minutesOf = token => { let m = minutes.get(token); if (!m) { m = createMinutes(); minutes.set(token, m); } return m; };
  function rollDay() {
    const today = tz.day(now());
    if (closedToday.day !== today) closedToday = { day: today, counts: {} };
    return today;
  }

  function apply(e) {
    const token = typeof e.token === 'string' && TOKEN.test(e.token) ? e.token : null;
    switch (e.event) {
      case 'listening':
        for (const a of agents.values()) {
          previous.set(a.token, { ...a, state: 'disconnected', stream: false, closedAt: a.closedAt ?? e.time,
            closedReason: a.state === 'connected' ? agentReason('server-stop') : a.closedReason });
        }
        sessions = new Map();
        agents = new Map();
        lastAgentEvent = {};
        server = { since: e.time, pid: Number.isFinite(e.pid) ? e.pid : null, mode: cap(e.mode ?? null, 20), url: cap(e.url ?? null, 200),
          ratePerMinute: Number.isFinite(e.ratePerMinute) ? e.ratePerMinute : null,
          maxSessionsPerToken: Number.isFinite(e.maxSessionsPerToken) ? e.maxSessionsPerToken : null,
          publicHosts: Array.isArray(e.publicHosts) ? e.publicHosts.slice(0, 5).map(h => cap(h, 120)) : [] };
        event(e, null, 'info', 'servidor', eventText.listening(e));
        return;
      case 'session-opened': {
        if (!token || typeof e.session !== 'string') return;
        if (e.customer) logNames[token] = cap(e.customer, 64);
        sessions.set(e.session.slice(0, 64), { session: e.session.slice(0, 64), token, ip: cap(e.ip ?? null, 64), ua: cap(e.ua ?? null, 120),
          client: cap(e.client ?? null, 80), openedAt: e.time, lastAt: e.time, calls: 0, lastTool: null, bytes: 0 });
        touch(token, e.time, null, 'session');
        usage?.addSessionOpened(token, e.time);
        event(e, token, 'info', 'sessao', eventText.sessionOpened(who(token), e));
        return;
      }
      case 'mcp-response-flushed': {
        const s = typeof e.session === 'string' ? sessions.get(e.session.slice(0, 64)) : null;
        const tools = Array.isArray(e.tools) ? e.tools.map(t => cap(t, 64)) : [];
        if (s) {
          s.calls += tools.length;
          s.lastTool = tools.length ? cap(tools.join(', '), 120) : s.lastTool;
          s.lastAt = e.time;
          s.bytes += Number.isFinite(e.bytes) ? e.bytes : 0;
        }
        touch(token, e.time, tools.length ? tools[tools.length - 1] : null, 'call');
        return;
      }
      case 'session-closed': {
        if (typeof e.session === 'string') sessions.delete(e.session.slice(0, 64));
        const reason = cap(e.reason ?? 'desconhecido', 40);
        if (tz.day(e.time) === rollDay()) inc(closedToday.counts, reason);     // a reason is data: own-property map (keys.mjs)
        event(e, token, 'info', 'sessao', eventText.sessionClosed(who(token), e));
        return;
      }
      case 'tokens-unreadable':
        tokensUnreadableAt = e.time;
        event(e, null, 'error', 'servidor', eventText.tokensUnreadable());
        return;
      case 'request-failed':
      case 'audit-failed':
        serverErrors.push({ time: e.time, event: e.event, error: cap(e.error ?? null, 64) });
        serverErrors = serverErrors.filter(x => Date.parse(x.time) > Date.parse(e.time) - 3600000).slice(-200);
        event(e, null, 'error', 'servidor', eventText.serverError(e), cap(e.error ?? null, 64));
        return;
      case 'hosted-context-closed':
        event(e, token, 'info', 'servidor', eventText.contextClosed(who(token), e));
        return;
      case 'quality-failed':
        // a quality record the server could not write (DESIGN-QUALIDADE 2.1, 4.1); the answer and the audit were not touched
        event(e, null, 'warning', 'servidor', eventText.qualityFailed(e), cap(e.error ?? null, 40));
        return;
      default:
        if (typeof e.event === 'string' && e.event.startsWith('agent-') && token) applyAgent(e, token);
    }
  }

  function applyAgent(e, token) {
    const before = lastAgentEvent[token];
    if (e.event !== 'agent-call') lastAgentEvent[token] = e.event;
    touch(token, e.time, null, 'agent');
    const c = who(token);
    switch (e.event) {
      case 'agent-connected':
      case 'agent-resumed': {
        const a = agentOf(token);
        const keep = e.event === 'agent-resumed' && a.since;
        a.state = 'connected';
        a.since = keep ? a.since : e.time;
        a.closedAt = null; a.closedReason = null;
        a.version = cap(e.agent ?? null, 32); a.ip = cap(e.ip ?? null, 64); a.machine = machineOf(e.machine);
        a.o11 = o11Of(e.o11); a.pack = packOf(e.pack); a.lastSignalAt = e.time;
        event(e, token, 'info', 'agente', e.event === 'agent-connected' ? eventText.agentConnected(c, e) : eventText.agentResumed(c));
        return;
      }
      case 'agent-stream-opened': { const a = agentOf(token); a.stream = true; a.lastSignalAt = e.time; return; }
      case 'agent-channel-closed': {
        const a = agentOf(token);
        const reason = before === 'agent-dead' ? AGENT_DERIVED.dead : before === 'agent-call-unaccepted' ? AGENT_DERIVED.unaccepted : agentReason(e.reason);
        a.state = 'disconnected'; a.stream = false; a.closedAt = e.time; a.closedReason = reason;
        event(e, token, e.reason === 'protocol-error' ? 'warning' : 'info', 'agente', eventText.agentClosed(c, reason));
        return;
      }
      case 'agent-call': {
        const a = agentOf(token);
        const ok = e.ok !== false;
        const code = ok ? null : cap(e.code ?? 'AGENT_ERROR', 64);
        minutesOf(token).add(e.time, ok, code, cap(e.kind ?? null, 40));
        a.lastSignalAt = e.time;
        if (code) a.lastCode = code;
        usage?.addAgentCall(token, e.time, ok, code);
        if (!ok) event(e, token, 'warning', 'agente', eventText.agentCallFailed(c, e), code);
        return;
      }
      case 'agent-dead': event(e, token, 'warning', 'agente', eventText.agentDead(c)); return;
      case 'agent-replaced': event(e, token, 'warning', 'agente', eventText.agentReplaced(c)); return;
      case 'agent-call-unaccepted': event(e, token, 'warning', 'agente', eventText.agentUnaccepted(c, e)); return;
      case 'agent-machine-pinned': event(e, token, 'info', 'agente', eventText.machinePinned(c, machineOf(e.machine))); return;
      case 'agent-machine-changed':
        if (e.customer && !logNames[token]) logNames[token] = cap(e.customer, 64);
        event(e, token, 'error', 'agente', eventText.machineChanged(who(token), machineOf(e.machine)));
        return;
      default:
        if (AGENT_OTHER.has(e.event)) event(e, token, 'warning', 'agente', eventText.agentOther(c, e));
    }
  }

  // An audit line is activity too (3.3 lastActivity); its customer field names a token missing from the store.
  const noteCall = (token, at, tool, customer = null) => { touch(token, at, tool, 'call'); if (customer && !logNames[token]) logNames[token] = cap(customer, 64); };

  return {
    apply, noteCall, customerOf,
    get server() { return server; },
    get sessions() { return sessions; },
    get agents() { return agents; },
    agentKnown: token => agents.get(token) ?? previous.get(token) ?? null,
    get lastActivity() { return lastActivity; },
    get logNames() { return logNames; },
    serverErrors: () => { const floor = now() - 3600000; return serverErrors.filter(x => Date.parse(x.time) > floor); },
    get tokensUnreadableAt() { return tokensUnreadableAt; },
    closedToday: () => { rollDay(); return closedToday.counts; },
    sessionsOf: token => { let n = 0; for (const s of sessions.values()) if (s.token === token) n++; return n; },
    // Agent calls of a token in the last `minutes` minutes: {calls, failures, topCode}.
    agentWindow: (token, mins) => minutes.get(token)?.window(now(), mins) ?? { calls: 0, failures: 0, topCode: null, topTool: null },
    agentTokens: () => [...minutes.keys()],
    toJSON: () => ({ server, sessions: [...sessions.values()], agents: [...agents.values()], previous: [...previous.values()], closedToday,
      lastActivity, logNames, serverErrors, tokensUnreadableAt, lastAgentEvent,
      minutes: Object.fromEntries([...minutes].map(([t, m]) => [t, m.toJSON()])) }),
    restore(saved) {
      if (!saved) return;
      server = saved.server ?? null;
      sessions = new Map((saved.sessions ?? []).map(s => [s.session, s]));
      agents = new Map((saved.agents ?? []).map(a => [a.token, a]));
      previous = new Map((saved.previous ?? []).map(a => [a.token, a]));
      closedToday = saved.closedToday ?? { day: null, counts: {} };
      lastActivity = saved.lastActivity ?? {};
      logNames = saved.logNames ?? {};
      serverErrors = saved.serverErrors ?? [];
      tokensUnreadableAt = saved.tokensUnreadableAt ?? null;
      lastAgentEvent = saved.lastAgentEvent ?? {};
      minutes.clear();
      for (const [t, b] of Object.entries(saved.minutes ?? {})) { const m = createMinutes(); m.restore(b); minutes.set(t, m); }
    },
  };
}
