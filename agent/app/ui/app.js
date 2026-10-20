// The panel: renders the state the main process pushes and sends the person's actions through window.ssam
// (src/preload.cjs). No framework, no network: everything comes over the bridge.
/* global ssam */
const $ = id => document.getElementById(id);
let current = null;
let setupOpen = false;

const DOT = { 'not-set-up': 'red', attention: 'red', stopped: 'grey', external: 'grey', starting: 'amber', connecting: 'amber', reconnecting: 'amber', connected: 'green' };
const running = view => ['starting', 'connecting', 'connected', 'reconnecting'].includes(view.status);

function updateLine(update, version) {
  switch (update.status) {
    case 'off': return `Version ${version}. Updates are off: this build has no update server and none is set below.`;
    case 'checking': return `Version ${version}. Checking for updates...`;
    case 'available': return `Version ${version}. Update ${update.version ?? ''} found; downloading.`;
    case 'downloading': return `Version ${version}. Downloading update ${update.version ?? ''}: ${update.percent ?? 0}%.`;
    case 'ready': return `Update ${update.version ?? ''} is ready. Restart to install it (the agent is stopped cleanly first).`;
    case 'up-to-date': return `Version ${version} is up to date${update.checkedAt ? ` (checked ${new Date(update.checkedAt).toLocaleString()})` : ''}.`;
    case 'error': return `Version ${version}. The last update check failed: ${update.error}`;
    default: return `Version ${version}.`;
  }
}

function render(state) {
  current = state;
  const { agent, update, app, settings, busy } = state;
  const view = agent.view;
  $('dot').className = 'dot ' + (DOT[view.status] ?? 'grey');
  $('status-text').textContent = view.text;
  $('status-detail').textContent = view.detail;
  $('btn-start').hidden = running(view) || view.status === 'not-set-up';
  $('btn-stop').hidden = !running(view);
  $('btn-start').disabled = busy || view.status === 'external' || view.status === 'attention' && !agent.setUp;
  $('btn-stop').disabled = busy;
  $('f-server').textContent = agent.server ?? '-';
  $('f-root').textContent = agent.root;
  $('f-pack').textContent = agent.pack ? `${agent.pack.id} (lanes ${agent.pack.lanes.join(', ')}${agent.pack.odcBridge ? `, ODC bridge ${agent.pack.odcBridge}` : ''}${agent.pack.o11BuiltFor ? `, Service Studio ${agent.pack.o11BuiltFor}` : ''})` : `not installed yet (the app carries ${app.bundledPack ?? 'no pack'})`;
  $('f-process').textContent = agent.pid ? `pid ${agent.pid}${agent.state?.at ? `, ${agent.state.state} since ${new Date(agent.state.at).toLocaleString()}` : ''}` : agent.lastExit !== null && agent.lastExit !== undefined ? `not running (last exit code ${agent.lastExit})` : 'not running';
  for (const id of ['btn-doctor', 'btn-setup-show', 'btn-save']) $(id).disabled = busy;
  $('update-text').textContent = updateLine(update, app.version);
  $('btn-check').disabled = ['off', 'checking', 'downloading'].includes(update.status);
  $('btn-install').hidden = update.status !== 'ready';
  if (document.activeElement !== $('in-update-url')) $('in-update-url').value = settings.updateUrl ?? '';
  $('in-update-url').placeholder = app.updateSource === 'build' || app.updateSource === 'env' ? app.updateUrl : 'https://updates.example.com/ssam-agent';
  $('in-autostart-footer').checked = settings.autostart === true;
  $('f-version').textContent = `SSAM Agent ${app.version} (Electron ${app.electron}, Node ${app.node})${app.packaged ? '' : ', checkout'}`;
  const showSetup = setupOpen || !agent.setUp;
  $('card-setup').hidden = !showSetup;
  $('card-agent').hidden = showSetup && !agent.setUp;
  $('btn-setup-cancel').hidden = !agent.setUp;
  if (showSetup && !$('in-root').value) $('in-root').value = agent.root || app.defaultRoot;
  if (showSetup && !$('in-server').value && agent.server) $('in-server').value = agent.server;
  if (showSetup && !$('in-port').value && agent.o11Port && agent.o11Port !== 4516) $('in-port').value = String(agent.o11Port);
}

