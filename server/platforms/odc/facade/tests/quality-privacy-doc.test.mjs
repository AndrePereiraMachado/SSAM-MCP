// The customer's privacy section (docs/AGENTE-CLIENTE.md "Privacidade"; privacy review of 2026-10-12, finding 2) states
// exactly what the server records: every field a quality line can carry has its words there (a field added to the contract
// without them fails here), retention as the owner configures it, who sees it (the owner only), the closed list of codes
// and the server.log facts of the agent's connection and of the first machine. In the SSAM-MCP server box the guide lives in
// the agent box (../agent/docs); without either copy the test skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeQualityLine, T_KEYS, CODE_UNLISTED } from '../quality-line.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GUIDE = [path.join(ROOT, 'docs', 'AGENTE-CLIENTE.md'), path.join(ROOT, '..', 'agent', 'docs', 'AGENTE-CLIENTE.md')].find(f => fs.existsSync(f));
const sectionOf = text => {
  const t = text.replace(/\r\n/g, '\n');
  const start = t.indexOf('## Privacidade: o que o servidor registra sobre o seu acesso\n');
  const end = t.indexOf('\n## ', start + 1);
  assert.ok(start >= 0, 'the privacy section');
  return t.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
};

// The words of each field of a quality line in the section (format fields of the line itself excluded).
const FORMAT = new Set(['schema', 'kind', 'trunc']);
const WORDS = {
  time: /Em toda linha:\*\* a hora/, token: /identificador do seu acesso/, customer: /o nome que o dono deu a ele/, session: /resumo da sessão MCP que não permite recuperá-la/,
  call: /a ordem na sessão/, tool: /A chamada:\*\* a ferramenta/, op: /a ação escolhida nela \(da lista da ferramenta\)/, lane: /a plataforma \(O11 ou ODC\)/,
  ms: /a duração/, gapMs: /o intervalo desde a resposta anterior/, inFlight: /quantas chamadas corriam juntas/,
  ok: /se deu certo/, class: /foi recusado, ficou incerto ou falhou/, code: /o código; o passo/, step: /o passo em que parou/,
  deliv: /`entregue`, `entregue e publicado` ou `criado`/,
  'problems.n': /quantos problemas de cada código/, 'problems.err': /quantos problemas de cada código/, 'problems.byCode': /quantos problemas de cada código/,
  'problems.warn': /quantos eram avisos/, 'problems.withPatch': /quantos vieram com correção pronta/, 'problems.byPhase': /\(por fase/, 'problems.cut': /se a lista foi cortada/,
  'norm.n': /quantas correções automáticas de cada regra/, 'norm.byRule': /quantas correções automáticas de cada regra/,
  'warn.n': /quantos avisos/, 'warn.high': /e quantos graves/,
  t: /quanto levou cada fase \(fila, captura, compilação, Studio, verificação, publicação, ambiente, transferência, rede e o próprio servidor\)/,
  'agent.n': /quantas chamadas ao agente/, 'agent.top': /de que tipo e comando/, 'agent.bytes': /com quantos bytes/, 'agent.failed': /quantas falhas/,
  'agent.shared': /quanto tempo e quantas falhas/, 'agent.approx': /quanto tempo e quantas falhas/,
  'kernel.runs': /quantas vezes o motor rodou/, 'kernel.cold': /quantas vezes o motor rodou/, 'kernel.worker': /quantas vezes o motor rodou/, 'kernel.ms': /o motor rodou e quanto levou/,
  'args.job': /como o job veio/, 'args.basedOn': /`basedOn`/, 'args.partial': /`partial`/, 'args.closePrevious': /`closePrevious`/, 'args.publish': /`publish`/,
  'args.until': /`until`/, 'args.patch': /quantos patches/, 'args.bytes': /o tamanho em bytes/,
  'answer.chars': /o tamanho, se veio em páginas/, 'answer.paged': /se veio em páginas/, 'answer.scan': /como o servidor a leu/,
  event: /quando abriu e fechou/, client: /a família do cliente MCP/, reason: /quando abriu e fechou, o motivo/, calls: /quantas chamadas teve/, openMs: /quando abriu e fechou/,
};
// Every field the contract keeps, from a line that fills them all (and the session lines).
function fieldsOfContract() {
  const frame = { schema: 'ssam-quality/1', time: '2026-10-12T18:00:00.000Z', token: 'tok_0000000a1fa0', customer: 'Cliente', session: 'abcdef012345' };
  const call = sanitizeQualityLine({ ...frame, kind: 'call', call: 1, tool: 'o11_deliver', op: 'close', lane: 'o11', ms: 9, gapMs: 1, inFlight: 1, ok: false, code: 'PREFLIGHT_REFUSED',
    class: 'refused', step: 'preflight', deliv: 'entregue', problems: { n: 1, err: 1, warn: 0, byCode: { PREFLIGHT_REFUSED: 1 }, withPatch: { PREFLIGHT_REFUSED: 1 }, byPhase: { preflight: 1 }, cut: true },
    norm: { n: 1, byRule: { SORT_KEYS_SPLIT: 1 } }, warn: { n: 1, high: 1 }, t: Object.fromEntries(T_KEYS.map(k => [k, 1])),
    agent: { n: 1, failed: 1, bytes: 1, shared: true, approx: true, top: [['file.get', 1, 1]] }, kernel: { runs: 1, cold: 1, worker: 1, ms: 1 },
    args: { job: 'inline', basedOn: true, partial: true, closePrevious: true, publish: true, patch: 1, until: 'merge', bytes: 1 }, answer: { chars: 1, paged: true, scan: 'full' } });
  const closed = sanitizeQualityLine({ ...frame, kind: 'session', event: 'closed', client: 'codex', reason: 'idle', calls: 1, openMs: 1 });
  const out = new Set();
  for (const line of [call, closed]) for (const [k, v] of Object.entries(line)) {
    if (FORMAT.has(k)) continue;
    if (k === 't') out.add('t');
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const sub of Object.keys(v)) out.add(k + '.' + sub);
    else out.add(k);
  }
  return [...out];
}

