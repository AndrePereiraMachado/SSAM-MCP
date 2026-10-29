// CIM preserves microseconds; Process.StartTime can include one additional tick.
// Keep exact timestamps in hook requests, but use this form for lifetime comparisons.
export function instanceStart(value) {
  if (typeof value !== 'string' || !value) return null;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?(?:Z|\+00:00)$/.exec(value);
  return match ? match[1] + '.' + (match[2] ?? '').padEnd(6, '0').slice(0, 6) + 'Z' : value;
}
export const sameInstance = (a, b) => Number(a?.pid) === Number(b?.pid) && instanceStart(a?.startedUtc) !== null && instanceStart(a.startedUtc) === instanceStart(b?.startedUtc);
export const completeInstances = rows => Array.isArray(rows) && rows.every(row => Number.isInteger(Number(row?.pid)) && Number(row.pid) > 0 && instanceStart(row.startedUtc) !== null);
