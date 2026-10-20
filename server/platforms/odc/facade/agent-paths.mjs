// The folder of the agent, said before it is needed (C26 of the atritos 3 package). In the hosted server the agent reads
// only inside its own root (the mirror's AGENT_READABLE: inbox/, odc/, o11/); a session that wrote its job to the Temp
// folder or its scratchpad got PATH_OUTSIDE_WORKSPACE without the folder it should have used. Pure: the server line
// (hosted/policy.mjs) binds it with the root the agent reports in its Hello (agent.root).
//
//   agentPath(abs, {agentRoot})              'agent:<rel>' when abs is under agentRoot in inbox/, odc/ or o11/ (case and
//                                            separators ignored), else null
//   outsideWorkspaceRefusal(value, {agentRoot, tool, args, field, pointer, refused})
//                                            {code:'PATH_OUTSIDE_WORKSPACE', error, fix, continuation}: the fix names the
//                                            exact place, <agentRoot>\inbox\<name>, to COPY the file into as it is (a9
//                                            follow-up M2: never rewritten), and the continuation is the same tool with every
//                                            refused path of the pointer (a list too: /files/*) as agent:inbox/<name>; for a
//                                            job (field job, fase4-24) the job itself goes inline: the fix says so first and
//                                            the continuation is the same tool with job = INLINE_JOB_MARKER
//
// fase4-26/a8-mac: an agent on macOS reports a POSIX folder (/Users/<user>/SSAM-Agent, docs/AGENTE-MAC.md). The paths of
// the user's machine then follow that folder: '/' separators, names compared without case and in NFC (APFS by default).
//   isPosixRoot(root)                 the agent folder is POSIX (macOS)
//   agentJoin(root, ...parts)         a path of the user's machine under the agent folder, in the folder's style
//   isAgentMachinePath(value, root)   value is an absolute path of the user's machine (a drive letter, or POSIX when the
//                                     agent folder is POSIX), the form C26 maps to agent:
import path from 'node:path';

export const AGENT_FOLDERS = ['inbox', 'odc', 'o11'];
export const PATH_OUTSIDE_WORKSPACE = 'PATH_OUTSIDE_WORKSPACE';
// The marker a continuation carries where the job itself goes (fase4-24: a hosted job travels inline, as compact JSON).
export const INLINE_JOB_MARKER = '<the job itself: its JSON, compact>';
const normalize = value => String(value).replace(/\//g, '\\').replace(/\\+$/, '');
const fold = value => normalize(value).toLowerCase();

export const isPosixRoot = root => typeof root === 'string' && root.startsWith('/') && !root.startsWith('//');
const posixRoot = root => root.replace(/\/+$/, '') || '/';
export const agentJoin = (root, ...parts) => (isPosixRoot(root) ? path.posix.join(posixRoot(root), ...parts) : path.win32.join(root, ...parts));
export const isAgentMachinePath = (value, root) => typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || (isPosixRoot(root) && isPosixRoot(value)));
const foldPosix = value => value.normalize('NFC').toLowerCase();

// macOS: the same rule with POSIX paths, segment by segment (an NFD spelling of the folder is the same folder).
function posixAgentPath(abs, agentRoot) {
  if (!isPosixRoot(abs) || /[\x00-\x1f]/.test(abs)) return null;
  const root = posixRoot(agentRoot).split('/');
  const parts = path.posix.normalize(abs).split('/');
  if (abs.split('/').includes('..')) return null;
  if (parts.length <= root.length || !root.every((part, i) => foldPosix(part) === foldPosix(parts[i]))) return null;
  const relative = parts.slice(root.length).filter(Boolean);
  if (relative.length < 2 || !AGENT_FOLDERS.includes(relative[0].toLowerCase())) return null;
  return 'agent:' + [relative[0].toLowerCase(), ...relative.slice(1)].join('/');
}

