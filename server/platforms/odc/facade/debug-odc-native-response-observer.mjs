import { createHash } from 'node:crypto';
import { parseWireJson, wireParityLeaves, parityPrints } from './debug-native-output-comparison.mjs';

// Passive, bounded evidence at the SignalR boundary. No payload is retained or
// returned; the original SDK still parses, validates and consumes every frame.
function fingerprint(value) {
  let nodes = 0;
  const ordered = (v, depth = 0) => {
    if (++nodes > 50000 || depth > 64) throw Error('budget');
    if (Array.isArray(v)) return v.map(x => ordered(x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered(v[k], depth + 1)]));
    return v;
  };
  const json = JSON.stringify(ordered(value));
  if (typeof json !== 'string' || json.length > 1048576) throw Error('budget');
  return createHash('sha256').update(json).digest('hex');
}
// parityKey (private, 64 hex): the coordinator's per-run producer-parity key. The
// matched completion also keeps a per-path typed HMAC map of the response, released
// only for the bound invocation (debug-native-output-comparison.mjs parityPrints).
export function createNativeResponseObserver({ parityKey } = {}) {
  if (parityKey !== undefined && (typeof parityKey !== 'string' || !/^[a-f0-9]{64}$/.test(parityKey))) throw new Error('debug_odc_native_response_parity_key_invalid');
  const key = parityKey === undefined ? null : Buffer.from(parityKey, 'hex');
  let pending = '', responseHash, status, count = 0, unavailable, prints, bound;
  return Object.freeze({
    observe(text, invocationId) {
      if (unavailable) return;
      try {
        if (typeof text !== 'string' || pending.length + text.length > 1048576) throw Error('budget');
        pending += text;
        let end;
        while ((end = pending.indexOf('\x1e')) >= 0) {
          const raw = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!raw) continue;
          const frame = JSON.parse(raw);
          if (!invocationId || frame.type !== 3 || frame.invocationId !== invocationId) continue;
          if (++count !== 1) throw Error('duplicate');
          const result = frame.result;
          if (frame.error || !result || typeof result.ResponseBody !== 'string' || !Number.isInteger(result.ResponseStatusCode)) throw Error('shape');
          status = result.ResponseStatusCode; bound = invocationId;
          responseHash = fingerprint(JSON.parse(result.ResponseBody));
          if (key) {
            try { const leaves = wireParityLeaves(parseWireJson(result.ResponseBody)); prints = leaves.complete ? parityPrints(leaves, key) : null; } catch { prints = null; }
            if (!prints?.complete) prints = { complete: false, leaves: [] };
          }
        }
      } catch { unavailable = true; pending = ''; responseHash = undefined; prints = undefined; }
    },
    compare(nativeResult) {
      try {
        if (unavailable || count !== 1 || !responseHash || pending) return { complete: false, reason: 'native-response-not-observed' };
        return { complete: true, nativeStatus: status, invocationMatched: true,
          envelopeRepresentationEqual: responseHash === fingerprint(nativeResult),
          requestOwnershipProved: false };
      } catch { return { complete: false, reason: 'comparison-budget' }; }
    },
    // Private broker channel only: keyed HMACs, never values or paths. Refused for
    // another invocation, a duplicate or unobserved completion, or without a key.
    responsePrints(invocationId) {
      if (!key) return { complete: false, reason: 'parity-key-unavailable' };
      if (unavailable || count !== 1 || !prints || pending) return { complete: false, reason: 'native-response-not-observed' };
      if (typeof invocationId !== 'string' || invocationId !== bound) return { complete: false, reason: 'invocation-mismatch' };
      return { schema: 'ssam-native-response-prints/1', complete: prints.complete, leaves: structuredClone(prints.leaves) };
    },
    dispose() { key?.fill(0); prints = undefined; unavailable = true; }
  });
}
