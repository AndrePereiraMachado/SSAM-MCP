// The code of a refusal that carries none (A20 of the 2026-10-06 package): 37% of the recorded failures were stored as
// OPERATION_FAILED, with no code the model or the friction queue could act on. Two readers share this one table:
//   - the response shaper (responses.mjs shapeToolResult): every `ok:false` (or isError) answer of the ssam server
//     without a code gets one before it reaches the model;
//   - the friction store (facade/friction-store.mjs outcomeOf): what never passed the shaper (an SDK validation error,
//     a protocol error, a CLI line) is classified the same way before falling back to OPERATION_FAILED.
// Pure: no I/O, no clock, no state. The texts are matched, never stored. Order matters: the first rule that matches wins.
//
//   codeFromText(text, {tool})         -> code | null       the text rules alone (a rule bound to some tools needs the tool)
//   refusalCode({tool, value, texts})  -> code | null       text rules, then the stage the answer names, then the tool
//   isCode(value)                      -> boolean           an UPPER_SNAKE code (OK is never a failure code)
// A rule never turns a word of the text into a code, except the debugger's own reasons in the debugger's own answers
// (isDebugTool): any other answer may quote a customer's name (privacy review of 2026-10-12).

export const CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]{3,}$/;
export const isCode = value => typeof value === 'string' && CODE_PATTERN.test(value) && value !== 'OK';

// The refusals of the prototype importer (docs/PROTOTIPO-NATIVO.md 1.4; prototype-op.mjs): the source, the headless
// render, an ambiguity with its ready mapping, a requested name that collides, and an IR or bundle the SSAM itself got
// wrong (ssamDefect). A divergent capture is captured again, never refused: there is no CAPTURE_STALE. data.bind (2.12) refuses
// PROTOTYPE_BINDING_REQUIRED with every list, text and event its producer must cover, each proposal built offline first.
export const PROTOTYPE_CODES = Object.freeze(['PROTOTYPE_SOURCE_INVALID', 'PROTOTYPE_RENDER_FAILED', 'PROTOTYPE_AMBIGUOUS',
  'PROTOTYPE_NAME_COLLISION', 'PROTOTYPE_IR_INVALID', 'PROTOTYPE_BINDING_REQUIRED']);

// The codes of the html op (docs/PROTOTIPO-NATIVO.md 5, H1-H16; kernel HtmlExpander/HtmlVisual/JobPreflight): the refusals
// the page and fragment forms answer with every problem at once, and the warnings of a page that compiles (one per class,
// with counts) that no refusal carries. The css guard of StyleSheetRules answers CSS_RULES_DROPPED (a patched job that lost
// rules of its stylesheet) and warns CSS_VAR_UNDEFINED.
export const HTML_CODES = Object.freeze(['HTML_INVALID', 'HTML_ARGUMENT_INVALID', 'HTML_ATTRIBUTE_SCRIPT', 'HTML_BINDING_INVALID',
  'HTML_BINDING_ORPHAN', 'HTML_CALL_ORDER', 'HTML_CALL_OTHER_SCREEN', 'HTML_CONTENT_EMPTY', 'HTML_CONTROL_DEAD', 'HTML_CSS_ID_SELECTOR',
  'HTML_CSS_INVALID', 'HTML_ID_DUPLICATE', 'HTML_KEY_UNBOUND', 'HTML_KIND_TAG', 'HTML_LIST_TEMPLATE', 'HTML_REFERENCE_UNRESOLVED',
  'HTML_TAG_NOT_ALLOWED', 'CSS_RULES_DROPPED']);
export const HTML_WARNING_CODES = Object.freeze(['CSS_IMPORT_HOISTED', 'CSS_REWRITTEN', 'CSS_VAR_UNDEFINED', 'HTML_ATTRIBUTE_EXTENDED',
  'HTML_CLICKABLE_ELEMENT', 'HTML_CONTROL_LABELLED', 'HTML_KEY_SHARED', 'HTML_LABEL_CHILDREN', 'HTML_SCREEN_ACTION_SAME_JOB',
  'HTML_TABLE_STATIC', 'HTML_VISIBLE_IF']);

// The debugger's tools (ssam_debug, ssam_debug_run, ...) and the friction store's names of them (debug, debug-run,
// debug-invoke). None of them is served by the hosted server (hosted/tools.json: unavailable).
export const isDebugTool = tool => typeof tool === 'string' && /^(?:ssam_debug(?:_[a-z]+)*|debug(?:-[a-z]+)*)$/.test(tool);

