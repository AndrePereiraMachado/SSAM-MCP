import React, { useEffect, useState } from 'react';
import logo from '../../../build/icon.png';
const ssam = window.ssam;
export const isRunning = view => ['starting', 'connecting', 'connected', 'reconnecting'].includes(view.status);

export function App() {
  const [state, setState] = useState(null);
  const [token, setToken] = useState('');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [replaceToken, setReplaceToken] = useState(false);
  useEffect(() => {
    const off = ssam.onState(setState);
    ssam.getState().then(setState);
    return off;
  }, []);
  if (!state) return <div className="loading">Loading...</div>;
  const { agent, busy, app } = state;
  const running = isRunning(agent.view);
  const setup = !agent.setUp || agent.server !== app.server || replaceToken || agent.lastExit === 2;
  const labels = { connected: 'Connected', connecting: 'Connecting...', starting: 'Connecting...', reconnecting: 'Reconnecting...', stopped: 'Disconnected', attention: 'Needs attention', external: 'Already running', 'not-set-up': 'Welcome' };
  async function act(action) {
    setWorking(true); setMessage('');
    try {
      if (action === 'setup') {
        const result = await ssam.setup({ credential: token });
        setToken('');
        if (!result.ok) setMessage('Unable to activate. Check your token and try again.');
        else setReplaceToken(false);
      } else if (action === 'check') {
        const result = await ssam.checkConnection();
        setMessage(result.message);
      } else if (action === 'connect') await ssam.start();
      else await ssam.stop();
    } catch { setMessage('Unable to complete the request. Please try again.'); }
    finally { setWorking(false); }
  }
  return <div className="shell">
    <div className="brand"><img src={logo} alt="SSAM" width="64" height="64" /><h1>SSAM Agent</h1></div>
    <div className="status" role="status"><span className={'indicator ' + (agent.view.status === 'connected' ? 'online' : running ? 'pending' : '')} />{labels[agent.view.status] || 'Disconnected'}</div>
    {setup ? <form onSubmit={event => { event.preventDefault(); act('setup'); }}>
      <p className="muted">Enter your activation token to finish setting up.</p>
      <label htmlFor="token">Activation token</label>
      <input id="token" type="password" value={token} onChange={event => setToken(event.target.value)} required minLength={54} maxLength={54} autoComplete="off" autoFocus placeholder="ssam_agent_..." />
      <button className="primary wide" disabled={busy || working}>Activate and connect</button>
    </form> : <>
      <p className="muted">{agent.view.status === 'connected' ? 'Your computer is ready for SSAM.' : 'Connect this computer to SSAM.'}</p>
      <div className="actions">
        <button className="primary" onClick={() => act('connect')} disabled={busy || working || running || agent.view.status === 'external'}>Connect</button>
        <button onClick={() => act('disconnect')} disabled={busy || working || !running}>Disconnect</button>
      </div>
      <button className="wide" onClick={() => act('check')} disabled={busy || working}>Check connection</button>
    </>}
    {message && <p className="feedback" role="alert">{message}</p>}
    <footer><span>Version {app.version}</span>{!setup && <button className="link" onClick={() => { setReplaceToken(true); setMessage(''); }}>Replace token</button>}</footer>
  </div>;
}
