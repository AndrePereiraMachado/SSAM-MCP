// Errors of the Service Center tools (port of kernel/scripts/service_center: http.ProtocolError/BridgeError,
// auth.AuthRequired, client.LayoutError). A ProtocolError is a local refusal; a BridgeError carries a contract code
// and extra facts (write, executed, sent, target...); an AuthRequired also says which login path was tried.
// Continuations name an MCP tool with its arguments, never a shell command or a script.
import { urlsplit } from './urls.mjs';

export class ProtocolError extends Error {
  constructor(message, code = 'SC_PROTOCOL_INVALID') { super(message); this.name = 'ProtocolError'; this.code = code; }
}

export class BridgeError extends ProtocolError {
  constructor(code, message, extra = {}) { super(message); this.name = 'BridgeError'; this.code = code; this.extra = extra; }
}

export const continuation = (tool, args, why) => ({ tool, arguments: args, why });
export const connectStudio = why => continuation('ssam_connect', { lane: 'o11' }, why);

export class AuthRequired extends BridgeError {
  constructor(code, message, { auth = null, continuation: next = null, attempts = [] } = {}) {
    super(code, message);
    this.name = 'AuthRequired'; this.auth = auth; this.continuation = next; this.attempts = attempts;
  }
  answer() {
    return { ok: false, code: this.code, stage: 'authentication', error: this.message, auth: this.auth ?? {},
      ...(this.continuation ? { continuation: this.continuation } : {}), attempts: this.attempts };
  }
}

// A refusal decided before any reservation, with the fields the next call needs (EXTENSION_VERSION_CHANGED with the
// observed version, STUDIO_BRIDGE_OUTDATED with the missing operations). Nothing was reserved or sent.
export class Refusal extends BridgeError {
  constructor(code, message, fields = {}) { super(code, message, { write: true, executed: false }); this.name = 'Refusal'; this.fields = fields; }
  answer() { return { ok: false, code: this.code, error: this.message, ...this.fields }; }
}

// timer-schedule on a timer page without a schedule editor SSAM can write through (the live Service Center 11.42 page:
// generic control names, no recurrence control; session dd2b79c0, 2026-10-05 01:06). Not an unknown layout and no
// capture round: the schedule of an O11 timer is its Schedule property in the module, delivered with o11_deliver (the
// native occurrence syntax, not prose accepted without semantic validation). Nothing was sent.
export class ScheduleInModule extends BridgeError {
  constructor({ timer, module = null, schedule = null, current = {} }) {
    const op = { op: 'set', target: 'ITimer:' + timer, prop: 'Schedule', value: schedule ?? '<native schedule, e.g. 00:00 12:00>' };
    const override = current.effectiveSchedule && current.defaultSchedule && current.effectiveSchedule !== current.defaultSchedule
      ? ` Service Center shows the effective schedule '${current.effectiveSchedule}' over the default '${current.defaultSchedule}': `
        + 'the module sets the default, and the effective one changes only where Service Center has no override.' : '';
    super('TIMER_SCHEDULE_IN_MODULE', `The timer page of ${timer} has no schedule editor SSAM writes through, so nothing was sent. The schedule `
      + `of an O11 timer is its Schedule property in the module: deliver ${JSON.stringify(op)} with o11_deliver${module ? ' on ' + module : ''} `
      + '(the user\'s words), then publish. Use native HH:mm occurrences, for example "00:00 12:00". Runtime activation and cadence require live verification.' + override,
    { write: true, executed: false, continuation: continuation('o11_deliver', { module: module ?? '<module of the timer>', job: { ops: [op] } },
      'the timer schedule is a module property; the deliver needs the user\'s authorization words and a publish afterwards') });
    this.name = 'ScheduleInModule';
    Object.assign(this, { timer, module, schedule, current, op });
  }
  answer() {
    return { ok: false, code: this.code, error: this.message, timer: this.timer, ...(this.module ? { module: this.module } : {}),
      ...(Object.keys(this.current).length ? { current: this.current } : {}), ...(this.schedule ? { schedule: this.schedule } : {}),
      job: { ops: [this.op] }, executed: false, continuation: this.extra.continuation };
  }
}

// A target whose lock an earlier pending or uncertain receipt holds (P6, friction c8b1090d, 2026-10-08): nothing was
// reserved or sent. The answer names the receipt and the two ways out: verify (reads the target's real state and resolves
// the receipt when the state proves it) and discard (the user's words naming the target, journaled). A ProtocolError, not
// a BridgeError: it is never classified as an outcome of a send.
export class TargetPending extends ProtocolError {
  constructor({ holder = null, receipt = null, host = null } = {}) {
    const name = receipt?.identity?.name ?? receipt?.plan?.name ?? null;
    super(`This runtime target has a pending/uncertain operation (${receipt?.identity?.action ?? 'unknown'}${name ? ' of ' + name : ''}, `
      + `receipt ${holder ?? 'unknown'}, state ${receipt?.state ?? 'unknown'}); nothing was reserved or sent. verify reads the target's real `
      + 'state and resolves the receipt when it proves the outcome; when it cannot, the user may discard it with words naming the target.');
    this.name = 'TargetPending'; this.code = 'TARGET_PENDING';
    this.holder = holder; this.receipt = receipt; this.host = host ?? receipt?.identity?.host ?? null; this.target = name;
  }
  answer() {
    const base = { ...(this.host ? { host: this.host } : {}), operationId: this.holder ?? '<operationId>' };
    return { ok: false, code: this.code, error: this.message, executed: false, holder: this.holder,
      ...(this.receipt ? { holderState: this.receipt.state, holderAction: this.receipt.identity?.action ?? null, holderCreatedAt: this.receipt.createdAt ?? null } : {}),
      continuation: continuation('o11_service_center_write', { action: 'verify', ...base },
        'reads the real state of the target (a deleted timer, a run after the attempt, or no run long after it) and resolves the receipt'),
      alternatives: [continuation('o11_service_center_write', { action: 'discard', ...base, words: `<the user's own words naming ${this.target ?? 'the target'}>` },
        'only when the user decides: closes the receipt as discarded (journaled) and frees the target; nothing is sent')] };
  }
}

// A Service Center page modeled only on synthetic fixtures (ASSUMED) that does not show the layout the parser knows.
// Nothing is guessed and nothing is sent; the answer asks for a live capture of the page.
export class LayoutError extends BridgeError {
  constructor(url, what, detail) {
    const parts = urlsplit(url || '');
    const pagePath = parts.path.split('/').at(-1) + (parts.query ? '?' + parts.query : '');
    super('LAYOUT_UNKNOWN', `${what}: ${detail}. This Service Center page was modeled on synthetic fixtures and not `
      + 'captured live yet, so nothing was guessed or sent. Capture this page live with o11_service_center_read '
      + `action=page-layout path=${pagePath} (a read-only GET) so the parser can be calibrated.`,
    { write: true, executed: false,
      continuation: continuation('o11_service_center_read', { action: 'page-layout', path: pagePath },
        'a read-only capture of this page lets the parser be calibrated') });
    this.name = 'LayoutError';
  }
}
