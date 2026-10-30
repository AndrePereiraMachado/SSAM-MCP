// The one closed list of agent call kinds (docs/FASE2-AGENTE.md 4.4), read by the hub (agent-hub.mjs: what it sends), the
// executor seam (executor.mjs: what runs on this machine) and the hosted executor (hosted/agent-executor.mjs: what it
// forwards). R2-H (review H4): the executor kept its own copy, 11 kinds against the hub's 13 (no net.probe since fase4-24,
// no screen.render since the preview); one list here, so a new kind cannot reach one of them and miss the others.
//
// The six kinds that touch a machine come first (MACHINE_KINDS); then the file kinds between the server and the agent;
// net.probe (fase4-24, 2.10): the network check of ssam_doctor {network:true}; file.upload (fase4-28/r2-briefing) and
// screen.render (fase4-28 r2-preview, DESENHO-PREVIEW-UPLOAD 2.3), sent only to an agent whose Hello lists them. New kinds
// go at the END, so the hub's supports() keeps the nine of protocol 1 for an agent without kinds.
export const CALL_KINDS = Object.freeze(['studio.processes', 'odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected',
  'file.put', 'file.get', 'file.list', 'file.sync', 'net.probe', 'file.upload', 'screen.render']);
// The kinds that touch a machine: the only ones the local executor runs and the hosted executor forwards.
export const MACHINE_KINDS = Object.freeze(CALL_KINDS.slice(0, 6));
// The kinds of protocol 1: what an agent whose Hello lists no kinds supports.
export const PROTOCOL1_KINDS = Object.freeze(CALL_KINDS.slice(0, 9));
// The kinds sent only to an agent whose Hello lists them (the hub refuses KIND_NOT_ALLOWED before anything is written).
export const HELLO_ONLY_KINDS = Object.freeze(new Set(['file.upload', 'screen.render']));
