// The exposure profile of a server (fix/no-internals, 17/10/2026): what an answer may tell about how SSAM is BUILT.
// Two profiles, one rule, one place (the hub's exit, ssam.mjs exposeHandler, as resultWithoutWordEchoes is for the words):
//   owner     the owner's local server: every answer as the tool built it (today's behaviour, the default locally).
//   licensee  a licensee's session (the default of a hosted server): an answer keeps everything needed to USE SSAM and
//             loses what tells how SSAM is BUILT (server paths, source files, kernel classes, stack traces, suite paths,
//             commands and counts, proof levels and stamps, run dates and sessions, round and review names, blind tests,
//             owner decisions, project documents, how a work packet is assembled).
//
// Round 2 (review C:\t\revisoes\no-internals\REVISAO.md, HIGH 1 and MEDIUM 2): the rule acts ONLY on what SSAM itself
// writes, by field, never by a regular expression over every string:
//   - USE is never touched: the strings under the code keys (ops, patch, arguments, Signature, Examples, default,
//     condition, value, set, contracts, the text of an example or a card, the data of a contract lookup...) and every
//     field of the customer's content (names, paths and keys of a module map, an inspect, records, Portal pages);
//   - SSAM's documentation (the answers of ssam_reference and ssam_discover, and any object whose schemaVersion is a
//     discovery, a job guidance or a work packet, wherever it travels) loses its internal fields AT THEIR PATHS (the index
//     identity, the evidence rule, proof lists, stamps, limits[].origin, a packet's assembly rule, a cut's counts, the
//     matched words) and its prose fields (description, text, note, why, rule, reason, guidance...) lose internal names;
//     a proof level becomes one seal;
//   - SSAM's runtime prose (error, message, fix, note, hint, why of any tool) loses only server paths, source files,
//     stack frames and kernel classes (Anvil.*), never a word of the customer's;
//   - a state report (ssam_doctor, studio_doctor) loses its server paths in every field;
//   - a handle (a whole value under a .local work folder: a job, an answer page, a reference file) and the arguments of
//     every call stay exactly as they are.
// Every change a licensee receives is declared here (LICENSEE_CHANGES) and in the server instructions of that profile.
// Pure: no I/O. The only state is the handle roots the caller passes.
import path from 'node:path';

export const EXPOSURES = Object.freeze(['owner', 'licensee']);
// SSAM_EXPOSURE=owner|licensee; unset: owner (a hosted server passes licensee itself).
export function exposureOf(env = process.env, fallback = 'owner') {
  const value = typeof env?.SSAM_EXPOSURE === 'string' && env.SSAM_EXPOSURE.trim() ? env.SSAM_EXPOSURE.trim() : fallback;
  if (!EXPOSURES.includes(value)) throw new Error('SSAM_EXPOSURE must be one of ' + EXPOSURES.join(', ') + ' (got ' + JSON.stringify(value) + ')');
  return value;
}

// What a licensee receives differently, declared (the owner's rule: never change what the model receives in silence).
export const LICENSEE_CHANGES = Object.freeze([
  'only fields SSAM writes change; code (ops, patches, expressions, signatures, contracts, example texts) and the customer\'s content never do',
  'paths of the server that are no handle become <server>; a handle (a job, an answer page, a reference file) and the arguments of every call stay as they are',
  'a suite job path in SSAM\'s documentation becomes its example id (ssam_reference {kind:"example", query:"<id>"} returns it)',
  'in SSAM\'s documentation, evidence and proof levels become one seal (proven, refused, not proven, undetermined); proof lists, stamps, mismatches, limit origins and the index identity are left out; guidance and limits stay',
  'stack frames, source file names, kernel class names, suite commands, run dates and sessions, round and review names, owner decisions, blind tests and project document names are left out of SSAM\'s prose',
  'ssam_reference answers usage references by part: a whole document becomes its list of parts with the call for each one, within a byte limit per call and per day',
]);
export const LICENSEE_INSTRUCTION = 'Answers carry what you need to use SSAM: grammars, op contracts, examples by id with the seal "proven", '
  + 'refusals with fix, patch and continuation. Paths of the server that you never pass back read <server>.';

