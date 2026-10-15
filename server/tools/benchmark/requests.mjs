import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const spec = JSON.parse(fs.readFileSync(new URL('./spec.json', import.meta.url), 'utf8'));
export const cases = ['S1', 'S2', 'C1', 'C2', 'C3', 'C4'];
const setupCases = new Set(['S1', 'S2']);
const conventions = [
  'Capture Now() uma única vez por action; Today é sua data no calendário local do ambiente. Valores monetários são Decimal com duas casas e arredondamento half-up.',
  'Datas e identificadores opcionais usam o nulo da plataforma. Referências obrigatórias devem existir e estar ativas. Toda escrita é atômica; bloqueie registros antes de verificar pré-condições mutáveis. Falha reverte tudo.',
  'Name é Text(200) obrigatório em todas as entidades, inclusive referência legível de Loan, Reservation e Fine: Loan:<CopyId>:<Now>, Reservation:<BookId>:<MemberId>:<Now> e Fine:<LoanId>.',
  'Listas retornam no máximo 50 registros ativos, salvo regra explícita diferente. Desempate sempre por Id ascendente. Registros obrigatórios ausentes ou inativos: exceção BusinessRule com mensagem exata Record not found, salvo mensagem específica.',
  'Implemente somente actions de servidor. Não crie interface, autenticação, integrações ou dados de exemplo. Não publique. Preserve todas as regras, assinaturas e mensagens literais deste pedido.'
];
const templateText = {
  Create: 'Apare Trim nos textos; execute {Entity}_Validate. Se inválido, lance BusinessRule com "Validation failed: " seguido das mensagens na ordem dos campos. Verifique unicidade entre ativos E inativos. Ignore Id, CreatedOn e IsActive recebidos; gere Id, CreatedOn=Now e IsActive=true; aplique defaults declarados a valores omitidos, persista atomicamente e retorne Id.',
  Update: 'Bloqueie registro por Id, inclusive inativo; ausente: Record not found. Substitua todos os campos de negócio preservando Id, CreatedOn e IsActive. Apare Trim nos textos; valide usando o Id atual para excluir a própria linha da unicidade; se inválido lance "Validation failed: " e mensagens. Persista atomicamente e retorne true.',
  Delete: 'Bloqueie registro inclusive inativo; ausente: Record not found. Defina somente IsActive=false. Já inativo também retorna true. Nunca exclua fisicamente nem aplique cascata.',
  Get: 'Busque por Id, incluindo inativos. Ausente: Record tipado vazio e Found=false; presente: linha completa e Found=true. Sem escrita.',
  List: 'Somente ativos. Apare Trim(Query); busca substring sem distinção de maiúsculas por OR em {TextFields}; vazio aceita todos. SortBy vazio significa Name; aceite apenas Name, CreatedOn, Id, senão Invalid sort field. Ordene na direção Descending e desempate por Id ascendente. Limit de 1 a 50, senão Invalid limit. Sem escrita e sem paginação.',
  Count: 'Conte todos os ativos com exatamente o predicado textual de List sobre {TextFields}. Sem limite de 50 e sem escrita.',
  Exists: 'Retorne se existe ativo com {LookupField} igual a Trim(Value), sem distinguir maiúsculas. Value vazio retorna false. Sem escrita.',
  Activate: 'Bloqueie registro inclusive inativo; ausente: Record not found. Defina somente IsActive=true. Já ativo também retorna true. Sem cascata nem alteração de status de negócio.',
  Deactivate: 'Bloqueie registro inclusive inativo; ausente: Record not found. Defina somente IsActive=false. Já inativo também retorna true. Sem cascata nem alteração de status de negócio.',
  Validate: 'Sem escrita nem exceção. Na ordem de declaração, valide texto obrigatório não vazio após Trim, comprimento máximo de textos, referências obrigatórias existentes e ativas, restrições numéricas e de datas, status estáticos e unicidade declarada contra TODAS as linhas excluindo Record.Id. Para referência opcional não nula também valide existência. Uma mensagem por falha, Field=<campo>, Message=<campo> is required / is too long / is invalid / already exists, conforme a falha. Ignore Id automático, CreatedOn e IsActive controlados pela criação. IsValid=true se e somente se Messages estiver vazia.'
};
const fill = (s, entity) => s.replaceAll('{Entity}', entity.name).replaceAll('{TextFields}', entity.textFields.join(', ')).replaceAll('{LookupField}', entity.lookupField);

export function moduleName(lane, round) {
  return (lane === 'o11' ? spec.round.o11Module : spec.round.odcLibrary).replace('<RR>', round);
}

export function generatedActions() {
  return spec.entities.flatMap(entity => spec.crudTemplates.map(template => ({
    name: `${entity.name}_${template.verb}`,
    inputs: fill(template.inputs, entity), outputs: fill(template.outputs, entity),
    rule: fill(templateText[template.verb], entity)
  })));
}

export function actionNames(caseName) {
  if (caseName === 'C4') return generatedActions().map(action => action.name);
  if (caseName === 'C3') return spec.businessActions.map(action => action.name);
  if (caseName === 'C1' || caseName === 'S2') return [spec.cases[caseName].action];
  return [];
}

