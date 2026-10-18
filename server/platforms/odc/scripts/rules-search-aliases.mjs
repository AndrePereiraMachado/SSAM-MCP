// node platforms/odc/scripts/rules-search-aliases.mjs [rev]
// Writes platforms/odc/facade/rules-search-aliases.json: the Portuguese team rules and standards of 8689de53, the last
// release that served them in Portuguese, as search-only aliases (never served).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const git = (...a) => execFileSync(process.env.GIT ?? 'git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
const rev = process.argv[2] ?? '8689de53';
const read = f => git('show', rev + ':' + f).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const out = {
  _doc: 'Search-only aliases (review english-junction F2): the Portuguese team rules (docs/CONHECIMENTO-DO-TIME.md) and the 35 standards (kernel/scripts/outsystems_padroes/RULES.md) as the release ' + rev + ' served them, before they were translated. ssam_reference {kind:"rules"} matches the words of a request against these headings and texts too, unit by unit at the same place as the English ones (search-aliases.mjs), so a Portuguese request finds the rule it found then; an answer always carries the English text. Input vocabulary, never served. Regenerate only with the same structure as the English documents.',
  source: rev,
  team: read('docs/CONHECIMENTO-DO-TIME.md'),
  standards: read('kernel/scripts/outsystems_padroes/RULES.md'),
};
fs.writeFileSync(path.join(root, 'platforms/odc/facade/rules-search-aliases.json'), JSON.stringify(out, null, 1) + '\n');
console.log('written', out.team.length, out.standards.length);
