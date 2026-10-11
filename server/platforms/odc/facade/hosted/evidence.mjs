// Third-party evidence out of hosted answers (docs/O11-BRIDGE-FINA.md 7.2). A job whose base is the capture of a
// customer's module (a fixture listed in fixtures.excluded of scripts/release/client-content.json) proves with that
// customer's evidence; a hosted customer never sees it. thirdPartyJobs() is the set of suite jobs that run on such a
// capture (directly, through a job:<name> chain, or with no declared base) or whose own text names one of the
// publisher's clients; scrubEvidence(result, jobs) takes their evidence out of a tool answer before the gate presents
// it. The proof level of a capability stays: it is a summary, not the evidence. Jobs on neutral fixtures (the blank-*
// bases and the anonymized lane fixture insurance-reactive-r8.oml) keep showing. The hosted image ships neither the
// list nor the captures (.dockerignore), so there nothing is third-party and nothing names one.
import fs from 'node:fs';
import path from 'node:path';
import { anvilRoot, workspaceRoot } from '../workspace.mjs';

export const OMITTED = '<fixture omitida>';
export const CLIENT_OMITTED = '<cliente omitido>';
const JOB_DIRS = ['jobs-odc', 'jobs-odc-negative', path.join('jobs-odc', 'examples')];

// ---- the publisher's list (scripts/release/client-content.json), read once: forbidden[].pattern (the client text the
// release scan looks for) and the stems of fixtures.excluded[].path (the captures of client modules). A release
// folder or the hosted image has no such file: no pattern, no capture.
let list;
function publisherList() {
  if (!list) {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'scripts', 'release', 'client-content.json'), 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stems = (data.fixtures?.excluded ?? []).map(entry => path.basename(String(entry.path ?? '')).replace(/\.oml$/i, '')).filter(Boolean);
    list = { clients: (data.forbidden ?? []).map(entry => new RegExp(entry.pattern, 'gi')), captures: stems.length ? new RegExp(stems.map(escape).join('|'), 'gi') : null };
  }
  return list;
}
export function clientPatterns() { return publisherList().clients; }
const FIXTURE = { test: text => { const re = publisherList().captures; if (!re) return false; re.lastIndex = 0; return re.test(text); } };
const namesClient = text => clientPatterns().some(re => text.search(re) >= 0);

// ---- the set, read once per process (per kernel root)
const sets = new Map();
export function thirdPartyJobs({ kernel = anvilRoot } = {}) {
  const key = path.resolve(kernel);
  if (!sets.has(key)) sets.set(key, readThirdParty(key));
  return sets.get(key);
}

function readThirdParty(kernel) {
  const entries = [];
  for (const dir of JOB_DIRS) {
    const folder = path.join(kernel, 'tests', dir);
    let files = [];
    try { files = fs.readdirSync(folder).filter(file => file.toLowerCase().endsWith('.json')); } catch { continue; }
    // The proven examples are named examples/<job>, as discovery names them; their coverage matrix (no ops) is data.
    const prefix = dir.includes(path.sep) || dir.includes('/') ? 'examples/' : '';
    for (const file of files) {
      let text = '', job = null;
      try { text = fs.readFileSync(path.join(folder, file), 'utf8').replace(/^﻿/, ''); job = JSON.parse(text); } catch { /* unreadable: no declared base */ }
      const object = job && typeof job === 'object' && !Array.isArray(job);
      if (prefix && object && !Array.isArray(job.ops) && !Array.isArray(job.jobs)) continue;
      entries.push({ name: prefix + file.slice(0, -'.json'.length), folder: prefix, base: object ? job.base : undefined, client: namesClient(text) });
    }
  }
  // A job is third-party when its base is the capture, when it declares no base (fail closed), when its own text names
  // a client (its description, notes or expected messages would show it), or when its base is job:<name> of a
  // third-party job: grow the set until nothing changes.
  const set = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, folder, base, client } of entries) {
      if (set.has(name)) continue;
      const chained = typeof base === 'string' && base.startsWith('job:') && (set.has(folder + base.slice(4)) || set.has(base.slice(4)));
      const third = client || typeof base !== 'string' || base.trim() === '' || FIXTURE.test(base) || chained;
      if (third) { set.add(name); grew = true; }
    }
  }
  return set;
}

// ---- the scrub
// A job reference: the bare name, or the job file under tests/jobs-odc[-negative]/ (relative or absolute).
const jobName = value => /(?:^|\/)tests\/jobs-odc(?:-negative)?\/((?:examples\/)?[^/]+)\.json$/i.exec(value.replaceAll('\\', '/'))?.[1] ?? value;
const isJob = (value, jobs) => typeof value === 'string' && jobs.has(jobName(value));
const mentions = value => typeof value === 'string' && FIXTURE.test(value);
const isEvidence = (node, jobs) => node !== null && typeof node === 'object' && !Array.isArray(node)
  && (isJob(node.job, jobs) || mentions(node.path) || mentions(node.base) || mentions(node.fixture));