export function agentPath(abs, { agentRoot } = {}) {
  if (typeof abs !== 'string' || !abs || typeof agentRoot !== 'string' || !agentRoot) return null;
  if (isPosixRoot(agentRoot)) return posixAgentPath(abs, agentRoot);
  if (!path.win32.isAbsolute(abs) || !path.win32.isAbsolute(agentRoot)) return null;
  const root = fold(path.win32.resolve(normalize(agentRoot)));
  const full = path.win32.resolve(normalize(abs));
  if (!fold(full).startsWith(root + '\\')) return null;
  const relative = full.slice(root.length + 1).split('\\').filter(Boolean);
  if (relative.length < 2 || !AGENT_FOLDERS.includes(relative[0].toLowerCase())) return null;
  if (relative.some(part => part === '..')) return null;
  return 'agent:' + [relative[0].toLowerCase(), ...relative.slice(1)].join('/');
}

// value: the path the call named. name: its file name (a job.json when it has none).
// servidor/fase4-26 a9: the refusal is generic. It never says the path back (a folder of the server, the real folder of a
// workspace, another customer's token: the gate answers before any presenter), and it names the file only by a plain file
// name (a name with an extension); anything else (a folder, a token) is <file name>, or job.json for a job.
const FILE_NAME = /^[^<>:"|?*\\/\x00-\x1f]{1,120}\.[A-Za-z0-9]{1,12}$/;
// a9 follow-up (review vps-a9 M2): the user's file goes into the agent inbox COPIED as it is (Copy-Item, cp), never rewritten:
// "write it with the Write tool" made the model transcribe a data file of up to 64 MiB (a read cut at 2000 lines became a
// partial load marked complete; leading zeros and decimals changed). And the continuation is the same call wherever the path
// is in its arguments (a pointer of hosted/tools.json, '*' for every item of a list: o11_data /request/files/*,
// studio_data_insert /files/*), with every path of that pointer the gate refuses (refused, the gate's rule) as
// agent:inbox/<name>: one refusal for the whole list, never a refusal per file and never ssam_doctor.
const segmentsOf = pointer => String(pointer).split('/').slice(1).map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'));
const pointerOf = keys => keys.map(k => '/' + String(k).replaceAll('~', '~0').replaceAll('/', '~1')).join('');
// A copy of args with map applied at every location of the pointer; map(value, at) returns the value to put there.
function mapAt(args, pointer, map) {
  const copy = structuredClone(args ?? {});
  const segments = segmentsOf(pointer);
  const walk = (node, i, at) => {
    if (!node || typeof node !== 'object') return;
    const key = segments[i], last = i === segments.length - 1;
    const keys = key === '*' ? (Array.isArray(node) ? node.map((_, j) => j) : Object.keys(node)) : Object.hasOwn(node, key) ? [key] : [];
    for (const k of keys) { if (last) node[k] = map(node[k], [...at, k]); else walk(node[k], i + 1, [...at, k]); }
  };
  if (segments.length) walk(copy, 0, []);
  return copy;
}
const andList = list => (list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list.at(-1));
// role 'out' (an output the tool writes: /out, /output): no file to copy; the output is named inside the workspace instead.
export function outsideWorkspaceRefusal(value, { agentRoot, tool, args = {}, field = 'job', pointer = null, refused = null, role = 'in' } = {}) {
  // (the field a pointer names: /job, /oml, /localOml; /request/files/* is files; only /job is the job that goes inline)
  if (pointer) field = segmentsOf(pointer).filter(segment => segment !== '*').at(-1) ?? field;
  const jobField = pointer ? pointer === '/job' : field === 'job';
  const at = pointer && tool ? pointer : tool && field ? pointerOf([field]) : null;
  const nameOf = v => { const base = typeof v === 'string' ? path.win32.basename(normalize(v)) : ''; return FILE_NAME.test(base) ? base : field === 'job' ? 'job.json' : '<file name>'; };
  // The folder of a macOS agent keeps its own style (fase4-26/a8-mac); a Windows one the answer it always had.
  const posix = isPosixRoot(agentRoot);
  const place = (...parts) => (agentRoot ? (posix ? agentJoin(agentRoot, ...parts) : path.win32.join(normalize(agentRoot), ...parts))
    : ['<agent folder>', ...parts].join(posix ? '/' : '\\'));
  // fase4-24: a job file the agent cannot read is not copied there: the job itself goes inline in the same call (one
  // request straight to the server, no upload through the agent). Other files (an OML, an image, a data file) go to the inbox.
  const inline = Boolean(tool) && jobField && role !== 'out';
  // Every refused path of the pointer, by its place in the arguments (a name taken twice is numbered: data.csv, data-2.csv).
  const entries = [], taken = new Map();
  const isRefused = v => v === value || (typeof refused === 'function' && typeof v === 'string' && v !== '' && refused(v));
  let continued = at ? mapAt(args, at, (v, keys) => {
    if (!isRefused(v)) return v;
    if (inline) { entries.push({ name: nameOf(v), as: nameOf(v) }); return INLINE_JOB_MARKER; }
    const name = nameOf(v), seen = taken.get(name) ?? 0;
    taken.set(name, seen + 1);
    const as = seen ? name.replace(/(\.[^.]+)?$/, m => '-' + (seen + 1) + m) : name;
    entries.push({ name, as, at: pointerOf(keys) });
    return role === 'out' ? as : 'agent:inbox/' + as;
  }) : null;
  // (a top-level field the arguments do not hold, as the callers of C26 name it: the same call with it, as before)
  if (at && !entries.length && /^\/[^/*]+$/.test(at)) {
    const name = nameOf(value);
    continued = { ...continued, [field]: inline ? INLINE_JOB_MARKER : role === 'out' ? name : 'agent:inbox/' + name };
    entries.push({ name, as: name });
  }
  // (a value the arguments do not hold at a deeper pointer: no same call to repeat; the doctor shows the agent folder)
  const same = Boolean(at) && entries.length > 0;
  if (!entries.length) entries.push({ name: nameOf(value), as: nameOf(value) });
  const label = e => (e.as === e.name ? e.name : e.name + ' (at ' + e.at + ') as ' + e.as);
  const how = posix ? 'cp' : 'Copy-Item';
  const copy = entries.length === 1
    ? 'copy ' + label(entries[0]) + ' as it is into ' + place('inbox', entries[0].as) + ' (' + how + '; never rewrite its content: a rewritten file can come back cut or changed) and pass agent:inbox/' + entries[0].as
    : 'copy ' + andList(entries.map(label)) + ' as they are into ' + place('inbox') + (posix ? '/' : '\\') + ' (' + how + '; never rewrite their content: a rewritten file can come back cut or changed) and pass each as agent:inbox/<name>';
  return {
    code: PATH_OUTSIDE_WORKSPACE,
    error: 'The path this call names is outside the folders the agent reads (' + AGENT_FOLDERS.map(f => f + '/').join(', ') + ' of its root) and outside your own workspace on this server; nothing was read there.',
    fix: role === 'out' ? 'name the output inside your own workspace: its file name alone (' + entries.map(e => e.as).join(', ') + '), which the server writes in your workspace, or a ws:<rel> path'
      : inline ? 'send the job itself inline in job (its JSON, compact) in the same call: it goes straight to the server, with no file; the inbox is for the user\'s own files (OML, images, data). If the job already is a file: ' + copy : copy,
    ...(agentRoot ? { agentRoot: posix ? posixRoot(agentRoot) : normalize(agentRoot), inbox: place('inbox') } : {}),
    continuation: { tool: same ? tool : 'ssam_doctor', arguments: same ? continued : {},
      why: !same ? 'shows the agent folder' : inline ? 'the same call with the job itself inline (compact JSON) in place of the marker'
        : role === 'out' ? 'the same call writing the output in your workspace'
        : 'the same call reading the file' + (entries.length > 1 ? 's' : '') + ' copied into the agent inbox' },
  };
}
