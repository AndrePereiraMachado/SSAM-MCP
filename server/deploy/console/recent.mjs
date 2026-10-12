// Per-minute counters for short windows (DESIGN 3.2, 3.3, 5): calls and failures of the last hour, with failure codes
// and tools, so the 15-minute and 1-hour alert windows survive restarts in a small checkpoint whatever the call rate.
const MINUTE = 60000;

export function createMinutes({ keepMinutes = 61 } = {}) {
  let buckets = [];   // [{m, calls, failures, codes: {code: {count, tools: {tool: n}}}}], ascending by m

  function add(time, ok, code = null, tool = null) {
    const ms = Date.parse(time);
    if (Number.isNaN(ms)) return;
    const m = Math.floor(ms / MINUTE);
    let b = buckets.length ? buckets[buckets.length - 1] : null;
    if (!b || b.m !== m) {
      b = buckets.find(x => x.m === m);
      if (!b) {
        const newest = buckets.length ? buckets[buckets.length - 1].m : -Infinity;
        if (m < newest - keepMinutes) return;
        b = { m, calls: 0, failures: 0, codes: {} };
        buckets.push(b);
        buckets.sort((x, y) => x.m - y.m);
      }
    }
    b.calls++;
    if (!ok) {
      b.failures++;
      const c = (b.codes[code ?? 'ERRO'] ??= { count: 0, tools: {} });
      c.count++;
      if (tool) c.tools[tool] = (c.tools[tool] ?? 0) + 1;
    }
    const floor = buckets[buckets.length - 1].m - keepMinutes;
    while (buckets.length && buckets[0].m < floor) buckets.shift();
  }
  // Totals over the last `minutes` minutes ending at nowMs (the current minute included).
  function window(nowMs, minutes) {
    const from = Math.floor(nowMs / MINUTE) - minutes + 1;
    let calls = 0, failures = 0;
    const codes = {};
    for (const b of buckets) {
      if (b.m < from || b.m * MINUTE > nowMs) continue;
      calls += b.calls; failures += b.failures;
      for (const [code, c] of Object.entries(b.codes)) {
        const into = (codes[code] ??= { count: 0, tools: {} });
        into.count += c.count;
        for (const [tool, n] of Object.entries(c.tools)) into.tools[tool] = (into.tools[tool] ?? 0) + n;
      }
    }
    let topCode = null, topCount = 0;
    for (const [code, c] of Object.entries(codes)) if (c.count > topCount || (c.count === topCount && code < topCode)) { topCode = code; topCount = c.count; }
    let topTool = null, toolCount = 0;
    if (topCode) for (const [tool, n] of Object.entries(codes[topCode].tools)) if (n > toolCount || (n === toolCount && tool < topTool)) { topTool = tool; toolCount = n; }
    return { calls, failures, topCode, topTool };
  }
  return {
    add, window,
    toJSON: () => buckets,
    restore(saved) { buckets = Array.isArray(saved) ? saved.filter(b => b && Number.isFinite(b.m)).sort((x, y) => x.m - y.m) : []; },
  };
}
