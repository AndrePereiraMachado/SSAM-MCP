// CX15: a destructive call takes two calls (destructive-operations.mjs). Tests whose old contract was "delete in one
// call" call previewThenConfirm(run, args, words): the preview (the same call without words), the fake clock past
// CONFIRM_MIN_AGE_MS (no owner answers sooner), then the same call without its selection, with the token and the owner's
// words. run(...argv) for a Service Center argv, run(input) for a tool input. Pass the clock to the code under test
// (runServiceCenter deps.clock, ...) so the confirmation is "later".
import { CONFIRM_MIN_AGE_MS } from '../../destructive-operations.mjs';

export function fakeClock(start = Date.parse('2026-10-15T12:00:00Z')) {
  let t = start;
  const clock = () => t;
  clock.advance = ms => { t += ms; return t; };
  clock.set = value => { t = value; return t; };
  return clock;
}
// The clock of every test file that does not bring its own (node --test runs each file in its own process).
export const clock = fakeClock();

// Flags of a selection (or of the old one-call execution) that never come with a token: dropped from the argv.
const SELECTION_FLAGS = new Set(['target', 'prefix', 'prefix-kind', 'max-deletes', 'application', 'application-key', 'module', 'module-key', 'extension',
  'module-kind', 'plan-only', 'execute', 'words', 'operation-id', 'owner-request']);
const SWITCHES = new Set(['plan-only', 'execute']);
const SELECTION_KEYS = ['applications', 'modules', 'extensions', 'prefix', 'prefixKind', 'maxDeletes', 'execute', 'words', 'authorize', 'operationId', 'ownerRequest', 'app'];

export const tokenOf = value => value?.confirmationToken ?? value?.result?.confirmationToken ?? value?.structuredContent?.confirmationToken
  ?? value?.structuredContent?.result?.confirmationToken ?? null;

export function withoutSelection(argv, { keep = [] } = {}) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);
    if (!token.startsWith('--')) { out.push(argv[i]); continue; }
    const name = token.slice(2).split('=')[0];
    if (!SELECTION_FLAGS.has(name) || keep.includes(name)) { out.push(argv[i]); if (!token.includes('=') && !SWITCHES.has(name) && i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) out.push(argv[++i]); continue; }
    if (!token.includes('=') && !SWITCHES.has(name)) i++;
  }
  return out;
}

// -> { preview, result, token }. options: clock (default the shared one), keep (selection flags or keys to keep, e.g.
// 'connection'), wordsKey ('words' | 'authorize' for tool inputs), extra (more argv or input for the confirmation).
export async function previewThenConfirm(run, args, words, { clock: c = clock, keep = [], wordsKey = 'words', extra = null, advance = CONFIRM_MIN_AGE_MS } = {}) {
  const argv = Array.isArray(args);
  // The preview: the call as asked, without the owner's words (they come after the list).
  const preview = argv ? await run(...stripWords(args)) : await run(Object.fromEntries(Object.entries(args).filter(([k]) => !['words', 'authorize', 'execute', 'operationId'].includes(k))));
  const token = tokenOf(preview);
  if (!token) return { preview, result: null, token: null };
  c.advance(advance);
  const confirm = argv ? [...withoutSelection(args, { keep }), '--confirmation-token=' + token, ...(words !== null ? ['--' + wordsKey + '=' + words] : []), ...(extra ?? [])]
    : { ...Object.fromEntries(Object.entries(args).filter(([k]) => !SELECTION_KEYS.includes(k) || keep.includes(k))), confirmationToken: token,
      ...(words !== null ? { [wordsKey]: words } : {}), ...(extra ?? {}) };
  const result = argv ? await run(...confirm) : await run(confirm);
  return { preview, result, token };
}
function stripWords(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);
    if (/^--(words|execute|operation-id)=/.test(token) || token === '--execute') continue;
    if (token === '--words' || token === '--operation-id') { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

// The backup of a delete (CX15 W4) downloads the published OML of each module through the CLI and the Studio: tests that
// do not test the backup inject this one (nothing downloaded, nothing saved) so no test ever reaches a real Studio.
export const noBackup = async () => ({ files: [] });
