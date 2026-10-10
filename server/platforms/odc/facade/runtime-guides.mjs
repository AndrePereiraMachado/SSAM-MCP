// Runtime guides: the documentation the model needs at run time, as MCP resources `ssam://guide/<topic>` (plan §7.2 Z,
// DESIGN-ADENDO §3.5). They speak only of MCP tools. Lane J registers them; this module only exports them.
//
//   GUIDES                 [{topic, name, uri, title, description, mimeType}], one per topic
//   guideText(topic, opts) the markdown of a topic
//   guideSections(text)    the numbered sections (## headings) of a markdown text: [{id, title, text}]
//   readGuide(uri, opts)   the ReadResourceCallback answer: {contents: [{uri, mimeType, text}]}
//   guideIndex()           one sentence naming every guide, for the server instructions
//
// J registers each one with the SDK: server.registerResource(g.name, g.uri, {title, description, mimeType},
// uri => readGuide(uri.href)).
//
// Where the text comes from:
//   - o11, odc, lifecycle: platforms/odc/facade/guides/<topic>.md. In the release bundle they are text, never files:
//     lane O defines SSAM_GUIDES (esbuild define) as {topic: text} for every entry of GUIDE_FILES, read at build time.
//     In the checkout the files are read through release-layout.mjs. A release without SSAM_GUIDES refuses (layoutPath
//     has no release path for them), never reads a stray file;
//   - refusals: generated from continuations.mjs (every code and its next call);
//   - rules, padroes: the owner's rules for generating or changing modules, the same files the team reads
//     (docs/CONHECIMENTO-DO-TIME.md and the 35 rules of kernel/scripts/outsystems_padroes/RULES.md). An app session never
//     reads a file: ssam_reference {kind:"rules"} answers them (2026-10-06, a session had to ask the user for an exception
//     to read the team rules), and these resources carry the same text.
import fs from 'node:fs';
import { CONTINUATIONS, formatCall } from './continuations.mjs';
import { layoutPath } from './release-layout.mjs';

/* global SSAM_GUIDES */
const BUNDLED = typeof SSAM_GUIDES !== 'undefined' ? SSAM_GUIDES : null;

export const GUIDE_FILES = Object.freeze({
  lifecycle: 'platforms/odc/facade/guides/lifecycle.md',
  o11: 'platforms/odc/facade/guides/o11.md',
  odc: 'platforms/odc/facade/guides/odc.md',
  rules: 'docs/CONHECIMENTO-DO-TIME.md',
  padroes: 'kernel/scripts/outsystems_padroes/RULES.md',
});

const guide = (topic, title, description) => Object.freeze({ topic, name: 'ssam-guide-' + topic, uri: 'ssam://guide/' + topic, title, description, mimeType: 'text/markdown' });
export const GUIDES = Object.freeze([
  guide('lifecycle', 'SSAM guide: install, license, setup, connect, update', 'First run, license states, words and secrets, connect, update, and the few steps the person does outside the MCP.'),
  guide('o11', 'SSAM guide: the O11 lane', 'Service Studio: connect, read by @key, prove and deliver a job, dialogs, environment, data, Service Center.'),
  guide('odc', 'SSAM guide: the ODC lane', 'ODC Studio and the ODC APIs: connect, read, deliver, publish with the person\'s words, Portal and public APIs.'),
  guide('refusals', 'SSAM guide: refusals and their next call', 'Every refusal code of the server with the MCP call that follows it.'),
  guide('rules', 'SSAM guide: team rules and platform lessons', 'The owner\'s rules before generating or changing an O11 or ODC module: how to work, implementation standards, lessons of the platform.'),
  guide('padroes', 'SSAM guide: the 35 OutSystems padrões rules', 'Logic, lists, data, server, UI, names, state and architecture rules every generated module follows (O11 and ODC; AR1 only O11).'),
]);

// The numbered sections of a markdown text: each heading of the level (2: "## ") with everything up to the next one, as
// it is in the text (line endings kept). id is the heading's leading number ("## 1. Como trabalhar" -> "1"), else its
// position.
export function guideSections(text, level = 2) {
  const source = String(text ?? '');
  const heading = new RegExp('^' + '#'.repeat(level) + ' (.+?)\\r?$', 'gm');
  const starts = [...source.matchAll(heading)];
  return starts.map((m, i) => ({ id: /^(\d+)[.)]?\s/.exec(m[1])?.[1] ?? String(i + 1), title: m[1].replace(/^\d+[.)]?\s+/, '').trim(),
    text: source.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : source.length).replace(/\s+$/, '') + '\n' }));
}

// Every code with its call and reason, grouped as the table is (one markdown table).
function refusalsGuide() {
  const rows = Object.entries(CONTINUATIONS).map(([code, next]) => '| `' + code + '` | `' + formatCall(next.tool, next.arguments) + '` | ' + next.why.replace(/\|/g, '\\|') + ' |');
  return ['# SSAM: refusals and their next call', '',
    'A refusal answers `{ok:false, executed:false, code, message, continuation:{tool, arguments, why}}`. Call the continuation; '
      + 'a value written `<...>` is filled from the refusal or asked to the person. `"<the user\'s own words>"` is always the '
      + 'person\'s own authorization words, quoted verbatim; never write them yourself.', '',
    '| code | next call | why |', '|---|---|---|', ...rows, ''].join('\n');
}

export function guideText(topic, opts) {
  if (topic === 'refusals') return refusalsGuide();
  if (!Object.hasOwn(GUIDE_FILES, topic)) throw new Error('Unknown SSAM guide: ' + topic + '; guides: ' + GUIDES.map(g => g.topic).join(', '));
  if (BUNDLED) {
    if (typeof BUNDLED[topic] !== 'string') throw new Error('SSAM guide missing from the bundle: ' + topic);
    return BUNDLED[topic];
  }
  return fs.readFileSync(layoutPath(GUIDE_FILES[topic], null, opts), 'utf8').replace(/^\uFEFF/, '');
}

export function readGuide(uri, opts) {
  const entry = GUIDES.find(g => g.uri === String(uri));
  if (!entry) throw new Error('Unknown SSAM guide resource: ' + uri);
  return { contents: [{ uri: entry.uri, mimeType: entry.mimeType, text: guideText(entry.topic, opts) }] };
}

export function guideIndex() {
  return 'Guides (MCP resources): ' + GUIDES.map(g => g.uri + ' (' + g.title.replace(/^SSAM guide: /, '') + ')').join('; ') + '.';
}
