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
import { CLI_FLAGS } from './cli-flags.mjs';

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
  // (review refusal-followups L-C: see WHOLE_FRAME and the record of an engine failure in scrub)
  'a stack frame SSAM serves as a value of its own (studio_build\'s frame) and the exception type and frames of a failure of SSAM\'s own engine (XIF_ENGINE_FAILED\'s exception and at) are left out; its stage, message and fix stay',
  'ssam_reference answers usage references by part: a whole document becomes its list of parts with the call for each one, within a byte limit per call and per day',
  // (review marco-a6 B1, the Integradora 19/10: see scrub, the patchedJob line)
  'a job SSAM corrected comes back as nextBasedOn (its path and sha256); the server\'s own record of it (patchedJob, with its provenance file) is left out',
  // (review vps-a9 E2: see EXCEPTION_TYPE)
  'the type of an exception of SSAM before its message (KernelRefusalException: ...) is left out of SSAM\'s prose and the failure of a job loses its exception field; the message stays, and so do the customer\'s exceptions (the debugger\'s exception field, UserException, DatabaseException...) and SSAM\'s references to exception elements (IUserException:Name)',
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
// (round 7b, review no-internals-7 B2: the body of a Portal or HTTP answer is the platform's and the customer's payload)
const DATA_KEYS = new Set(['records', 'rows', 'data', 'items', 'values', 'elements', 'nodes', 'children', 'properties', 'body']);
// The data of a lookup of the kernel's contracts (api, functions, ui-block, types, where-can, verify-message): code.
const CONTRACT_KINDS = new Set(['api', 'functions', 'ui-block', 'types', 'where-can', 'verify-message', 'tool']);
// A check of the customer's own job or delivery answers about the customer's job: runtime prose, never documentation.
const CHECK_KINDS = new Set(['check-job', 'check-delivery']);
// SSAM's prose in its documentation.
const DOC_PROSE = new Set(['description', 'text', 'note', 'notes', 'why', 'title', 'rule', 'recover', 'reason', 'summary', 'scope', 'guidance',
  'use', 'work', 'batch', 'how', 'after', 'error', 'message', 'fix', 'hint', 'proof', 'evidence', 'alternative', 'caution', 'deliver',
  'source', 'doc', 'readWhy', 'parallel', 'when', 'choose', 'warning', 'warnings', 'reduced', 'status', 'rows', 'rules',
  // (round 7b, review no-internals-7 B1: the limits of a capability, also as the strings a packet writes)
  'limits']);
