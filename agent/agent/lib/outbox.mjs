// The agent's outbox (docs/FASE2-AGENTE.md 3.4). Every upstream message of a call (accepted, result) is queued; one POST
// takes a batch and only a 204 confirms it. Without the 204 the batch goes back to the front of the queue and is sent
// again (after a reconnection). Each call id is kept as running | done until the POST that carried its result is
// confirmed, so a call the server writes again on a resumed stream never runs twice: running queues `accepted` again,
// done already has its result queued. The server never resends an id once its result was confirmed. A pong never comes
// here: it goes in a POST of its own (channel.mjs, C03), so a stuck batch never holds it.
export function createOutbox() {
  const queue = [];
  const calls = new Map(); // id -> 'running' | 'done'
  let inflight = null;

  const queueAccepted = id => { if (!queue.some(m => m.t === 'accepted' && m.id === id)) queue.push({ t: 'accepted', id }); };

  return {
    push(message) { queue.push(message); },
    // A call arrived: 'new' (run it), 'running' (accepted queued again) or 'done' (result already queued).
    receive(id) {
      const state = calls.get(id);
      if (state === 'done') return 'done';
      queueAccepted(id);
      if (state === 'running') return 'running';
      calls.set(id, 'running');
      return 'new';
    },
    finish(id, result) { calls.set(id, 'done'); queue.push(result); },
    // The next batch (serialized size at most maxBytes, at least one message), or null while a batch is in flight.
    take(maxBytes = 1048576) {
      if (inflight || queue.length === 0) return null;
      let size = 16; let count = 0;
      while (count < queue.length) {
        const next = Buffer.byteLength(JSON.stringify(queue[count])) + 1;
        if (count > 0 && size + next > maxBytes) break;
        size += next; count++;
      }
      inflight = queue.splice(0, count);
      return inflight;
    },
    // The POST of the in-flight batch got its 204: results in it are confirmed and their ids forgotten.
    ack() {
      for (const message of inflight ?? []) if (message.t === 'result') calls.delete(message.id);
      inflight = null;
    },
    // The POST failed: the batch goes back to the front, in order.
    nack() { if (inflight) queue.unshift(...inflight); inflight = null; },
    // A single message the server refused as too large (413) is dropped; the server's deadline covers it.
    drop() { for (const message of inflight ?? []) if (message.t === 'result') calls.delete(message.id); inflight = null; },
    busy: () => inflight !== null,
    get queued() { return queue.length; },
    get tracked() { return calls.size; },
    state: id => calls.get(id) ?? null,
  };
}