// [pattern, code | (match) => code, only?]. Each pattern is linear (no nested quantifiers) and anchored on literal words.
// only(tool): the rule applies to the answers of these tools alone (codeFromText without a tool skips it).
export const TEXT_RULES = Object.freeze([
  // A text that names a prototype code keeps it (a relayed refusal of the importer that lost its object); a capture engine
  // that is not in the release is an SSAM defect of the bundle.
  [/\b(PROTOTYPE_(?:SOURCE_INVALID|RENDER_FAILED|AMBIGUOUS|NAME_COLLISION|IR_INVALID))\b/, m => m[1]],
  [/\bprototype[\\/](?:capture|fidelity)\.mjs\b/, 'PROTOTYPE_IR_INVALID'],
  // A text that names a refusal code of the html op or of the css loss guard keeps it (only the refusals: a warning code
  // in a text never makes it a failure).
  [/\b(HTML_[A-Z]+(?:_[A-Z]+)*|CSS_RULES_DROPPED)\b/, m => (HTML_CODES.includes(m[1]) ? m[1] : null)],
  // The SDK refuses before the handler ("Input validation error: Invalid arguments for tool X: ..."), zod issues
  // (a ZodError's message is its JSON issue list; "Too big: expected ...", "Unrecognized key"), and the ajv messages of
  // fromJsonSchema ("data/budgetBytes must be >= 4096").
  [/Input validation error|Invalid arguments for tool|Unrecognized keys?\b|\bToo (?:big|small): expected\b|\bInvalid input(?::| expected)|\bdata(?:\/[\w$.-]+)* must (?:be|NOT|have|match|equal)\b|"code"\s*:\s*"(?:custom|invalid_type|too_big|too_small|unrecognized_keys|invalid_union|invalid_value|invalid_format|invalid_enum_value)"/, 'INPUT_INVALID'],
  // The debugger answers snake_case reasons (debug_o11_native_execution_failed, debug_odc_native_action_not_found:@k):
  // the reason itself in UPPER_SNAKE, without touching the debugger's files. Only in a debugger tool's answer: in any other
  // ("Invalid object name 'debug_folha_pagamento'.") the word is the customer's, never a code.
  [/\b(debug_[a-z0-9]+(?:_[a-z0-9]+)+)\b/, m => m[1].toUpperCase(), isDebugTool],
  [/dead code: no public entry reaches\b/, 'DEBUG_NO_PUBLIC_ENTRY'],
  // discovery.mjs: a capability pointer that no longer resolves in the extracted sources.
  [/discovery descriptor does not match/, 'DISCOVERY_INDEX_INVALID'],
  // odc-pipe.mjs PipeError texts (the code was lost by a wrapper that kept only the message).
  [/\bis not attached to ODC Studio\b/, 'BRIDGE_NOT_ATTACHED'],
  [/\bstayed busy for \d+ ?s\b/, 'BRIDGE_BUSY'],
  // app-urls.mjs: no runtime origin for the tenant and stage.
  [/\bNo runtime origin for\b/, 'RUNTIME_ORIGIN_MISSING'],
  [/\bsession is no longer connected\b/, 'STUDIO_SESSION_CHANGED'],
  // Atritos 3 (docs/PACOTE-ATRITOS-3.md 5.3): D5, a Service Studio without a main window (an older bridge answers "the
  // Studio has no window"), and C26, a path outside the folders the hosted agent reads.
  [/\b(?:has no main window|the Studio has no window)\b/, 'STUDIO_WINDOWLESS'],
  [/\bis outside the folders the agent reads\b/, 'PATH_OUTSIDE_WORKSPACE'],
  // G11 (FarmaVirtual 2026-10-10, call 131): an @key the reader (ModelReader.Resolve, the 22nd's "Unresolved or ambiguous
  // key") or the map does not resolve in the capture; next-steps.mjs continues to the map under that key. A key that names
  // several elements is KEY_AMBIGUOUS, with no continuation: the map keeps one row per key, and the reader's text names
  // the paths that tell them apart.
  [/\bUnresolved(?: or ambiguous)? key in this (?:snapshot|capture)\b/, 'KEY_UNRESOLVED'],
  [/\bAmbiguous key in this (?:snapshot|capture)\b/, 'KEY_AMBIGUOUS'],
  [/\b(?:timed out|TimeoutException|ETIMEDOUT)\b/, 'TIMEOUT'],
  [/\b(?:SharpZipBaseException|Illegal rep length code)\b/, 'FILE_UNREADABLE'],
  [/\b(?:ENOENT|FileNotFoundException|DirectoryNotFoundException)\b|\bno such file or directory\b/, 'FILE_NOT_FOUND'],
  [/\bUnknown lane\b/, 'LANE_UNKNOWN'],
  [/\bTool [\w-]+ (?:not found|disabled)\b/, 'TOOL_UNKNOWN'],
  // A .NET exception line of a CLI ("ArgumentException: missing --out"): its family.
  [/\bArgumentException\b/, 'ARGUMENT_INVALID'],
  [/\bUnauthorizedAccessException\b/, 'ACCESS_DENIED'],
  [/\bInvalidOperationException\b/, 'OPERATION_INVALID'],
  [/\bIOException\b/, 'IO_FAILED'],
]);

