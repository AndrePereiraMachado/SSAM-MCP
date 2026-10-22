import React, { useEffect, useRef } from 'react';

const ssam = window.ssam;

export function LogCard({ lines, onRefresh }) {
  const box = useRef(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines]);
  return (
    <section className="card">
      <h2>Agent log</h2>
      <pre className="report" ref={box}>{lines.length ? lines.join('\n') : 'No log yet.'}</pre>
      <div className="row">
        <button onClick={onRefresh}>Refresh</button>
        <button onClick={() => ssam.openAppLog()}>Open app log</button>
      </div>
    </section>
  );
}