const MARK = '<server>';
// ---- the fields
// Tools whose whole answer is SSAM's documentation.
const DOC_TOOLS = new Set(['ssam_reference', 'ssam_discover']);
// An object of SSAM's documentation wherever it travels (a job's discovery, a discover page read back with ssam_evidence).
const DOC_SCHEMA = /^ssam-(?:discovery|job-guidance|packet|packet-part)\//;
// State reports: every field is SSAM's. Round 5 (re-review round 4, LOW 4): ssam_friction, SSAM's own queue (answered by the
// launcher, facade/launch.mjs frictionAnswerShaper; a report names the queue folder).
const REPORT_TOOLS = new Set(['ssam_doctor', 'studio_doctor', 'ssam_friction']);
// Code: never touched, at any depth below them.
const CODE_KEYS = new Set(['ops', 'patch', 'patchByName', 'arguments', 'Signature', 'Examples', 'default', 'condition', 'value', 'set',
  'contract', 'contracts', 'definition', 'content', 'expression', 'expressions', 'code', 'ddl', 'flow', 'html', 'files',
  'route', 'operation', 'address', 'call', 'calls', 'expand', 'grammar', 'card', 'job', 'jobs', 'bindings', 'native', 'nextBasedOn', 'basedOn']);
// The customer's records: code outside SSAM's documentation (where rows are SSAM's own tables).
const DATA_KEYS = new Set(['records', 'rows', 'data', 'items', 'values', 'elements', 'nodes', 'children', 'properties']);
// The data of a lookup of the kernel's contracts (api, functions, ui-block, types, where-can, verify-message): code.
const CONTRACT_KINDS = new Set(['api', 'functions', 'ui-block', 'types', 'where-can', 'verify-message', 'tool']);
// A check of the customer's own job or delivery answers about the customer's job: runtime prose, never documentation.
const CHECK_KINDS = new Set(['check-job', 'check-delivery']);
// SSAM's prose in its documentation.
const DOC_PROSE = new Set(['description', 'text', 'note', 'notes', 'why', 'title', 'rule', 'recover', 'reason', 'summary', 'scope', 'guidance',
  'use', 'work', 'batch', 'how', 'after', 'error', 'message', 'fix', 'hint', 'proof', 'evidence', 'alternative', 'caution', 'deliver',
  'source', 'doc', 'readWhy', 'parallel', 'when', 'choose', 'warning', 'warnings', 'reduced', 'status', 'rows']);
// SSAM's prose in any answer. Round 5 (re-review round 4, LOW 3): `scope`, the sentence that says what a check covers.
// Round 6 (re-review round 5, LOW 3; D17): the lists of SSAM's prose (a JOB_INVALID check repeats its problems in errors[]).
const RUNTIME_PROSE = new Set(['error', 'message', 'fix', 'note', 'hint', 'why', 'warning', 'next', 'recover', 'detail', 'reason', 'scope',
  'errors', 'warnings', 'messages', 'notes', 'hints', 'details', 'reasons']);
// SSAM's own path fields in its documentation (a suite path becomes an id, a server path <server>).
const DOC_PATHS = new Set(['path', 'base', 'proof', 'source', 'doc', 'report', 'file', 'studioDirectory', 'studioDir']);
// Internal fields at the paths where they are internal (documentation only).
const DOC_DROP = new Set(['identity', 'evidenceRule', 'keyStrategy', 'nativeRuntime', 'provenance', 'mismatches', 'executedAt', 'provenBy',
  'verifiedQualified', 'proofs', 'kernelSha256', 'fixtureSha256', 'nativeAssemblies', 'builtAt', 'suite', 'testWork']);
const DOC_TOP_DROP = new Set(['coverage', 'basis']);
// The proof levels and evidence values, as one seal (documentation only).
const SEALS = Object.freeze({
  'proven-current': 'proven', 'proven-historical': 'proven', 'proven-scoped': 'proven', 'C-executed-current': 'proven',
  'C-executed-historical': 'proven', 'C-executed': 'proven', 'C-suite': 'proven', 'refusal-proven': 'refused', 'refusal-declared': 'refused',
  declared: 'not proven', 'declared-not-proven': 'not proven',
});
const STATES = Object.freeze({ 'blind-test-pending': 'not offered' });