const MAX_TEXT = 4000; // the rules look at the head of a text; a long answer is never scanned whole

export function codeFromText(text, { tool = null } = {}) {
  if (typeof text !== 'string' || !text) return null;
  const head = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  for (const [pattern, code, only] of TEXT_RULES) {
    if (only && !only(tool)) continue;
    const m = pattern.exec(head);
    if (m) { const value = typeof code === 'function' ? code(m) : code; if (isCode(value)) return value; }
  }
  return null;
}

// The step an answer names (failed, stage, gate): BUILD_FAILED, MERGE_FAILED, BASE_DRIFT, STUDIO_BUSY. The quality registry
// (platforms/odc/scripts/quality-registry.mjs) composes the same codes from the step and gate words of the sources with it.
const upper = value => String(value).trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
export function stepCode(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.gate === 'string' && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(value.gate)) return upper(value.gate);
  for (const key of ['failed', 'stage', 'gate']) {
    const step = value[key];
    if (typeof step === 'string' && /^[a-z][a-z0-9-]{1,40}$/.test(step)) { const code = upper(step) + '_FAILED'; if (isCode(code)) return code; }
  }
  return null;
}

// The doctors answer a lane that is not usable; any other tool names itself.
const TOOL_DEFAULT = { ssam_doctor: 'DOCTOR_LANE_UNUSABLE', studio_doctor: 'DOCTOR_LANE_UNUSABLE' };
function toolCode(tool) {
  if (typeof tool !== 'string' || !tool) return null;
  if (TOOL_DEFAULT[tool]) return TOOL_DEFAULT[tool];
  const code = upper(tool) + '_FAILED';
  return isCode(code) ? code : null;
}

// The texts an answer carries: error (a string or {message}), message, reason, detail; and the extra texts the caller
// passes (a plain-text MCP answer).
function textsOf(value, texts = []) {
  const out = [...texts];
  if (value && typeof value === 'object') {
    for (const key of ['error', 'message', 'reason', 'detail']) {
      const v = value[key];
      if (typeof v === 'string') out.push(v);
      else if (v && typeof v === 'object' && typeof v.message === 'string') out.push(v.message);
    }
  } else if (typeof value === 'string') out.push(value);
  return out;
}

// The code of a refusal without one: a refusal with the problems of a job (PREFLIGHT_REFUSED), the text rules over its
// texts, then its step, then the tool (when given).
// `tool` absent (the friction store): null when neither texts nor step name one, so the store keeps OPERATION_FAILED.
// An answer that declares its outcome uncertain is never "failed": OUTCOME_UNCERTAIN (EQUIVALENCE_UNCERTAIN at the
// equivalence gate), the same codes the friction store records.
export function refusalCode({ tool, value, texts = [] } = {}) {
  if (value && typeof value === 'object' && value.outcome === 'uncertain') return value.gate === 'equivalence' ? 'EQUIVALENCE_UNCERTAIN' : 'OUTCOME_UNCERTAIN';
  // primeira-certa A3: a refusal that carries the problems of a job (phase, pointer, fix, patch) is the kernel's single
  // refusal, whatever step it came from: every problem is in it, and patch + basedOn applies them.
  if (value && typeof value === 'object' && Array.isArray(value.problems) && value.problems.some(p => p && typeof p === 'object' && typeof p.code === 'string' && p.severity !== 'warning'))
    return 'PREFLIGHT_REFUSED';
  for (const text of textsOf(value, texts)) { const code = codeFromText(text, { tool }); if (code) return code; }
  return stepCode(value) ?? toolCode(tool);
}
