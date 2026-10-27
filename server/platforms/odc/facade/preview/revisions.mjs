import { createHash } from 'node:crypto';
const sha = text => createHash('sha256').update(text).digest('hex');
export function validateRevision(revision, origin) {
  if (!revision) return;
  if (!Array.isArray(revision.assets) || revision.assets.length < 1 || revision.assets.length > 20) throw new Error('PREVIEW_REVISION_ASSETS_REQUIRED');
  const names = new Set();
  for (const asset of revision.assets) {
    const url = new URL(asset.url);
    if (url.origin !== origin || url.username || url.password || !/^[a-f0-9]{64}$/.test(asset.sha256) || names.has(url.href)) throw new Error('PREVIEW_REVISION_INVALID');
    names.add(url.href);
  }
}
// Hash the code already loaded by Chrome, never a new HTTP response or a caller-supplied script.
export async function verifyLoadedRevision(cdp, revision, origin) {
  if (!revision) return { verified: false, reason: 'No deployed asset manifest supplied', assets: [] };
  validateRevision(revision, origin);
  await cdp.send('Page.enable');
  const resources = new Map();
  const {frameTree} = await cdp.send('Page.getResourceTree');
  const collect = tree => {
    for (const resource of tree.resources ?? []) if (resource.type === 'Script') resources.set(resource.url, tree.frame.id);
    for (const child of tree.childFrames ?? []) collect(child);
  };
  collect(frameTree);
  const assets = [];
  for (const expected of revision.assets) {
    const frameId = resources.get(expected.url);
    if (!frameId) { assets.push({ url: expected.url, expected: expected.sha256, actual: null, matched: false }); continue; }
    const {content, base64Encoded} = await cdp.send('Page.getResourceContent', {frameId, url:expected.url});
    if (typeof content !== 'string' || Buffer.byteLength(content) > 22000000) throw new Error('PREVIEW_REVISION_ASSET_SIZE');
    const actual = sha(base64Encoded ? Buffer.from(content, 'base64') : content);
    assets.push({ url: expected.url, expected: expected.sha256, actual, matched: actual === expected.sha256 });
  }
  return { verified: assets.every(a => a.matched), assets, fingerprint: sha(JSON.stringify(revision.assets)) };
}
