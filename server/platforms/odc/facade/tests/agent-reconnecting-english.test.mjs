// Owner rule of 2026-10-15 (every text SSAM emits is English only), lane A: the answers about the customer's agent
// connection. AGENT_RECONNECTING (both ages) and AGENT_NOT_CONNECTED of the hosted gate (hosted/policy.mjs), called for
// real, and the AGENT_RECONNECTING of the hub (agent-hub.mjs reconnectingError, read from the source) carry no
// Portuguese: no accented letter and none of the common Portuguese words below. The codes and retryAfterSeconds stay.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentNotConnected, RESTART_AFTER_MS, RETRY_AFTER_SECONDS } from '../hosted/policy.mjs';

const facade = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORDS = new Set(('nao voce esta este isso pelo pela para com sem uma um dos das nos nas ao em de da ou que se ja mais ainda depois quando ' +
  'sempre nunca seu sua ele ela nada repita chamada agente sozinho reconecta usuario janela conferir peca contato servidor').split(' '));
const portuguese = text => String(text).split(/[\s'"`(){}[\],;+=<>|!?*&]+/u)
  .map(piece => piece.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').toLowerCase())
  .filter(token => token && (/[À-ÖØ-öø-ÿ]/u.test(token) || WORDS.has(token)));
const texts = answer => [answer.error, answer.continuation?.why].filter(Boolean);

test('the hosted gate answers about the agent connection in English, with the same codes', () => {
  const now = Date.parse('2026-10-15T12:00:00.000Z');
  const seen = ms => ({ instance: 'i-1', lastSeenAt: new Date(now - ms).toISOString() });
  const recent = agentNotConnected(seen(5000), { now, tool: 'studio_status', args: { pid: 1 } });
  const quiet = agentNotConnected(seen(RESTART_AFTER_MS + 1000), { now });
  const never = agentNotConnected(null, { now });
  const noCredential = agentNotConnected({ credential: false }, { now });
  assert.deepEqual([recent.code, quiet.code, never.code, noCredential.code], ['AGENT_RECONNECTING', 'AGENT_RECONNECTING', 'AGENT_NOT_CONNECTED', 'AGENT_NOT_CONNECTED']);
  assert.equal(recent.retryAfterSeconds, RETRY_AFTER_SECONDS);
  for (const [name, answer] of Object.entries({ recent, quiet, never, noCredential }))
    for (const text of texts(answer)) assert.deepEqual(portuguese(text), [], name + ': ' + text);
  assert.match(recent.continuation.why, /repeat the same call in 15 s/);
  assert.match(quiet.continuation.why, /agent\\ssam-agent\.ps1 status/);
});

test('the hub answers AGENT_RECONNECTING in English (reconnectingError in agent-hub.mjs)', () => {
  const source = fs.readFileSync(path.join(facade, 'agent-hub.mjs'), 'utf8');
  const start = source.indexOf('function reconnectingError(');
  assert.ok(start > 0, 'reconnectingError');
  const body = source.slice(start, source.indexOf('\n  }\n', start));
  const literals = [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);
  assert.ok(literals.some(l => l.includes('reconnect')), body);
  for (const literal of literals) assert.deepEqual(portuguese(literal), [], literal);
});
