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