test('the privacy section names every field of the quality record, by category', { skip: !GUIDE && 'docs/AGENTE-CLIENTE.md is in the agent box' }, () => {
  const section = sectionOf(fs.readFileSync(GUIDE, 'utf8'));
  for (const field of fieldsOfContract()) {
    assert.ok(Object.hasOwn(WORDS, field), 'a field of the contract the privacy section does not describe yet: ' + field);
    assert.match(section, WORDS[field], field);
  }
  assert.match(section, new RegExp('Um valor fora da lista vira um marcador fixo, como `' + CODE_UNLISTED + '`, e só é contado'));
  assert.match(section, /Nada do seu trabalho entra na auditoria nem no registro de qualidade: nenhum nome de módulo, tela, action ou entidade, nenhum job, expressão, mensagem, caminho de arquivo, endereço de ambiente ou texto seu/);
});

test('the privacy section says who sees the records, how long they stay and the server.log facts of the agent', { skip: !GUIDE && 'docs/AGENTE-CLIENTE.md is in the agent box' }, () => {
  const section = sectionOf(fs.readFileSync(GUIDE, 'utf8'));
  assert.match(section, /Só o dono do servidor vê o log, a auditoria e o registro de qualidade/);
  // retention as configured (rotate-logs.sh: LOG_KEEP_DAYS 56, AUDIT_KEEP_DAYS and QUALITY_KEEP_DAYS 0 = keep all), never "the same as the audit"
  assert.match(section, /O dono escolhe por quantos dias guarda cada um desses registros\. O padrão guarda o log por 56 dias e a auditoria e o registro de qualidade sem prazo\./);
  assert.doesNotMatch(section, /mesma retenção da auditoria/);
  // agent-connected and agent-machine-pinned (agent-hub.mjs hello): the machine name, the Windows user and the IP, plainly
  assert.match(section, /Quando o agente conecta:\*\* o IP, a versão do agente, o nome do computador, o seu usuário do Windows e um identificador da máquina/);
  assert.match(section, /Na primeira conexão do agente, o servidor guarda o nome do computador, o seu usuário do Windows, o identificador, a hora e o IP/);
  assert.match(section, /Quando o seu cliente MCP abre uma sessão:\*\* o nome que o dono deu ao seu acesso, o número da sessão MCP, o IP de onde você conecta, o nome e a versão do cliente MCP/);
  // what the customer's workspace keeps, including the free text of ssam_friction reports
  assert.match(section, /o texto dos relatos que o seu cliente MCP grava com `ssam_friction`/);
});
