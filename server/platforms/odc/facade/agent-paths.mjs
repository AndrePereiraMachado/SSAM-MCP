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
import path from 'node:path';

export const AGENT_FOLDERS = ['inbox', 'odc', 'o11'];
export const PATH_OUTSIDE_WORKSPACE = 'PATH_OUTSIDE_WORKSPACE';
// The marker a continuation carries where the job itself goes (fase4-24: a hosted job travels inline, as compact JSON).
export const INLINE_JOB_MARKER = '<o próprio job: o JSON, compacto>';
const normalize = value => String(value).replace(/\//g, '\\').replace(/\\+$/, '');
const fold = value => normalize(value).toLowerCase();

export function agentPath(abs, { agentRoot } = {}) {
  if (typeof abs !== 'string' || !abs || typeof agentRoot !== 'string' || !agentRoot) return null;
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
export function outsideWorkspaceRefusal(value, { agentRoot, tool, args = {}, field = 'job' } = {}) {
  const name = (typeof value === 'string' && path.win32.basename(normalize(value))) || 'job.json';
  const target = agentRoot ? path.win32.join(normalize(agentRoot), 'inbox', name) : '<pasta do agente>\\inbox\\' + name;
  const reference = 'agent:inbox/' + name;
  // fase4-24: a job file the agent cannot read is not copied there: the job itself goes inline in the same call (one
  // request straight to the server, no upload through the agent). Other files (an OML, an image) still go to the inbox.
  const inline = Boolean(tool) && field === 'job';
  const inbox = 'grave em ' + target + ' com a ferramenta Write (UTF-8) e passe ' + reference;
  return {
    code: PATH_OUTSIDE_WORKSPACE,
    error: 'The path ' + String(value ?? '').slice(0, 300) + ' is outside the folders the agent reads (' + AGENT_FOLDERS.map(f => f + '/').join(', ') + ' of its root).',
    fix: inline ? 'mande o próprio job inline em job (o JSON, compacto) na mesma chamada: vai direto ao servidor, sem arquivo; o inbox fica para arquivos do usuário (OML, imagens). Se o job já existe em arquivo: ' + inbox : inbox,
    ...(agentRoot ? { agentRoot: normalize(agentRoot), inbox: path.win32.join(normalize(agentRoot), 'inbox') } : {}),
    continuation: { tool: tool ?? 'ssam_doctor', arguments: tool ? { ...args, [field]: inline ? INLINE_JOB_MARKER : reference } : {},
      why: !tool ? 'mostra a pasta do agente' : inline ? 'a mesma chamada com o próprio job inline (JSON compacto) no lugar do marcador' : 'a mesma chamada lendo o arquivo gravado no inbox do agente' },
  };
}
