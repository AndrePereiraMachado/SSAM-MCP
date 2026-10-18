import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { toolTexts } from '../tool-listing.mjs';

// F1 of the cx11-final review, as a family: a projected text that keeps a naming rule keeps its predicate and condition.
// "Corporate tenants: the words name the tenant" served as "...; corporate tenant." kept the subject and lost the verb:
// a meaning changed in silence, signed by a review hash. Every clause of an ORIGINAL text in which the words (or the
// owner's reply, or the parameter that carries them) name an object must be served, in the same tool, by a clause
// (a sentence or a ;-segment) that still has the words, a naming verb and that object, under the same condition
// (corporate) when the original states one. Checked on the served listing of app and all and on the warm-start snapshot.
const WORDS = /\b(?:words?|reply|authoriz\w*)\b/i;
// The naming VERB, not the noun ("role names", "{name, ...}", "the module name"): naming, or name(s) right after the
// words, a reply or must/need/that/also/to (one word may sit between).
const NAMING = /\bnaming\b|\b(?:words?|reply|must|needs?|that|also|to)\s+(?:\w+\s+)?nam(?:e|es)\b/i;
// Objects that name the same thing.
const SAME = { application: 'app', environment: 'place', host: 'place', tenant: 'place' };
const kind = o => SAME[o] ?? o;
const SKIP = new Set(['the', 'a', 'an', 'every', 'each', 'all', 'both', 'its', 'their', 'that', 'this', 'also', 'it', 'them', 'of']);
const segments = text => (text ?? '').split(/(?<=[.;])\s+|;\s*/).map(s => s.trim()).filter(Boolean);
const singular = w => w.toLowerCase().replace(/[^a-z]/g, '').replace(/s$/, '');
const lastNoun = s => singular(s.split(/[^A-Za-z]+/).filter(Boolean).pop() ?? '');
// The object a naming clause names: the first noun after the verb; a pronoun ("words also name it") is the subject
// before the colon ("corporate tenant: words also name it").
function objectOf(segment) {
  const m = NAMING.exec(segment); if (!m) return null;
  const words = segment.slice(m.index + m[0].length).split(/[^A-Za-z]+/).filter(Boolean).map(w => w.toLowerCase()).filter(w => !SKIP.has(w));
  if (words[0]) return singular(words[0]);
  return segment.includes(':') ? lastNoun(segment.slice(0, segment.indexOf(':'))) || null : null;
}
// Naming rules of a tool's texts: [{where, object, corporate, clause}]; the parameter that carries the words counts as
// the words; a pronoun left without a subject takes the last noun of the clause before ("corporate host; words must name it").
function namingRules(tool) {
  const t = toolTexts(tool), rules = [];
  for (const [where, text] of [['description', t.description], ...Object.entries(t.params)]) {
    const carrier = /\/(?:words|authorize|authorization)$/.test(where);
    const parts = segments(text);
    parts.forEach((s, i) => {
      if (!NAMING.test(s) || !(WORDS.test(s) || carrier)) return;
      let object = objectOf(s), corporate = /\bcorporate\b/i.test(s);
      if (!object && i > 0) { object = lastNoun(parts[i - 1]) || null; corporate ||= /\bcorporate\b/i.test(parts[i - 1]); }
      if (object) rules.push({ where, object, corporate, clause: s });
    });
  }
  return rules;
}
const keeps = (served, rule) => namingRules(served).some(r => (kind(r.object) === kind(rule.object) || r.clause.toLowerCase().includes(rule.object)) && (!rule.corporate || r.corporate));
async function listings(profile) {
  const make = async deps => {
    const server = await createSsamServer({ profile, deps });
    const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'naming-rules', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    try { return { tools: (await client.listTools()).tools, snapshot: server.ssamTools }; } finally { await client.close(); await server.close(); }
  };
  const short = await make({}), full = await make({ listing: 'full' });
  return { short: short.tools, snapshot: short.snapshot, originals: new Map(full.tools.map(t => [t.name, t])) };
}
for (const profile of ['app', 'all']) test(`a naming rule of an original keeps its verb and condition in the served listing and the warm-start snapshot (${profile})`, async () => {
  const { short, snapshot, originals } = await listings(profile);
  const lost = []; let checked = 0;
  for (const [label, list] of [['served', short], ['snapshot', snapshot]]) for (const served of list) {
    const original = originals.get(served.name); if (!original) continue;
    for (const rule of namingRules(original)) {
      checked++;
      if (!keeps(served, rule)) lost.push(`${label} ${served.name}${rule.where === 'description' ? '' : rule.where}: ${rule.corporate ? 'corporate ' : ''}words name ${rule.object}: "${rule.clause.slice(0, 120)}"`);
    }
  }
  assert.ok(checked >= 40, 'naming rules checked: ' + checked);
  assert.deepEqual(lost, [], 'naming rules served without their predicate or condition');
});
