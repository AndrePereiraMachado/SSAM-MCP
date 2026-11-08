// The window rule of the local rehearsal (rehearse.mjs), apart from the script so it can be tested without Docker: how many
// image pairs a rehearsal takes, and which pairs get a license of their own. The production window (gen-compose.mjs
// versionPairs) allows up to 20; the rehearsal runs every backend at once on one workstation, so it stops at MAX_PAIRS.
// r44: the fifth pair (Service Studio 11.55.95 / ODC Studio 1.7.32) is one more entry here, not a new special case.
export const MAX_PAIRS = 6;
export function rehearsalWindow(images) {
  if (images === null || images === undefined) return null;
  if (!Array.isArray(images) || images.length < 2 || images.length > MAX_PAIRS) throw Error(`The window takes two to ${MAX_PAIRS} images.`);
  const names = images.map((x, i) => x?.name ?? 'v' + (i + 1));
  if (new Set(names).size !== names.length) throw Error('Every pair of the window has its own name.');
  return images.length;
}
// The words of the check names ("v102 accepted on the five pairs"): unchanged for two to four pairs.
export const pairWords = count => (['', 'one', 'two', 'three', 'four', 'five', 'six'][count] ?? String(count)) + ' pairs';
// Licenses a and b serve the first two pairs; every pair from the third on gets its own, so each backend proves routing,
// tools/list and its state with a session of its own.
export const extraLicenses = count => Array.from({ length: Math.max(0, count - 2) }, (_, i) => ({ index: i + 2, customer: 'Rehearsal pair ' + (i + 3) }));
// r44 rodada 2: the backend definition the rehearsal starts comes from gen-compose itself (the same SSAM_SERVED_VERSIONS and the
// same read-only model plugin mount the release compose gives each backend), so the rehearsal cannot drift from the compose.
// keepServed: the versions.json field (the first N backends keep the served list of the window they were deployed with).
import {generateCompose, MODEL_PLUGINS_VOLUME, MODEL_PLUGINS_TARGET} from './gen-compose.mjs';
export function backendPlan(pairs, keepServed = 0) {
  const entry = lane => pairs.map((p, j) => ({ version: p[lane], tag: 'rehearsal-' + j, image: 'rehearsal' }));
  const compose = generateCompose({ window: pairs.length, keepServed, odc: entry('odc'), o11: entry('o11') });
  return pairs.map((p, i) => {
    const s = compose.services['ssam-server-v' + (i + 1)];
    const plugins = s.volumes.find(v => v.source === MODEL_PLUGINS_VOLUME);
    return { name: p.name, served: s.environment.SSAM_SERVED_VERSIONS, modelPlugins: plugins ? { target: plugins.target, readOnly: plugins.read_only === true } : null };
  });
}
export { MODEL_PLUGINS_TARGET };
// What a backend answers for a Studio version of a lane, by its served list (studio-identity relations): its own version is
// served; one in the served list but not its own is served elsewhere (refused, the agent must move); one newer than every
// served version is served here with the studioNewerThanServed note.
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return Math.sign(d); } return 0; };
export function expectedLane(own, served, installed) {
  if (cmp(installed, own) === 0) return 'served';
  if (served.includes(installed)) return 'refused';
  return served.every(v => cmp(installed, v) > 0) ? 'newer' : 'refused';
}