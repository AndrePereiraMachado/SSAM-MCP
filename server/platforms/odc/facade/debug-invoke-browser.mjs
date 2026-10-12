import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail, describeParameters } from './debug-invoke-contract.mjs';
import { privateRequest, checkNativeRequest } from './debug-invoke-http.mjs';
import { localAppDataViews } from './debug-state-root.mjs';

// A private transport, not a configurable DevTools proxy: only the user's isolated preview profile. Accepted under
// this process's %LOCALAPPDATA% view and under the real folder (an MSIX caller sees its own copy of the first).
const previewRoots = () => { try { return localAppDataViews().map(view => view.path); } catch { return [process.env.LOCALAPPDATA]; } };
export function isPreviewProfile(profile, local = previewRoots()) {
  if (!local || !profile) return false;
  return [local].flat().filter(Boolean).some(root => {
    const relative = path.win32.relative(root, profile).toLowerCase();
    return relative === 'codexbrowserpreview' || /^packages\\openai\.codex_[a-z0-9]+\\localcache\\local\\codexbrowserpreview$/.test(relative);
  });
}
export async function previewTarget(tabId, origin) {
  // Packaged Codex can virtualize LOCALAPPDATA. Verify the actual main-process profile first.
  const script = "@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match '--user-data-dir=(?:\"(?<profile>[^\"]+)\"|(?<profile>[^ ]+))' } | ForEach-Object { if ($_.CommandLine -match '--user-data-dir=(?:\"(?<profile>[^\"]+)\"|(?<profile>[^ ]+))') { $Matches.profile } }) | ConvertTo-Json -Compress";
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 });
  let profiles; try { profiles = JSON.parse(stdout); } catch { fail('invoke_preview_not_verified'); }
  const matches = (Array.isArray(profiles) ? profiles : [profiles]).filter(p => isPreviewProfile(p));
  if (matches.length !== 1) fail('invoke_preview_not_verified');
  const profile = matches[0];
  const [portText, browserPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
  if (!/^\d+$/.test(portText) || Number(portText) < 1024 || Number(portText) > 65535 || !/^\/devtools\/browser\/[a-f0-9-]+$/.test(browserPath)) fail('invoke_preview_not_verified');
  const base = 'http://127.0.0.1:' + portText;
  const version = await (await fetch(base + '/json/version', { signal: AbortSignal.timeout(3000) })).json();
  if (new URL(version.webSocketDebuggerUrl).pathname !== browserPath) fail('invoke_preview_not_verified');
  const tabs = await (await fetch(base + '/json/list', { signal: AbortSignal.timeout(3000) })).json();
  const target = tabs.find(t => t.id === tabId && t.type === 'page');
  if (!target || new URL(target.url).origin !== origin) fail('invoke_tab_origin_changed');
  const ws = new URL(target.webSocketDebuggerUrl);
  if (!['127.0.0.1', 'localhost'].includes(ws.hostname) || ws.port !== portText || ws.pathname !== '/devtools/page/' + tabId) fail('invoke_preview_not_verified');
  return target.webSocketDebuggerUrl;
}
export class Cdp {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.listeners = new Map();
    socket.addEventListener('message', e => {
      let message; try { message = JSON.parse(e.data); } catch { return; }
      if (message.id) { const p = this.pending.get(message.id); if (p) { clearTimeout(p.timer); this.pending.delete(message.id); message.error ? p.reject(new Error('invoke_browser_command_rejected')) : p.resolve(message.result); } }
      else for (const fn of this.listeners.get(message.method) ?? []) fn(message.params);
    });
    socket.addEventListener('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('invoke_browser_connection_lost')); } this.pending.clear(); });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => { socket.close(); reject(new Error('invoke_browser_unreachable')); }, 3000); socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('invoke_browser_unreachable')); }, { once: true }); });
    return new Cdp(socket);
  }
  send(method, params = {}, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('invoke_browser_command_timeout')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('invoke_browser_connection_lost')); }
    });
  }
  on(method, fn) { const list = this.listeners.get(method) ?? []; list.push(fn); this.listeners.set(method, list); }
  async evaluate(fn, value, timeout = 10000) {
    const r = await this.send('Runtime.evaluate', { expression: '(' + fn.toString() + ')(' + JSON.stringify(value) + ')', awaitPromise: true, returnByValue: true }, timeout);
    if (r.exceptionDetails || !r.result || r.result.subtype === 'error') fail('invoke_browser_script_failed');
    return r.result.value;
  }
  close() { this.socket.close(); }
}
export async function prepareBrowserPlan(input, identity, planId, connect = Cdp.connect) {
  const cdp = await connect(await previewTarget(input.tabId, input.origin));
  try {
    await cdp.send('Network.enable', { maxPostDataSize: 4194304 });
    let finish, reject, timer, captured = false;
    const observed = new Promise((resolve, fail) => { finish = resolve; reject = fail; timer = setTimeout(() => fail(new Error('invoke_request_not_observed: trigger the selected entry once or use reload=true')), input.timeoutSeconds * 1000); });
    observed.catch(() => {}); // Reload can fail before awaiting observation; retain the original rejection safely.
    cdp.on('Network.requestWillBeSent', async event => {
      if (captured || event.request.method !== 'POST' || event.request.url !== input.origin + identity.entryPath) return;
      captured = true;
      try {
        const text = event.request.postData ?? (await cdp.send('Network.getRequestPostData', { requestId: event.requestId })).postData;
        if (!text || Buffer.byteLength(text) > 4194304) fail('invoke_request_size');
        const body = JSON.parse(text), parameterDiscovery = { scope: input.inputPaths.length ? 'selected-paths' : 'automatic-scalars', complete: true };
        const parameters = describeParameters(body, input.inputPaths, parameterDiscovery);
        const headers = {};
        // Authentication is copied only inside the private broker/browser memory. Never returned or persisted.
        for (const [name, value] of Object.entries(event.request.headers)) if (/^(content-type|authorization|origin|referer|x-csrf-?token|x-requested-with|outsystems-csrftoken)$/i.test(name)) headers[name] = value;
        const cookies = await cdp.send('Network.getCookies', { urls: [event.request.url] });
        if (cookies.cookies.length) headers.Cookie = cookies.cookies.map(c => c.name + '=' + c.value).join('; ');
        const native = { url: event.request.url, method: 'POST', headers, body };
        checkNativeRequest(native, identity, input.origin);
        await privateRequest('Seal', planId, native);
        clearTimeout(timer); finish({ parameters, parameterDiscovery, versionInfo: body.versionInfo ? Object.keys(body.versionInfo) : [], method: 'POST' });
      } catch (error) { clearTimeout(timer); reject(new Error(/^invoke_[a-z_]+/.exec(error.message)?.[0] ?? 'invoke_capture_invalid')); }
    });
    try { if (input.reload) await cdp.send('Page.reload'); return await observed; } finally { clearTimeout(timer); }
  } finally { cdp.close(); }
}
