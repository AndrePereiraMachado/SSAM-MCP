// Before/after of the exposure filter on the same calls (exposure-inventory.mjs run with --exposure owner and licensee):
// per tool the bytes served, and per answer what USE needs and must not lose: ok and code, every problem (code, pointer,
// fix, patch, patchByName), nextBasedOn's content hash, every continuation call (tool + arguments), the discover matches,
// contract pointers and example ids, and the rules text. Exit 1 when one answer lost one of them.
//   node scripts/exposure-compare.mjs <owner answers.json> <licensee answers.json> [--json <out>]
import fs from 'node:fs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8')).answers;
const bodyOf = a => a.structured ?? (() => { try { return JSON.parse(a.text); } catch { return a.text; } })();
const calls = value => {
  const out = [];
  const walk = v => {
    if (!v || typeof v !== 'object') return;
    if (!Array.isArray(v) && typeof v.tool === 'string' && v.arguments && typeof v.arguments === 'object') out.push(JSON.stringify({ tool: v.tool, arguments: v.arguments }));
    for (const x of Object.values(v)) walk(x);
  };
  walk(value);
  return out.sort();
};
// The parts a model uses, as comparable values. Paths that are handles may differ between two runs (an inline job gets a
// new file per call), so a job file is compared by its name pattern only.
const volatile = s => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/\b[0-9a-f]{64}\b/g, '<sha>').replace(/"elapsedMs":\d+/g, '');
export function useParts(body) {
  if (!body || typeof body !== 'object') return { text: typeof body === 'string' ? body.length : 0 };
  return {
    ok: body.ok ?? null, code: body.code ?? null,
    problems: (body.problems ?? []).map(p => JSON.stringify([p.code, p.pointer, p.fix ?? null, p.patch ?? null, p.patchByName ?? null])),
    nextBasedOn: body.nextBasedOn?.sha256 ?? null,
    calls: calls(body).map(volatile),
    matches: (body.matches ?? []).map(m => m.id ?? m.name ?? null),
    contracts: Object.keys(body.contracts ?? {}),
    examples: Object.values(body.examples ?? {}).map(e => e?.job ?? null),
    expansions: Object.keys(body.expansions ?? {}),
    rulesText: typeof body.text === 'string' ? body.text.length > 0 : null,
    // round 2 (review HIGH 1): every expression and call written anywhere (CurrDateTime(), GetUserId(): UserId, If(...))
    expressions: [...new Set(JSON.stringify(body).match(/\b[A-Za-z_][\w.]*\((?:[^()"\\]|\([^()"\\]*\))*\)/g) ?? [])].sort(),
  };
}

if (process.argv[1] && process.argv[1].endsWith('exposure-compare.mjs')) {
  const [ownerFile, licenseeFile] = process.argv.slice(2);
  const owner = read(ownerFile); const licensee = read(licenseeFile);
  if (owner.length !== licensee.length) { console.error('different call lists'); process.exit(2); }
  const tools = {}; const lost = [];
  owner.forEach((o, i) => {
    const l = licensee[i];
    const t = tools[o.tool] ??= { answers: 0, ownerBytes: 0, licenseeBytes: 0 };
    t.answers++; t.ownerBytes += o.bytes; t.licenseeBytes += l.bytes;
    const a = useParts(bodyOf(o)); const b = useParts(bodyOf(l));
    for (const k of Object.keys(a)) {
      // a list loses an item the owner answer has; a value differs (a discover answered with more is no loss: its first
      // answer depends on the session's earlier calls)
      const x = JSON.stringify(a[k]); const y = JSON.stringify(b[k]);
      const missing = Array.isArray(a[k]) ? a[k].filter(v => !(b[k] ?? []).includes(v)) : x === y ? [] : [a[k]];
      if (missing.length) lost.push({ i, tool: o.tool, args: JSON.stringify(o.args).slice(0, 100), part: k, owner: x.slice(0, 300), licensee: y.slice(0, 300) });
    }
  });
  const total = Object.values(tools).reduce((s, t) => ({ ownerBytes: s.ownerBytes + t.ownerBytes, licenseeBytes: s.licenseeBytes + t.licenseeBytes }), { ownerBytes: 0, licenseeBytes: 0 });
  const report = { tools, total, lost };
  const at = process.argv.indexOf('--json');
  if (at > 0) fs.writeFileSync(process.argv[at + 1], JSON.stringify(report, null, 1));
  for (const [name, t] of Object.entries(tools)) console.log(name.padEnd(16), String(t.answers).padStart(3), String(t.ownerBytes).padStart(8), '->', String(t.licenseeBytes).padStart(8), (100 * (1 - t.licenseeBytes / t.ownerBytes)).toFixed(1) + '%');
  console.log('total', total.ownerBytes, '->', total.licenseeBytes, (100 * (1 - total.licenseeBytes / total.ownerBytes)).toFixed(1) + '%');
  console.log('lost', lost.length);
  for (const x of lost.slice(0, 30)) console.log(JSON.stringify(x));
  process.exit(lost.length ? 1 : 0);
}
