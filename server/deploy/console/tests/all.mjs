// `node --test <this folder>` runs the folder as a module (package.json "main"): this file imports every *.test.mjs.
// A test file run on its own works too: `node --test tests/security.test.mjs`.
import './alerts.test.mjs';
import './github-auth.test.mjs';
import './host.test.mjs';
import './licenses.test.mjs';
import './licenses-pg.test.mjs';
import './live.test.mjs';
import './misc.test.mjs';
import './quality-line.test.mjs';
import './quality.test.mjs';
import './readers.test.mjs';
import './secrets.test.mjs';
import './security.test.mjs';
import './usage.test.mjs';
import './views.test.mjs';
import './write-scope.test.mjs';

import './studio-versions.test.mjs';
import './version-sources.test.mjs';
import './version-reader.test.mjs';