// Round 7b (B1): a limit a packet wrote as the JSON of {text, origin} (work-packet.mjs capabilitiesSection, cut at 200
// characters) reads as its text; the origin is the limit's own internal origin, left out as limits[].origin is.
const LIMIT_JSON = /^\{"(?:text|title)":"((?:[^"\\]|\\.)*)("?)/;
function limitText(value) {
  const m = LIMIT_JSON.exec(value);
  if (!m) return value;
  const raw = m[2] ? m[1] : m[1].replace(/…\(\+\d+\)$/, '').replace(/\\$/, '');
  let text; try { text = JSON.parse('"' + raw + '"'); } catch { text = raw.replace(/\\(.)/g, '$1'); }
  return m[2] ? text : text.replace(/\s+\S*$/, '') + '…';
}
// SSAM's prose in any answer. Round 5 (re-review round 4, LOW 3): `scope`, the sentence that says what a check covers.
// Round 6 (re-review round 5, LOW 3; D17): the lists of SSAM's prose (a JOB_INVALID check repeats its problems in errors[]).
const RUNTIME_PROSE = new Set(['error', 'message', 'fix', 'note', 'hint', 'why', 'warning', 'next', 'recover', 'detail', 'reason', 'scope',
  'errors', 'warnings', 'messages', 'notes', 'hints', 'details', 'reasons']);
// Round 7 (review vps-a7-3 B1): SSAM's prose in a field named for it outside the lists (verifyReason, closeReason, skipMessage,
// readWhy...): a reason, a message, an error, a hint, a note, a warning, a detail, a cause, a why, of any answer.
const PROSE_SUFFIX = /^[a-z][a-zA-Z]*(?:Reason|Message|Error|Hint|Note|Warning|Detail|Cause|Why)s?$/;
const proseKey = (set, key) => set.has(key) || (typeof key === 'string' && PROSE_SUFFIX.test(key));
// SSAM's own path fields in its documentation (a suite path becomes an id, a server path <server>).
// (round 7: the origin of a fact, kernel/catalog/model-api-<version>.json or a suite job, is such a field too)
const DOC_PATHS = new Set(['path', 'base', 'proof', 'source', 'doc', 'report', 'file', 'studioDirectory', 'studioDir', 'origin']);
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
// Round 7 (review vps-a7-3 B2): an internal proof level is the seal in any field of SSAM's answers, also below a code key
// (bindings[].level, native[].evidence) and in a packet's patch; "declared" alone is a plain word elsewhere, so it is
// sealed only under evidence/level, as before.
const INTERNAL_LEVELS = new Set(Object.keys(SEALS).filter(level => level !== 'declared'));
const sealOf = value => (typeof value === 'string' && INTERNAL_LEVELS.has(value.trim()) ? SEALS[value.trim()] : null);

// ---- the texts
const INTERNAL_MARK = new RegExp([
  String.raw`\b20\d\d-\d\d-\d\d\b`, String.raw`\bcold session\b`, String.raw`\bround \d+\b`, String.raw`\binvestigation of\b`,
  // (round 7b, MEDIUM 2: the owner's decision, rule or approval; "the owner's words naming the target" is how a delete is
  // confirmed, a rule of use)
  String.raw`\bowner's (?:decision|rule|approval)\b`, String.raw`\b(?:CX|PA|FA)\d{1,3}\b`, String.raw`\b[A-Z]\w*(?:Tests|Scenarios)\b`, String.raw`\.(?:cs|mjs|py|ps1)\b`,
  String.raw`\bkernel[\\/]`, String.raw`\btests[\\/]`, String.raw`\bNAO-DA\b`, String.raw`\bprovenance\b`, String.raw`\bstamp`,
  String.raw`\bINT-[A-Z0-9]`, String.raw`\bblind tests?\b`, String.raw`\bauthor's report\b`, String.raw`\bwf_[0-9a-f]{6}`, String.raw`\bD-M\d`,
  // (round 7b: an audit of the project, "audit T1", is a review name)
  String.raw`\baudit T\d+\b`,
].join('|'));
const BLIND = /\b(?:independent )?blind[- ]tests?\b|\bauthor's report\b/i;
// (round 7b: "stamped by the snapshot author" is the manifest gate's rule of use, no proof stamp)
const INTERNAL_SENTENCE = new RegExp(BLIND.source + String.raw`|\bno stamp\b|\bstamped\b(?!\s+by\s+the\s+snapshot\b)`, 'i');
const SENTENCES = /((?<=;)[ \t]+|(?<=\.)[ \t]+(?=[A-Z]))/;
// a stack frame: indented "at Name.Space.Method(...)" with or without " in <file>:line N"
const STACK_FRAME = /^[ \t]+at [\w.$`<>[\],]+\([^)\r\n]*\)(?: in [^\r\n]*)?(?:\r?\n|$)/gm;
// (review refusal-followups L-C) the same frame as a whole value of its own, outside the prose (studio_build's frame: lib.mjs
// builder, the first frame of SSAM's own code in the builder's stderr)
const WHOLE_FRAME = /^[ \t]*at [\w.$`<>[\],]+\([^)\r\n]*\)(?: in [^\r\n]*)?[ \t]*$/;
// (round 7: in any suite folder of jobs, jobs-live too, and any folder below it, examples-live too)
const SUITE_JOB = /\b(?:kernel[\\/])?tests[\\/]jobs(?:-[a-z]+)*[\\/](?:[\w-]+[\\/])*([\w.-]+?)\.json\b/g;
// (round 7: an html example is also its css, js and json files)
const SUITE_HTML = /\b(?:kernel[\\/])?tests[\\/]html[\\/]([\w.\\/-]+?\.(?:html|css|js|json))\b/g;
const SUITE_DIR = /`?\b(?:kernel[\\/])?tests[\\/](?:jobs(?:-[a-z]+)*|html)(?:[\\/]examples)?\b`?(?![\\/]\w)|\bjobs-(?:odc-)?negative\b/g;
const SUITE_FIXTURE = /\b(?:kernel[\\/])?tests[\\/]fixtures[\\/](?:[\w.-]+[\\/])*([\w.-]+\.(?:oml|json|wsdl|yaml|yml|xif))\b/g;
// Round 6 (re-review round 5, LOW 4; D17): a folder of the suite's fixtures (after its files became their names), and a path
// the kernel writes under its own placeholder (<kernel>/.local/**/snapshots|downloads|...), tell how SSAM is laid out.
const SUITE_FIXTURE_DIR = /`?\b(?:kernel[\\/])?tests[\\/](?:fixtures|Shared)(?:[\\/][\w-]+)*`?/g;
const KERNEL_PLACEHOLDER = /<kernel>[\\/][\w.*\\/|-]*/g;
// The suite's paths in SSAM's prose: a job becomes its id, an html source html/<file>, a fixture its file name, a folder of
// examples "the proven examples", a folder of fixtures "the SSAM fixtures".
// (round 7: a suite job path cut before its .json, in a text cut at its end, is its name too)
const SUITE_PARTIAL = /\b(?:kernel[\\/])?tests[\\/]jobs(?:-[a-z]+)*[\\/](?:[\w-]+[\\/])*(?!examples\b)([\w.-]+)(?![\w.-]*[\\/])/g;
// Round 7b (review no-internals-7, B5): the id only when ssam_reference serves the folder of the job (ssam-reference.mjs
// listExamples: tests/jobs, tests/jobs-odc and their examples); a job of another folder of the suite (live, negative,
// coverage) reads as an example of SSAM, never as an id that answers EXAMPLE_NOT_FOUND.
const SERVED_JOBS = /^(?:kernel\/)?tests\/jobs(?:-odc)?\/(?:examples\/)?[^/]+$/;
// (the value of an argument in a call form, job:"<path>", keeps the job's name: it is no pointer to the reference)
const suiteJob = (path, name, at, text) => { const p = path.replace(/\\/g, '/'); return SERVED_JOBS.test(p) || text[at - 1] === '"' ? name : /-live\//.test(p) ? 'a live example of SSAM' : 'an example of SSAM'; };
const suitePaths = out => out.replace(SUITE_JOB, suiteJob).replace(SUITE_PARTIAL, suiteJob)
  .replace(/`(a live example of SSAM|an example of SSAM)`/g, '$1').replace(/\blive (a live example of SSAM)/g, '$1')
  .replace(/\ban? (?:live )?example of SSAM(?:(?:,? and |,? or |, )an? (?:live )?example of SSAM)+/g, 'examples of SSAM')
  .replace(SUITE_HTML, (m, p) => 'html/' + p.replace(/\\/g, '/')).replace(SUITE_FIXTURE, '$1')
  .replace(SUITE_DIR, 'the proven examples').replace(/the proven examples(?:(?:, | or | and )the proven examples)+/g, 'the proven examples')
  .replace(SUITE_FIXTURE_DIR, 'the SSAM fixtures').replace(KERNEL_PLACEHOLDER, MARK);
// (round 7: a path at the end of a sentence leaves its period to the sentence)
const WIN_PATH = /(?<![\w])[A-Za-z]:[\\/](?:[^\\/"'`<>|*?\r\n]*[\\/])*[^\\/\s"'`<>|*?,;)\]]*(?<!\.)/g;
const UNC_PATH = /\\\\[\w.$-]+\\(?:[^\\"'`<>|*?\r\n]*\\)*[^\\\s"'`<>|*?,;)\]]*(?<!\.)/g;
// servidor/fase4-26 a7 phase 3 (review vps-a7-2 B4): the layout of the Linux image too, its temp folder (/tmp, also HOME) and
// its volumes (/data/server, /data/cache, /data/friction, /data/odc-features: docker/ssam-server/Dockerfile and the SSAM-MCP
// image). Only the volumes of /data: a JSON pointer of SSAM's own prose (/data/results, /data/html) is no path.
// (review no-internals-7, item 6: the name of a root ends its segment, so a JSON pointer such as /options/0, /applicationKey
// or /apps is no server path; a path at the end of a sentence leaves its period, as WIN_PATH does)
const POSIX_PATH = /(?<![\w.:/~-])\/(?:studio|opt|srv|var|home|root|usr|etc|mnt|app|workspace|customers|tmp|data\/(?:server|cache|friction|odc-features))(?=$|[\\/\s"'`<>|,;:)\]]|\.(?:\s|$))(?:\/[^\s"'`<>|,;)\]]*(?<!\.))?/g;
const DOC_REPO_PATH = /(?<![\w./\\-])(?:kernel|platforms|facade|scripts|publisher|tools|docs|src|\.local)[\\/][\w.*\\/-]+(?<!\.)(?::\d+(?:-\d+)?)?/g;
const RUNTIME_REPO_PATH = /(?<![\w./\\-])(?:kernel|platforms|\.local)[\\/][\w.*\\/-]+(?<!\.)(?::\d+(?:-\d+)?)?|(?<![\w./\\-])docs[\\/][\w.-]+\.md\b/g;
const SOURCE_FILE = /\b[\w.*-]+\.(?:cs|mjs|py|ps1|csproj|sln)\b(?::line \d+|:\d+(?:-\d+)?|#L\d+|\(\d+(?:,\d+)?\))?/g;
const ANVIL = /\bAnvil\.[A-Z][\w.]*/g;
// Review vps-a9, E2: the type of an exception before its message, as the kernel writes it (Errors.Envelope and Errors.Text
// "<Type>: <message>", Verbs.Apply's Unwrap "op #0 (html Login): KernelRefusalException: ..." and its cause " <- <Type>: ...",
// EndOfApplyFailure; with or without its namespace), says how SSAM is built, not what to do: it leaves SSAM's prose and the
// message stays. The OutSystems exceptions a customer's flow raises are the customer's and stay, as does the exception of the
// customer's app (under an exception key: the debugger's, scrub below).
// Review refusal-followups M-B: only that form, with the space the kernel always writes after the colon. SSAM's references to
// exception elements are Type:Name with no space (IUserException:OrderClosed, ISystemException:All Exceptions,
// IRoleException:...) and stay whole: without its kind a reference is a literal (JobPreflight.BaseReferences), so the fix
// "use one of: IUserException:OrderClosed" would have told a licensee to write something else.
const PLATFORM_EXCEPTIONS = ['User', 'Database', 'Security', 'Communication', 'AbortActivityChange', 'NotRegistered'];
const EXCEPTION_TYPE = new RegExp(String.raw`(?<![\w.])(?:[A-Za-z_]\w*\.)*(?!(?:${PLATFORM_EXCEPTIONS.join('|')})Exception:)[A-Z][A-Za-z0-9]*Exception:[ \t]+`, 'g');
const withoutExceptionTypes = (text, keep = false) => (keep ? text : text.replace(EXCEPTION_TYPE, ''));
const SUITE_CLASS = /(?<![$.\w])[A-Z]\w*(?:Tests|Scenarios)\b(?:\.\w+)*/g;
const ROUND = /\b(?:CX|PA|FA)\d{1,3}\b(?:\s*(?:r|round|review)\s*\d+)?|\bD-M\d+-\d+\b|\bwf_[0-9a-f-]{6,}\b|\bINT-[A-Z0-9-]+\b|\baudit T\d+\b/g;
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
// servidor/fase4-26 a8 (review of feat/ssam-code-hosted, M1): the names of the owner's releases, lines and branches
// (marco-a5, servidor/fase4-26 a8, fase4-24, fix/system-reference, integracao/marco-a5) tell a licensee nothing he can use.
// A parenthetical of only such names (and their round labels: "(fix/system-reference, a7)") is left out; a name in a
// sentence is left out with the label that follows it ("servidor/fase4-26 a8").
const RELEASE_SEGMENT = String.raw`[\w-]+(?:\.[\w-]+)*`; // a branch segment never takes the period that ends a sentence
const RELEASE_NAME = String.raw`(?:servidor\/fase\d[\w-]*(?:\/${RELEASE_SEGMENT})?|fase\d+(?:-\d+)?(?:\/${RELEASE_SEGMENT})?|marco-a\d+|(?:fix|feat|integracao)\/${RELEASE_SEGMENT})`;
const RELEASE_LABEL = String.raw`(?:[ \t]+a\d+\b)?`;
const RELEASE_PAREN = new RegExp(String.raw` ?\((?:[ \t]*(?:${RELEASE_NAME}${RELEASE_LABEL}|a\d+)[ \t]*[,;]?)+\)`, 'g');
const RELEASE = new RegExp(String.raw`(?<![\w./:-])${RELEASE_NAME}(?![\w/-])${RELEASE_LABEL}`, 'g');
const withoutReleaseNames = text => text.replace(RELEASE_PAREN, '').replace(RELEASE, '');
const withoutInternalNames = text => withoutReleaseNames(text).replace(KERNEL_PAREN, '').replace(KERNEL_TICKS, 'SSAM').replace(STATE_PATH, MARK).replace(KERNEL_ENV, MARK)
  .replace(KERNEL_FILE, MARK).replace(KERNEL_NAME, 'SSAM').replace(PROJECT_FOLDER, 'SSAM').replace(OWNER_ENVIRONMENT, 'personal-xxxx');
// Round 7 (review vps-a7-3 B1; the family rule of D17): a command line or a flag of a CLI in SSAM's prose (the kernel's, a
// lane's, a script's): a licensee works through the tools. A parenthetical that holds a flag is left out, unless it also
// names a tool form (a tool name or {...}): then only its flags go. A clause (up to a ";" or the end of a sentence) that holds
// a quoted command line (a flag with a command before it or a value after it) or a "dotnet <cli> <verb>" command is left
// out. A bare flag goes with its value and with the words that introduced it ("try --find", ", or bind a snapshot on the
// command: --base <oml> / --producer <Name>=<oml>"). A CSS custom property (--color-primary: ..., var(--color-primary), a
// lone `--color-primary`) is no flag. Code never passes here.
// Round 7b (review no-internals-7, MEDIUM 2): a CLI form leaves the prose without taking any information of use with it, and
// without breaking a sentence:
//   (1) in a parenthetical only its parts (between "; ") that hold a CLI form go; it goes when none is left;
//   (2) a clause never ends inside a parenthetical, a quoted text or a code span, and a cell of a markdown table ends one; a
//       clause that names a tool form outside its quoted command line loses only that command line, with the words that
//       introduce it and a parenthetical right after it;
//   (3) a flag's value is a <placeholder>, a quoted text, an =value, a token with a dot, slash, colon, backslash or equals
//       sign, a capitalized or numeric token, or a plain word that ends the phrase, never a word the sentence goes on with
//       ("--model-scope reads"); a sentence whose subject is the CLI's flag ("CLI --x reads ...") goes whole;
//   (4) the run of a lane ("with --platform odc") reads as the lane ("on ODC");
// and a clause left out joins its neighbours with the strongest separator around it (a line break, a table cell), a sentence
// end it had, and an empty cell where a whole cell went, so no sentence is fused and no table loses a column.
const FLAG_NAME = String.raw`--[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\w-]*\s*:)`;
// (a lone flag right inside backticks is a CSS custom property; a command line in backticks is read by CLI_TICKS)
const FLAG = String.raw`(?<![\w-]|var\(|\x60)${FLAG_NAME}`;
const TICK_FLAG = String.raw`(?<![\w-]|var\()${FLAG_NAME}`;
const VALUE_ENDS = String.raw`(?=[ \t]*(?:$|[.,;:)\]|\r\n]))`;
// (a value never takes the period that ends its sentence)
const FLAG_VALUE_BODY = String.raw`=(?:"[^"\r\n]*"|<[^<>\r\n]*>|[^\s,;)\]]*[^\s,;)\].])|[ ](?!--)(?:"[^"\r\n]*"|<[^<>\r\n]*>(?:=<[^<>\r\n]*>)?|\.\.\.(?=\s|$)|[\w@*<>-]*[.\/:=\\][^\s,;)\]]*[^\s,;)\].]|[\w-]+\[[^\]\r\n]*\]|[A-Z0-9][\w-]*|[a-z][\w-]*${VALUE_ENDS})`;
const FLAG_VALUE = String.raw`(?:${FLAG_VALUE_BODY})?`;
const FLAG_RUN = String.raw`\[?${FLAG}${FLAG_VALUE}\]?(?:\s*(?:\/|,|\band\b|\bor\b)?\s*\[?${FLAG}${FLAG_VALUE}\]?)*`;
// Round 7b (review no-internals-7, B3): a flag with a value, a run of flags or a bracketed flag is a command line; a single
// flag without a value is the name of an option ("without another --expected-environment", "--create-active requires
// --create-accounts"), which reads as the tools name it, so the kernel's sentence stays whole and its error never vanishes.
const ONE_FLAG = String.raw`\[?${FLAG}${FLAG_VALUE}\]?`;
const FLAG_JOIN = String.raw`\s*(?:\/|,|\band\b|\bor\b)?\s*`;
const COMMAND_RUN = String.raw`(?:\[?${FLAG}(?:${FLAG_VALUE_BODY})\]?|\[${FLAG}${FLAG_VALUE}\])(?:${FLAG_JOIN}${ONE_FLAG})*|${ONE_FLAG}(?:${FLAG_JOIN}${ONE_FLAG})+`;
const optionName = flag => flag.slice(2).replace(/-([a-z0-9])/g, (m, c) => c.toUpperCase());
const HAS_FLAG = new RegExp(FLAG);
const TOOL_FORM = /\b(?:ssam|studio|odc|o11|hybrid)_[a-z_]+\b|\{/;
const CLI_PAREN = /(?<!var) ?\(((?:[^()\r\n]|\([^()\r\n]*\))*)\)/g;
const CLI_TICKS = new RegExp(String.raw`\`[^\`\r\n]*(?:\S\s+${TICK_FLAG}|${TICK_FLAG}[ =][^\`\s])[^\`\r\n]*\``);
const TICK_SPAN = /`[^`\r\n]*`/g;
const isCliTick = span => CLI_TICKS.test(span) && !TOOL_FORM.test(span);
// a quoted command line with the words that introduce it (", and the job binds `...`") and a parenthetical right after it
const TICK_PART = /(?:(?:,[ \t]*|[ \t]+(?:and|or|then)[ \t]+)(?:[\w-]+[ \t]+){0,4})?`[^`\r\n]*`(?:[ \t]*\((?:[^()\r\n]|\([^()\r\n]*\))*\))?/g;
const withoutCliTicks = text => text.replace(TICK_PART, m => (isCliTick(m.match(/`[^`\r\n]*`/)[0]) ? '' : m));
const DOTNET_CLI = /\bdotnet\s+(?:<[^<>\r\n]*>|\S+\.dll)\s+[a-z][\w-]*/;
const ON_THE_COMMAND = String.raw`\s*,?\s*(?:\bor\s+)?(?:[\w-]+\s+){0,3}on the command(?: line)?:?`;
const FLAG_INTRO = String.raw`(?:${ON_THE_COMMAND}|\s*,?\s*\b(?:try|use|pass|with|via|run|or|and|as)\b)?\s*`;
const BARE_FLAGS = new RegExp(FLAG_INTRO + FLAG_RUN, 'g');
const COMMAND_FLAGS = new RegExp(FLAG_INTRO + '(?:' + COMMAND_RUN + ')', 'g');
const COMMAND_LINE = new RegExp(ON_THE_COMMAND + String.raw`\s*` + FLAG_RUN, 'g');
const INTRODUCED_FLAG = new RegExp(String.raw`(?:${ON_THE_COMMAND}|\s*,?\s*\b(?:try|use|pass|with|via|run|or|and|as)\b)\s*${ONE_FLAG}`, 'g');
const OPTION_FLAG = new RegExp(FLAG, 'g');
// The flags left in a text: a command line, and a flag the words before it introduce as one ("try --find"), go with those
// words; a single flag reads as its option (or goes too, in an operation's text, which is a command line of its own).
const flagsLeft = (text, options) => { const out = text.replace(COMMAND_FLAGS, ''); return options ? out.replace(INTRODUCED_FLAG, '').replace(OPTION_FLAG, optionName) : out.replace(BARE_FLAGS, ''); };
const CLI_SUBJECT = new RegExp(String.raw`^[ \t]*(?:the[ \t]+)?CLI(?:'s)?[ \t]*:?[ \t]*${FLAG}`, 'i');
const LANE_RUN = /\bwith[ \t]+(`?)--(?:platform|lane)[ =](o11|odc)\1(?![\w-])/gi;
// Round 7b (review no-internals-7, B2): a flag is one of SSAM's own command lines (cli-flags.mjs, the closed list of the flags
// their sources accept), outside a quoted text: a CSS custom property of the customer (--brand-navy), a word of a customer's
// expression (Concat("--force", Name)) or a flag of another tool (--verbose) is the customer's and is held aside, as it is,
// while the rule reads the text.
const FLAG_TOKEN = /(?<![\w-])--([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g;
const HELD_FLAG = /\u0001(\d+)\u0001/g;
function holdForeignFlags(text) {
  if (!text.includes('--')) return { text, restore: out => out };
  const quoted = [...text.matchAll(/"[^"\r\n]*"/g)].map(m => [m.index, m.index + m[0].length]);
  const kept = [];
  const held = text.replace(FLAG_TOKEN, (m, name, at) => (CLI_FLAGS.has(name) && !quoted.some(([a, b]) => at > a && at < b) ? m : '\u0001' + (kept.push(m) - 1) + '\u0001'));
  return { text: held, restore: out => (kept.length ? out.replace(HELD_FLAG, (m, i) => kept[Number(i)] ?? m) : out) };
}
const hasCliFormHeld = text => HAS_FLAG.test(text) || CLI_TICKS.test(text) || DOTNET_CLI.test(text);
const hasCliForm = text => hasCliFormHeld(holdForeignFlags(text).text);
// (a clause ends at a "; ", at the end of a sentence, at a line break after . ; : or before a blank line or a markdown line,
// and at a cell of a markdown table)
const SEPARATOR = /(?<=;)[ \t]+|(?<=\.)[ \t]+(?=[A-Z`])|(?<=[.;:])[ \t]*\r?\n|\r?\n(?=[ \t]*(?:\r?\n|[|#*>-]|\d+\.\s))|[ \t]+\|[ \t]+/g;
// The characters a clause never ends inside: code spans, quoted texts and the parentheticals that pair.
function guarded(text) {
  const mask = new Uint8Array(text.length + 1);
  const fill = (a, b) => { for (let i = a; i < b; i++) mask[i] = 1; };
  for (const m of text.matchAll(/`[^`\r\n]*`/g)) fill(m.index, m.index + m[0].length);
  for (const m of text.matchAll(/"[^"\r\n]*"/g)) if (!mask[m.index]) fill(m.index, m.index + m[0].length);
  const open = [];
  for (let i = 0; i < text.length; i++) { if (mask[i]) continue; if (text[i] === '(') open.push(i); else if (text[i] === ')' && open.length) fill(open.pop(), i + 1); }
  return mask;
}
function clausesOf(text) {
  const mask = guarded(text), out = []; let last = 0;
  for (const m of text.matchAll(SEPARATOR)) { if (mask[m.index]) continue; out.push(text.slice(last, m.index), m[0]); last = m.index + m[0].length; }
  out.push(text.slice(last));
  return out;
}
// A clause as the rule keeps it, or null when it goes.
function clauseKept(part) {
  if (CLI_SUBJECT.test(part)) return null;
  const ticks = [...part.matchAll(TICK_SPAN)].some(m => isCliTick(m[0]));
  if (!ticks && !DOTNET_CLI.test(part)) return part;
  if (DOTNET_CLI.test(part.replace(TICK_SPAN, ''))) return null;
  const without = withoutCliTicks(part);
  return TOOL_FORM.test(without) ? without : null;
}
// Round 7b (review no-internals-7, B4): a pointer to SSAM's own reference reads as the MCP form that serves it, never left
// out: `api --op <x>` (and --type <T>) is ssam_reference {kind:"api", query:{op:"<x>"}}, `api --name <T>` is
// ssam_reference {kind:"api", query:"<T>"}, --find is query:{find}, --app is the app argument, and a producer binding of a job
// or a delivery is its producers / captureProducers argument.
const API_OP = /(?:\b(?:anvil(?:-odc)?|SSAM)\s+)?\bapi\s+--op[ =]([a-z][\w-]*(?:\|[a-z][\w-]*)*)(?:\s+--type[ =](<[^<>\r\n]*>|[A-Z][\w.]*))?/g;
const API_NAME = /(?:\b(?:anvil(?:-odc)?|SSAM)\s+)?\bapi\s+--name[ =](<[^<>\r\n]*>|[A-Z][\w.]*)/g;
const FIND_FLAG = /(?<![\w-])--find(?![\w-])/g;
const APP_FLAG = /(?<![\w-])--app(?![\w-])/g;
const PRODUCER_FLAG = /(?<![\w-])--producer[ =](<[^<>\r\n]*>|[\w.-]+)=(<[^<>\r\n]*>|[^\s`,;)\]]*[^\s`,;)\].])/g;
const CAPTURE_FLAG = /(?<![\w-])--capture-producer[ =](<[^<>\r\n]*>|[\w.-]+)(?:\[=[^\]\r\n]*\]|=[^\s`,;)\]]*[^\s`,;)\].])?/g;
const toolForms = text => text
  .replace(API_OP, (m, op, type) => 'ssam_reference {kind:"api", query:{op:"' + (op.includes('|') ? '<' + op + '>' : op) + '"' + (type ? ', type:"' + type + '"' : '') + '}}')
  .replace(API_NAME, (m, type) => 'ssam_reference {kind:"api", query:"' + type + '"}')
  .replace(FIND_FLAG, 'query:{find:"<words>"}').replace(APP_FLAG, 'app')
  .replace(PRODUCER_FLAG, (m, name, file) => 'producers:{"' + name + '":"' + file + '"}')
  .replace(CAPTURE_FLAG, (m, name) => 'captureProducers:["' + name + '"]');
const isCell = sep => /\|/.test(sep);
const upperFirst = text => text.replace(/^(\s*)([a-z])/, (m, s, c) => s + c.toUpperCase());
// options: a single flag reads as its option (SSAM's prose); false in an operation's text, where every flag goes.
function withoutCliForms(text, { options = true } = {}) {
  const held = holdForeignFlags(text);
  if (!hasCliFormHeld(held.text)) return text;
  let out = toolForms(held.text.replace(COMMAND_LINE, '')).replace(LANE_RUN, (m, tick, lane) => 'on ' + lane.toUpperCase());
  out = out.replace(CLI_PAREN, (m, inner) => {
    if (!hasCliForm(inner)) return m;
    const parts = inner.split(/(;[ \t]+)/), kept = [];
    for (let i = 0; i < parts.length; i += 2) {
      const part = parts[i];
      if (!hasCliForm(part)) { kept.push(part); continue; }
      if (!TOOL_FORM.test(part.replace(TICK_SPAN, s => (isCliTick(s) ? '' : s)))) continue;
      const left = flagsLeft(withoutCliTicks(part), options).trim();
      if (left.replace(/[\s,;:]/g, '')) kept.push(left);
    }
    return kept.length ? m.match(/^ ?\(/)[0] + kept.join('; ') + ')' : '';
  });
  const parts = clausesOf(out);
  out = ''; let run = null;
  for (let i = 0; i < parts.length; i += 2) {
    const sep = i ? parts[i - 1] : '';
    let part = clauseKept(parts[i]);
    if (part === null) { run ??= { seps: [], period: false }; run.seps.push(sep); if (/\.\s*$/.test(parts[i])) run.period = true; continue; }
    if (!run) { out += sep + part; continue; }
    if (!out.trim()) { out = upperFirst(part.replace(/^\s+/, '')); run = null; continue; }
    const seps = [...run.seps, sep];
    let joint = seps.find(s => /\n/.test(s)) ?? seps.find(isCell) ?? sep;
    if (isCell(run.seps[0]) && isCell(sep)) joint = ' |' + ' |'.repeat(run.seps.slice(1).filter(isCell).length + 1) + ' ';
    // (the clause before keeps its own "; " unless the run ended a sentence, a line or a cell)
    if (run.period && !isCell(joint)) out = out.replace(/[;,](\s*)$/, '.$1');
    else if (/\n/.test(joint) || isCell(joint)) out = out.replace(/[;,](\s*)$/, '$1');
    if (/\.\s*$/.test(out)) part = upperFirst(part);
    out += joint + part; run = null;
  }
  if (run) out = out.replace(/\s*[;,]\s*$/, run.period ? '.' : '');
  return held.restore(flagsLeft(out, options).replace(/\s*[;,]\s*$/, '').replace(/[ \t]+$/, ''));
}
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
// (review no-internals-7, item 6: a JSON pointer the answer itself names in violations[].path, even an exact root name such as
// /app, is the name of an argument: it is held aside while the text is scrubbed, in every mode)
const POINTER = /^\/[\w-]+(?:\/[\w-]+)*$/;
// (servidor/fase4-26 a7 phase 4: exported, so the hosted presenter, hosted/policy.mjs, holds the same pointers by the same rule)
export const pointersOf = value => (Array.isArray(value?.violations) ? value.violations.map(v => v?.path).filter(p => typeof p === 'string' && POINTER.test(p)) : []);
const HELD = /\u0000(\d+)\u0000/g;
// Round 7b (review no-internals-7, B6): the caller's own text, quoted in SSAM's prose (the id a refusal echoes, "no example
// 'tests/jobs/x'"), comes back as the caller sent it, as the arguments of every call do: it tells the caller nothing he did not
// write. The texts are the string values of the call's arguments (echoesOf); a path on the machine is no echo, it stays the
// server's (round 6). Only a whole quoted text ('...', "..." or `...`) equal to one of them is held, never a word inside SSAM's
// own text.
const QUOTE_OPEN = /(['"`])(?=([^'"`\r\n]{1,500}?)\1)/g;
const MAX_ECHOES = 2000;
export function echoesOf(args) {
  const out = new Set();
  const walk = (value, depth) => {
    if (out.size >= MAX_ECHOES || depth > 8) return;
    if (typeof value === 'string') { const text = value.trim(); if (text && text.length <= 500 && !isServerPath(text) && !/['"`\r\n]/.test(text)) out.add(text); return; }
    if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return; }
    if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v, depth + 1);
  };
  walk(args, 0);
  return out;
}
// (servidor/fase4-26 a7 phase 4: exported, so the hosted presenter holds the same pointers; without echoes it holds only them)
export function holdPointers(text, pointers, echoes) {
  if (!pointers?.length && !echoes?.size) return { text, restore: out => out };
  const kept = [];
  const hold = m => '\u0000' + (kept.push(m) - 1) + '\u0000';
  let out = text;
  if (echoes?.size && /['"`]/.test(out)) {
    let next = '', from = 0;
    for (const m of out.matchAll(QUOTE_OPEN)) {
      if (m.index < from || !echoes.has(m[2])) continue;
      const end = m.index + m[2].length + 2;
      next += out.slice(from, m.index) + hold(out.slice(m.index, end)); from = end;
    }
    out = next + out.slice(from);
  }
  if (pointers?.length) {
    const named = new RegExp('(?<![\\w/])(?:' + [...new Set(pointers)].map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?=[\\s:;,)]|$)', 'g');
    out = out.replace(named, hold);
  }
  return kept.length ? { text: out, restore: after => after.replace(HELD, (m, i) => kept[Number(i)] ?? m) } : { text, restore: after => after };
}

/** SSAM's runtime prose (an error, a message, a fix...): server paths, source files, stack frames and kernel classes only. */
export function scrubRuntimeText(text, { isHandle = () => false, pointers = [], echoes = null, customerException = false } = {}) {
  if (typeof text !== 'string' || !text || isHandle(text.trim())) return text;
  const held = holdPointers(text, pointers, echoes);
  // (round 7, B1: the forms of a CLI too)
  let out = withoutCliForms(withoutDocReferences(held.text.replace(STACK_FRAME, '')));
  // (round 6, LOW 4: the suite's paths too, as in the documentation)
  out = held.restore(withoutExceptionTypes(paths(suitePaths(out)), customerException).replace(RUNTIME_REPO_PATH, MARK).replace(SOURCE_FILE, MARK).replace(ANVIL, MARK));
  if (out === text) return text;
  return tidy(out).trim();
}
/** SSAM's documentation prose (rules, descriptions, notes of the reference and the discover). */
export function scrubText(text, { isHandle = () => false, suiteNames = null, pointers = [], echoes = null, customerException = false } = {}) {
  if (typeof text !== 'string' || !text || isHandle(text.trim())) return text;
  const held = holdPointers(text, pointers, echoes);
  // (round 6c: the internal names of the kernel and of the project, as in a tool definition)
  let out = withoutCliForms(withoutInternalNames(withoutDocReferences(held.text.replace(STACK_FRAME, ''))));
  // a sentence part that only says how a proof was made (a blind test, a stamp, the author's report) is left out
  if (INTERNAL_SENTENCE.test(out)) {
    const parts = out.split(SENTENCES); let kept = '';
    for (let i = 0; i < parts.length; i += 2) if (!INTERNAL_SENTENCE.test(parts[i])) kept += (kept ? parts[i - 1] ?? ' ' : '') + parts[i];
    out = kept;
    if (!out.trim() && BLIND.test(text)) out = 'not offered yet';
  }
  out = suitePaths(out);
  // a parenthetical that only says where, when or by whom something was proven (a date literal #2026-01-31# is the language's)
  // (round 7b, MEDIUM 2: only its parts, between "; ", that say it; a part of use stays: "(measured on <date>; it counts as a
  // consumer of the FK when deleting)" keeps "(it counts as a consumer of the FK when deleting)")
  const marked = part => INTERNAL_MARK.test(part.replace(/#[^#\r\n]*#/g, ''));
  out = out.replace(/ ?\(([^()]{0,600})\)/g, (m, inner) => {
    if (!marked(inner)) return m;
    const kept = inner.split(/;[ \t]+/).filter(part => !marked(part));
    return kept.length ? m.match(/^ ?\(/)[0] + kept.join('; ') + ')' : '';
  });
  // (round 7: the same parenthetical cut at the end of a text cut to its room, with or without a mark: it goes and the cut is
  // marked; a parenthetical left open in a whole text, with a sentence after it inside, is no cut and stays)
  out = out.replace(/ ?\(([^()]{0,600})$/, (m, inner) => (INTERNAL_MARK.test(inner.replace(/#[^#\r\n]*#/g, '')) && !/[.!?]\s+[A-Z]/.test(inner) ? '\u2026' : m));
  out = held.restore(withoutExceptionTypes(paths(out), customerException).replace(SUITE_COMMAND, MARK).replace(DOC_REPO_PATH, MARK).replace(SOURCE_FILE, MARK).replace(ANVIL, MARK)
    .replace(SUITE_CLASS, m => (!suiteNames || suiteNames.has(m.split('.')[0]) ? MARK : m)).replace(PROJECT_DOC, MARK).replace(ROUND, '').replace(OWNER, 'the rule')
    .replace(/\blexical,\s*|,\s*lexical\b/g, '')); // the name of the matcher's section, in a recovery hint
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
    // (round 7b, B2: a proof level is the seal only in SSAM's documentation and its code; a runtime answer's "C-suite" can be
    // the customer's word)
    const seal = sealOf(value); if (seal) return seal;
    if ((key === 'evidence' || key === 'level') && Object.hasOwn(SEALS, value)) return SEALS[value];
    if (key === 'state' && Object.hasOwn(STATES, value)) return STATES[value];
    if (key === 'limits') value = limitText(value);
    if (proseKey(DOC_PROSE, key) || DOC_PATHS.has(key)) { const after = scrubText(value, ctx); return emptied(value, after) ? DROP : after; }
    return ctx.isHandle(value.trim()) || !isServerPath(value.trim()) ? value : MARK;
  }
  if (ctx.mode === 'report') {
    const whole = value.trim();
    if (isServerPath(whole)) return ctx.isHandle(whole) ? value : MARK;
  }
  // (a runtime prose that held only a CLI form is left out; one that held a server path keeps <server>, as before)
  if (proseKey(RUNTIME_PROSE, key)) { const after = scrubRuntimeText(value, ctx); return after.trim() || !value.trim() ? after : DROP; }
  // (review refusal-followups L-C) a stack frame served as a value of its own leaves, as the frames of SSAM's prose do; the
  // customer's (under the debugger's exception key) stays
  if (!ctx.customerException && WHOLE_FRAME.test(value)) return DROP;
  // (marco-a6, the family "no server path reaches a licensee") a whole value that is a path of the server is served only as
  // a handle the next call takes back (under a handle root, in any key: review marco-a6 B1, SSAM answers its handles as
  // path, snapshot, manifest, receipt, evidence, checks, xif... too) or as the very path the caller sent in this call; any
  // other (a root itself, a folder outside the roots, a temp or customers folder) is <server>
  if (ctx.mode === 'runtime') {
    const whole = value.trim();
    if (isServerPath(whole) && !ctx.isHandle(whole) && !ctx.sentPaths?.has(whole)) return MARK;
  }
  return value;
}
// The whole paths the caller sent in the arguments of the call (its own text, which tells it nothing new).
function sentPathsOf(args) {
  const out = new Set();
  const walk = (value, depth) => {
    if (out.size >= MAX_ECHOES || depth > 8) return;
    if (typeof value === 'string') { const text = value.trim(); if (isServerPath(text)) out.add(text); return; }
    if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return; }
    if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v, depth + 1);
  };
  walk(args, 0);
  return out;
}
function scrub(value, ctx, key = null, depth = 0) {
  if (typeof value === 'string') return key === null && ctx.mode !== 'doc' ? value : scrubString(value, key, ctx);
  if (Array.isArray(value)) {
    if (ctx.mode === 'doc' && key === 'why' && value.every(v => typeof v === 'string')) return DROP; // the matched words
    // Round 6 (re-review round 5, LOW 3; D17): a string in a list is read like a string under the list's key, in every mode
    // (a list of prose is prose, a report's list of paths is paths); before, only the prose lists of the documentation were.
    const out = value.map(v => (typeof v === 'string' ? scrubString(v, key, ctx) : scrub(v, ctx, key, depth + 1))).filter(v => v !== DROP);
    // (marco-a6) a runtime list of paths of the server only (the roots of a refusal) is left out
    if (ctx.mode === 'runtime' && value.length && value.every(v => typeof v === 'string' && isServerPath(v.trim())) && out.every(v => v === MARK)) return DROP;
    return out;
  }
  if (!isObject(value)) return value;
  const mode = typeof value.schemaVersion === 'string' && DOC_SCHEMA.test(value.schemaVersion) ? 'doc' : ctx.mode;
  // (item 6: the pointers an answer names in violations[].path reach every text below it)
  const pointers = pointersOf(value);
  const here = mode === ctx.mode && !pointers.length ? ctx : { ...ctx, mode, ...(pointers.length ? { pointers: [...(ctx.pointers ?? []), ...pointers] } : {}) };
  const top = mode === 'doc' && (mode !== ctx.mode || depth === 0);
  if (mode === 'doc' && key === 'evidence') {
    // an evidence object: its level as the seal, its guidance and limits as prose, its proofs out
    const level = value.level ?? value.evidence;
    if (typeof level === 'string' && SEALS[level]) value = { ...value, level: SEALS[level] };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    // Round 7 (review vps-a7-3 B2) and 7b (review no-internals-7, MEDIUM 1): a packet part's patch, read as the list it is
    if (here.mode === 'doc' && k === 'missing' && Array.isArray(v) && v.length && v.every(isPatchOp)) { out[k] = exposedPatch(v, typeof value.section === 'string' ? value.section : null, here, depth + 1); continue; }
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
    // (review marco-a6 B1, the Integradora 19/10: X3's patchedJob leaves a licensee's answer whole. Its path and hash are
    // nextBasedOn's, the same corrected job (appliedJobIdentity + nextBasedOnOf), and its source is the server's provenance
    // sidecar, which no tool takes back; when the server could not verify the corrected file, nextBasedOn names the job that
    // ran, never the unverified one. The owner reads it whole.)
    if (here.mode !== 'doc' && k === 'patchedJob') continue;
    // (review vps-a9 E2: the type of the exception a job's failure kept apart, job-guidance.mjs failureOf, is SSAM's class)
    if (k === 'exception' && key === 'failure' && typeof v === 'string') continue;
    // (review refusal-followups L-C: so is the record of a failure of SSAM's own engine, its exception type kept apart beside its
    // frames, Anvil.Xif.Engine Program.Unexpected {stage, exception, at}, as o11_extension relays XIF_ENGINE_FAILED: both leave,
    // the stage and the message stay; an exception object of the customer's app is the debugger's and stays)
    if ((k === 'exception' || k === 'at') && here.mode !== 'doc' && !here.customerException && typeof value.exception === 'string'
      && Array.isArray(value.at) && value.at.length && value.at.every(f => typeof f === 'string')) continue;
    // (round 6, LOW 5: the definition of a tool is documentation, its schema code; exposedToolDefinition reads both)
    if (k === 'definition' && value.schemaVersion === 'ssam-tool-definition/1' && isObject(v)) { out[k] = exposedToolDefinition(v, here); continue; }
    if (CODE_KEYS.has(k) && key !== 'operations') { out[k] = here.mode === 'doc' ? docCode(k === 'native' ? withoutRuntimeProvenance(v) : v, here, k) : v; continue; }
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
    // (review marco-a6 M2: the messages of a problem are SSAM's prose wherever they sit. A problem of a refusal, an element of
    // a problems list, keeps under items the members fitProblems grouped, each with its own message and fix: SSAM's own
    // problems, read by the rule like the group's first message, never the customer's records)
    if (here.mode !== 'doc' && DATA_KEYS.has(k) && !(k === 'data' && here.checkData && depth === 0) && !(k === 'items' && key === 'problems')) { out[k] = v; continue; }
    // (review vps-a9 E2: an exception object is the customer's app's, the debugger's: its type stays in its texts)
    const next = scrub(v, (k === 'exception' || k === 'exceptions') && !here.customerException ? { ...here, customerException: true } : here, k, depth + 1);
    if (next !== DROP) out[k] = next;
  }
  if (here.mode === 'doc' && Array.isArray(out.historical) && Array.isArray(out.proven)) { out.proven = [...out.proven, ...out.historical]; delete out.historical; delete out.text; delete out.coverage; }
  return out;
}
// The code of SSAM's own documentation (a suite job's ops, a contract): every string stays, except a WHOLE value that is a
// path SSAM itself wrote (a fixture of its suites becomes its file name, a suite job its id, a server folder <server>).
// (round 7: any suite folder of jobs: jobs-live too)
const SUITE_PATH_WHOLE = /^(?:kernel[\\/])?tests[\\/](?:fixtures|jobs(?:-[a-z]+)*|html)[\\/]/;
function docCode(value, ctx, key = null) {
  if (typeof value === 'string') {
    // (round 7, B1: a prose field inside code, a rule of a contract, loses its CLI forms, and only them)
    const seal = sealOf(value); if (seal) return seal;
    // (round 7: the _why note of a job's op is SSAM's documentation prose, not code)
    if (key === '_why') { const after = scrubText(value, ctx); return emptied(value, after) ? '' : after; }
    // (round 7b, B1: the operation of a capability, under its route or in a packet's item and patch, is SSAM's text of how
    // to call it: its CLI forms leave it)
    if (key === 'operation') return withoutCliForms(value, { options: false });
    if (key === 'limits') value = limitText(value);
    if (proseKey(DOC_PROSE, key) && hasCliForm(value)) return withoutCliForms(value);
    const whole = value.trim();
    if (SUITE_PATH_WHOLE.test(whole)) return whole.replace(SUITE_JOB, '$1').replace(SUITE_HTML, (m, p) => 'html/' + p.replace(/\\/g, '/')).replace(SUITE_FIXTURE, '$1');
    return isServerPath(whole) && !ctx.isHandle(whole) ? MARK : value;
  }
  if (Array.isArray(value)) return value.map(v => docCode(v, ctx, key));
  // (round 7, B1: a route's operation is SSAM's text of how to call it: its CLI forms leave it, as any operation does)
  return isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isCall(value) && k === 'arguments' ? v : docCode(v, ctx, k)])) : value;
}
// Round 7 (review vps-a7-3 B2) and 7b (review no-internals-7, MEDIUM 1): a packet part's patch ({op, path, value} under missing,
// work-packet.mjs packetMissing: every container is added empty and filled key by key) rebuilds a section of SSAM's
// documentation, and the licensee applies it to the packet he was served. So it is read as the list it is, in its order:
//   - an op whose path passes through a field the licensee's section leaves out (a list of matched words under why, an
//     internal field of the documentation, a limit's origin, a packet's rule, a cut's counts, a source that names the index
//     it came from) is left out, with every op below it;
//   - an op whose value the rule leaves out is left out with every op below it too;
//   - every other value reads exactly as the field its path names reads in the whole section: it is shown by the same rule
//     (scrub, or docCode below a code key), under the same key and the same parent key;
//   - a long text paged by character (text ops) is read whole when all its pages are in this part; pages that go on in
//     another part keep their length (filled with spaces), so every offset the client checks still holds.
const isPatchOp = v => isObject(v) && typeof v.op === 'string' && typeof v.path === 'string';
const pointerKeys = p => (p ? p.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')) : []);
const isIndex = s => /^\d+$/.test(s);
const startsWith = (keys, prefix) => prefix.length <= keys.length && prefix.every((k, i) => keys[i] === k);
// Where a patch path leads in the licensee's section: null when the section leaves it out; else the key of its parent (an
// index reads its list's key, as scrub reads a list) and whether a code key is above it. later: the ops after it in the part.
function patchPlace(keys, section, ctx, later) {
  let field = section, code = false;
  for (let i = 0; i < keys.length; i++) {
    const name = keys[i], last = i === keys.length - 1;
    if (isIndex(name)) { if (!code && field === 'why') return null; continue; }
    if (!code) {
      if (DOC_DROP.has(name) || (name === 'origin' && field === 'limits') || (name === 'rule' && field === 'packet') || (name === 'left' && field === 'cuts')) return null;
      const named = k => k.length > i + 1 && startsWith(k, keys.slice(0, i + 1)) && (k[i + 1] === 'index' || k[i + 1] === 'builtAt');
      if (name === 'source' && (named(keys) || later.some(op => named(pointerKeys(op.path))))) return null;
      if (last) break;
      if ((CODE_KEYS.has(name) && field !== 'operations') || (name === 'data' && ctx.contractData) || (name === 'text' && (field === 'example' || field === 'card'))) code = true;
    }
    if (!last) field = name;
  }
  return { field, code, leaf: keys.at(-1) };
}
// The value of an op as the whole section shows it at that place, or DROP.
function patchValue(op, place, ctx, depth) {
  if (!Object.hasOwn(op, 'value')) return op;
  const { field, code, leaf } = place;
  let shown;
  if (leaf === undefined) shown = code ? docCode(op.value, ctx, field) : scrub(op.value, ctx, field, depth);
  else if (isIndex(leaf)) { const list = code ? docCode([op.value], ctx, field) : scrub([op.value], ctx, field, depth); shown = Array.isArray(list) && list.length ? list[0] : DROP; }
  else { const holder = code ? docCode({ [leaf]: op.value }, ctx, field) : scrub({ [leaf]: op.value }, ctx, field, depth); shown = isObject(holder) && Object.hasOwn(holder, leaf) ? holder[leaf] : DROP; }
  return shown === DROP ? DROP : { ...op, value: shown };
}
function exposedPatch(ops, section, ctx, depth) {
  const out = [], gone = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i], keys = pointerKeys(op.path);
    if (gone.some(prefix => startsWith(keys, prefix))) continue;
    const place = patchPlace(keys, section, ctx, ops.slice(i + 1));
    if (!place) { gone.push(keys); continue; }
    if (op.op !== 'text') {
      const shown = patchValue(op, place, ctx, depth + keys.length + 1);
      if (shown === DROP) gone.push(keys); else out.push(shown);
      continue;
    }
    // the pages of one text in a row
    let end = i;
    while (end + 1 < ops.length && ops[end + 1].op === 'text' && ops[end + 1].path === op.path) end++;
    const pages = ops.slice(i, end + 1);
    i = end;
    if (place.code) { out.push(...pages); continue; }
    const reset = out.at(-1);
    const whole = op.offset === 0 && reset?.path === op.path && reset.op !== 'text' && reset.value === '' && end + 1 < ops.length;
    if (whole) {
      const shown = patchValue({ op: 'replace', path: op.path, value: pages.map(p => p.value).join('') }, place, ctx, depth + keys.length + 1);
      if (shown === DROP || typeof shown.value !== 'string') { out.pop(); gone.push(keys); } else if (shown.value) out.push({ ...op, offset: 0, value: shown.value });
      continue;
    }
    for (const page of pages) {
      const shown = typeof page.value === 'string' ? patchValue({ ...page, op: 'replace' }, place, ctx, depth + keys.length + 1) : DROP;
      const text = shown === DROP || typeof shown.value !== 'string' ? '' : shown.value;
      const length = typeof page.value === 'string' ? page.value.length : 0;
      out.push({ ...page, value: text.length >= length ? text.slice(0, length) : text + ' '.repeat(length - text.length) });
    }
  }
  return out;
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
  const out = withoutCliForms(withoutInternalNames(paths(suitePaths(withoutDocReferences(text))))).replace(DOC_REPO_PATH, MARK).replace(ANVIL, MARK).replace(PROJECT_DOC, MARK)
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
    checkData: served.tool === 'ssam_reference' && CHECK_KINDS.has(served.args?.kind), evidenceRoot: tool === 'ssam_evidence',
    // (round 7b, B6: the caller's own texts, held where SSAM's prose quotes them)
    echoes: echoesOf(args),
    // (marco-a6: the caller's own paths, served back as it sent them)
    sentPaths: sentPathsOf(args) };
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
      try { parsed = JSON.parse(part.text); } catch { return { ...part, text: (modeOf(tool, args, origin) === 'doc' ? scrubText : scrubRuntimeText)(part.text, { isHandle: handleTest(handleRoots), suiteNames, echoes: echoesOf(args) }) }; }
      return { ...part, text: JSON.stringify(exposedValue(parsed, options)) };
    }) : result.content;
    return { ...result, ...(content ? { content } : {}), ...(structured !== undefined ? { structuredContent: structured } : {}) };
  } catch {
    return outcomeOnly(result);
  }
}