const replaceFixture = text => { const re = publisherList().captures; return re ? text.replace(re, OMITTED) : text; };
const replaceClients = text => clientPatterns().reduce((current, re) => current.replace(re, CLIENT_OMITTED), replaceFixture(text));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// A discover answer: continuation.omitted stops offering the example of a capability whose example the scrub took out
// (the expansion would come back null as well); an entry left with no part leaves the list.
function dropScrubbedExamples(original, shown) {
  if (!isObject(original?.examples) || !isObject(shown?.examples) || !Array.isArray(shown.continuation?.omitted)) return;
  const gone = new Set(Object.keys(original.examples).filter(id => original.examples[id] != null && shown.examples[id] === null));
  if (!gone.size) return;
  shown.continuation.omitted = shown.continuation.omitted.flatMap(entry => {
    if (!gone.has(entry?.id) || !Array.isArray(entry.parts) || !entry.parts.includes('example')) return [entry];
    const parts = entry.parts.filter(part => part !== 'example');
    return parts.length ? [{ ...entry, parts, expand: `${entry.id}:${parts.join('+')}` }] : [];
  });
}

// An ssam_discover answer with `app` also carries the customer's own module, read from the customer's capture: the
// application context (context) and, in the work packet of the 23rd release (packet:true, ssam-packet/1), the module
// section, the cut that reads it again and the module the next delivery names (servidor/fase4-23). Those parts keep the
// customer's own names, as every other answer does: only the owner's catalogs (capabilities, examples, rules, tools) lose
// client names. The third-party evidence goes out of all of them.
const PACKET = 'ssam-packet/1';
export function scrubDiscover(result, jobs = thirdPartyJobs()) {
  const shown = scrubEvidence(result, jobs, { clientText: true });
  const original = result?.structuredContent;
  if (!isObject(original) || !isObject(shown.structuredContent) || (original.app === undefined && original.context === undefined)) return shown;
  const own = scrubEvidence(result, jobs).structuredContent;
  const out = shown.structuredContent;
  for (const key of ['app', 'context']) if (Object.hasOwn(original, key)) out[key] = own[key];
  if (original.schemaVersion === PACKET) {
    if (Object.hasOwn(original, 'module')) out.module = own.module;
    if (isObject(original.next) && Object.hasOwn(original.next, 'deliver') && isObject(out.next)) out.next = { ...out.next, deliver: own.next?.deliver ?? null };
    if (Array.isArray(original.cuts) && Array.isArray(out.cuts) && Array.isArray(own.cuts) && own.cuts.length === out.cuts.length)
      out.cuts = out.cuts.map((cut, i) => (cut?.section === 'module' ? own.cuts[i] : cut));
  }
  if (Array.isArray(shown.content)) {
    const originalText = JSON.stringify(original);
    shown.content = shown.content.map((item, i) => (result.content[i]?.type === 'text' && result.content[i].text === originalText ? { ...item, text: JSON.stringify(out) } : item));
  }
  return shown;
}

// scrubEvidence(result, jobs, {clientText}) -> a new tool result. In structuredContent, at any depth: a list item that
// is evidence of a job of the set (an object whose job is in the set or whose path, base or fixture names the capture,
// or the job name itself) leaves the list; such an object as a field value becomes null; every other text naming the
// capture gets '<fixture omitida>'. With clientText (an answer made of the owner's catalogs, ssam_discover), every text
// matching a client pattern also gets '<cliente omitido>'; other answers carry the customer's own data and keep it.
// With anything taken out, structuredContent.hostedEvidenceOmitted counts it. A content text that was the JSON of the
// original structuredContent is written again from the cleaned one; other text only gets the replacement.
export function scrubEvidence(result, jobs = thirdPartyJobs(), { clientText = false } = {}) {
  if (!result || typeof result !== 'object') return result;
  const replace = clientText ? replaceClients : replaceFixture;
  let omitted = 0;
  const clean = node => {
    if (typeof node === 'string') return replace(node);
    if (Array.isArray(node)) return node.flatMap(item => (isEvidence(item, jobs) || isJob(item, jobs) ? (omitted++, []) : [clean(item)]));
    if (node !== null && typeof node === 'object')
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [replace(key), isEvidence(value, jobs) ? (omitted++, null) : clean(value)]));
    return node;
  };
  const out = { ...result };
  const original = result.structuredContent;
  if (original !== undefined) {
    out.structuredContent = clean(original);
    if (omitted && isObject(out.structuredContent)) {
      out.structuredContent.hostedEvidenceOmitted = omitted;
      dropScrubbedExamples(original, out.structuredContent);
    }
  }
  if (Array.isArray(result.content)) {
    let originalText;
    out.content = result.content.map(item => {
      if (item?.type !== 'text' || typeof item.text !== 'string') return item;
      if (original !== undefined && item.text === (originalText ??= JSON.stringify(original))) return { ...item, text: JSON.stringify(out.structuredContent) };
      return { ...item, text: replace(item.text) };
    });
  }
  return out;
}
