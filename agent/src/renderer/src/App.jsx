// The panel: header with the agent's state, the agent card, the setup form, updates, the agent log. Everything comes
// from the state the main process pushes (window.ssam.onState) and every action goes back through window.ssam.
import React, { useCallback, useEffect, useState } from 'react';
import { Header } from './components/Header.jsx';
import { AgentCard } from './components/AgentCard.jsx';
import { SetupForm } from './components/SetupForm.jsx';
import { UpdatesCard } from './components/UpdatesCard.jsx';
import { LogCard } from './components/LogCard.jsx';
import { Footer } from './components/Footer.jsx';

const ssam = window.ssam;
export const isRunning = view => ['starting', 'connecting', 'connected', 'reconnecting'].includes(view.status);

export function App() {
  const [state, setState] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [log, setLog] = useState([]);

  const refreshLog = useCallback(async () => { try { setLog(await ssam.readLog()); } catch { setLog([]); } }, []);

  useEffect(() => {
    const off = ssam.onState(setState);
    ssam.getState().then(next => { setState(next); refreshLog(); });
    return off;
  }, [refreshLog]);

  useEffect(() => {
    if (!state || !isRunning(state.agent.view)) return undefined;
    const timer = setInterval(refreshLog, 10000);
    return () => clearInterval(timer);
  }, [state, refreshLog]);

  if (!state) return <div className="loading">Loading...</div>;
  const { agent, app, settings, update, busy } = state;
  const showSetup = setupOpen || !agent.setUp;

  return (
    <>
      <Header view={agent.view} busy={busy} setUp={agent.setUp} onStart={() => ssam.start()} onStop={() => ssam.stop()} />
      <main>
        {(!showSetup || agent.setUp) && (
          <AgentCard agent={agent} app={app} busy={busy} onChangeSetup={() => setSetupOpen(true)} />
        )}
        {showSetup && (
          <SetupForm agent={agent} app={app} settings={settings} busy={busy} canCancel={agent.setUp}
            onDone={() => { setSetupOpen(false); refreshLog(); }} onCancel={() => setSetupOpen(false)} />
        )}
        <UpdatesCard update={update} app={app} settings={settings} />
        <LogCard lines={log} onRefresh={refreshLog} />
      </main>
      <Footer app={app} settings={settings} />
    </>
  );
}
