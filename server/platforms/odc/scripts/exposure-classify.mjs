// The classification of the exposure inventory (exposure-inventory.mjs): every string leaf and every key of every captured
// answer is read against the families of what tells how SSAM is BUILT (never what a licensee needs to USE it). The
// report counts leaves, bytes and keys per family and per tool, with distinct samples.
//   node scripts/exposure-classify.mjs <answers.json> [--json <out.json>]
import fs from 'node:fs';

export const FAMILIES = Object.freeze({
  'absolute-path': /(?:\b[A-Za-z]:[\\/][^\s"'`<>|]+|\\\\[\w.$-]+\\[^\s"'`<>|]+|(?<![\w.:/-])\/(?:studio|opt|srv|var|home|root|tmp|usr|etc|mnt|app|data|workspace|customers|Users)\/[^\s"'`<>|]*)/,
  'repo-path': /(?<![\w-])(?:kernel|platforms|facade|scripts|publisher|tools)[\\/][\w.\\/-]+|(?<![\w-])docs[\\/][\w.-]+\.md|(?:^|[\\/\s"'(])\.local[\\/]|customers[\\/]tok_/,
  'source-file': /\b[\w.-]+\.(?:cs|mjs|py|ps1|csproj|sln)\b(?:[:(#]L?\d+)?/,
  'kernel-symbol': /\bAnvil\.(?:Core|Cli|Bridge|Tests)\w*|\b(?:CommandSurface|JobRunner|KernelModelReader|DeliveryTask|ModelReading|HeadlessSession|StudioAssemblies|CoverageLedger|ExamplesO11Tests|ExamplesOdcTests|JobTests|OdcJobTests|SurfaceTests)\b(?:\.\w+)?/,
  'test-suite': /kernel[\\/]tests\b|\btests[\\/](?:jobs|fixtures|html)|\bjobs-odc(?:-negative)?\b|\bjobs-negative\b|\btest-work\b|provenance-o11\.json|\bdotnet test\b|\bTRX\b|\.trx\b|\bAnvil\.Tests(?:\.Odc)?\b|\bmatriz\.json\b/,
  'suite-count': /\b\d+\s+(?:stamped\s+)?(?:jobs?|tests?|suites?|test cases?|cases|runs|executions|proofs)\b(?!\s*[:=])/i,
  'proof-detail': /\bproven-(?:current|historical|scoped)\b|\bexecuted evidence\b|\bproof level\b|\bkernelSha256\b|\bfixtureSha256\b|\bstamp(?:ed)?\b|\bprovenance\b/i,
  'internal-reason': /\bblind test\b|\bgenerators? (?:is |are )?(?:suspended|pending|blocked)\b|\bowner(?:'s)? (?:decision|approval|rule)\b|\bdecided by the owner\b|\bindependent (?:blind )?test\b|\bGENERATOR_APPROVAL\b/i,
  'round-name': /\b(?:CX|PA|FA)\d{1,3}\b|\b[XR]\d{1,2}[a-z]?\b(?![.\-]\d)|\bD-M\d+-\d+\b|\bwf_[0-9a-f]{6,}|\b(?:review|round|rodada|wave|lane F\d|atritos)\s+\d+\b/,
  'project-doc': /\b(?:PLANO|NAO-DA|DECISOES|RETOMADA|HANDOFF|CONHECIMENTO-DO-TIME|COBERTURA-EXEMPLOS-(?:O11|ODC))(?:[\w-]*)(?:\.md)?\b/,
  'mechanism': /\bby keywords?\b|\bkeyword[- ]?(?:match|search|index)\b|\bup to \d+ rules\b|\b\d+ rules? at most\b|\bwork packet (?:is )?(?:built|assembled)\b|\blexical\b/i,
  'dated-run': /\b20\d\d-\d\d-\d\d(?:[T ]\d\d:\d\d)?/,
});
export const INTERNAL_KEYS = /^(?:provenance|executions?|executed|stamp|stamps|kernelSha256|fixtureSha256|assemblies|suite|testWork|evidenceRule|proof|proofLevel|level|source|sources|file|path|cli|kernel|kernelDll|studioDir|ideVersion|naoDa|identity|elapsedMs|timings)$/;

export function* leaves(value, pointer = '') {
  if (typeof value === 'string') { yield { pointer, text: value }; return; }
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) yield* leaves(value[i], pointer + '/' + i); return; }
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { yield { pointer: pointer + '/' + k, key: k }; yield* leaves(v, pointer + '/' + k); }
}
export const bodyOf = answer => answer.structured ?? (() => { try { return JSON.parse(answer.text); } catch { return answer.text; } })();

export function classify(answers) {
  const total = { answers: answers.length, bytes: 0, leaves: 0, flaggedLeaves: 0, flaggedBytes: 0 };
  const families = {}; const byTool = {}; const keys = {};
  for (const answer of answers) {
    total.bytes += answer.bytes;
    const tool = byTool[answer.tool] ??= { answers: 0, bytes: 0, flaggedLeaves: 0, flaggedBytes: 0, families: {} };
    tool.answers++; tool.bytes += answer.bytes;
    for (const leaf of leaves(bodyOf(answer))) {
      if (leaf.key !== undefined) {
        if (INTERNAL_KEYS.test(leaf.key)) { const k = keys[leaf.key] ??= { count: 0, tools: new Set() }; k.count++; k.tools.add(answer.tool); }
        continue;
      }
      total.leaves++;
      const hits = Object.entries(FAMILIES).filter(([, re]) => re.test(leaf.text)).map(([name]) => name);
      if (!hits.length) continue;
      const bytes = Buffer.byteLength(leaf.text, 'utf8');
      total.flaggedLeaves++; total.flaggedBytes += bytes; tool.flaggedLeaves++; tool.flaggedBytes += bytes;
      for (const name of hits) {
        const family = families[name] ??= { leaves: 0, bytes: 0, tools: {}, samples: [] };
        family.leaves++; family.bytes += bytes; family.tools[answer.tool] = (family.tools[answer.tool] ?? 0) + 1;
        tool.families[name] = (tool.families[name] ?? 0) + 1;
        const match = leaf.text.match(FAMILIES[name]);
        const at = Math.max(0, match.index - 60);
        const sample = { tool: answer.tool, args: JSON.stringify(answer.args).slice(0, 80), pointer: leaf.pointer, text: leaf.text.slice(at, match.index + match[0].length + 60).replace(/\s+/g, ' ') };
        if (family.samples.length < 12 && !family.samples.some(s => s.text === sample.text)) family.samples.push(sample);
      }
    }
  }
  return { total, families, byTool, keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, { count: v.count, tools: [...v.tools] }])) };
}

if (process.argv[1] && process.argv[1].endsWith('exposure-classify.mjs')) {
  const file = process.argv[2];
  const { answers } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const report = classify(answers);
  const at = process.argv.indexOf('--json');
  if (at > 0) fs.writeFileSync(process.argv[at + 1], JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report.total));
  for (const [name, f] of Object.entries(report.families)) console.log(name.padEnd(16), String(f.leaves).padStart(5), 'leaves', String(f.bytes).padStart(8), 'B', JSON.stringify(f.tools));
  console.log('keys', JSON.stringify(report.keys));
}
