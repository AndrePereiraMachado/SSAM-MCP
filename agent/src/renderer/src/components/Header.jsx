import React from 'react';
import { isRunning } from '../App.jsx';

const DOT = { 'not-set-up': 'red', attention: 'red', stopped: 'grey', external: 'grey', starting: 'amber', connecting: 'amber', reconnecting: 'amber', connected: 'green' };

export function Header({ view, busy, setUp, onStart, onStop }) {
  const running = isRunning(view);
  return (
    <header>
      <span className={'dot ' + (DOT[view.status] ?? 'grey')} />
      <div>
        <h1>{view.text}</h1>
        <p className="muted">{view.detail}</p>
      </div>
      <div className="spacer" />
      {running
        ? <button onClick={onStop} disabled={busy}>Stop agent</button>
        : view.status !== 'not-set-up' && <button className="primary" onClick={onStart} disabled={busy || view.status === 'external' || !setUp}>Start agent</button>}
    </header>
  );
}
