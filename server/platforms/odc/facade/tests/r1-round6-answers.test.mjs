import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { exposedValue, POSIX_PATH } from '../exposure.mjs';
import { oneLine } from '../answer-size.mjs';
const oldPath = /(?<![\w.:/~-])\/(?:studio|opt|srv|var|home|root|usr|etc|mnt|app|workspace|customers|tmp|data\/(?:server|cache|friction|odc-features))(?=$|[\/\s"'`<>|,;:)\]]|\.(?:\s|$))(?:\/[^\s"'`<>|,;)\]]*(?<!\.))?/g;
const licensee = message => exposedValue({ message }, { exposure: 'licensee', tool: 'o11_deliver' }).message;

test('round 6: POSIX paths stop at whitespace unless a quote closes on the same line', t => {
  const cases = [
    ['/data/server/x failed in step.json then', '<server> failed in step.json then'],
    ['Capture /data/server/customers/c7/o11/snapshots/X.oml is older than Orders.Core', 'Capture <server> is older than Orders.Core'],
    ['The module /app/Orders could not load Orders_CS.GetOrders now', 'The module <server> could not load Orders_CS.GetOrders now'],
    ['Read /data/server/logs and the file app.log for details', 'Read <server> and the file app.log for details'],
    ['/data/server/x is missing e.g. after a reset', '<server> is missing e.g. after a reset'],
    ["It is at '/data/server/x.oml and Ana saved the rest of the line", "It is at '<server> and Ana saved the rest of the line"],
    ['/data/server/My App.oml', '<server> App.oml'],
    ['/studio/o11/11.55.92/ServiceStudio.Framework.dll failed', '<server> failed'],
    ['/opt/ssam/v1.7.30/agent.js loaded', '<server> loaded'],
    ['/app/builder/net10.0/ODC3.Builder.dll failed', '<server> failed'],
    ['/data/server/answers/abc.json.origin', '<server>'],
    ['C:\\Program Files\\Server\\kernel\\anvil.dll failed', '<server> failed'],
    ['\\\\fileserver\\share\\Server Folder\\kernel\\anvil.dll failed', '<server> failed'],
  ];
  for (const [text, expected] of cases) assert.equal(licensee(text), expected, text);
  for (const quote of ['"', "'", '`']) {
    assert.equal(licensee(`${quote}/data/server/My App.oml${quote} is ready`), quote === '`' ? '<server> is ready' : `${quote}<server>${quote} is ready`);
    assert.equal(licensee(`${quote}/data/server/x.oml has no matching quote`), `${quote}<server> has no matching quote`);
    assert.equal(licensee(`${quote}/data/server/x.oml has no matching quote\n${quote} next line`), `${quote}<server> has no matching quote\n${quote} next line`);
  }

  // Same deterministic cases as the review's probe23, with names independent
  // of any app: compare leaks, lost words, and fragments created by oneLine.
  const roots = ['/data/server', '/studio/o11', '/opt/ssam', '/app', '/tmp', '/workspace', '/data/cache'];
  const segments = ['customers', 'c7', 'o11', '11.55.92', 'v1.7.30', 'net10.0', 'snapshots', 'a.json', 'abc.json.origin', 'kernel', '.local', 'cli', 'anvil.dll', 'x:12'];
  const last = [...segments, 'My App.oml', 'My Sales App.oml'];
  const words = ['failed', 'in', 'step.json', 'then', 'Orders.Core', 'the', 'module', 'at', '10:00', 'was', 'saved', 'by', 'Ana', 'see', 'config.json', '2.5', ';', ',', '.', ':'];
  const fragment = /customers\/c7|11\.55\.92|v1\.7\.30|net10\.0|anvil\.dll|abc\.json|snapshots|Sales App|App\.oml/;
  const alpha = s => (s.match(/[A-Za-z][A-Za-z0-9_.:]*/g) ?? []).filter(w => w !== 'server').length;
  let seed = 23; const random = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let i = 0; i < 20000; i++) {
    const mid = Array.from({ length: random(4) }, () => '/' + segments[random(segments.length)]).join('');
    const p = roots[random(roots.length)] + mid + (random(2) ? '/' + last[random(last.length)] : '');
    const quote = ['', '', '', '"', "'"][random(5)];
    const pre = Array.from({ length: random(3) }, () => words[random(words.length)]).join(' ');
    const post = Array.from({ length: random(7) }, () => words[random(words.length)]).join(' ');
    const text = (pre ? pre + ' ' : '') + quote + p + quote + (post ? ' ' + post : '');
    const actual = licensee(text), previous = licensee(text.replace(oldPath, '<server>'));
    assert.ok(!fragment.test(actual) || fragment.test(previous), `new leak: ${text}`);
    if (/[A-Za-z]/.test(post)) assert.ok(alpha(actual) >= alpha(previous), `lost prose: ${text}`);
    const compact = licensee(oneLine(text, 20 + random(80)));
    assert.ok(!fragment.test(compact) || fragment.test(actual), `fragment after compacting: ${text}`);
  }
  if (process.env.SSAM_ANSWER_TRANSCRIPT) {
    const corpus = JSON.parse(fs.readFileSync(process.env.SSAM_ANSWER_TRANSCRIPT, 'utf8'));
    let answers = 0, strings = 0;
    const visit = value => {
      if (typeof value === 'string') { assert.equal(value.replace(POSIX_PATH, '<server>'), value.replace(oldPath, '<server>')); strings++; }
      else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child);
    };
    for (const call of corpus) { if (!/__ssam_|__o11_|__studio_|__odc_/.test(call.name)) continue; let value; try { value = JSON.parse(call.text); } catch { continue; } if (value && typeof value === 'object') { answers++; visit(value); } }
    assert.equal(answers, 575); assert.ok(strings > 1000); t.diagnostic(`${answers} answers and ${strings} strings match the earlier rule`);
  }
});
