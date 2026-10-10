// The one error type of the agent. `code` goes to the server in result.error.code (docs/FASE2-AGENTE.md 3.5);
// `executed` says whether anything may have run on this machine: false (nothing ran), null (unknown).
export class AgentError extends Error {
  constructor(code, message, { executed = false, sent } = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.executed = executed;
    if (sent !== undefined) this.sent = sent;
  }
}

// A refusal before anything touched the machine.
export const refuse = (code, message) => new AgentError(code, message, { executed: false });
