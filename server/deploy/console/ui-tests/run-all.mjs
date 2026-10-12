// Entry of `node --test server/deploy/console/ui-tests/`: a directory given to the test runner is loaded as a module
// (package.json "main"), so this file imports every *.test.mjs of the folder. Each file also runs alone:
//   node --test server/deploy/console/ui-tests/format.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of fs.readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort()) {
  await import(pathToFileURL(path.join(here, f)).href);
}
