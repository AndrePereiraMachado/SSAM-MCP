import React, { useState } from 'react';

const ssam = window.ssam;
export function AgentCard({ agent, app, busy, onChangeSetup }) {
  const [doctor, setDoctor] = useState(null);
  const [running, setRunning] = useState(false);
  async function runDoctor() {
    setRunning(true); setDoctor(null);
    try { setDoctor(await ssam.doctor()); } catch (error) { setDoctor({ report: null, text: error.message }); } finally { setRunning(false); }
  }

  return (
    <section className="card">
      <h2>Agent</h2>
      <dl className="facts">
        <dt>Server</dt><dd>{agent.server ?? '-'}</dd>
      </dl>
      <div className="row">
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
