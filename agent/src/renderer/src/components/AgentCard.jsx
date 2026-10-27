import React, { useState } from 'react';

const ssam = window.ssam;
const when = iso => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };

export function AgentCard({ agent, app, busy, onChangeSetup }) {
  const [doctor, setDoctor] = useState(null);
  const [running, setRunning] = useState(false);
  const pack = agent.pack
    ? `${agent.pack.id} (lanes ${agent.pack.lanes.join(', ')}${agent.pack.odcBridge ? `, ODC bridge ${agent.pack.odcBridge}` : ''}${agent.pack.o11BuiltFor ? `, Service Studio ${agent.pack.o11BuiltFor}` : ''})`
    : `not installed yet (the app carries ${app.bundledPack ?? 'no pack'})`;
  const process = agent.pid
    ? `pid ${agent.pid}${agent.state?.at ? `, ${agent.state.state} since ${when(agent.state.at)}` : ''}`
    : agent.lastExit !== null && agent.lastExit !== undefined ? `not running (last exit code ${agent.lastExit})` : 'not running';

  async function runDoctor() {
    setRunning(true); setDoctor(null);
    try { setDoctor(await ssam.doctor()); } catch (error) { setDoctor({ report: null, text: error.message }); } finally { setRunning(false); }
  }

  return (
    <section className="card">
      <h2>Agent</h2>
      <dl className="facts">
        <dt>Server</dt><dd>{agent.server ?? '-'}</dd>
        <dt>Folder</dt><dd>{agent.root}</dd>
        <dt>Pack</dt><dd>{pack}</dd>
        <dt>Process</dt><dd>{process}</dd>
      </dl>
      <div className="row">
        <button onClick={() => ssam.openFolder()}>Open folder</button>
        <button onClick={() => ssam.openLog()}>Open agent log</button>
        <button onClick={runDoctor} disabled={busy || running}>{running ? 'Running the doctor...' : 'Run doctor'}</button>
        <button onClick={onChangeSetup} disabled={busy}>Change setup...</button>
      </div>
      {doctor && (
        <pre className="report">
          {doctor.report
            ? [<div key="head">{`${doctor.report.ok ? 'OK' : 'Problems found'}: agent ${doctor.report.agentVersion}, ${doctor.report.runtime === 'native-aot' ? 'native core' : 'Node ' + doctor.report.node}, pack ${doctor.report.pack?.id ?? '?'}`}</div>,
              ...(doctor.report.checks ?? []).map((check, i) => <div key={i} className={check.status}>{`[${check.status}] ${check.name}: ${check.detail}`}</div>)]
            : (doctor.text || 'The doctor gave no report.')}
        </pre>
      )}
    </section>
  );
}