function modelText() {
  const fields = field => `${field.name}: ${field.type}${field.required ? ', obrigatório' : ''}${field.unique ? ', índice único inclusive inativos' : ''}${field.default !== undefined ? `, default ${field.default}` : ''}${field.validation ? `, restrição ${field.validation}` : ''}`;
  return [
    'Modelo exato (não conte as entidades estáticas entre as 10 entidades de negócio):',
    `Campos comuns a todas: ${spec.commonFields.map(fields).join('; ')}. Id é chave primária autonumérica.`,
    ...spec.entities.map(entity => `- ${entity.name}: ${entity.fields.length ? entity.fields.map(fields).join('; ') : 'somente campos comuns'}. Consulta Exists por ${entity.lookupField}.`),
    ...Object.entries(spec.staticEntities).map(([name, values]) => `- Estática ${name}: ${values.join(', ')}.`),
    ...Object.entries(spec.structures).map(([name, value]) => `- Estrutura ${name}: ${value}.`),
    'Cada campo Identifier referencia a entidade indicada; vínculos não fazem exclusão física em cascata. Fine.LoanId tem índice único, para impedir multas duplicadas.'
  ].join('\n');
}

function actionTable(actions) {
  return '| Nome | Entradas | Saídas | Regra exata |\n|---|---|---|---|\n' + actions.map(a => `| ${a.name} | ${a.inputs} | ${a.outputs} | ${a.rule.replaceAll('|', '\\|')} |`).join('\n');
}

export function renderRequest({ lane, case: caseName, subagents = 'no', round = '01' }) {
  if (!['o11', 'odc'].includes(lane)) throw new Error('lane deve ser o11 ou odc');
  if (!cases.includes(caseName)) throw new Error('case deve ser S1, S2, C1, C2, C3 ou C4');
  if (!['yes', 'no'].includes(subagents)) throw new Error('subagents deve ser yes ou no');
  if (!/^(0[1-9]|[1-9][0-9])$/.test(round)) throw new Error('round deve ter dois dígitos de 01 a 99');
  if (setupCases.has(caseName)) subagents = 'no';
  const module = moduleName(lane, round);
  const current = spec.cases[caseName];
  const parts = [
    `[BenchSSAM round=${round} case=${caseName} lane=${lane} subagents=${subagents}]`,
    '', `${current.measured ? 'Pedido medido' : 'Preparação não medida (measured:false)'} da bateria de biblioteca e empréstimos. Destino: ${lane === 'odc' ? 'library ODC' : 'módulo O11'} ${module}.`,
    subagents === 'yes' ? 'Use subagentes em paralelo para acelerar.' : 'Faça sem subagentes.',
    'Autorizo criar e alterar somente os elementos pedidos no destino acima. Não publicar. Use as ferramentas SSAM da sessão e as regras do time. Se algum pré-requisito estiver ausente, pare e relate; não o reconstrua dentro do pedido medido.',
    '', ...conventions, ''
  ];
  if (caseName === 'S1') parts.push(spec.cases.S1.purpose, modelText());
  if (caseName === 'S2') parts.push(`Pré-requisito: S1 concluído neste destino. Crie apenas ${current.action}(${current.inputs}) → ${current.outputs}.`, ...current.steps.map((step, i) => `${i + 1}. ${step}`));
  if (caseName === 'C1') parts.push(`Pré-requisito: S1 e S2 concluídos. Crie ${current.action}(${current.inputs}) → ${current.outputs}.`, ...current.rules.map((rule, i) => `${i + 1}. ${rule}`));
  if (caseName === 'C2') parts.push('Pré-requisito: S2 concluído, ainda com DailyFine=0.50. Leia a action existente antes de editar.', current.rule);
  if (caseName === 'C3') parts.push('Pré-requisito: S1, S2, C1 e C2 concluídos. Crie todas e somente as 20 actions da tabela. Reutilize Loan_Checkout já existente. Não altere actions existentes.', actionTable(spec.businessActions));
  if (caseName === 'C4') parts.push('Pré-requisito: S1 concluído. Crie 100 actions, geradas pela família de 10 entidades × 10 verbos. Nenhuma substitui as actions de negócio. Reutilize o modelo existente abaixo. Não altere actions existentes.', modelText(), actionTable(generatedActions()));
  parts.push('', `Critério de pronto: entregue no módulo ${module}, ${current.newActions} actions novas${caseName === 'C2' ? ', somente a alteração de uma linha' : ''}, sem erros. Informe assinaturas, validação e links do app quando disponíveis; não publique.`);
  return parts.join('\n') + '\n';
}

export function writeAll({ round = '01', out }) {
  // Preparações não têm variante de subagentes: 2 × (2 + 4 × 2) = 20.
  const entries = ['o11', 'odc'].flatMap(lane => cases.flatMap(caseName =>
    (setupCases.has(caseName) ? ['no'] : ['yes', 'no']).map(subagents => ({
      lane, case: caseName, subagents, round,
      filename: `${lane}-${caseName}${setupCases.has(caseName) ? '' : `-${subagents}`}.md`
    }))));
  const rendered = entries.map(entry => ({ ...entry, text: renderRequest(entry) }));
  fs.mkdirSync(path.resolve(out), { recursive: true });
  for (const entry of rendered) fs.writeFileSync(path.resolve(out, entry.filename), entry.text);
  return rendered.map(({ filename }) => path.resolve(out, filename));
}

export function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--all') args.all = true;
    else if (['--lane', '--case', '--subagents', '--round', '--out'].includes(flag)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Valor ausente: ${flag}`);
      args[flag.slice(2)] = argv[++i];
    } else throw new Error(`Opção desconhecida: ${flag}`);
  }
  if (args.all) {
    if (!args.out) throw new Error('--all requer --out');
    const files = writeAll(args);
    process.stdout.write(`Gerados ${files.length} pedidos em ${path.resolve(args.out)}.\n`);
  } else {
    if (args.out) throw new Error('--out requer --all');
    process.stdout.write(renderRequest(args));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
