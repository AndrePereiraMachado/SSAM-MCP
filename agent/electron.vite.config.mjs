// electron-vite: the three builds of the app, from src/ to out/ (what electron-builder packs).
//   - main (src/main/index.mjs -> out/main/index.mjs, ESM, Node built-ins and electron-updater left external);
//   - preload (src/preload/index.mjs -> out/preload/index.cjs: CommonJS, because the panel runs sandboxed and
//     Electron loads an ESM preload only without the sandbox);
//   - renderer (src/renderer: the React panel -> out/renderer, served by the Vite dev server in `npm run dev`).
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rolldownOptions: { input: 'src/main/index.mjs' } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rolldownOptions: { input: 'src/preload/index.mjs', output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    plugins: [react()],
  },
});
