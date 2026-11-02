// The one closed list of agent call kinds (docs/FASE2-AGENTE.md 4.4), read by the hub (agent-hub.mjs: what it sends), the
// executor seam (executor.mjs: what runs on this machine) and the hosted executor (hosted/agent-executor.mjs: what it
// forwards). R2-H (review H4): the executor kept its own copy, 11 kinds against the hub's 13 (no net.probe since fase4-24,
// no screen.render since the preview); one list here, so a new kind cannot reach one of them and miss the others.
//
// The six kinds that touch a machine come first (MACHINE_KINDS); then the file kinds between the server and the agent;
// net.probe (fase4-24, 2.10): the network check of ssam_doctor {network:true}; file.upload (fase4-28/r2-briefing) and
// screen.render (fase4-28 r2-preview, DESENHO-PREVIEW-UPLOAD 2.3), sent only to an agent whose Hello lists them. New kinds
// go at the END, so the hub's supports() keeps the nine of protocol 1 for an agent without kinds. o11.users (fase4-28 r4,
// hosted/users-agent.mjs): the Users application through the user's agent, sent only to an agent whose Hello lists it.
// o11.xif (F4 of PLANO-11H, hosted/xif-stage.mjs): one Integration Studio stage (model or final) of o11_extension on the
// user's machine, with the user's own Integration Studio; sent only to an agent whose Hello lists it. credential.session (r40a,
// hosted/credential-agent.mjs): a private Service Center or ODC Portal sign-in and request run by the user's agent, the secret kept
// on the user's machine; sent only to an agent whose Hello lists it. document.fetch (r40,
// integration-documents.mjs): one integration document (a WSDL and what it imports, an OpenAPI document, a rest-consume sample GET)
// downloaded by the user's agent on the user's machine for a hosted customer, whose server never makes that request; sent only
// to an agent whose Hello lists it (the Node agent 0.3.12, 0.4.9-native, the SSAM Agent app 0.2.4).
export const CALL_KINDS = Object.freeze(['studio.processes', 'odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected',
  'file.put', 'file.get', 'file.list', 'file.sync', 'net.probe', 'file.upload', 'screen.render', 'o11.users', 'o11.xif', 'credential.session', 'document.fetch']);
// The kinds that touch a machine: the only ones the local executor runs and the hosted executor forwards.
export const MACHINE_KINDS = Object.freeze(CALL_KINDS.slice(0, 6));
// The kinds of protocol 1: what an agent whose Hello lists no kinds supports.
export const PROTOCOL1_KINDS = Object.freeze(CALL_KINDS.slice(0, 9));
// The kinds sent only to an agent whose Hello lists them (the hub refuses KIND_NOT_ALLOWED before anything is written).
export const HELLO_ONLY_KINDS = Object.freeze(new Set(['file.upload', 'screen.render', 'o11.users', 'o11.xif', 'credential.session', 'document.fetch']));