function renderDoctor(result) {
  const box = $('doctor');
  box.hidden = false;
  box.textContent = '';
  if (!result.report) { box.textContent = result.text || 'The doctor gave no report.'; return; }
  const head = document.createElement('div');
  head.textContent = `${result.report.ok ? 'OK' : 'Problems found'}: agent ${result.report.agentVersion}, Node ${result.report.node}, pack ${result.report.pack?.id ?? '?'}`;
  box.appendChild(head);
  for (const check of result.report.checks ?? []) {
    const line = document.createElement('div');
    line.className = check.status;
    line.textContent = `[${check.status}] ${check.name}: ${check.detail}`;
    box.appendChild(line);
  }
}

async function refreshLog() {
  const lines = await ssam.readLog();
  $('log').textContent = lines.length ? lines.join('\n') : 'No log yet.';
  $('log').scrollTop = $('log').scrollHeight;
}

function showError(id, text) { const box = $(id); box.hidden = !text; box.textContent = text ?? ''; }

$('btn-start').addEventListener('click', async () => { const result = await ssam.start().catch(error => ({ error: error.message })); if (result?.error) showError('setup-error', result.error); });
$('btn-stop').addEventListener('click', () => ssam.stop());
$('btn-folder').addEventListener('click', () => ssam.openFolder());
$('btn-log').addEventListener('click', () => ssam.openLog());
$('btn-app-log').addEventListener('click', () => ssam.openAppLog());
$('btn-log-refresh').addEventListener('click', refreshLog);
$('btn-doctor').addEventListener('click', async () => { $('doctor').hidden = false; $('doctor').textContent = 'Running the doctor...'; renderDoctor(await ssam.doctor().catch(error => ({ report: null, text: error.message }))); });
$('btn-setup-show').addEventListener('click', () => { setupOpen = true; showError('setup-error', null); if (current) render(current); $('in-credential').focus(); });
$('btn-setup-cancel').addEventListener('click', () => { setupOpen = false; $('in-credential').value = ''; if (current) render(current); });
$('btn-pick').addEventListener('click', async () => { const folder = await ssam.pickRoot(); if (folder) $('in-root').value = folder; });
$('setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  showError('setup-error', null);
  $('btn-save').disabled = true;
  const payload = { server: $('in-server').value.trim(), credential: $('in-credential').value, root: $('in-root').value.trim(), o11Port: $('in-port').value.trim() || null, autostart: $('in-autostart').checked };
  const result = await ssam.setup(payload).catch(error => ({ ok: false, error: error.message.replace(/^Error invoking remote method '[^']*': Error: /, '') }));
  $('in-credential').value = '';
  if (result.ok) { setupOpen = false; if (current) render(current); refreshLog(); }
  else showError('setup-error', result.error || 'The setup did not finish.');
  $('btn-save').disabled = false;
});
$('btn-check').addEventListener('click', () => ssam.checkUpdates());
$('btn-install').addEventListener('click', () => ssam.installUpdate());
$('btn-update-url').addEventListener('click', async event => {
  event.preventDefault();
  showError('update-url-error', null);
  const result = await ssam.setSettings({ updateUrl: $('in-update-url').value.trim() || null }).catch(error => ({ error: error.message.replace(/^Error invoking remote method '[^']*': Error: /, '') }));
  if (result?.error) showError('update-url-error', result.error);
  else showError('update-url-error', 'Saved. The new address is used from the next start of the app.');
});
$('in-autostart-footer').addEventListener('change', event => ssam.setSettings({ autostart: event.target.checked }));
$('btn-quit').addEventListener('click', () => ssam.quit());

ssam.onState(render);
ssam.getState().then(state => { render(state); refreshLog(); });
setInterval(() => { if (current && running(current.agent.view)) refreshLog(); }, 10000);
