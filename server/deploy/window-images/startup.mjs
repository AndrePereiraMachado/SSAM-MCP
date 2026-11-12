// Smoke of an image built with Studios from images (trilha D, IMAGENS.md; window-images/smoke.sh), run INSIDE a throwaway container of the new image as its user 10001,
// without network: the kernel the server would start with, from a kernel.json naming the image's own versions.
//   node /smoke/startup.mjs <o11 default> <odc> [multi|single]
// single (a correction image of a production commit before the window 4x4): no o11-kernels event is expected; the kernel must
// still be the image's two versions with nothing refused.
import fs from 'node:fs';
import { startupKernel } from '/app/platforms/odc/facade/ssam.mjs';
const [o11, odc, layout = 'multi'] = process.argv.slice(2);
const dir = fs.mkdtempSync('/tmp/smoke-rt-');
fs.writeFileSync(dir + '/kernel.json', JSON.stringify({ o11, odc }));
const events = [];
const { kernel, refused } = await startupKernel({ dir, fileVersion: async () => null, log: e => events.push(e), caches: false });
const pick = name => events.filter(e => e.event === name);
const out = {
  env: { SSAM_IMAGE_O11: process.env.SSAM_IMAGE_O11, SSAM_IMAGE_ODC: process.env.SSAM_IMAGE_ODC, ANVIL_STUDIO_DIR: process.env.ANVIL_STUDIO_DIR, SSAM_O11_STUDIO_ROOT: process.env.SSAM_O11_STUDIO_ROOT },
  kernel: { o11: kernel.o11, odc: kernel.odc, o11Builds: kernel.o11Builds, builds: kernel.builds },
  refused, o11Kernels: pick('o11-kernels'), versionMissing: pick('kernel-version-missing'),
};
const ok = kernel.o11 === o11 && kernel.odc === odc && Object.keys(refused).length === 0 && out.versionMissing.length === 0
  && (layout === 'single' || (out.o11Kernels.length === 1 && Array.isArray(out.o11Kernels[0].off) && out.o11Kernels[0].off.length === 0));
console.log(JSON.stringify({ ok, ...out }, null, 1));
process.exit(ok ? 0 : 1);
