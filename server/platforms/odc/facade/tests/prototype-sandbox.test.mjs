// The capture child is a sandbox for untrusted prototype JS (docs/PROTOTIPO-NATIVO.md 2.1): a booby-trapped prototype
// folder must not reach the host filesystem, spawn processes, or read the user's environment. jsdom's vm context is not
// a security boundary (a page script can reach the host realm through, e.g., document.createElement.constructor), so
// the guarantee comes from the OS-level permission model and the stripped environment of the forked child (pool.mjs),
// plus the realm reparenting of the globals SSAM installs (dom-runtime.mjs). These tests exercise a hostile prototype
// and assert the escape yields nothing: no write, no read of a secret outside the folder, no spawn, no home directory.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePrototype, closeResidentPools } from '../prototype/capture.mjs';
import { childModuleFiles } from '../prototype/pool.mjs';
import { walk, attr } from '../prototype/ir.mjs';

const sandboxed = process.env.SSAM_PROTOTYPE_NO_SANDBOX !== '1';
const clock = '2026-10-10T21:00:00Z';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-proto-sbx-'));
// A secret file and a drop target, both OUTSIDE the prototype folder and outside every allow-listed root.
const secret = path.join(tmp, 'secret.txt');
const marker = path.join(tmp, 'escaped.txt');
fs.writeFileSync(secret, 'TOP-SECRET-CREDENTIAL');
// SSAM's own sources: another facade module (one the child does not load, next to the ones it does), the facade entry and
// a kernel file. The child reads its own modules file by file, never the facade folder nor the kernel.
const facade = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const facadeSibling = path.join(facade, 'prototype', 'capture.mjs');
const facadeEntry = path.join(facade, 'ssam.mjs');
const kernelFile = path.resolve(facade, '..', '..', '..', 'kernel', 'AGENTS.md');
after(() => { closeResidentPools(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Builds a prototype whose only script probes the sandbox and records the outcome of each probe in a DOM element, so the
// capture carries it back as text. It reaches the host realm the way a real attacker would and then tries to act.
function hostile(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const script = `
    (function () {
      var out = [];
      function probe(name, fn) { try { out.push(name + '=' + fn()); } catch (e) { out.push(name + '=ERR:' + (e && e.code || e && e.message || e)); } }
      // Realm-reparented globals: their constructor is the jsdom-realm Function, where 'process' does not exist.
      probe('timerCtor', function () { return typeof setTimeout.constructor('return process')(); });
      probe('fetchCtor', function () { return typeof fetch.constructor('return process')(); });
      // The inherent jsdom vector still reaches the host process; the OS sandbox must make it useless.
      var P; try { P = document.createElement.constructor('return process')(); } catch (e) { P = null; }
      probe('reachedProcess', function () { return !!P; });
      probe('home', function () { return (P.env.USERPROFILE || P.env.HOME || '') === '' ? 'none' : 'LEAKED'; });
      probe('path', function () { return (P.env.PATH || P.env.Path || '') === '' ? 'none' : 'present'; });
      probe('spawn', function () { P.getBuiltinModule('child_process').execSync('cmd /c echo pwned'); return 'RAN'; });
      probe('write', function () { P.getBuiltinModule('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); return 'WROTE'; });
      probe('readSecret', function () { return P.getBuiltinModule('fs').readFileSync(${JSON.stringify(secret)}, 'utf8'); });
      probe('readFacadeSibling', function () { return P.getBuiltinModule('fs').readFileSync(${JSON.stringify(facadeSibling)}, 'utf8').length; });
      probe('readFacadeEntry', function () { return P.getBuiltinModule('fs').readFileSync(${JSON.stringify(facadeEntry)}, 'utf8').length; });
      probe('listFacade', function () { return P.getBuiltinModule('fs').readdirSync(${JSON.stringify(facade)}).length; });
      probe('readKernel', function () { return P.getBuiltinModule('fs').readFileSync(${JSON.stringify(kernelFile)}, 'utf8').length; });
      document.getElementById('o').setAttribute('data-probe', out.join(' | '));
    })();
  `;
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><p id="o">app</p><script>' + script + '</script></body></html>');
  return dir;
}

function probeOf(result) {
  let found = '';
  for (const view of result.ir?.views ?? []) walk(view.root, node => { const value = attr(node, 'data-probe'); if (value) found = value; });
  return found;
}

test('a hostile prototype cannot write, read a secret, spawn, or see the environment through the capture child', { skip: sandboxed ? false : 'sandbox disabled via SSAM_PROTOTYPE_NO_SANDBOX' }, async () => {
  const result = await capturePrototype({ source: hostile(path.join(tmp, 'hostile')), clock, pool: 1, download: null, resident: false });
  assert.equal(result.ok, true, 'the capture still renders the page: ' + JSON.stringify(result.problems));
  const probe = probeOf(result);
  // The constructor vectors on the installed globals are closed inside the realm.
  assert.match(probe, /timerCtor=ERR:.*process is not defined/, probe);
  assert.match(probe, /fetchCtor=ERR:.*process is not defined/, probe);
  // Whether or not the inherent jsdom vector reaches the host process, the sandbox denies every capability.
  assert.match(probe, /spawn=ERR:/, 'child_process must be denied: ' + probe);
  assert.match(probe, /write=ERR:/, 'fs write outside the work dir must be denied: ' + probe);
  assert.match(probe, /readSecret=ERR:/, 'fs read of a file outside the allow-list must be denied: ' + probe);
  // SSAM's own code: the facade module the child does not load, the facade entry, the facade folder and the kernel.
  assert.match(probe, /readFacadeSibling=ERR:ERR_ACCESS_DENIED/, 'another facade module must be denied: ' + probe);
  assert.match(probe, /readFacadeEntry=ERR:ERR_ACCESS_DENIED/, 'the facade entry must be denied: ' + probe);
  assert.match(probe, /listFacade=ERR:ERR_ACCESS_DENIED/, 'the facade folder must not be listable: ' + probe);
  assert.match(probe, /readKernel=ERR:ERR_ACCESS_DENIED/, 'the kernel must be denied: ' + probe);
  assert.doesNotMatch(probe, /home=LEAKED/, 'the user home directory must not be reachable: ' + probe);
  assert.doesNotMatch(probe, /path=present/, 'PATH must not be forwarded to the child: ' + probe);
  // Nothing happened on disk: no dropped file, and the secret was never overwritten or removed.
  assert.equal(fs.existsSync(marker), false, 'the escape must not have created a file on the host');
  assert.equal(fs.readFileSync(secret, 'utf8'), 'TOP-SECRET-CREDENTIAL', 'the secret file must be untouched');
});

test('the capture child is allowed its own modules file by file, never the facade folder', () => {
  // the closure of child.mjs's relative imports: what the sandbox allow-lists of the facade (pool.mjs readFiles)
  const names = childModuleFiles().map(file => path.relative(facade, file).split(path.sep).join('/'));
  assert.deepEqual(names, ['prototype/child.mjs', 'prototype/dom-runtime.mjs', 'prototype/ir.mjs', 'prototype/network.mjs', 'prototype/scripts.mjs', 'prototype/store.mjs', 'prototype/vendor.mjs']);
});
