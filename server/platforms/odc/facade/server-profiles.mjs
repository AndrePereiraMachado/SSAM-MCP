// Membership is defined once. The app server deliberately keeps native app SQL testing.
const DEBUG_TOOLS = Object.freeze(['ssam_debug', 'ssam_debug_invoke', 'ssam_debug_run', 'ssam_debug_client', 'ssam_debug_server', 'ssam_debug_matrix']);
export const SERVER_PROFILES = Object.freeze({
  app: Object.freeze({ name: 'ssam', excludes: DEBUG_TOOLS }),
  debug: Object.freeze({ name: 'ssam-debug', includes: Object.freeze([...DEBUG_TOOLS, 'ssam_doctor', 'ssam_evidence']) }),
  all: Object.freeze({ name: 'ssam' }),
});
export function serverProfile(profile = 'app') {
  if (!Object.hasOwn(SERVER_PROFILES, profile)) throw new Error('Usage: ssam mcp --profile app|debug|all (SSAM_MCP_PROFILE)');
  return SERVER_PROFILES[profile];
}
export function profileServes(profile, tool) {
  const selected = serverProfile(profile);
  return selected.includes ? selected.includes.includes(tool) : !selected.excludes?.includes(tool);
}
export function parseMcpProfile(args = [], env = process.env) {
  const positions = args.flatMap((arg, i) => arg === '--profile' ? [i] : []);
  if (positions.length > 1) throw new Error('Usage: ssam mcp --profile app|debug|all');
  const index = positions[0];
  if (index !== undefined && (!args[index + 1] || args[index + 1].startsWith('--'))) throw new Error('Usage: ssam mcp --profile app|debug|all');
  const profile = index === undefined ? env.SSAM_MCP_PROFILE || 'app' : args[index + 1];
  serverProfile(profile);
  return profile;
}
