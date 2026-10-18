// THE answer to "is this file SSAM's documentation?" (fix/no-internals round 3, re-review MEDIUM A and B): a large
// ssam_reference answer is written to <lane .local>/reference/<hash>.json and read back with ssam_evidence {file}. The
// hub's day limit and the exit rule's documentation mode both ask this one function, on the NORMALIZED path (resolved,
// real path when it exists, separators and dot segments folded, lower case on Windows), never on the string as written:
// "reference\\x.json", "reference\.\x.json", "reference\..\reference\x.json", forward slashes and another case are the
// same file. Round 4: the same path answers whose answer any file SSAM kept holds (fileOrigin, below).
import fs from 'node:fs';
import path from 'node:path';
import { hostedContext } from './executor.mjs';

const canonical = file => {
  let resolved = path.resolve(file);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* a file not there yet: its resolved path */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** The folders ssam_reference writes its large answers to (ssam-reference.mjs outDir): every lane of the kernel root,
 *  or <outDir>/<lane> when the reference was given its own folder. */
// servidor/fase4-26 a7: folders, the exact folders (a hosted session: its workspace's <ws>/odc/.local/reference and
// <ws>/o11/reference, where its ssam_reference writes).
export function referenceFolders({ root, outDir = null, folders: given = null } = {}) {
  const folders = Array.isArray(given) ? given : outDir ? ['o11', 'odc'].map(lane => path.join(outDir, lane))
    : [path.join(root, '.local', 'reference'), path.join(root, '.local', 'lane-ss5', 'reference'), path.join(root, '.local', 'lane-odc', 'reference')];
  return folders.map(canonical);
}

/** Whether file is a reference answer SSAM wrote: a .json directly inside one of the folders. */
export function isReferenceDocument(file, folders) {
  if (typeof file !== 'string' || !file.trim() || !Array.isArray(folders)) return false;
  const real = canonical(file.trim());
  return real.endsWith('.json') && folders.includes(path.dirname(real));
}

// Round 4 (re-review MEDIUM 2): THE answer to "whose answer does this file hold?", on the same normalized path. ssam_evidence
// serves such a file as that tool's answer (the exit rule's mode and the day): a reference document is ssam_reference's; an
// answer SSAM kept for a later read (<root>/.local/answers/<sha256>.json: an omitted part, a paged answer, the final answer
// of a detached call) names the tool that answered, and the kind the rule reads, in its origin record <sha256>.origin,
// written next to it when it is kept (answer-size.mjs keepAnswer); any other file is evidence of a run (null).
/** The folders SSAM keeps answers in (answer-size.mjs keepAnswer) under a root. */
// a7: directory, the exact folder (a hosted session keeps its answers in ws:o11/answers).
export function answerFolders({ root, directory = null }) {
  return [canonical(directory ?? path.join(root, '.local', 'answers'))];
}
// a7 (no-internals list item 12): hosted, the answers are in the customer's visible area (ws:o11/answers), which the
// customer's agent may write to; the origin record of each one is kept in <ws>/state/answer-origins instead, a folder no
// tool or agent of the customer names, so a record the customer brings never decides how a server answer is read back.
const originRecord = file => {
  const context = hostedContext();
  const name = path.basename(file).replace(/\.json$/i, '') + '.origin';
  return context ? path.join(context.workspace, 'state', 'answer-origins', name) : file.replace(/\.json$/i, '') + '.origin';
};
/** Names the tool (and kind) whose answer a kept file holds; the first answer that kept a body names it. */
export function writeAnswerOrigin(file, origin) {
  if (!origin || typeof origin.tool !== 'string') return;
  const record = originRecord(file);
  if (fs.existsSync(record)) return;
  const temporary = record + '.' + process.pid + '.tmp';
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({ tool: origin.tool, ...(typeof origin.kind === 'string' ? { kind: origin.kind } : {}) }), 'utf8');
  fs.renameSync(temporary, record);
}
// Round 5 (re-review round 4, LOW 2; D13 of the Integradora, 17/10): a valid record names a tool (a tool name, nothing else)
// and, when it has one, a kind (a short line of text). A record that is missing, not JSON or of another shape is no origin.
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const KIND_NAME = /^[^\u0000-\u001f]{1,200}$/;
/** {tool, kind?} of the answer a file holds: a reference document or a kept answer with a valid origin record; else null. */
export function fileOrigin(file, { reference = [], answers = [] } = {}) {
  if (typeof file !== 'string' || !file.trim()) return null;
  const real = canonical(file.trim());
  if (!real.endsWith('.json')) return null;
  const folder = path.dirname(real);
  if (reference.includes(folder)) return { tool: 'ssam_reference' };
  if (!answers.includes(folder)) return null;
  try {
    const origin = JSON.parse(fs.readFileSync(originRecord(real), 'utf8'));
    if (typeof origin?.tool !== 'string' || !TOOL_NAME.test(origin.tool)) return null;
    if (origin.kind !== undefined && (typeof origin.kind !== 'string' || !KIND_NAME.test(origin.kind))) return null;
    return { tool: origin.tool, ...(origin.kind !== undefined ? { kind: origin.kind } : {}) };
  } catch { return null; }
}
/** Whether file is an answer SSAM kept (a .json directly inside one of the answer folders), whatever its record says. On a
 *  licensee's server such a file is read only as the answer its valid origin record names (D13: none, refused). */
export function isKeptAnswer(file, answers = []) {
  if (typeof file !== 'string' || !file.trim()) return false;
  const real = canonical(file.trim());
  return real.endsWith('.json') && answers.includes(path.dirname(real));
}
