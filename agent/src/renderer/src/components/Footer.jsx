import React from 'react';

const ssam = window.ssam;

export function Footer({ app, settings }) {
  return (
    <footer className="muted">
      <span>{`SSAM Agent ${app.version} (Electron ${app.electron}, Node ${app.node})${app.packaged ? '' : ', checkout'}`}</span>
      <span className="spacer" />
      <label className="check"><input type="checkbox" checked={settings.autostart !== false} onChange={e => ssam.setSettings({ autostart: e.target.checked })} /> Open when I log in</label>
      <button onClick={() => ssam.quit()}>Quit app</button>
    </footer>
  );
}
