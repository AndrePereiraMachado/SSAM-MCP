import { createHash } from 'node:crypto';

// Log times belong to the Service Center display timezone. Compare stable rows,
// never convert these times to UTC or attribute another scheduler's execution.
export function timerLogSnapshot(listing, identity, target) {
  const unavailable = reason => ({ available: false, reason });
  if (listing?.complete !== true || listing.truncated) return unavailable('incomplete-log-list');
  let timerKey, tenantId;
  try {
    const url = new URL(target);
    if (url.hostname !== identity.host || url.protocol !== 'https:') return unavailable('target-host-mismatch');
    timerKey = url.searchParams.get('Cyclic_Job_Key');
    tenantId = url.searchParams.get('TenantId');
    if (tenantId !== null && !/^[0-9]+$/.test(tenantId)) return unavailable('invalid-timer-tenant');
  } catch { return unavailable('invalid-timer-target'); }
  if (!timerKey) return unavailable('missing-timer-key');
  const runs = [];
  for (const row of listing.rows ?? []) {
    const exact = (row.links ?? []).some(link => {
      try {
        const url = new URL(link.href);
        return url.protocol === 'https:' && url.hostname === identity.host
          && url.pathname.toLowerCase() === '/servicecenter/espace_timer_edit.aspx'
          && url.searchParams.get('EspaceId') === String(identity.moduleId)
          && url.searchParams.get('Cyclic_Job_Key')?.toLowerCase() === timerKey.toLowerCase()
          && (tenantId === null || url.searchParams.get('TenantId') === tenantId);
      } catch { return false; }
    });
    if (!exact) continue;
    const fields = row.fields ?? {};
    const time = fields['Time of Log'] ?? fields.Date;
    if (fields.Timer !== identity.name || !time || !fields.Duration) return unavailable('unrecognized-exact-timer-row');
    const errorIds = [], moduleNames = [];
    for (const link of row.links ?? []) {
      try {
        const url = new URL(link.href);
        if (url.protocol !== 'https:' || url.hostname !== identity.host) continue;
        if (url.pathname.toLowerCase() === '/servicecenter/show_error.aspx') {
          const id = url.searchParams.get('Error_Id');
          if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id ?? '')) errorIds.push(id);
        }
        if (url.pathname.toLowerCase() === '/servicecenter/espace_edit.aspx'
          && url.searchParams.get('EspaceId') === String(identity.moduleId) && link.name) moduleNames.push(link.name);
      } catch { /* Untrusted links never become requests. */ }
    }
    const run = { time, scheduledFor: fields['Should Have Run At'] ?? null, duration: fields.Duration,
      tenant: fields.Tenant ?? null, server: fields.Server ?? fields['Executed By'] ?? null,
      hasErrorLink: (row.links ?? []).some(link => /\/Show_Error\.aspx\?/i.test(link.href)) };
    const { hasErrorLink, duration, ...stable } = run;
    runs.push({ ...run, errorIds: [...new Set(errorIds)],
      moduleName: new Set(moduleNames).size === 1 ? moduleNames[0] : null,
      fingerprint: createHash('sha256').update(JSON.stringify(stable)).digest('hex') });
  }
  if (new Set(runs.map(run => run.fingerprint)).size !== runs.length) return unavailable('ambiguous-duplicate-log-rows');
  return { available: true, timerKey, moduleId: String(identity.moduleId), ...(tenantId !== null ? { tenantId } : {}), runs, observedAt: listing.observedAt };
}

// An error linked from an exact timer row can establish that this observed
// attempt failed. It does not establish which Run Now triggered it or whether
// the scheduler has exhausted retries. Keep the historical fingerprint stable.
export async function observeTimerErrors(comparison, identity, readError, limit = 10) {
  const observations = []; let reads = 0;
  for (const run of comparison.newRuns ?? []) {
    if (!run.hasErrorLink) continue;
    const pending = reason => observations.push({ fingerprint: run.fingerprint, outcome: 'unknown', reason });
    if (run.errorIds?.length !== 1 || !run.moduleName || !run.server) { pending('error-identity-incomplete'); continue; }
    if (reads >= limit) { pending('error-read-limit'); continue; }
    reads++;
    const errorId = run.errorIds[0]; let detail;
    try { detail = await readError(errorId); } catch (error) {
      pending('error-detail-unavailable');
      if (/^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '')) observations.at(-1).code = error.code;
      continue;
    }
    let validSource = false;
    try { const url = new URL(detail.source); validSource = url.protocol === 'https:' && url.hostname === identity.host
      && url.pathname.toLowerCase() === '/servicecenter/show_error.aspx' && url.searchParams.get('Error_Id') === errorId; } catch {}
    const lines = typeof detail.detail === 'string' ? detail.detail.split(/\r?\n/).map(s => s.trim()) : [];
    const field = label => { const indexes = lines.flatMap((s,i) => s === label ? [i] : []); return indexes.length === 1 ? lines[indexes[0]+1] : null; };
    const message = field('Message');
    const terminalPrefix = `Timer ${identity.name} reached maximum number of retries (`;
    const terminal = message?.startsWith(terminalPrefix)
      ? message.slice(terminalPrefix.length).match(/^([1-9][0-9]*)\) \[Calculating next run\]$/) : null;
    if (!validSource || detail.truncated !== false || detail.errorId !== errorId
      || field('Id') !== errorId || field('Time of Log') !== run.time || field('Module') !== run.moduleName
      || field('Server') !== run.server || (!terminal && !message?.startsWith(`Timer ${identity.name} error (inside action '`))) {
      pending('error-detail-correlation-unverified'); continue;
    }
    observations.push({ fingerprint: run.fingerprint, errorId, outcome: 'failed',
      evidence: detail.source, observedAt: detail.observedAt, requestKey: field('Request Key'),
      retryScheduled: terminal ? false : /\[retry \d+ of \d+ scheduled\]/i.test(message) ? true : null,
      retriesExhausted: Boolean(terminal), ...(terminal ? { retryLimit: Number(terminal[1]) } : {}) });
  }
  return { errorObservations: observations,
    failedAttemptObserved: observations.some(x => x.outcome === 'failed'),
    failedCycleObserved: observations.some(x => x.outcome === 'failed' && x.retriesExhausted),
    errorDetailsComplete: observations.every(x => x.outcome === 'failed') };
}

export function compareTimerLogs(before, after) {
  if (!before?.available || !after?.available) return { executionObserved: null, reason: before?.reason ?? after?.reason ?? 'missing-baseline' };
  if (before.timerKey !== after.timerKey || before.moduleId !== after.moduleId || before.tenantId !== after.tenantId) return { executionObserved: null, reason: 'timer-identity-changed' };
  const known = new Set(before.runs.map(run => run.fingerprint));
  const newRuns = after.runs.filter(run => !known.has(run.fingerprint));
  return { executionObserved: newRuns.length > 0, newRuns, attributedToRequest: false,
    executionCompleted: null, verificationScope: 'new-exact-timer-log-rows',
    note: 'A new execution log is observed; it does not identify the triggering request or prove successful completion.' };
}
