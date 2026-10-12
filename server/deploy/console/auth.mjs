// Access key of the console (DESIGN 2.2 step 4, 2.3): 32 random bytes in base64url, made at every start and at every
// POST /api/key/rotate, written to /state/access.key (0600) for painel-ssam.ps1. A presented key is compared in constant
// time over SHA-256 digests. Ten wrong keys within 60 s lock every request except /healthz for 60 s.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const sha256 = text => createHash('sha256').update(String(text), 'utf8').digest();
export const KEY_FILE = 'access.key';
const WINDOW_MS = 60000;
const MAX_BAD = 10;

export function createAuth({ state, now = Date.now }) {
  let digest = null;
  let bad = [];
  let lockedUntil = 0;

  function rotate() {
    const key = randomBytes(32).toString('base64url');
    state.writeText(KEY_FILE, key, 0o600);
    digest = sha256(key);
    return key;
  }
  // 'ok' | 'missing' | 'invalid'
  function check(presented) {
    if (typeof presented !== 'string' || presented === '') return 'missing';
    if (!digest) return 'invalid';
    return timingSafeEqual(sha256(presented), digest) ? 'ok' : 'invalid';
  }
  function noteBad() {
    const t = now();
    bad = bad.filter(at => at > t - WINDOW_MS);
    bad.push(t);
    if (bad.length >= MAX_BAD) { lockedUntil = t + WINDOW_MS; bad = []; }
  }
  // Seconds left in the lockout, 0 when open.
  const lockedFor = () => { const left = lockedUntil - now(); return left > 0 ? Math.ceil(left / 1000) : 0; };
  return { rotate, check, noteBad, lockedFor };
}
