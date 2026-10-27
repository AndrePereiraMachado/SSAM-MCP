// The prototype import is turned off (owner decision of 2026-10-22). A job, or the code of a job, with the op `prototype`
// is refused before any Studio, build or kernel work, with ONE refusal: PROTOTYPE_IMPORT_DISABLED, the same on the O11 and
// ODC lanes, in the CLI and in the MCP. Its continuation is the supported path for screens: the html op written through
// ssam_code (part html, the ssam-html/1 text), an existing screen read with ssam_map view html, and ssam_discover for the rest.
// The kernel refuses the op the same way (kernel/src/Anvil.Core/Kernel/Prototype/PrototypeImport.cs), so a job that reaches
// it by another path gets the same code and text.
//
//   prototypeOpSites(document, {readPart})        the ops `prototype` of a job ({ops}, an array of ops, or a composite
//                                                 {jobs:[...]} whose parts readPart reads), each with its pointer
//   prototypeImportRefusal(document, options)     the refusal, or null when the job has no such op
//   prototypeImportRefusalOfFile(file, options)   the same for a job file (its composite parts read beside it)
//
// Pure but for the job files read here: no Studio, no kernel, no clock.
import fs from 'node:fs';
import path from 'node:path';
import { partReader } from './text-routes.mjs';

export const PROTOTYPE_IMPORT_DISABLED = 'PROTOTYPE_IMPORT_DISABLED';
// The kernel mirrors these texts word for word (PrototypeImport.cs).
export const PROTOTYPE_DISABLED_MESSAGE = 'The prototype import is turned off: the op prototype is no longer supported, and nothing ran (no Studio, build or kernel work).';
export const PROTOTYPE_DISABLED_FIX = 'Remove the op prototype and build each screen with the html op: write it as ssam-html/1 text with ssam_code (part html, action write; '
  + 'action grammar gives the syntax and an example), read an existing screen with ssam_map view html, and ask ssam_discover for anything else.';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const LANES = new Set(['o11', 'odc']);

export function prototypeOpSites(document, { readPart = null } = {}) {
  const sites = [];
  const visit = (doc, prefix, seen) => {
    if (isObject(doc) && Array.isArray(doc.jobs)) {
      doc.jobs.forEach((spec, k) => {
        const where = `${prefix}/jobs/${k}`;
        if (isObject(spec) || Array.isArray(spec)) { visit(spec, where, seen); return; }
        if (typeof spec !== 'string' || !readPart || seen.has(spec)) return;
        let part = null;
        try { part = readPart(spec); } catch { part = null; }
        if (part != null) visit(part, where, new Set([...seen, spec]));
      });
      return;
    }
    const array = Array.isArray(doc);
    const ops = array ? doc : isObject(doc) && Array.isArray(doc.ops) ? doc.ops : [];
    ops.forEach((op, i) => { if (isObject(op) && op.op === 'prototype') sites.push({ op: i, pointer: (array ? prefix : prefix + '/ops') + '/' + i }); });
  };
  visit(document, '', new Set());
  return sites;
}

// The supported path for screens, as the calls of the lane (module filled when the call names it).
export function screenCalls(lane, module = null) {
  const target = typeof module === 'string' && module.trim() ? module.trim() : '<Module>';
  return {
    grammar: { tool: 'ssam_code', arguments: { lane, action: 'grammar', part: 'html' },
      why: 'the prototype import is turned off; screens are built with the html op: this gives the ssam-html/1 syntax and a from-scratch example' },
    write: { tool: 'ssam_code', arguments: { lane, action: 'write', module: target, part: 'html', text: '<screen Name>...</screen>' },
      why: 'writes each new screen as ssam-html/1 (the html op), delivered to the open module in one call' },
    read: { tool: 'ssam_map', arguments: { lane, target, view: 'html', screen: '<Screen>' },
      why: 'reads an existing screen as ssam-html/1 with the ready edit call' },
    discover: { tool: 'ssam_discover', arguments: { lane, intent: 'create a screen <Name> with <what it shows>' },
      why: 'the routes and contracts of the screen work' },
  };
}

export function prototypeImportRefusal(document, { lane = 'o11', module = null, readPart = null } = {}) {
  const sites = prototypeOpSites(document, { readPart });
  if (!sites.length) return null;
  const l = LANES.has(lane) ? lane : 'o11';
  const calls = screenCalls(l, module);
  return {
    ok: false, code: PROTOTYPE_IMPORT_DISABLED, error: PROTOTYPE_DISABLED_MESSAGE + ' ' + PROTOTYPE_DISABLED_FIX,
    problems: sites.map(({ op, pointer }) => ({ op, pointer, code: PROTOTYPE_IMPORT_DISABLED, severity: 'error', phase: 'preflight',
      message: 'op #' + op + ' (prototype): ' + PROTOTYPE_DISABLED_MESSAGE, fix: PROTOTYPE_DISABLED_FIX })),
    continuation: calls.grammar,
    nextCalls: [calls.write, calls.read, calls.discover],
  };
}

export function prototypeImportRefusalOfFile(file, options = {}) {
  let document = null;
  try { document = JSON.parse((t => (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t))(fs.readFileSync(file, 'utf8'))); } catch { return null; }
  return prototypeImportRefusal(document, { ...options, readPart: options.readPart ?? partReader(path.resolve(file), fs, path) });
}
