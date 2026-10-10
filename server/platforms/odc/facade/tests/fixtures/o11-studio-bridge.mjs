// A fake O11 bridge with programmable Studio state, for o11-studio.test.mjs. Built on fake-o11-bridge.mjs (ephemeral
// loopback port, one JSON line per request). Replies follow kernel\src\Anvil.Bridge (Reads, WindowsHandler, OpenHandler,
// MergeHandler.Snapshot, ScApiHandler): the authenticated verbs refuse a wrong key as BridgeAccess.Require does.
// state.before(request, state) runs before each reply (transitions such as "the dialog goes away on the 3rd read");
// state.replies[method](params, state) overrides one verb. The `login` verb (credential file) is deliberately absent.
import { fakeBridge } from './fake-o11-bridge.mjs';

const ok = data => ({ success: true, data, error: null });
const fail = error => ({ success: false, data: null, error });
const scOk = (host, user, body) => ok({ ok: true, source: 'studio', host, user, elapsedMs: 0, ...body });

export async function studioBridge(initial = {}) {
  const state = { key: 'K', pid: 4242, version: '9.9.9.9', protocol: 2, alive: true, active: null, dialogs: [], modules: [],
    environments: [], windows: [], sessions: {}, loginPending: {}, errors: null, publishLog: null, opened: [], replies: {}, before: null, ...initial };
  const handlers = {
    ping: () => ok({ pid: state.pid, bridge: 'anvil', version: state.version, uiThread: false }),
    bridge_manifest: () => ok({ bridge: 'anvil', protocolVersion: state.protocol, authentication: true, verbs: ['ping'], capabilities: ['studio_login', 'sc_session'] }),
    get_active_module: () => (state.active ? ok({ ...state.active, bridgeSessionId: 's', pendingDialogs: state.dialogs })
      : fail('InvalidOperationException: no module open in the Studio')),
    list_open_modules: () => ok({ count: state.modules.length, modules: state.modules, environments: state.environments }),
    ui_alive: p => ok({ alive: state.alive, elapsedMs: 1, timeoutMs: p.timeout_ms ?? 5000 }),
    windows: p => ok({ count: state.windows.length, windows: state.windows.map(w => ({ width: 400, height: 300, isActive: false, ...w,
      texts: (w.texts ?? []).slice(0, p.max_texts ?? 40) })) }),
    close_dialog: p => {
      const closed = [];
      state.windows = state.windows.filter(w => {
        const match = w.isModal && w.isVisible && (p.title == null || String(w.title).toLowerCase() === String(p.title).toLowerCase())
          && (p.type == null || String(w.type).toLowerCase() === String(p.type).toLowerCase());
        if (match) closed.push(w.type + ':' + w.title);
        return !match;
      });
      return ok({ closed });
    },
    open_module: p => {
      state.opened.push(p);
      const module = { name: p.name, key: 'key-' + p.name, environment: p.environment ?? 'dev.example.com', isModified: false };
      state.active = { ...module, kind: 'Web' };
      return ok({ name: p.name, opened: true, alreadyOpen: false, selected: true, serverSilentMode: false, referencesCheck: 'complete', referencesOutdated: false, elapsedMs: 12 });
    },
    snapshot_module: p => {
      if (!state.active) return fail('InvalidOperationException: no module open in the Studio');
      if (p.module_key && p.module_key !== state.active.key) return fail('InvalidOperationException: Requested module identity is no longer active; nothing was executed');
      return ok({ baseline: [], environment: state.active.environment, bridgeSessionId: 's', snapshot_id: 'snap-1', sha256: 'ab'.repeat(32),
        path: p.path, bytes: 10, name: state.active.name, key: state.active.key, elapsedMs: 3 });
    },
    get_errors: p => (state.errors ? ok(state.errors(p)) : fail('InvalidOperationException: no module open in the Studio')),
    // PublishLogHandler.Handle: absent (an older bridge) unless the test gives state.publishLog(params) -> data.
    publish_log: p => (state.publishLog ? ok(state.publishLog(p)) : fail('Unknown method: publish_log')),
    studio_login: p => {
      if (state.sessions[p.host]) return scOk(p.host, null, { signedIn: true, dialogOpened: false });
      state.loginPending[p.host] = true;
      return scOk(p.host, null, { signedIn: false, dialogOpened: true, pending: true, note: 'the Studio shows its sign-in' });
    },
    sc_session: p => {
      const session = state.sessions[p.host];
      return scOk(p.host ?? '', session?.user ?? null, {
        studio: session ? { signedIn: true, host: p.host, user: session.user, loginType: 'token', serverVersion: '11.x' }
          : { signedIn: false, loginPending: state.loginPending[p.host] === true },
        signedInHosts: Object.keys(state.sessions), web: null, bridge: { bridge: 'anvil' } });
    },
  };
  const bridge = await fakeBridge(async request => {
    const params = request.params ?? {};
    if (state.before) await state.before(request, state);
    if (!['ping', 'bridge_manifest'].includes(request.method) && request.authorization !== state.key)
      return { success: false, data: null, error: 'UnauthorizedAccessException: Bridge operation requires the trusted Hybrid controller', executed: false };
    if (state.replies[request.method]) return state.replies[request.method](params, state);
    return handlers[request.method] ? handlers[request.method](params) : fail('Unknown method: ' + request.method);
  });
  return { ...bridge, state, methods: () => bridge.seen.map(r => r.method) };
}
