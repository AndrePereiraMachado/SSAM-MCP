// Event ring of the console (DESIGN 3.2: the last 2000 events live in the checkpoint; 4.2 Event; 4.3 /api/events).
const GROUPS = new Set(['sessao', 'agente', 'chamada', 'licenca', 'servidor', 'vps', 'painel']);
const LEVELS = new Set(['info', 'warning', 'error']);
export const EVENT_GROUPS = GROUPS;
export const EVENT_LEVELS = LEVELS;

export function createEvents({ max = 2000 } = {}) {
  let seq = 0;
  let ring = [];

  function emit({ time, level = 'info', group, token = null, customer = null, text, code = null }) {
    const event = { seq: ++seq, time, level: LEVELS.has(level) ? level : 'info', group: GROUPS.has(group) ? group : 'painel',
      token: token ?? null, customer: customer ?? null, text, code: code ?? null };
    ring.push(event);
    if (ring.length > max) ring.splice(0, ring.length - max);
    return event;
  }
  // after: events with seq > after, ascending, at most limit; lastSeq lets the next poll continue without a gap.
  // Without after: the newest `limit` (before = seq bound for "older" pages), ascending.
  function query({ after = null, before = null, limit = 200, groups = null, levels = null, token = null } = {}) {
    const match = e => (!groups || groups.has(e.group)) && (!levels || levels.has(e.level)) && (!token || e.token === token);
    if (after != null) {
      const out = [];
      for (const e of ring) {
        if (e.seq <= after || !match(e)) continue;
        if (out.length >= limit) return { events: out, lastSeq: out[out.length - 1].seq };
        out.push(e);
      }
      return { events: out, lastSeq: seq };
    }
    const matched = ring.filter(e => (before == null || e.seq < before) && match(e));
    return { events: matched.slice(-limit), lastSeq: seq };
  }
  // After a cold start the replay applied server.log and audit lines file by file, each into its own bounded ring:
  // merge them with this ring in time order, keep the newest `max` and number them again.
  function adopt(...lists) {
    const all = [...ring];
    for (const list of lists) all.push(...list);
    all.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.seq - b.seq));
    // numbers keep growing, so a page polling with after=<lastSeq> receives the merged ring instead of a gap
    const base = seq;
    ring = all.slice(-max).map((e, i) => ({ ...e, seq: base + i + 1 }));
    seq = base + ring.length;
  }
  return {
    emit, query, adopt,
    get ring() { return ring; },
    recent: n => ring.slice(-n).reverse(),
    get lastSeq() { return seq; },
    toJSON: () => ({ seq, ring }),
    restore(saved) { seq = Number(saved?.seq) || 0; ring = Array.isArray(saved?.ring) ? saved.ring.slice(-max) : []; },
    clear() { seq = 0; ring = []; },
  };
}