// ---- the texts
const INTERNAL_MARK = new RegExp([
  String.raw`\b20\d\d-\d\d-\d\d\b`, String.raw`\bcold session\b`, String.raw`\bround \d+\b`, String.raw`\binvestigation of\b`,
  String.raw`\bowner's\b`, String.raw`\b(?:CX|PA|FA)\d{1,3}\b`, String.raw`\b[A-Z]\w*(?:Tests|Scenarios)\b`, String.raw`\.(?:cs|mjs|py|ps1)\b`,
  String.raw`\bkernel[\\/]`, String.raw`\btests[\\/]`, String.raw`\bNAO-DA\b`, String.raw`\bprovenance\b`, String.raw`\bstamp`,
  String.raw`\bINT-[A-Z0-9]`, String.raw`\bblind tests?\b`, String.raw`\bauthor's report\b`, String.raw`\bwf_[0-9a-f]{6}`, String.raw`\bD-M\d`,
].join('|'));
const BLIND = /\b(?:independent )?blind[- ]tests?\b|\bauthor's report\b/i;
const INTERNAL_SENTENCE = new RegExp(BLIND.source + String.raw`|\bno stamp\b|\bstamped\b`, 'i');
const SENTENCES = /((?<=;)[ \t]+|(?<=\.)[ \t]+(?=[A-Z]))/;
// a stack frame: indented "at Name.Space.Method(...)" with or without " in <file>:line N"
const STACK_FRAME = /^[ \t]+at [\w.$`<>[\],]+\([^)\r\n]*\)(?: in [^\r\n]*)?(?:\r?\n|$)/gm;
const SUITE_JOB = /\b(?:kernel[\\/])?tests[\\/](?:jobs-odc-negative|jobs-negative|jobs-odc|jobs)[\\/](?:examples[\\/])?([\w.-]+?)\.json\b/g;
const SUITE_HTML = /\b(?:kernel[\\/])?tests[\\/]html[\\/]([\w.\\/-]+?\.html)\b/g;
const SUITE_DIR = /`?\b(?:kernel[\\/])?tests[\\/](?:jobs-odc-negative|jobs-negative|jobs-odc|jobs|html)(?:[\\/]examples)?\b`?(?![\\/]\w)|\bjobs-(?:odc-)?negative\b/g;
const SUITE_FIXTURE = /\b(?:kernel[\\/])?tests[\\/]fixtures[\\/](?:[\w.-]+[\\/])*([\w.-]+\.(?:oml|json|wsdl|yaml|yml|xif))\b/g;
// Round 6 (re-review round 5, LOW 4; D17): a folder of the suite's fixtures (after its files became their names), and a path
// the kernel writes under its own placeholder (<kernel>/.local/**/snapshots|downloads|...), tell how SSAM is laid out.
const SUITE_FIXTURE_DIR = /`?\b(?:kernel[\\/])?tests[\\/](?:fixtures|Shared)(?:[\\/][\w-]+)*`?/g;
const KERNEL_PLACEHOLDER = /<kernel>[\\/][\w.*\\/|-]*/g;
// The suite's paths in SSAM's prose: a job becomes its id, an html source html/<file>, a fixture its file name, a folder of
// examples "the proven examples", a folder of fixtures "the SSAM fixtures".
const suitePaths = out => out.replace(SUITE_JOB, '$1').replace(SUITE_HTML, (m, p) => 'html/' + p.replace(/\\/g, '/')).replace(SUITE_FIXTURE, '$1')
  .replace(SUITE_DIR, 'the proven examples').replace(/the proven examples(?:(?:, | or | and )the proven examples)+/g, 'the proven examples')
  .replace(SUITE_FIXTURE_DIR, 'the SSAM fixtures').replace(KERNEL_PLACEHOLDER, MARK);
const WIN_PATH = /(?<![\w])[A-Za-z]:[\\/](?:[^\\/"'`<>|*?\r\n]*[\\/])*[^\\/\s"'`<>|*?,;)\]]*/g;
const UNC_PATH = /\\\\[\w.$-]+\\(?:[^\\"'`<>|*?\r\n]*\\)*[^\\\s"'`<>|*?,;)\]]*/g;
// servidor/fase4-26 a7 phase 3 (review vps-a7-2 B4): the layout of the Linux image too, its temp folder (/tmp, also HOME) and
// its volumes (/data/server, /data/cache, /data/friction, /data/odc-features: docker/ssam-server/Dockerfile and the SSAM-MCP
// image). Only the volumes of /data: a JSON pointer of SSAM's own prose (/data/results, /data/html) is no path.
const POSIX_PATH = /(?<![\w.:/~-])\/(?:studio|opt|srv|var|home|root|usr|etc|mnt|app|workspace|customers|tmp|data\/(?:server|cache|friction|odc-features))(?:\/[^\s"'`<>|,;)\]]*)?/g;
const DOC_REPO_PATH = /(?<![\w./\\-])(?:kernel|platforms|facade|scripts|publisher|tools|docs|src|\.local)[\\/][\w.*\\/-]+(?::\d+(?:-\d+)?)?/g;
const RUNTIME_REPO_PATH = /(?<![\w./\\-])(?:kernel|platforms|\.local)[\\/][\w.*\\/-]+(?::\d+(?:-\d+)?)?|(?<![\w./\\-])docs[\\/][\w.-]+\.md\b/g;
const SOURCE_FILE = /\b[\w.*-]+\.(?:cs|mjs|py|ps1|csproj|sln)\b(?::line \d+|:\d+(?:-\d+)?|#L\d+|\(\d+(?:,\d+)?\))?/g;
const ANVIL = /\bAnvil\.[A-Z][\w.]*/g;
const SUITE_CLASS = /(?<![$.\w])[A-Z]\w*(?:Tests|Scenarios)\b(?:\.\w+)*/g;
const ROUND = /\b(?:CX|PA|FA)\d{1,3}\b(?:\s*(?:r|round|review)\s*\d+)?|\bD-M\d+-\d+\b|\bwf_[0-9a-f-]{6,}\b|\bINT-[A-Z0-9-]+\b/g;
const PROJECT_DOC = /\b(?:PLANO|NAO-DA|DECISOES|RETOMADA|HANDOFF|CONHECIMENTO-DO-TIME|COBERTURA-EXEMPLOS-(?:O11|ODC))[\w-]*(?:\.md)?(?::\d+(?:-\d+)?)?/g;
const SUITE_COMMAND = /\bdotnet test\b[^;\r\n)]*/g;
// Round 6 (re-review round 5, LOW 5; D17): a reference to a project document tells a licensee nothing he can use. A
// parenthetical that holds only such references is left out, and so is a sentence that only points to one ("See docs/X.md.",
// "See docs/X.md for the verified contract.", "Live coverage and restrictions: docs/X.md."), before any other step.
const DOC_REF = String.raw`(?:(?:kernel|platforms[\\/]odc)[\\/])?docs[\\/][\w.-]+\.md\b|\b(?:PLANO|NAO-DA|DECISOES|RETOMADA|HANDOFF|CONHECIMENTO-DO-TIME|COBERTURA-EXEMPLOS-(?:O11|ODC))[\w-]*\.md\b`;
const REF_PAREN = new RegExp(String.raw` ?\((?:see )?(?:${DOC_REF})(?:(?:,| and| or) (?:${DOC_REF}))*\)`, 'gi');
const REF_SENTENCE = new RegExp(String.raw`(?:^|(?<=[.;!?])[ \t]+)(?:See (?:also )?(?:${DOC_REF})[^.;!?\r\n]*|[A-Z][^.;:!?\r\n]{0,80}: (?:${DOC_REF})(?=[.;]?(?:[ \t]|$)))[.;]?`, 'g');
const withoutDocReferences = text => text.replace(REF_PAREN, '').replace(REF_SENTENCE, '');
// Round 6b (re-review round 6, LOW 1) and 6c (the Integradora: all the documentation a licensee is served): the internal
// names of the kernel and of the project, in SSAM's documentation prose and in a tool definition alike. A parenthetical
// that is the kernel's CLI or one of its command lines ("(anvil-odc)", "(anvil-odc census --oml <capture>)") is left out
// and a quoted command line of it reads SSAM ("by `anvil-odc verify-catalog --out`" reads "by SSAM"); a state folder of the
// server (%USERPROFILE%\.ssam-hybrid\..., %LOCALAPPDATA%\SSAM...), an ANVIL_* variable and a kernel file are <server>; the
// kernel's own name (Anvil, anvil-odc) and a folder of the project (SSAM-Hybrid-ODC) read SSAM, the product the licensee
// uses ("the SSAM fixtures", "which SSAM reads as ...", "(SSAM signature)"); an environment of the owner (personal-<id>)
// reads the placeholder personal-xxxx the catalog itself uses. An Anvil.<Class> is the kernel class rule's (<server>). A
// vault entry name (SSAM/ODC3/<tenant>/...) is an identifier a tool reads: it stays. Code never passes here.
const KERNEL_PAREN = / ?\(anvil(?:-odc)?(?:\s[^()]*?\s--?[\w-][^()]*)?\)/g;
const KERNEL_TICKS = /`anvil(?:-odc)?\b[^`\r\n]*`/g;
const STATE_PATH = /(?:%[A-Z_]+%|~)[\\/][^\s"'`<>|*?,;)\]]*|\.ssam-hybrid(?:[\\/][^\s"'`<>|*?,;)\]]*)?/g;
const KERNEL_ENV = /\bANVIL_[A-Z0-9_]+\b/g;
const KERNEL_FILE = /\banvil[\w-]*\.(?:dll|exe|cmd)\b/gi;
const KERNEL_NAME = /\banvil(?:-odc)?\b(?!\.[A-Za-z])/gi;
const PROJECT_FOLDER = /\bSSAM-Hybrid(?:-\w+)*\b/g;
const OWNER_ENVIRONMENT = /\bpersonal-(?!xxxx\b)[a-z0-9]{5,}\b/g;
const withoutInternalNames = text => text.replace(KERNEL_PAREN, '').replace(KERNEL_TICKS, 'SSAM').replace(STATE_PATH, MARK).replace(KERNEL_ENV, MARK)
  .replace(KERNEL_FILE, MARK).replace(KERNEL_NAME, 'SSAM').replace(PROJECT_FOLDER, 'SSAM').replace(OWNER_ENVIRONMENT, 'personal-xxxx');
const OWNER = /\b(?:[Tt]he )?owner's (?:decision|rule|approval)\b/g;

// The handle test: a path a later call takes back (a job, an answer page, a reference file, a capture under a root the
// caller names). Folders of the suites, the CLIs and the caches under those roots are no handle.
// A WHOLE value that is a path on a machine (a drive, a share, a server folder): never a line of text such as a /// comment.
// (a7 phase 3, B4: the volumes of the Linux image's /data too)
const PATH_VALUE = /^(?:[A-Za-z]:[\\/]|\\\\[\w.$-]+\\|\/(?:studio|opt|srv|var|home|root|usr|etc|mnt|app|workspace|customers|tmp|Users|data\/(?:server|cache|friction|odc-features))\/)[^\r\n<>|"*?]*$/;
const isServerPath = value => typeof value === 'string' && PATH_VALUE.test(value);
const NOT_HANDLE =/[\\/](?:cli|test-work|discovery|readers|builder|bin|obj|lane-[\w-]+[\\/]cli)(?:[\\/]|$)/i;
export function handleTest(roots = []) {
  const prefixes = roots.filter(r => typeof r === 'string' && r).map(r => path.resolve(r).replace(/[\\/]+$/, '').toLowerCase());
  return text => {
    if (typeof text !== 'string' || !path.isAbsolute(text)) return false;
    const lower = path.resolve(text).toLowerCase();
    // a file or folder BELOW a root (the root itself is a server folder, never a handle)
    return prefixes.some(p => (lower.startsWith(p + '\\') || lower.startsWith(p + '/')) && !NOT_HANDLE.test(lower.slice(p.length)));
  };
}
const tidy = out => out.replace(/(?:<server>[\s,/\\:*]*){2,}/g, MARK + ' ').replace(/`<server>`/g, MARK)
  // (round 6: a space goes before a closing parenthesis, and before , . ; : only when they end a phrase: " .avsig" stays)
  .replace(/(?<=\S)[ \t]{2,}/g, ' ').replace(/ +([,.;:](?=\s|$)|\))/g, '$1').replace(/,\s*,/g, ',').replace(/\r?\n{3,}/g, '\n\n');
const paths = out => out.replace(WIN_PATH, MARK).replace(UNC_PATH, MARK).replace(POSIX_PATH, MARK);

/** SSAM's runtime prose (an error, a message, a fix...): server paths, source files, stack frames and kernel classes only. */
export function scrubRuntimeText(text, { isHandle = () => false } = {}) {
  if (typeof text !== 'string' || !text || isHandle(text.trim())) return text;
  let out = withoutDocReferences(text.replace(STACK_FRAME, ''));
  // (round 6, LOW 4: the suite's paths too, as in the documentation)
  out = paths(suitePaths(out)).replace(RUNTIME_REPO_PATH, MARK).replace(SOURCE_FILE, MARK).replace(ANVIL, MARK);
  if (out === text) return text;
  return tidy(out).trim();
}
/** SSAM's documentation prose (rules, descriptions, notes of the reference and the discover). */
export function scrubText(text, { isHandle = () => false, suiteNames = null } = {}) {
  if (typeof text !== 'string' || !text || isHandle(text.trim())) return text;
  // (round 6c: the internal names of the kernel and of the project, as in a tool definition)
  let out = withoutInternalNames(withoutDocReferences(text.replace(STACK_FRAME, '')));
  // a sentence part that only says how a proof was made (a blind test, a stamp, the author's report) is left out
  if (INTERNAL_SENTENCE.test(out)) {
    const parts = out.split(SENTENCES); let kept = '';
    for (let i = 0; i < parts.length; i += 2) if (!INTERNAL_SENTENCE.test(parts[i])) kept += (kept ? parts[i - 1] ?? ' ' : '') + parts[i];
    out = kept;
    if (!out.trim() && BLIND.test(text)) out = 'not offered yet';
  }
  out = suitePaths(out);
  // a parenthetical that only says where, when or by whom something was proven (a date literal #2026-01-31# is the language's)
  out = out.replace(/ ?\(([^()]{0,600})\)/g, (m, inner) => (INTERNAL_MARK.test(inner.replace(/#[^#\r\n]*#/g, '')) ? '' : m));
  out = paths(out).replace(SUITE_COMMAND, MARK).replace(DOC_REPO_PATH, MARK).replace(SOURCE_FILE, MARK).replace(ANVIL, MARK)
    .replace(SUITE_CLASS, m => (!suiteNames || suiteNames.has(m.split('.')[0]) ? MARK : m)).replace(PROJECT_DOC, MARK).replace(ROUND, '').replace(OWNER, 'the rule')
    .replace(/\blexical,\s*|,\s*lexical\b/g, ''); // the name of the matcher's section, in a recovery hint
  if (out === text) return text;
  return tidy(out).trim();
}
// A string that held only internal names becomes nothing (its field is left out).
const emptied = (before, after) => after !== before && (!after.replace(/<server>|[\s,.;:()`'"/\\-]/g, '') || after === MARK);
const DROP = Symbol('drop');
const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const isCall = v => isObject(v) && typeof v.tool === 'string' && isObject(v.arguments);

// ctx: {mode: 'doc'|'runtime'|'report', isHandle, contractData}
function scrubString(value, key, ctx) {
  if (ctx.mode === 'doc') {
    if ((key === 'evidence' || key === 'level') && Object.hasOwn(SEALS, value)) return SEALS[value];
    if (key === 'state' && Object.hasOwn(STATES, value)) return STATES[value];
    if (DOC_PROSE.has(key) || DOC_PATHS.has(key)) { const after = scrubText(value, ctx); return emptied(value, after) ? DROP : after; }
    return ctx.isHandle(value.trim()) || !isServerPath(value.trim()) ? value : MARK;
  }
  if (ctx.mode === 'report') {
    const whole = value.trim();
    if (isServerPath(whole)) return ctx.isHandle(whole) ? value : MARK;
  }
  if (RUNTIME_PROSE.has(key)) return scrubRuntimeText(value, ctx);
  return value;
}
function scrub(value, ctx, key = null, depth = 0) {
  if (typeof value === 'string') return key === null && ctx.mode !== 'doc' ? value : scrubString(value, key, ctx);
  if (Array.isArray(value)) {
    if (ctx.mode === 'doc' && key === 'why' && value.every(v => typeof v === 'string')) return DROP; // the matched words
    // Round 6 (re-review round 5, LOW 3; D17): a string in a list is read like a string under the list's key, in every mode
    // (a list of prose is prose, a report's list of paths is paths); before, only the prose lists of the documentation were.
    return value.map(v => (typeof v === 'string' ? scrubString(v, key, ctx) : scrub(v, ctx, key, depth + 1))).filter(v => v !== DROP);
  }
  if (!isObject(value)) return value;
  const mode = typeof value.schemaVersion === 'string' && DOC_SCHEMA.test(value.schemaVersion) ? 'doc' : ctx.mode;
  const here = mode === ctx.mode ? ctx : { ...ctx, mode };
  const top = mode === 'doc' && (here !== ctx || depth === 0);
  if (mode === 'doc' && key === 'evidence') {
    // an evidence object: its level as the seal, its guidance and limits as prose, its proofs out
    const level = value.level ?? value.evidence;
    if (typeof level === 'string' && SEALS[level]) value = { ...value, level: SEALS[level] };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    // the arguments of a call and every code key: exactly as they are
    // ssam_evidence returns a file SSAM wrote (an answer page, a result, a reference file): its value and items are read
    // as an answer of their own (a refused job's stderr, a discovery inside it), not as code
    if (ctx.evidenceRoot && depth === 0 && (k === 'value' || k === 'items')) {
      // (round 3, MEDIUM A: a reference file is documentation, its prose scrubbed and its internal fields out; only its code
      // keys stay as they are, as in an inline ssam_reference answer)
      const next = scrub(v, { ...here, evidenceRoot: false }, null, 0);
      if (next !== DROP) out[k] = next;
      continue;
    }
    // (a verb of an operations map, such as set, is no code key)
    if (k === 'arguments' && isCall(value)) { out[k] = v; continue; }
    // (round 6, LOW 5: the definition of a tool is documentation, its schema code; exposedToolDefinition reads both)
    if (k === 'definition' && value.schemaVersion === 'ssam-tool-definition/1' && isObject(v)) { out[k] = exposedToolDefinition(v, here); continue; }
    if (CODE_KEYS.has(k) && key !== 'operations') { out[k] = here.mode === 'doc' ? docCode(k === 'native' ? withoutRuntimeProvenance(v) : v, here) : v; continue; }
    if (here.mode === 'doc') {
      if (DOC_DROP.has(k)) continue;
      if (top && DOC_TOP_DROP.has(k)) continue;
      if (k === 'data' && here.contractData) { out[k] = docCode(v, here); continue; }
      if (k === 'origin' && key === 'limits') continue; // limits[].origin: the suite jobs that proved a limit
      if (k === 'rule' && key === 'packet') continue; // how a work packet is assembled
      if (k === 'left' && key === 'cuts') continue; // the counts a cut leaves (how many rules a packet holds)
      if (k === 'source' && isObject(v) && ('index' in v || 'builtAt' in v)) continue; // the index a guidance came from
      if (k === 'report' && typeof v === 'string' && (isServerPath(v) || /\.md$/i.test(v))) continue;
      if (k === 'reason' && typeof v === 'string' && BLIND.test(v)) continue;
      if (k === 'summary' && typeof v === 'string' && /\bcoverage\b|\bhistorical\b/.test(v)) continue;
    } else if (depth === 0 && (k === 'stderr' || k === 'stack')) continue; // the kernel's own stderr of a refused run
    // the text of an example or of a card is code (a DDL, a flow, an html source)
    if (here.mode === 'doc' && k === 'text' && (key === 'example' || key === 'card') && typeof v === 'string') { out[k] = v; continue; }
    // (round 5, LOW 3: the data of a check is SSAM's answer about the customer's job or delivery, never the customer's
    // records: it follows the runtime rule, so its prose loses kernel classes, source files and server paths)
    if (here.mode !== 'doc' && DATA_KEYS.has(k) && !(k === 'data' && here.checkData && depth === 0)) { out[k] = v; continue; }
    const next = scrub(v, here, k, depth + 1);
    if (next !== DROP) out[k] = next;
  }
  if (here.mode === 'doc' && Array.isArray(out.historical) && Array.isArray(out.proven)) { out.proven = [...out.proven, ...out.historical]; delete out.historical; delete out.text; delete out.coverage; }
  return out;
}
// The code of SSAM's own documentation (a suite job's ops, a contract): every string stays, except a WHOLE value that is a
// path SSAM itself wrote (a fixture of its suites becomes its file name, a suite job its id, a server folder <server>).
const SUITE_PATH_WHOLE = /^(?:kernel[\\/])?tests[\\/](?:fixtures|jobs-odc-negative|jobs-negative|jobs-odc|jobs|html)[\\/]/;
function docCode(value, ctx) {
  if (typeof value === 'string') {
    const whole = value.trim();
    if (SUITE_PATH_WHOLE.test(whole)) return whole.replace(SUITE_JOB, '$1').replace(SUITE_HTML, (m, p) => 'html/' + p.replace(/\\/g, '/')).replace(SUITE_FIXTURE, '$1');
    return isServerPath(whole) && !ctx.isHandle(whole) ? MARK : value;
  }
  if (Array.isArray(value)) return value.map(v => docCode(v, ctx));
  return isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isCall(value) && k === 'arguments' ? v : docCode(v, ctx)])) : value;
}
// Round 6 (re-review round 5, LOW 5; D17): a tool's definition (the listing a licensee is served, ssam_reference {kind:"tool"})
// is SSAM's documentation: every description in it (the tool's, and those of its schemas) loses its internal names
// (scrubDefinitionText); names, titles, types, enums, patterns, defaults and examples stay as they are. A description that
// held only internal names is left out.
const DEFINITION_VALUES = new Set(['default', 'examples', 'example', 'enum', 'const']);
// The prose of a definition is a rule of use written for the model (a parenthetical with "the owner's reply" is how a delete
// is confirmed): only the internal names leave it (a reference to a project document, a path of the repository, the suite or
// the server, a kernel class, a project document, a round name, a suite class, and the internal names of the kernel and of
// the project: withoutInternalNames, rounds 6b and 6c), never a sentence or a parenthetical of use.
function scrubDefinitionText(text, { isHandle = () => false, suiteNames = null } = {}) {
  if (typeof text !== 'string' || !text || isHandle(text.trim())) return text;
  const out = withoutInternalNames(paths(suitePaths(withoutDocReferences(text)))).replace(DOC_REPO_PATH, MARK).replace(ANVIL, MARK).replace(PROJECT_DOC, MARK)
    .replace(ROUND, '').replace(SUITE_CLASS, m => (!suiteNames || suiteNames.has(m.split('.')[0]) ? MARK : m));
  return out === text ? text : tidy(out).trim();
}
export function exposedToolDefinition(definition, { isHandle = () => false, suiteNames = null } = {}) {
  const walk = node => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' && typeof v === 'string') {
        const after = scrubDefinitionText(v, { isHandle, suiteNames });
        if (!emptied(v, after) && after.trim()) out[k] = after;
      } else out[k] = DEFINITION_VALUES.has(k) ? v : walk(v);
    }
    return out;
  };
  return walk(definition);
}
const withoutRuntimeProvenance = native => (Array.isArray(native) ? native.map(n => (isObject(n) && isObject(n.runtime) ? { ...n, runtime: (({ provenance, ideVersion, ...rest }) => rest)(n.runtime) } : n)) : native);

// Round 4 (re-review MEDIUM 2): the facts of a call the rule reads, {tool, kind?}: the tool that answered and, for
// ssam_reference, its kind (a check is runtime prose, a contract lookup is code). An answer SSAM keeps for a later read
// carries them (reference-files.mjs writeAnswerOrigin), so ssam_evidence serves it as that tool's answer.
export const exposureOrigin = (tool, args) => ({ tool, ...(typeof args?.kind === 'string' ? { kind: args.kind } : {}) });
const originArgs = origin => (typeof origin?.kind === 'string' ? { kind: origin.kind } : {});
// Whose answer a value is: ssam_evidence serves the answer of the file it reads (origin, decided by the caller on the
// normalized path: reference-files.mjs fileOrigin, the same answer the day gets, never this module on the string); every
// other tool serves its own.
const servedBy = (tool, args, origin) => (tool === 'ssam_evidence' && typeof origin?.tool === 'string' && origin.tool !== 'ssam_evidence'
  ? { tool: origin.tool, args: originArgs(origin) } : { tool, args });
function modeOf(tool, args, origin = null) {
  const served = servedBy(tool, args, origin);
  if (served.tool === 'ssam_reference' && CHECK_KINDS.has(served.args?.kind)) return 'runtime';
  if (DOC_TOOLS.has(served.tool)) return 'doc';
  if (REPORT_TOOLS.has(served.tool)) return 'report';
  return 'runtime';
}

/** The value as the profile shows it (a copy; the value is never changed). tool and args say whose answer it is; origin,
 *  for ssam_evidence, whose answer the file it read holds. */
export function exposedValue(value, { exposure = 'owner', handleRoots = [], tool = null, args = null, suiteNames = null, origin = null } = {}) {
  if (exposure === 'owner') return value;
  const served = servedBy(tool, args, origin);
  const ctx = { mode: modeOf(tool, args, origin), isHandle: handleTest(handleRoots), suiteNames, contractData: served.tool === 'ssam_reference' && CONTRACT_KINDS.has(served.args?.kind),
    checkData: served.tool === 'ssam_reference' && CHECK_KINDS.has(served.args?.kind), evidenceRoot: tool === 'ssam_evidence' };
  const out = scrub(value, ctx);
  return out === DROP ? null : out;
}

/** A file that holds a tool's answer (a reference document, an omitted part, a paged answer, the final answer of a detached
 *  call), as that tool's answer is shown: ssam_evidence's reader applies it BEFORE any reading, as it does the redaction of
 *  secrets, so no shape of the reader (a pointer, a table, a projection, a count, a filter, the example of a refusal) ever
 *  sees what the rule leaves out. A kept MCP result {content, structuredContent} is shown as a result. */
export function presentedDocument(doc, { exposure = 'owner', handleRoots = [], origin = null, suiteNames = null } = {}) {
  if (exposure === 'owner' || typeof origin?.tool !== 'string') return doc;
  const options = { exposure, handleRoots, tool: origin.tool, args: originArgs(origin), suiteNames };
  if (isObject(doc) && Array.isArray(doc.content) && doc.content.every(part => isObject(part) && typeof part.type === 'string')) return exposedResult(doc, options);
  return exposedValue(doc, options);
}

// What a call's outcome is, when the exit rule itself fails: never the content, always what happened and what is next.
const OUTCOME_FIELDS = ['ok', 'code', 'outcome', 'status', 'continuation', 'next', 'nextBasedOn', 'taskId'];
function outcomeOnly(result) {
  const source = isObject(result?.structuredContent) ? result.structuredContent : (() => { try { return JSON.parse(result?.content?.find(c => c?.type === 'text')?.text ?? 'null'); } catch { return null; } })();
  const value = { ...Object.fromEntries(OUTCOME_FIELDS.filter(k => isObject(source) && Object.hasOwn(source, k)).map(k => [k, source[k]])),
    exposureError: 'the answer could not be presented in full; its outcome is above' };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(result?.isError ? { isError: true } : {}) };
}

/** An MCP tool result as the profile shows it: structuredContent and every text part (JSON or prose). */
export function exposedResult(result, { exposure = 'owner', handleRoots = [], tool = null, args = null, suiteNames = null, origin = null } = {}) {
  if (exposure === 'owner' || !result || typeof result !== 'object' || result.resultType === 'input_required') return result;
  try {
    const options = { exposure, handleRoots, tool, args, suiteNames, origin };
    const structured = isObject(result.structuredContent) ? exposedValue(result.structuredContent, options) : undefined;
    const content = Array.isArray(result.content) ? result.content.map(part => {
      if (part?.type !== 'text' || typeof part.text !== 'string') return part;
      if (result.structuredContent && part.text === JSON.stringify(result.structuredContent)) return { ...part, text: JSON.stringify(structured) };
      let parsed;
      try { parsed = JSON.parse(part.text); } catch { return { ...part, text: (modeOf(tool, args, origin) === 'doc' ? scrubText : scrubRuntimeText)(part.text, { isHandle: handleTest(handleRoots), suiteNames }) }; }
      return { ...part, text: JSON.stringify(exposedValue(parsed, options)) };
    }) : result.content;
    return { ...result, ...(content ? { content } : {}), ...(structured !== undefined ? { structuredContent: structured } : {}) };
  } catch {
    return outcomeOnly(result);
  }
}
