// O11 bridge methods through the agent (docs/FASE2-AGENTE.md 4.6): the same mirror rule as ODC, with
// <ws>/o11/<rel> <-> agent:o11/<rel> (all of o11/ is writable on the agent). The caller has already removed port and
// authorization: the agent always talks to the port of its own record, with its own key.
import { randomUUID } from 'node:crypto';
import { MirrorError } from './mirror.mjs';
import { mapAgentPaths } from './odc-stage.mjs';

// login carries a credential file; the exports are not used in hosted mode.
export const refusedMethod = method => method === 'login' || /^export_/.test(String(method));

// One o11.bridge call: { params } to send and after(value) for the {reply} that comes back. Errors before the send are
// MirrorErrors with sent:false (the bridge never saw the request).
export async function stageO11Bridge({ method, params }, mirror, { newId = randomUUID } = {}) {
  if (refusedMethod(method)) throw new MirrorError('METHOD_NOT_ALLOWED', 'The bridge method ' + method + ' is not available in hosted mode.');
  const p = structuredClone(params ?? {});
  if ((method === 'sc_api' || method === 'sc_web') && p.args && typeof p.args === 'object' && Object.hasOwn(p.args, 'outFile'))
    throw new MirrorError('HOSTED_PATH_PARAM_REFUSED', 'args.outFile is not accepted in hosted mode: the bridge would write a file on the user\'s machine that the server never reads.');
  let snapshot = false, download = false;
  if (method === 'snapshot_module' && typeof p.path === 'string') { p.path = mirror.output(p.path); snapshot = true; }
  if (method === 'merge_from_oml') {
    // first_pass_path: the merge order's first-pass copy (Delivery), read by the bridge like the candidate.
    for (const field of ['foreign_path', 'base_path', 'first_pass_path']) if (typeof p[field] === 'string') p[field] = await mirror.input(p[field], 'o11');
  }
  if (method === 'environment_session' && p.operation === 'download') {
    // The kernel passes null (Publisher.cs) or its temporary folder, which hosted processes keep in the workspace.
    p.arguments = { ...(p.arguments ?? {}) };
    const dir = p.arguments.outputDirectory;
    p.arguments.outputDirectory = dir === null || dir === undefined ? 'agent:o11/downloads/' + newId() : mirror.output(dir);
    download = true;
  }
  if (method === 'sc_api' && p.args && typeof p.args.file === 'string')
    p.args = { ...p.args, file: await mirror.input(p.args.file, 'o11', { stageAlways: true }) };

  return {
    params: p,
    async after(value) {
      const { paths, ...rest } = value ?? {};
      const reply = value?.reply;
      if (!reply || typeof reply !== 'object') return rest;
      // The paths the server reads next MUST come back as agent: (anything else is a violation, nothing written); the
      // other agent paths are the strings the agent reports it rewrote. Any other text is data.
      const required = [];
      if (reply.success === true && snapshot) required.push(['data', 'path']);
      if (reply.success === true && download && reply.data?.value?.FilePath != null) required.push(['data', 'value', 'FilePath']);
      const bring = required.map(keys => keys.reduce((node, key) => node?.[key], reply));
      for (const agentPath of bring) mirror.fromAgent(agentPath);
      const mapped = mapAgentPaths(structuredClone(reply), paths, text => mirror.fromAgent(text), { link: mirror.link, required });
      for (const agentPath of bring) await mirror.pull(agentPath);
      return { ...rest, reply: mapped };
    },
  };
}
