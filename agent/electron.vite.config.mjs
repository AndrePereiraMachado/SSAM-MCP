// electron-vite: the three builds of the app, from src/ to out/ (what electron-builder packs).
//   - main (src/main/index.mjs -> out/main/index.mjs, ESM, Node built-ins and electron-updater left external);
//   - preload (src/preload/index.mjs -> out/preload/index.cjs: CommonJS, because the panel runs sandboxed and
//     Electron loads an ESM preload only without the sandbox);
//   - renderer (src/renderer: the React panel -> out/renderer, served by the Vite dev server in `npm run dev`).
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// The pinned update key of the Windows app (src/main/core/update-trust.mjs): the base64 SPKI DER of the owner's Ed25519 key.
// scripts/build.mjs sets SSAM_BUILD_UPDATE_SPKI for this child process only, from its explicit --trust-public-key input
// (empty otherwise); the final key lives in the bundle, never read from the environment at runtime.
const updateSpki = process.env.SSAM_BUILD_UPDATE_SPKI ?? '';
if (updateSpki && !/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/.test(updateSpki)) throw new Error('SSAM_BUILD_UPDATE_SPKI is not the base64 SPKI of one Ed25519 public key');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __SSAM_UPDATE_PUBLIC_KEY__: JSON.stringify(updateSpki) },
    build: { rolldownOptions: { input: 'src/main/index.mjs' } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rolldownOptions: { input: { index: 'src/preload/index.mjs', 'private-dialog': 'src/preload/private-dialog.mjs' }, output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    plugins: [react()],
    build: { rolldownOptions: { input: { index: 'src/renderer/index.html', 'private-dialog': 'src/renderer/private-dialog/index.html' } } },
  },
});
