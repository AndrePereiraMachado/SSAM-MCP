import React, { useState } from 'react';

const ssam = window.ssam;
const ipcError = message => String(message ?? '').replace(/^Error invoking remote method '[^']*': Error: /, '');

export function SetupForm({ agent, app, settings, busy, canCancel, onDone, onCancel }) {
  const [server, setServer] = useState(agent.server ?? '');
  const [credential, setCredential] = useState('');
  const root = agent.root || app.defaultRoot;
  const [port, setPort] = useState(agent.o11Port && agent.o11Port !== 4516 ? String(agent.o11Port) : '');
  const [autostart, setAutostart] = useState(settings.autostart !== false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError(null); setSaving(true);
    const result = await ssam.setup({ server: server.trim(), credential, root: root.trim(), o11Port: port.trim() || null, autostart }).catch(e => ({ ok: false, error: ipcError(e.message) }));
    setCredential('');
    setSaving(false);
    if (result.ok) onDone(); else setError(result.error || 'The setup did not finish.');
  }

  return (
    <section className="card">
      <h2>Set up the agent</h2>
      <p className="muted">What the server owner gave you: the server address and the agent credential (<code>ssam_agent_...</code>). The credential is stored privately on this computer and never shown again.</p>
      <form onSubmit={submit} autoComplete="off">
        <label>Server address <input type="url" placeholder="https://ssam.example.com" required value={server} onChange={e => setServer(e.target.value)} /></label>
        <label>Agent credential <input type="password" placeholder="ssam_agent_..." required minLength={54} maxLength={54} value={credential} onChange={e => setCredential(e.target.value)} autoFocus /></label>
        <details>
          <summary>Service Studio bridge port</summary>
          <label>Local port (default 4516) <input type="number" min={1024} max={65535} placeholder="4516" value={port} onChange={e => setPort(e.target.value)} /></label>
        </details>
        <label className="check"><input type="checkbox" checked={autostart} onChange={e => setAutostart(e.target.checked)} /> Open SSAM Agent when I log in (minimized to the tray)</label>
        <div className="row">
          <button type="submit" className="primary" disabled={busy || saving}>{saving ? 'Saving...' : 'Save and start'}</button>
          {canCancel && <button type="button" onClick={onCancel}>Cancel</button>}
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  );
}
