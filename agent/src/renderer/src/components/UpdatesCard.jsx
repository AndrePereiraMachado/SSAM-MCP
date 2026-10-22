import React, { useState } from 'react';

const ssam = window.ssam;
const ipcError = message => String(message ?? '').replace(/^Error invoking remote method '[^']*': Error: /, '');

function updateLine(update, version, autoInstall) {
  switch (update.status) {
    case 'off': return `Version ${version}. Updates are off: this build has no update server and none is set below.`;
    case 'checking': return `Version ${version}. Checking for updates...`;
    case 'available': return `Version ${version}. Update ${update.version ?? ''} found; downloading.`;
    case 'downloading': return `Version ${version}. Downloading update ${update.version ?? ''}: ${update.percent ?? 0}%.`;
    case 'ready': return autoInstall ? `Update ${update.version ?? ''} is ready: the app restarts by itself in a few seconds to install it (the agent is stopped cleanly first).`
      : `Update ${update.version ?? ''} is ready. Restart to install it (the agent is stopped cleanly first).`;
    case 'up-to-date': return `Version ${version} is up to date${update.checkedAt ? ` (checked ${new Date(update.checkedAt).toLocaleString()})` : ''}.`;
    case 'error': return `Version ${version}. The last update check failed: ${update.error}`;
    default: return `Version ${version}.`;
  }
}

export function UpdatesCard({ update, app, settings }) {
  const [url, setUrl] = useState(settings.updateUrl ?? '');
  const [note, setNote] = useState(null);
  const autoInstall = settings.updateAutoInstall !== false;

  async function saveUrl(event) {
    event.preventDefault();
    setNote(null);
    const result = await ssam.setSettings({ updateUrl: url.trim() || null }).catch(e => ({ error: ipcError(e.message) }));
    setNote(result?.error ? { error: result.error } : { ok: 'Saved. The new address is used from the next start of the app.' });
  }

  return (
    <section className="card">
      <h2>App updates</h2>
      <p className="muted">{updateLine(update, app.version, autoInstall)}</p>
      <p className="muted">{autoInstall ? 'Updates install by themselves: no click needed.' : 'Updates wait for you: use "Restart to update" or quit the app.'}</p>
      <div className="row">
        <button onClick={() => ssam.checkUpdates()} disabled={['off', 'checking', 'downloading'].includes(update.status)}>Check for updates</button>
        {update.status === 'ready' && <button className="primary" onClick={() => ssam.installUpdate()}>Restart to update now</button>}
      </div>
      <details>
        <summary>Update server</summary>
        <p className="muted">The build fixed the owner's update server; an address here replaces it (https only). Leave it empty to use the built-in one.</p>
        <form className="row" onSubmit={saveUrl}>
          <input type="url" placeholder={app.updateSource === 'build' || app.updateSource === 'env' ? app.updateUrl : 'https://updates.example.com/ssam-agent'} value={url} onChange={e => setUrl(e.target.value)} />
          <button type="submit">Save</button>
        </form>
        {note?.error && <p className="error">{note.error}</p>}
        {note?.ok && <p className="muted">{note.ok}</p>}
      </details>
    </section>
  );
}
