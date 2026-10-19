// The folder of the agent, said before it is needed (C26 of the atritos 3 package). In the hosted server the agent reads
// only inside its own root (the mirror's AGENT_READABLE: inbox/, odc/, o11/); a session that wrote its job to the Temp
// folder or its scratchpad got PATH_OUTSIDE_WORKSPACE without the folder it should have used. Pure: the server line
// (hosted/policy.mjs) binds it with the root the agent reports in its Hello (agent.root).
//
//   agentPath(abs, {agentRoot})              'agent:<rel>' when abs is under agentRoot in inbox/, odc/ or o11/ (case and
//                                            separators ignored), else null
//   outsideWorkspaceRefusal(value, {agentRoot, tool, args, field})
//                                            {code:'PATH_OUTSIDE_WORKSPACE', error, fix, continuation}: the fix names the
//                                            exact place, <agentRoot>\inbox\<name>, written with the Write tool (UTF-8), and
//                                            the continuation is the same tool with agent:inbox/<name>; for a job (field
//                                            job, fase4-24) the job itself goes inline: the fix says so first and the
//                                            continuation is the same tool with job = INLINE_JOB_MARKER
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
export function outsideWorkspaceRefusal(value, { agentRoot, tool, args = {}, field = 'job' } = {}) {
  const base = typeof value === 'string' ? path.win32.basename(normalize(value)) : '';
  const name = FILE_NAME.test(base) ? base : field === 'job' ? 'job.json' : '<file name>';
  // The folder of a macOS agent keeps its own style (fase4-26/a8-mac); a Windows one the answer it always had.
  const posix = isPosixRoot(agentRoot);
  const place = (...parts) => (posix ? agentJoin(agentRoot, ...parts) : path.win32.join(normalize(agentRoot), ...parts));
  const target = agentRoot ? place('inbox', name) : '<agent folder>\\inbox\\' + name;
  const reference = 'agent:inbox/' + name;
  // fase4-24: a job file the agent cannot read is not copied there: the job itself goes inline in the same call (one
  // request straight to the server, no upload through the agent). Other files (an OML, an image) still go to the inbox.
  const inline = Boolean(tool) && field === 'job';
  const inbox = 'write ' + target + ' with the Write tool (UTF-8) and pass ' + reference;
  return {
    code: PATH_OUTSIDE_WORKSPACE,
    error: 'The path this call names is outside the folders the agent reads (' + AGENT_FOLDERS.map(f => f + '/').join(', ') + ' of its root) and outside your own workspace on this server; nothing was read there.',
    fix: inline ? 'send the job itself inline in job (its JSON, compact) in the same call: it goes straight to the server, with no file; the inbox is for the user\'s own files (OML, images). If the job already is a file: ' + inbox : inbox,
    ...(agentRoot ? { agentRoot: posix ? posixRoot(agentRoot) : normalize(agentRoot), inbox: place('inbox') } : {}),
    continuation: { tool: tool ?? 'ssam_doctor', arguments: tool ? { ...args, [field]: inline ? INLINE_JOB_MARKER : reference } : {},
      why: !tool ? 'shows the agent folder' : inline ? 'the same call with the job itself inline (compact JSON) in place of the marker' : 'the same call reading the file written to the agent inbox' },
  };
}
