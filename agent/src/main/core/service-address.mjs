export const SERVICE_ADDRESS = 'https://mcp.ssam.pro';

export function serviceAddress(env = process.env) {
  // Only the isolated UI harness may redirect to a loopback test server.
  if (env.PLAYWRIGHT_MODULE && env.SSAM_TEST_SERVER) {
    const url = new URL(env.SSAM_TEST_SERVER);
    if (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash)
      return url.origin;
    throw new Error('The UI test service must use a loopback address.');
  }
  return SERVICE_ADDRESS;
}
