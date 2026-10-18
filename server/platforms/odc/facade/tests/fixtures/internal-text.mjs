// The families of "how SSAM is built" the no-internals guard looks for in a licensee's answers (no-internals-answers.test.mjs)
// and the inventory script reuses (scripts/exposure-inventory.mjs --guard). Independent of the filter's own rules: this
// file never imports exposure.mjs.
export const GUARD_FAMILIES = Object.freeze({
  // (servidor/fase4-26 a7 phase 3, review vps-a7-2 B4: the Linux image's temp folder and its /data volumes too)
  'absolute path': /(?<![\w])[A-Za-z]:[\\/][^\s"'`]+|(?<![\w.:/~-])\/(?:studio|opt|srv|var|home|root|usr|mnt|app|customers|tmp|data\/(?:server|cache|friction|odc-features))\/[^\s"'`]*/,
  'file:line or source file': /\.(?:cs|mjs|py|ps1)(?::line \d+|:\d+)|\b[\w.-]+\.(?:cs|csproj)\b/,
  'kernel or suite path': /\bkernel[\\/]|\bplatforms[\\/]|\bfacade[\\/][\w-]+\.mjs|\btests[\\/](?:jobs|fixtures|html|Shared)\b|\btest-work\b|\.local[\\/](?:cli|test-work)/,
  'suite command or count': /\bdotnet test\b|\bAnvil\.Tests\b|\.trx\b|\bTRX\b|\b\d+\s+(?:stamped\s+)?(?:jobs|tests|executions|results)\s+(?:on|in|of|for)\s+(?:the\s+)?(?:O11|ODC|suite|lane)\b|\b\d+\s+(?:test\s+)?suites?\b/i,
  'proof level or stamp': /\bproven-(?:current|historical|scoped)\b|\bC-(?:executed|suite)\b|\bA-runtime\b|\bkernelSha256\b|\bprovenance\b|\bexecuted evidence\b/,
  'round or review name': /\b(?:CX|PA|FA)\d{1,3}\b|\bD-M\d+-\d+\b|\bwf_[0-9a-f]{6,}\b|\bcold session [A-Z]\b|\bround \d+\b/,
  'internal reason': /\bblind[- ]tests?\b|\bowner's decision\b|\bauthor's report\b|\bblind-test-pending\b/i,
  'project document': /\bNAO-DA\b|\bPLANO\b|\bCOBERTURA-EXEMPLOS\b|\bCONHECIMENTO-DO-TIME\b|\bdocs[\\/][\w-]+\.md\b/,
  'kernel class': /\bAnvil\.(?:Core|Cli|Bridge)\b|\b[A-Z]\w+Tests\b|\bJobRunner\b|\bCommandSurface\b|^\s+at \S+\(/m,
  'packet mechanism': /\bby keywords?\b|\bup to \d+ rules\b|\beach takes its share of the room\b/i,
});
// Keys whose presence alone tells how SSAM is built.
export const GUARD_KEYS = Object.freeze(['provenance', 'proofs', 'mismatches', 'evidenceRule', 'identity', 'keyStrategy', 'nativeRuntime', 'stderr', 'provenBy', 'builtAt', 'executedAt', 'testWork', 'suite']);
// A path is allowed only as a handle: the value of a handle field (or of a call's arguments) under a .local folder of
// the server that is no CLI, suite or cache folder.
const HANDLE_KEYS = new Set(['job', 'out', 'result', 'resultFile', 'file', 'capture', 'output', 'target', 'oml', 'answer', 'reservation']);
const handlePath = text => /^[A-Za-z]:[\\/]/.test(text) && /[\\/]\.local[\\/]/.test(text) && !/[\\/](?:cli|test-work|discovery|readers)[\\/]/i.test(text);

export function findings(value, at = '', ctx = { inArguments: false, key: null }) {
  const out = [];
  if (typeof value === 'string') {
    for (const [family, re] of Object.entries(GUARD_FAMILIES)) {
      if (!re.test(value)) continue;
      if ((family === 'absolute path' || family === 'kernel or suite path') && (ctx.inArguments || HANDLE_KEYS.has(ctx.key)) && handlePath(value.trim())) continue;
      const m = value.match(re);
      out.push({ family, at, sample: value.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40) });
    }
    return out;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => out.push(...findings(v, at + '/' + i, { ...ctx, key: null }))); return out; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (GUARD_KEYS.includes(k)) out.push({ family: 'internal key', at: at + '/' + k, sample: k });
      out.push(...findings(v, at + '/' + k, { inArguments: ctx.inArguments || (k === 'arguments' && typeof value.tool === 'string'), key: k }));
    }
  }
  return out;
}
