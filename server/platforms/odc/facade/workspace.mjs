import path from 'node:path';
import { RELEASE, root, kernelRoot, releaseManifest, workspaceConfig } from './release-layout.mjs';
// The roots come from release-layout.mjs. Checkout: the repository (.ssam-workspace.json), exactly as before. Release
// (RELEASE, bundle only): the release folder, whose marker is release.json; there the O11 lane is release.json's
// o11Lane, else ss4 (one installed Studio, no ss4/ss5 clones), and ANVIL_LANE still wins.
export const workspaceRoot = root();
export const odcRoot = RELEASE ? workspaceRoot : path.join(workspaceRoot, 'platforms', 'odc');
const config = RELEASE ? { o11Lane: releaseManifest().o11Lane ?? 'ss4' } : workspaceConfig();
export const anvilRoot = RELEASE ? kernelRoot() : process.env.ANVIL_ROOT ?? path.join(workspaceRoot, config.kernel);
// The O11 lane (which Service Studio copy, CLI build and worker port the O11 side uses), resolved ONCE for every
// entry (launcher, lanes table, discovery, readers): an explicit ANVIL_LANE wins; otherwise the workspace's
// `o11Lane`. Nothing else may default a lane on its own (phase 3, 2026-09-23: lanes.mjs assumed ss5 and
// discovery.mjs ss4 when the variable was absent, which could bind a Studio the target was not built for).
export const O11_LANES = ['ss4', 'ss5'];
export function resolveO11Lane(env = process.env, layout = config) {
  const explicit = typeof env.ANVIL_LANE === 'string' && env.ANVIL_LANE.trim() ? env.ANVIL_LANE.trim().toLowerCase() : null;
  const configured = typeof layout.o11Lane === 'string' && layout.o11Lane.trim() ? layout.o11Lane.trim().toLowerCase() : null;
  const lane = explicit ?? configured;
  if (!lane) throw new Error('No O11 lane: set ANVIL_LANE (ss4|ss5) or `o11Lane` in .ssam-workspace.json; nothing is assumed');
  if (!O11_LANES.includes(lane)) throw new Error(`Unknown O11 lane '${lane}' (${explicit ? 'ANVIL_LANE' : '.ssam-workspace.json o11Lane'}); lanes: ${O11_LANES.join(', ')}`);
  return { lane, source: explicit ? 'env:ANVIL_LANE' : 'workspace:o11Lane', configured, explicit };
}
export const o11Lane = resolveO11Lane();
