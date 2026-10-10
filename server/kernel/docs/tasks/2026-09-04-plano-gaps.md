# Plano de implementacao dos gaps (2026-09-04)

Plano escrito a partir das 16 investigacoes e dos 32 vereditos (2 ceticos por item). Onde investigador e ceticos discordaram, fui ao codigo/descompilado e decidi; as verificacoes que eu proprio fiz estao na seccao "Certezas e incertezas" e no corpo de cada item, sempre com ficheiro:linha. Regras do MANIFESTO citadas como P1..P10.

## Quadro-resumo

| Onda | Foco | Itens | Horas |
|---|---|---|---|
| 1 | Bugs e recusas baratas que fecham por mecanismo | 14, 11, 12, 13a, 15a/06a/16a (Detail + ordem dos erros), 09, 02, 01a | 37 |
| 2 | Checagens e contratos | 03, 16b, 04, 06b, 05, 15b, 13b, 01b, 07, 17 (novo: fidelidade do merge) | 75 |
| 3 | Spec de telas por arquetipo | 10 | 40 |
| 4 | Superficie por comandos (exige ADR "superficie por comandos" e decisao do dono local vs servico) | 08 | 12 |
| | **Total** | 16 itens + 1 novo | **164** |

Ordem dentro da onda 1: 14 -> 15a/06a/16a -> 11 -> 12 -> 13a -> 09 -> 02 -> 01a. A onda 2 depende de 02 (bases) e de 15a (Detail) estarem fechados; 03 tem de entrar antes de 04; 16b e 07 partilham o delta por identidade de 03.

## Progresso (atualizado pela sessao em curso; continuar daqui noutra sessao)

Regras para quem continua: trabalhar na faixa `ANVIL_LANE=ss5` (SS5, bridge 4536, worker 4537, `.local/lane-ss5/`) enquanto
outra sessao usar o SS4; build do CLI da faixa: `python scripts/build.py` (para/build/arranca so o worker SS5); bridge no SS5:
`scripts/open_studio.ps1 -Lane ss5 -ForceRestart` e depois `ANVIL_LANE=ss5 python scripts/studio_env.py login --credentials <arquivo> --open <Modulo>`.
Cada passo fecha com teste verde, linha em `docs/PROVAS.md`, commit, e a linha abaixo atualizada.
ATENCAO (19:40): o SS4 deixou de correr durante a tarde (nao foi este trabalho: o lancador da faixa ss5 so mata processos "Anvil 4536");
o worker 4517 continua de pe. Quando a outra sessao terminar, alinhar o SS4 com o codigo novo: `scripts/open_studio.ps1 -Lane ss4 -ForceRestart`
(bridge com passos 4-6), depois `python scripts/studio_env.py login --credentials <arquivo>`, e `python scripts/build.py` na faixa ss4 (CLI com passos 2-3).

| # | Item | Estado | Commit | Notas |
|---|---|---|---|---|
| 1 | 17 Fidelidade do merge | FEITO 20:00 (causa raiz + correcao no verbo + teste headless + prova viva no SS5/Davitest_UI, TrueChange 0) | e59e96b | docs/mapa/2026-09-04-fidelidade-do-merge.md; Verbs.Unhide; MergeProbe; MergeFidelityTests; hidden-reference-block.json. Pendente menor: gate no MergeHandler (recusar foreign com referencia oculta usada) e `hiddenReference:true` no Resolve |
| 2 | 14 Envelope de erro + forward-refs | FEITO 19:45 | 8bd4526 | Errors.cs (Describe, UnresolvedReferenceException, ForwardRefs); jobs-negative/destination-before-screen.json; NegativeJobTests (jobs com expectError) |
| 3 | 15a/06a/16a Detail, erros primeiro, get de expressao | FEITO 19:45 | 8bd4526 | ValidationDetails: `Message | Detail`, erros nunca cortados, hints com orcamento proprio; Verbs.Get testa IExpression antes de IObjectSignature; suite 83/83 |
| 4 | 11 Caminhos absolutos na bridge | FEITO 19:55 | 1cb17c2 | PathArgs.cs; MergeHandler/ExportHandler/LoginHandler; proof_merge resolve --login; PathArgsTests; prova viva no SS5 (relativo recusado, absoluto ok, nada gravado na pasta do Studio) |
| 5 | 12 Pre-condicao Match no merge | FEITO 20:35 (prova viva: merge recusado nomeando o dialogo de dependencias; sem 'Matches cannot be set already', sem restart) | 6d85cb0 + (commit seguinte) | Receita da prova: publicar entidade publica no Davitest_CS, referencia-la no Davitest_UI e publicar, republicar o Davitest_CS com atributo novo, reiniciar o SS5, `open_module Davitest_UI` (dialogo de referencias) e `merge_from_oml` -> recusa em <1 s |
| 6 | 13a Detecao de dialogos | FEITO 20:35 (prova viva com o dialogo real de dependencias: open_module 4,7 s com blockedBy; pendingDialogs = ManageDependencies com dica) | 6d85cb0 + (commit seguinte) | scripts/proof_refs_dialog.py reproduz o cenario; pendente menor: esperar o dialogo de progresso resolver antes de classificar (hoje devolve WebDialog Progress nos primeiros 5 s) | Dialogs.cs, DialogPolicy.cs (+ WebDialog, Progress), OpenHandler (3 ciclos), WindowsHandler (isModal/contentKind), scripts/proof_dialogs.py, DialogPolicyTests |
| 7 | 09 Regra de nome | FEITO 20:00 (regra + testes; jobs-cold fica fora ate consolidar v2..v7, que sao da outra sessao) | c1a314f | JobRunner.CheckJobName; ApplyCmd; CollectOps; GuideTests (NoJobIsAVersionedCopy + teoria); AGENTS.md secao 0 |
| 8 | 02 Bases so fixture/job:/snapshot | FEITO 20:53 (114/114, suite isolada e prova viva) | 40e5384 | JobSources + JobRunner centralizados; --base opcional e --producer repetivel; 15 campos migrados; ADR-007; prova viva SS5/Headless_UI TrueChange 0; proximo: 10 (03 expectedMessages) |
| 9 | 01a Worker: build.py, suite serializada | FEITO 20:05 | e04d91c | build.py; xunit.runner.json (2 m 31 s vs 2 m 24 s); FiveRuns estendido (released, LoadedModules=0, heap plano). Pendente menor: `commands` separado de `served` no ping |
| 10 | 03 expectedMessages | FEITO 21:13 (129/129 e gate vivo) | 943bce6 | Delta por identidade do Studio; expectativas com id/element/why; gate no merge provado ao vivo; cada parte e composto tem seu contrato proprio (decisao do dono) |
| 11 | 16b TrueChange em delta | FEITO 21:51 (131 testes .NET + 5 Python; provas vivas) | f1d96fa | MergeHandler captura antes/depois na UI; retorno new/fixed/preexisting/newErrors; proof_merge falha sem publicar nem desfazer se ha erro novo |
| 12 | 04 Input sem uso (spec logic) | FEITO 21:58 (138/138, paridade e prova viva) | aa9f86f | LogicUsage puro, compilacao recusa inputs/vars/outputs sem uso; max/start/sort/SQL values reconhecidos; paridade B/V com Verify; prova viva Usage_CheckText |
| 13 | 06b SQL checks | FEITO 22:06 (154/154 e prova viva) | 13f1754 | SqlChecks: igualdade de parametros, comentarios/literais, rejeita where/sort/start; self-assign; set/link com candidatos da API; prova viva SqlItems_Search |
| 14 | 05 replace:true + ordenacao | FEITO 22:18 (165/165 e prova viva) | 5abf9f4 | LogicOrder estavel, chamadas irma/client, ciclos, pre-check de nomes; replace recria na mesma transacao e verifica consumidores externos aos corpos |
| 15 | 15b Hint Current + reference | FEITO 22:27 (178/178 e prova viva) | 38b06c4 | Tipos reais de entidade/structure/aggregate agrupado; receita Public; 4 negativos principais e 2 adicionais de escopo |
| 16 | 13b ServerSilentMode | FEITO 22:47 (182/182 e prova viva) | 4aa98f0 | Abertura nova com refs antigas em 7,5 s; silent:false em 4,6 s; timeout restaura flags; Progress corrigido; abas restauradas |
| 17 | 01b Worker fila/auto-arranque | FEITO 22:57 (185/185 + 13 Python + soak) | fa2ac4c | Fila serial, ping responsivo, lock/identidade de processo, reciclagem e erro de replay desconhecido |
| 18 | 07 deliver | FEITO 23:11 (199/199 + 11 Python + tickets-all vivo) | dc1c154 | SnapshotRegistry, foreign Key, get_errors since, Delivery fora do Kernel, BridgeClient e wrapper fino; 1 merge em 27,6 s |
| 19 | 10 Spec de telas | CONCLUIDO (provas vivas + fria em 1 tentativa; suite isolada 229/229) | 0d86d17 | ScreenExpander puro, contratos locais, 6 goldens, fonte action paginada; secao 3.4; snapshots live sem avisos novos |
| 20 | 08 Superficie por comandos | CONCLUIDO (5 consultas frias aprovadas; suite isolada 229/229) | 3402449 | 468 IDs/textos por DLL, 169 hints, 4 mapas x 2147, recipes limitadas e esquemas fechados; ADR-012 |

### Notas da etapa 8

- Fecho: **114/114 testes verdes em 2 m 32 s**, SS5/11.55.73; TRX em `.local/lane-ss5/test-results/portable-sources-complete.trx`.
  A corrida com `.local/jobs` e `.local/test-work` ocultadas tambem passou (113/113 em 2 m 32 s, antes do teste adicional do indice).
  Proximo passo: **10, item 03 expectedMessages**; depois 11 (delta TrueChange), 12 (input sem uso).
- Resolucao de bases e producers centralizada em C#; Python so repassa. Dependencias usam a pasta do job que as declara,
  inclusive partes de compostos. Ciclos recusados; outputs isolados em `<work>/producers/<corrida>/`; erros de reference
  conservam o indice global da op. Snapshots explicitos entram por `--base` / `--producer Nome=oml`.
- Os 15 campos previstos foram migrados (11 bases e 4 producers). O dono autorizou mexer somente em base/producer dos jobs
  frios: eles continuam **untracked**, sem entrar no commit desta etapa, assim como os arquivos de arranque de outras LLMs.
- Prova viva equivalente ao aceite (c): o Headless_CS atual tem `Game`, mas ja nao tem `Product` do exemplo antigo.
  Snapshot atual ligado por `--producer Headless_CS=...` ao job local `portable-source-proof`: referencia Game e cria a
  structure publica PortableSourceProof no Headless_UI. Merge unico em 5.302 ms; TrueChange 0 erros / 1 warning pre-existente
  (Slugify); find da structure e da entidade presente; nao publicado.
- O SS5 esta em 11.55.73; o SS4 continua em 11.55.69. O primeiro teste completo revelou somente o catalogo de funcoes:
  112/113 verdes em 2 m 32 s. Comparacao: as 121 funcoes sao identicas, so o campo Studio mudou. Registrado o catalogo .73
  e o teste passou a escolher a versao instalada, preservando o .69. Nenhum processo/build da faixa SS4 foi alterado.
- Na prova de independencia, `.local/jobs` e `.local/test-work` foram renomeadas temporariamente e restauradas em finally;
  as saidas novas ficam em `.local/test-work.portable-generated-<data>`. Nenhum OML anterior foi apagado.

### Notas da etapa 10

- Fecho: **129/129 testes verdes em 2 m 17 s**, SS5/11.55.73; `message-contract-complete.trx` em `.local/lane-ss5/test-results/`.
  Proximo passo: **11, item 16b TrueChange em delta depois do merge**, seguido do 12 (input sem uso).
- MessageInfo/MessageDelta usam ID, chave do dono, propriedades e parametros capturados do Verify. Uma leitura por fase;
  resumo e detalhes usam a mesma lista. Novas/corrigidas/preexistentes nao se compensam por contagem.
- expectedMessages exige id conhecido, sufixo de caminho com dois niveis ou mais e why. Contratos obsoletos, ambiguos ou
  incompletos rejeitam o resultado. expectValid agora e aplicado (default true); snapshots de diagnostico continuam salvos.
- Decisao do dono, apos exemplo concreto dos tickets: **cada teste tem sua lista**. As partes mantem expectativas para
  executar isoladamente; o composto julga exclusivamente a lista do proprio composto, sem heranca.
- Migrados todos os campos numericos dos jobs e scripts; entre os 17 jobs oficiais com teto positivo, so 11 criam mensagens
  novas. Os demais herdavam avisos ou nao precisavam do teto. Tickets-01 declara 6; tickets-02 declara 7 novos; tickets-all 1.
- Jobs frios continuam untracked, agora com metadados de expectativas: actions cria 42 avisos declarados; input-fields herda
  42 e nao cria novos; SQL v5 corrige 42 e cria 42 (actions recriadas); SQL v7 corrige os 42 e termina sem mensagens.
  Nao houve alteracao dos ops de negocio. Variantes historicas all-sql e v4 ja falhavam antes do Verify; v2/v3, v6 e
  sql-result-probe ja tinham erros. Permanecem rejeitadas; seus erros nao foram declarados como expectativas aceitas.
- Provas vivas SS5/Headless_UI: undeclared-warning bloqueia merge (exit 4, Studio intacto); hidden-reference-block entrega
  12 avisos declarados + 1 preexistente, TrueChange 0 erros, 5.061 ms. A tela HiddenRefProbe ficou no Studio, nao publicada.
- gen_tickets conserva os mesmos ops e expectativas revisadas; galeria Tabs gera 3 expectativas e passa no replay.
  Frio e worker concordam nos dois negativos. ADR-008 registra a decisao de nao introduzir messages/diff dentro de ApplyOne.

### Notas da etapa 11 e continuacao autorizada

- O dono autorizou seguir **do 11 ao 20**, fechando cada etapa antes da seguinte. Proximo agora: **12, input sem uso na spec**.
- 131/131 testes .NET em 2 m 23 s; 5 testes Python do chamador. Tickets helpers no merge real headless: 7 novas, 2 corrigidas,
  4 preexistentes (saldo 5 nao mascara as 7). Fixture Mobile sem alteracao: 6 preexistentes, zero novas/corrigidas.
- SS5 atualizado com bridge nova; snapshots preventivos dos tres modulos em `.local/lane-ss5/bridge-delta-backup/manifest.json`.
  Headless_CS e Headless_UI recuperados e comparados por MatchTree: sem diferencas. A recuperacao tambem abriu KKRTimeEntry_UI
  (nao tocado). Davitest_UI ficou com HasOpenedActiveESpace=false e open_module timeout, sem dialogo visivel; snapshot preservado.
  Investigar essa condicao na etapa 16 (open_module), sem descartar o snapshot nem reiniciar para resolver matches.
- Prova viva Headless_UI (estado atual tem 13 warnings, nao os 218 do levantamento): aviso novo separado (1/0/13), entrega 4.181 ms;
  job vazio: 0/0/14 em 3.188 ms. Cenário de 218 antigos coberto pelo teste do script. Variavel MergeDeltaWarning fica como prova.
- Prova negativa manual no lab: foreign invalido (Right) introduz 1 erro e 1 warning; bridge retorna newErrors=1, merge permanece.
  Inspecionado e restaurado por merge inverso: 0 novas, 2 corrigidas, 0 erros novos, totais originais repostos. Nada publicado.

### Notas da etapa 12

- Fecho: **138/138 testes em 2 m 22 s**, SS5, TRX `.local/lane-ss5/test-results/logic-usage.trx`. Proximo: **13, SQL checks**.
- LogicUsage analisa expressoes sem strings/membros qualificados; filtro/sort desconsidera entidade e alias da fonte.
  Campos max/start e params.value contam; output passado a chamada pode ser mutado (ListAppend), com Verify como juiz final.
- Erro inclui todos os inputs/vars/outputs sem uso da action e os campos onde podem ser usados; nenhum escape em JSON/CLI.
  ExpandForVerification e interno, so para a prova de paridade com Verify (sem flag global).
- Spec de paridade: recusa B e V, aceita A (referido como a) e Ok atribuido; Verify emite exatamente B/V quando compilada
  pelo caminho interno de teste. logic-spec-services continua a expandir; parametros de helpers por verbos nao mudaram.
- Specs frias incompletas agora sao recusadas mesmo que tenham expectedMessages. Seus ops/API de negocio nao foram alterados
  para inventar consumo de parametros. A checagem e propria da spec, nao um bloqueio a handlers OSUI escritos por verbos.
- Vivo SS5/Headless_UI: negativo UsageProbe falha no compile sem merge; Usage_CheckText publico, input Value e output Ok
  usados, entregue em 5.943 ms, TrueChange 0 novas/0 corrigidas/14 preexistentes e zero erros. Sem publish.

### Notas da etapa 13

- Fecho: **154/154 em 2 m 16 s**, SS5; TRX `.local/lane-ss5/test-results/sql-contract.trx`. Proximo: **14, replace e ordenacao**.
- SQL da spec exige parametros usados/declarados iguais (case-insensitive), ignorando comentarios/literais e sem ignorar @@.
  params tem esquema fechado type/value; where/sort/start com sql:true e statement/params sem sql:true sao recusados.
  max continua valido. Self-assign (incluindo LoadSqlRecord1 do v6) falha com "does nothing".
- Set/link mostram propriedades gravaveis, expressoes e setters/conectores aceitos, quatro parecidas do proprio conjunto e
  anvil api --name. Conector errado nao e convertido silenciosamente em CreateConnector/Targets.
- 27 testes focados verdes. SQL por verbos continua vindo do Verify (Missing no Detail), sem hints paralelos.
  sql-input-output continua com 1 mensagem declarada e 0 hints. Novo job oficial logic-sql-params usa input em params.value.
- Vivo SS5/Headless_UI: SqlItem + SqlItems_Search + ReadSqlItems encontrados; 0 novas/0 corrigidas/14 preexistentes,
  zero erros, 8.040 ms E2E, sem publish. Log em `.local/lane-ss5/sql-proof/merge.log`.

### Notas da etapa 14

- Fecho: **165/165 testes em 2 m 26 s**, SS5; TRX `.local/lane-ss5/test-results/logic-replace.trx`. Proximo: **15, Hint Current e reference**.
- LogicOrder ordena dependencias de call de forma estavel, reconhece declaracoes irma e recusa ciclos com a cadeia.
  Chamadas client usam ExecuteClient; chamada de sistema ListAppend em server action tambem verificada.
- replace e booleano da action na spec; exige action propria existente do mesmo kind e definicao completa. Sem ele, logic e
  create recusam nome existente. O expander puro gera os mesmos ops com/sem o marcador; o adaptador apaga/recria e verifica
  as chaves dos consumidores, invalidando handles antigos. Nao herda flags nem parametros omitidos da declaracao anterior.
- Substituicoes multiplas verificam os consumidores fora de TODOS os corpos reescritos (os nos internos podem mudar de chave).
  Testes preservam argumento N e chave do Execute, e facade externo quando duas actions sao substituidas.
- Jobs de prova isolados logic-call-order (caller antes do callee) e logic-spec-replace. Foram preferidos a alterar Ticket_Get:
  demonstram a mesma regra sem modificar a logica de negocio de tickets. Negativo logic-duplicate-action nao salva resultado.
- Vivo Headless_UI: setup 7.929 ms; replace 5.293 ms, 0 novas/0 corrigidas/14 preexistentes, zero erros. Compute manteve a chave
  zcVPZZuDTkabOXe5eO+v9A. Logs em `.local/lane-ss5/replace-proof/`; nada publicado.

## Ordem de execucao (sequencia unica)

Cada passo so comeca quando o anterior fechou (teste verde + prova em PROVAS.md). "Depende de" diz o que tem de estar fechado.

| # | Item | Horas | Depende de | Fecha com |
|---|---|---|---|---|
| 1 | 17 Fidelidade do merge (investigar o par foreign.084203 / base.084358, 2 erros e 56 objetos perdidos) | 4 | - | nota em docs/mapa + item proprio se for bug nosso |
| 2 | 14 Envelope de erro com cadeia + forward-refs listados | 5 | - | jobs-negative/destination-before-screen |
| 3 | 15a/06a/16a Detail do Verify, erros antes de warnings, `get` mostra expressoes | 2 | - | Fact: erro e a 1a linha com 218 warnings |
| 4 | 11 Caminhos absolutos na bridge | 2 | - | BridgePathArgsTests + prova viva |
| 5 | 12 Pre-condicao `Match == null` no merge, mensagem que ensina | 4 | 3 | prova viva com Manage Dependencies aberto |
| 6 | 13a Detecao de dialogos em <= 5 s (`blockedBy`) | 5 | 5 | prova viva com o message box de referencias |
| 7 | 09 Regra de nome (sem -vN) + consolidar jobs-cold | 3 | - | GuideTests.NoJobIsAVersionedCopy |
| 8 | 02 Bases so fixture, `job:` ou snapshot ligado; `--producer` | 12 | 7 | GuideTests.NoJobPointsAtMutableOml + suite verde |
| 9 | 01a Worker: build.py, suite serializada, teste de release | 4 | 8 | teste estendido < 10 s |
| 10 | 03 `expectedMessages` com identidade do Studio; migrar 17 jobs | 12 | 3, 8 | grep maxNewMessages = 0; jobs negativos |
| 11 | 16b TrueChange em delta dentro do merge | 6 | 10, 5 | proof_merge imprime novas/corrigidas/pre-existentes |
| 12 | 04 Input sem uso = erro na spec logic (sem escape) | 6 | 10 | LogicSpecTests + paridade com o Verify |
| 13 | 06b SQL: params nos dois sentidos, sem where/sort/start com sql, X = X, erro do set com parecidas | 6 | 12 | LogicSpecTests + sql-unknown-param |
| 14 | 05 `replace:true` e ordenacao topologica na spec | 9 | 12 | logic-spec-replace + prova viva |
| 15 | 15b `Hint Current` + erro do reference com receita | 4 | 3, 13 | 4 negativos + 2 positivos |
| 16 | 13b Prevenir o dialogo de referencias (ServerSilentMode no aggregator) | 6 | 6 | open_module devolve referencesOutdated em < 20 s |
| 17 | 01b Worker: fila com ping sempre vivo, auto-arranque, reciclagem | 8 | 9 | dois clientes em simultaneo; reciclagem no N-esimo |
| 18 | 07 `deliver` (snapshot registado, base so do snapshot, delta) | 14 | 8, 11, 5, 6 | DeliverTests + prova viva no Headless_CS |
| 19 | 10 Spec de telas por arquetipo (6 jobs de ouro) | 40 | 2, 15 | suite + prova viva + rodada fria refaz as 3 telas |
| 20 | 08 `verify-message` (DLL), `where-can`, `recipe`, `api --op` como funcoes puras (CLI e servico) | 12 | ADR superficie por comandos | SurfaceTests + rodada fria com contagem de leituras |

Total: 164 h. Os passos 19 e 20 podem correr em paralelo depois do 18. Marcos de entrega: apos o 9 (onda 1: bugs da bridge
e runner fechados, sessao fria sem restarts), apos o 18 (onda 2: `deliver` unico com delta), apos o 19 (telas de produto).

## Decisoes do dono (2026-09-04, fim do dia)

| Pergunta | Decisao | Efeito no plano |
|---|---|---|
| Dialogos do Studio durante open_module/deliver | So detetar e devolver `blockedBy` em <= 5 s; a bridge nunca clica por si | 13a fica como esta; fecho automatico sai do 13b (nem opt-in) |
| Merge que deixa erros novos de TrueChange | Manter o merge e so reportar o delta (novos vs pre-existentes); quem chama decide; nada publica | 07: sem undo automatico; `deliver` devolve o delta e o exit code reflete `newErrors` (a LLM ve, o humano tem Ctrl+Z); 17 continua a investigar a fidelidade |
| Textos do `verify-message` | Ler o DLL instalado em runtime; no repo so os hints curados nossos (principio 6) | 08 como proposto |
| Forma do produto (ADR superficie por comandos) | CEREBRO EM SERVICO + MAOS LOCAIS: spec de logica/telas, receitas, checagens e catalogos de saber num servico nosso; localmente bridge, apply, merge; o OML nunca sai da maquina do cliente; o cliente envia specs, nunca OML; kill switch = desligar a conta | Onda 4 desbloqueada; os comandos (`recipe`, `where-can`, `verify-message`, `api --op`) nascem como funcoes puras chamaveis tanto pelo CLI local como pelo servico; a ADR fixa a fronteira: o que le OML corre local, o que compila spec/serve saber corre no servico |
| Escape para input sem uso na spec de logica | Nenhum: input declarado e nao usado e erro de compilacao, sempre | 04 como proposto, sem `unused:true` |

Recomendacao minha ainda sem decisao: puxar o item 17 (fidelidade do merge) para o topo da onda 1, porque um merge que perde objetos invalida o resto.

## Alavancas transversais (decididas uma vez, usadas por varios itens)

| Alavanca | Onde | Serve os itens | Prova que verifiquei |
|---|---|---|---|
| Envelope de erro do CLI preserva a cadeia de mensagens (hoje desce ate a raiz e descarta o prefixo `op #i (...)`) | `src/Anvil.Cli/Program.cs:52-53` (`ErrorEnvelope`), usado por Main :43 e Serve :210 | 14, 05, 06, 15 e todo erro de verbo | Lido: `while (root.InnerException != null) root = root.InnerException` |
| `IValidationMessage.Detail` impresso a seguir ao `Message` | `src/Anvil.Core/Adapters.SS11/ModelHost.cs:117-120` (`ValidationDetails`) | 15a, 06a, 08, 03 | `anvil api --name IValidationMessage` lista `Detail: String`; hoje so `vm.Message` e impresso; padrao `Message | Detail` ja existe em `Publisher.cs:82` |
| Erros primeiro e nunca cortados em `ValidationDetails` | `ModelHost.cs:113-127` | 16a, 03, bridge `get_errors` (`Reads.cs:41-55`) | `if (list.Count >= max) break;` corta em DFS sem ordenar por severidade; 2 erros invisiveis em 60 (inspect de `Headless_UI.base.084358.oml`: 222 msgs, `IsValid=false`) |
| Identidade de mensagem = a do proprio Studio (MessageId + ObjectKey do dono + PropertyNames + MessageParameters), lida do `espace.Verify()` que `Describe` ja consome | `ModelHost.cs:200-213` (`Describe`) e novo `Kernel/Messages.cs` (DTO puro) | 03, 16b, 07 | `Describe` ja itera `espace.Verify()` com `m.MessageId`/`m.ObjectIdentifier` (ADR-004: internos so no adaptador) |
| Resolucao de `base`/`producer` uma vez so, em C# | `src/Anvil.Core/Kernel/JobRunner.cs` | 02, 09, 05, 07 | Hoje 4 regras: `JobRunner.ResolveProducer:101-133`, `run_job.py:27-39`, `JobTests.cs:46-59`, `worker_soak.py:42-48` |

ADRs a escrever (numeracao pela ordem de commit; a do item 08 e a que o pedido chama ADR-007):
`jobs-portateis` (02, 09, 05-nome), `mensagens-do-verify` (03, 06, 15, 16), `compiladores-de-acucar` (05, 04, 10, 14: classifica `layout`, `rename`, `dump`, `spec`, `logic`, `screen` face aos 17 verbos da ADR-003), `worker-residente` (01), `entrega-e-enforcement-na-bridge` (07), `superficie-por-comandos` (08).

## O que NAO fazer agora e porque

- Reordenacao automatica de ops ou fila de sets pendentes no runner (14): delete+recreate legitimo em `tests/jobs-cold/game-set-publishers-sql.json` #0/#1 quebraria; contraria P2 e a semantica "um job = sequencia de verbos" (ADR-003).
- Cirurgia in-place de actions (apagar Nodes/LocalVariables, reconciliar parametros) (05): o Studio religa consumidores por nome quando a action renasce no mesmo comando (`Framework:53230` -> `ReplaceReferences` -> `SetAction(null, ReferenceReplaced)` -> `PreviousActionValue`, `Framework:229528-229536`, `228717`); `replace:true` = delete + os mesmos ops + verificacao dos consumidores.
- Refresh de referencias pela bridge no modulo aberto (12): muta o modulo do humano fora do merge (P1, ADR-001). E o hash vazio NAO e a causa do dialogo: `HasIncompatibleReferences` decide por catalogo do servidor, `DecorationCache` e comparacao elemento a elemento (`Presenter:227681-227719`), nunca por `Reference.ReferenceHash` local.
- `close_pending`/fecho automatico de dialogos (12, 13): responde pelo humano; fica opt-in e so depois de decisao do dono.
- Undo automatico do merge (07): fora ate o dono decidir; default = exit code 2 + "Ctrl+Z desfaz".
- Hints SQL por tokenizador proprio (06): o Detail do Verify ja nomeia o parametro nos dois sentidos; o parser do Studio muda de comportamento em SQL "Unrecognized" e um hint que contradiga o Verify fere P2.
- `explain --section` (08): re-serve prosa que a LLM ja tem; o que foi lido 4x e o ESQUEMA da op `logic`, que se expoe como dado gerado.
- Prova visual por screenshot (10): nao ha `CssClasses` no catalogo para Card/Pagination/Tabs/Rating/Carousel (verifiquei: listas vazias), nem URL de runtime na bridge; juiz continua o Verify + `find` dos block instances.
- Carimbo de build/MVID no ping e estado "stale" no cliente (01): com o worker de pe os DLLs estao bloqueados para escrita (verifiquei: `PermissionError` em `.local/cli/anvil.dll` e `Anvil.Core.dll` com pid 52176 vivo); o build falha em vez de deixar um worker velho. O mecanismo e `scripts/build.py` (stop -> build -> start).
- Multi-thread no worker (01): `UndoManager`, `ESpaceInstances` e `ObjectCloner` sao estaticos do Studio sem prova de reentrancia; a fila e de UM consumidor.
- Verbo `messages`/`diff` no `ApplyOne` (03): decidir os dois juntos no ADR `mensagens-do-verify`; nao ha prova de que `Verify()` a meio do comando aberto devolve o mesmo que no fim.

---

## Onda 1: bugs e recusas baratas (37 h)

### 14. Destino de navegacao antes do link

**Diagnostico: corrigido.** O mecanismo esta certo (Apply sequencial `Verbs.cs:44-60`; `Destination` e `IObjectSignature` -> `Convert` -> `Resolve` `Verbs.cs:401-415`; `Descendants()` sem cache). A causa das 2 execucoes perdidas NAO e a frase "add the dependency first": (a) `ErrorEnvelope` (`Program.cs:52-53`) desce ate a excecao raiz e descarta o prefixo `op #i (set Destination)` de `Verbs.cs:56`, logo a LLM recebeu um nome sem indice de op num job de 343 ops; (b) o fail-fast reporta UM forward-ref por corrida, e o job tinha dois (GameDetail e Catalog; friction.md:43-44).

**O que fazer:**
1. `Program.cs:52-53`: `ErrorEnvelope` emite a mensagem completa da cadeia (exterior -> raiz) e mantem o stack da raiz. Uma linha; vale para todos os erros de verbo.
2. `Verbs.cs:410-415`: `Resolve` lanca `UnresolvedReferenceException { Reference, Type, Name }` (nova, em Kernel); texto em ingles como as 35 mensagens existentes: `no IMobileScreen named Catalog: not in this module, not in its references, and not created by an EARLIER op of this job (create it first, or add the dependency with the reference verb)`.
3. `Verbs.cs:56` (catch de `Apply`): se a excecao e `UnresolvedReferenceException`, chamar helper puro `ForwardRefs.Find(ops, i)` (novo `Kernel/ForwardRefs.cs`) que varre TODOS os ops `j > i` e lista referencias `Tipo:Nome`/`$alias` em `set`/`link`/`create.parent` cujo `create` (ou `as`) so aparece depois; UMA mensagem com todos: `op #2 (set Destination): IMobileScreen 'Catalog' does not exist yet at this point of the job: it is created at op #3 (create IMobileScreen Catalog). Also out of order: IMobileScreen 'GameDetail' (op #9, used at op #5). Create the screens (and their input parameters) before these sets`. So corre apos falha real, logo delete+recreate nao dispara.
4. `tests/jobs-negative/destination-before-screen.json` com DOIS destinos fora de ordem (base `reactive-ui.oml`, `expectValid:false`).
5. Teste xunit sobre `ex.GetBaseException()` e sobre o envelope (ou teste que corre `run_job.py`); frase em `AGENTS.md` ~:163 e :204-206; linha em `docs/PROVAS.md`; remissao ao item 10 (ordem por construcao nasce na spec de telas).

**Aceitacao:** `ANVIL_WORKER=0 python scripts/run_job.py tests/jobs-negative/destination-before-screen.json` e o mesmo via worker imprimem `op #2 (set Destination): ... created at op #3 ... Also out of order: ... GameDetail` na primeira corrida; nenhum job de `tests/jobs` muda de resultado.
**Esforco:** 5 h. **Risco:** lookahead sugerir um `create` homonimo noutro escopo (exigir tipo compativel). **Deterministica:** sim (falha na 1a execucao com todos os forward-refs).

### 11. Bridge: caminho relativo grava no cwd do Studio

**Diagnostico: confirmado.** `MergeHandler.Snapshot` faz `Path.GetFullPath(path)` dentro do processo do Studio (`MergeHandler.cs:22-29`); `Merge` valida so `File.Exists` (:40-41) e grava o dump em `foreignPath + ".matchtree.txt"` (:83-84); `ExportHandler.cs:45,65`; `LoginHandler.cs:21-22`. `open_ss4.ps1:66` lanca com `-WorkingDirectory $StudioDir`. Log :778 e o ficheiro em `...\Service Studio\.local\producers\Headless_CS.oml` confirmam.

**O que fazer:**
1. `src/Anvil.Core/Kernel/PathArgs.cs` (novo, puro): `Absolute(verb, param, value, processCwd)` exige `Path.IsPathFullyQualified`, devolve normalizado, senao `ArgumentException` que cita verbo, parametro, valor e o cwd lido em `Environment.CurrentDirectory` no momento (nunca cacheado; nunca conteudo de ficheiro).
2. Aplicar nos 5 verbos antes de qualquer `File.*`: `MergeHandler.Snapshot` (:22-27), `MergeHandler.Merge` (foreign_path/base_path :35-41), `ExportHandler.Start/Status` (:26,:45,:63-65), `LoginHandler.Login` (:21-22).
3. `scripts/proof_merge.py:45`: `credentials_file=str(pathlib.Path(args.login).resolve())` (hoje passa cru; `studio_env.py:62` ja resolve).
4. Testes em `tests/Anvil.Tests/OfflineTests.cs` (classe `BridgePathArgsTests`), guardados por `OperatingSystem.IsWindows()`.
5. `AGENTS.md` seccao 5 (~:210): "todos os caminhos passados a bridge sao absolutos"; correr `GuideTests` (a regex :18 apanha `nome.json`: nao usar exemplo `credentials.json`).
6. Rebuild + `open_ss4.ps1 -ForceRestart` + login; prova viva com 4 chamadas relativas recusadas e ZERO ficheiro novo em `...\Service Studio\.local`; linha em PROVAS.md. O ficheiro ja gravado la e apagado pelo dono.

**Aceitacao:** offline `dotnet test --filter BridgePathArgsTests` verde; vivo: `snapshot_module path='.local/proofs/x.oml'` -> `success=false` com "must be an absolute path" e o cwd; `proof_merge.py` com job ja provado continua a passar.
**Esforco:** 2 h. **Risco:** so o helper e testavel offline; os 5 call sites so ao vivo. **Deterministica:** sim.

### 12. Merge falha com "Matches cannot be set already"

**Diagnostico: corrigido.** Mecanismo confirmado: `MatchTree.AddRoot` exige `localRoot.match == null` (`Framework:28845`); o Manage Dependencies monta um `MatchTree` + `SetESpaces(local, ReferencesESpace, null)` (`Presenter:226426-226428`, `Framework:28817-28820`) que so e disposto ao fechar o presenter (`Presenter:11663/11726`). Correcoes dos ceticos que adoto: (a) `new ReferencesManager(mru, mrt)` (`Presenter:189441`) usa o ctor de `226256-226264` que NAO inicializa; o Match nasce em `Presenter:11621` ja dentro do dialogo; (b) o hash vazio do verbo `reference` NAO abre o dialogo (`prs#gikpnede`, `Presenter:227681-227719`, nunca le o hash local); a causa foi o `Headless_CS` republicado as 11:58 (log :705); (c) o Manage Dependencies das 15:11-15:14 foi aberto pelo fluxo de `open_module` preso 180 s (log :793) - gaps 12 e 13 sao o MESMO incidente.

**O que fazer:**
1. `MergeHandler.Merge`, no `InvokeAsync` que ja obtem `Studio.Active` (:46): se `local.Match != null` (`AbstractObject.Match` publico) devolver `Server.Fail` em <1 s: `merge_from_oml: 'Headless_UI' has a Manage Dependencies or merge editor open in the Studio: apply/close it and retry`, com `pending.kind` = `ManageDependencies` | `MergeEditor` | `unknown` obtido por `aggregator.ChildPresenters` (`IDialogPresenter` contendo `IAddRemoveReferencesPresenter`, `Presenter:61621`; `IMergeEditorPresenter`, `Presenter:71235`). Nunca `AddRoot(resetMatches:true)`.
2. Rede: em `MergeHandler.Run` apanhar a `InvalidOperationException` "Matches cannot be set already" e devolver a mesma mensagem (a janela transitoria de "Checking references" pode escapar a pre-condicao).
3. `Server.cs:74`: nao truncar a 200 chars respostas de erro nem de `windows` (limite 4000).
4. `get_active_module`/`windows`: campo `activeMatch: bool` (sem verbo novo).
5. `OpenHandler.cs:25-29`: `alreadyOpen` passa a exigir `a.HasOpenedActiveESpace` (hoje testa so `ActiveESpace?.Name`), senao devolve `opening:true` + `blockedBy` (item 13a).
6. RETIRAR do pacote o bloco do `ReferenceHash` (`Verbs.cs:318`): abre como item proprio do "add references headless" (nao e pre-requisito).
7. `AGENTS.md` seccao 5: "'Matches cannot be set already' = dialogo de referencias/merge aberto, nunca restart"; PROVAS.md.

**Aceitacao:** vivo (SS4, Manage Dependencies aberto por humano): `merge_from_oml` devolve `success=false` em <1 s com `pending.kind=ManageDependencies`, o log NAO contem a excecao, nenhum restart; apos Apply no dialogo, o mesmo merge passa com TrueChange 0 erros.
**Esforco:** 4 h. **Risco:** enumerar presenters e ler `Match` tem de correr na UI thread (`InvokeAsync`), como o resto. **Deterministica:** sim (recusa com mensagem que ensina).

### 13a. Dialogos travam open_module 180 s: deteccao com nome

**Diagnostico: corrigido.** Os dialogos NAO sao nativos: sao `DialogWindow` (BaseWindow com webview React, `WebViewImplementation:41451`), alvos do CDP como o de recuperacao ja provado (`PROVAS.md`, `cdp_pages.py --click Discard`). `open_module` fica preso porque `HasOpenedActiveESpace` so volta a true no `finally` do comando Open (`Presenter:16582-16592`) e `CheckForIncompatibleOrMissingReferences(silent:false)` (`Presenter:14208`, `104824-104861`) mostra o message box de forma sincrona; a UI thread responde (log `windows 0 ms` durante o open). O laco de `OpenHandler.cs:44-61` nunca olha para janelas.

**O que fazer (deteccao; a prevencao e 13b):**
1. `OpenHandler.Open`, em cada volta do laco de 1,5 s: enumerar `agg.ModalStandaloneEditorPresenters` (`Presenter:61695`) do aggregator cujo `ActiveESpace.Name == name` e janelas Avalonia com `Owner != null`; se ha modal e o modulo nao esta ativo, devolver em <= 5 s `{opened:false, blockedBy:[{kind, id, title}], hint}`. Timeout so para download/carregamento sem dialogo.
2. `WindowsHandler.Windows`: por janela `isModal`, `contentKind:"web"` para `DialogWindow`; por aggregator `modalDialogs` (`{id, type, isManageDependencies}`), so API publica (sem reflexao no `DialogWindow.Id`).
3. `WindowsHandler.CloseDialog`: aceitar `id`; devolver `answer` lido de `MessageDefinition.GetMessage(id).CancelButton` (`RuntimeCommon:7775`, publico) quando e message box - nunca "Cancel" generico. Registar em PROVAS qual e o CancelButton de `AutoRecoverEspace` antes de permitir `close_dialog` no dialogo de recuperacao.
4. `src/Anvil.Core/Kernel/DialogPolicy.cs` (puro; `Anvil.Tests` nao referencia `Anvil.Bridge`) + `DialogPolicyTests`.
5. `studio_env.py`/`proof_merge.py` imprimem `blockedBy` e param; `cdp_pages.py --json`.
6. Corrigir `docs/tasks/2026-09-04-levantamento-llm-externa.md:19,39`: "dialogo web"; "invisivel ao CDP" -> "nao verificado".

**Aceitacao:** vivo: `open_module` com o message box de referencias aberto devolve `opened:false` + `blockedBy` em <= 5 s; segundo `open_module` com o primeiro pendente devolve `opening:true`, nunca `alreadyOpen`; `snapshot_module`/`merge_from_oml` nesse estado recusam. Registar se o `DialogWindow` das referencias aparece em `127.0.0.1:9226/json`.
**Esforco:** 5 h. **Risco:** reproduzir a condicao exige produtor republicado + restart + login. **Deterministica:** sim para a deteccao (nunca 180 s mudos).

### 15a / 06a / 16a. Detail do Verify, erros primeiro, `get` mostra expressoes

**Diagnostico: corrigido (os tres).** O Verify JA nomeia o identificador ("Can't identify 'Game' element in expression" vs "'Name'") e o parametro SQL desconhecido/nao usado no `Detail`; o produto descarta-o (`ModelHost.cs:120`). `ValidationDetails` corta em DFS sem ordenar: com 218 warnings os 2 erros ficam invisiveis mesmo em 60 (inspect de `base.084358.oml`: 222 msgs, `IsValid=false`). E `Verbs.Get` (`Verbs.cs:368-369`) testa `IObjectSignature` antes de `IExpression`, logo `get` mostra `@key.#MaxRecords` para toda expressao - hipotese plausivel para o "MaxRecords" do levantamento (sem rasto nos logs).

**O que fazer:**
1. `ModelHost.cs:117-121`: formato `{Type} {Id}: {Message} | {Detail} @ {Path}` quando `Detail` nao vazio nem igual a `Message` (try/catch como `Publisher.cs:349`); ordenar Error antes de Warning; erros nunca cortados (o `max` so corta warnings); hints do `ExpressionCheck` com orcamento proprio (nao morrem no teto).
2. `Verbs.cs:368-369`: testar `IExpression` antes de `IObjectSignature`.
3. `AGENTS.md:22-25` e :197 (formato novo; ordem erros -> warnings -> hints); `docs/diagnostics/verify-messages.md:148`; `worker_soak.py:67` continua a comparar frio vs quente do mesmo build (ordem deterministica nos dois).
4. Teste: `FunctionCatalogTests` continua com `StartsWith`/`Contains`; novo Fact: job negativo com 1 erro + N warnings -> linha `Error` e a primeira; `get` de `MaxRecords` devolve `50`.

**Aceitacao:** `run_job.py` sobre um job com `LoadGames.Games.Current.Game.Title` imprime `Error ExpressionUnknownObject: Invalid Expression | Can't identify 'Game' element in expression. @ ...`; sobre `@MaxPrice` sem parametro imprime `Unknown 'MaxPrice' parameter used in 'SearchProducts'`; `get` de um `ISQLNode` mostra `MaxRecords: 50`.
**Esforco:** 2 h. **Risco:** consumidores que fazem parse posicional (nenhum encontrado alem de prefixo). **Deterministica:** sim (informacao que estava a ser descartada).

### 09. Copias do mesmo job (v2..v7)

**Diagnostico: corrigido.** Nenhuma regra de nome existe (`GuideTests.cs:17-29`, `JobRunner.Run:8-15`); `run_job.py:49` grava por stem. Mas (a) `tests/jobs-cold` FOI rastreada nas rodadas 1-2 e promovida por rename (`git log`: c2d48d3, 521f870, e604ff5 -> 1bf080e, 1654bcb) - o `??` de hoje e trabalho nao commitado, nao desenho; (b) v1..v5 sao reexecucoes de um job que nunca aplicou (erros de conversao SQL repetidos, gap 06) e v6/v7 sao OUTRA tarefa (base e criterio diferentes, gap 04/07); (c) 12 das 13 sessoes frias iteraram no mesmo ficheiro com o mesmo runner: nao ha "laco que induz copias", ha ausencia de regra; (d) similaridade >90% da falso positivo (`osui-patterns`/`-mobile` = 0,93) e Jaccard 1,0 nao apanha nada.

**O que fazer:**
1. `JobRunner.CheckJobName(jobPath)` (puro): recusa stem com `-v\d+$|_v\d+$|\(\d+\)$` SO para caminhos sob `<RepoRoot>/tests/` (`RepoRoot` ja existe, `JobRunner.cs:85-90`); mensagem: `job 'x-v2' has a version suffix: edit the same file (git keeps versions) or name it by intent (e.g. x-inputs-consumed)`. Chamada em `Program.cs:526` (`ApplyCmd`, ANTES de `Host(args)` - senao paga ~2,5 s de arranque) e em `CollectOps` por parte.
2. `GuideTests.NoJobIsAVersionedCopy` sobre `tests/jobs*` reutilizando `CheckJobName` (sem regra de conteudo).
3. `OfflineTests`: aceita `tickets-01-data`, `rest-consume-get`, `osui-patterns-mobile`; recusa `x-v2`, `x (1)`; documenta o limite `rest-consume-api-v2` (recusado; escape: `api2`).
4. Mesmo commit: consolidar em DOIS jobs pela intencao (`virtual-game-store-all-sql` = v5, criterio 42; `virtual-game-store-inputs-consumed` = v7, base `job:store-business-input-fields`), apagar v2..v6, corrigir `PROVAS.md:8` e friction.md; commitar `tests/jobs-cold` como nas rodadas 1-2 (ADR `jobs-portateis`).
5. `AGENTS.md:12-14`: "um job = um ficheiro; tarefa diferente = nome pela intencao; nunca -vN"; `docs/tasks/2026-09-04-testar-com-outra-llm.md:20-21`.

**Aceitacao:** `run_job.py tests/jobs-cold/probe-v2.json` -> `ok=False` com a mensagem na 1a execucao (frio ~2,5 s = custo do Bind, sem tocar na base; worker <50 ms); GuideTests verde com a arvore consolidada; PROVAS.md:8 cita ficheiro existente.
**Esforco:** 3 h. **Risco:** depende de 02 para o job promovido correr (`job:` em jobs-cold via C#). **Deterministica:** sim.

### 02. Bases mutaveis em `.local` dentro de jobs

**Diagnostico: confirmado com alcance maior.** `JobRunner.Run` nunca le `job["base"]` (`:8-11`); `ApplyCmd` exige `--base` (`Program.cs:527`); resolucao de `base` reimplementada 4x com regras diferentes (`run_job.py:27-39` so `tests/jobs`; `JobTests.cs:46-59`; `worker_soak.py:42-48`; `ResolveProducer:101-133`). Contagens verificadas: 11 bases em `.local/jobs` em jobs-cold; producers em `.local` = `tests/jobs/consume-reference-screens.json:9` (teste OFICIAL que passa lendo um ficheiro das 09:38 que a suite nao produz), `tests/jobs-live/consume-headless-cs.json:7`, 2 em jobs-cold: 15 campos. Bug latente: `ResolveProducer:117` resolve o `base` do produtor com o `jobDir` do consumidor (ternario no-op). `%TEMP%\anvil-producers` (`:118-120`) e partilhado entre frio, worker e testes. `deliver` nao existe: a ligacao por nome `--producer Nome=oml` e a ponte.

**O que fazer:**
1. `JobRunner.ResolveBase(host, jobPath, bindings, log)`: `bindings[nome]` -> `job:` via `ResolveJobFile` (`:74-90`, ja faz "pasta do job depois tests/jobs") -> caminho cujo `GetFullPath` cai em `<root>/tests/fixtures` -> senao recusa: `base/producer '<spec>' points to an OML outside tests/fixtures (a file another run rewrites). Use job:<name>, a fixture, or bind a snapshot on the command: --base <oml> / --producer <Name>=<oml>`. `ResolveProducer` aplica a mesma funcao ao `producer` e ao `base` do produtor com `Path.GetDirectoryName(depPath)`; saida dos produtores em `<work>/producers/<nome>.oml` (nao `%TEMP%`; nao `Work/<nome>.oml`, colide com `JobTests.cs:35`).
2. `JobRunner.Run` sobrecarga com `basePath` null => `ResolveBase`; `--base` explicito continua livre (caminho do MANIFESTO P1: `proof_merge.py:55,61` passa o snapshot).
3. `Program.cs:525-527`: `--base` opcional; `--producer Nome=oml` repetivel reutilizando o parse de `UiGalleryCmd` (`Program.cs:462-465`). O worker herda (mesmo Dispatch).
4. `run_job.py`: apagar `resolve_base`; `anvil_cli.apply(base=None)`; aceitar `--producer`. `JobTests.cs:46-59`: apagar `ResolveBase`, usar a do C#. `worker_soak.py` mantem o cache por rodada (`--base` explicito).
5. Migrar os 15 campos: `consume-reference-screens.json:9` -> `job:producer-public`; `consume-headless-cs.json:7` e 2 jobs-cold -> `"producer": "Headless_CS"` (ligado por `--producer`); 11 bases jobs-cold -> `job:<irmao>`.
6. `GuideTests.NoJobPointsAtMutableOml` varre `tests/jobs*` (base e todos os `producer`, incluindo partes de compostos); teste offline da politica de caminhos.
7. `proof_merge.py`: `--producer Nome=caminho` repassado; `AGENTS.md:12-14,62`; ADR `jobs-portateis`; PROVAS.md.

**Aceitacao:** (a) offline: GuideTests/OfflineTests verdes, 0 ocorrencias fora de `{job:, tests/fixtures/, nome ligado}`; (b) com Studio, `.local/jobs` e `.local/test-work` RENOMEADAS (nao apagadas: ~100 MB de OMLs de depuracao do dono): `dotnet test` completo verde (hoje `consume-reference-screens` falharia); `run_job.py tests/jobs-cold/virtual-game-store-actions.json` corre sem `--base`; (c) vivo: `proof_merge.py --module Headless_UI --job tests/jobs-live/consume-headless-cs.json --producer Headless_CS=<snapshot absoluto>` com TrueChange 0; sem `--producer` -> erro "producer Headless_CS not bound".
**Esforco:** 12 h (prova (c) separavel). **Risco:** cadeias `job:` reaplicadas por job alongam a suite (medir; soak mantem cache). **Deterministica:** sim.

### 01a. Worker residente: o que fecha barato

**Diagnostico: corrigido.** Raizes de memoria fechadas (`Publisher.cs:156` ClearHistory; `ModelHost.Release`; `JobRunner.cs:44-50`; soak 10 rodadas identicas). Mas: (a) `FunctionCatalogTests.FiveRunsOfTheSameJobGiveTheSameModule` (`:59-74`) JA repete 5x e compara assinatura - falta so `released`, `LoadedModules` e heap; (b) build com worker de pe FALHA por ficheiro bloqueado (verifiquei), logo nao ha "stale silencioso" a detetar; (c) `_served++` (`Program.cs:214`) conta pings; (d) xunit paraleliza classes (sem `xunit.runner.json`, sem `[Collection]`); (e) o cliente e nao determinista entre esperar na fila TCP (ate 900 s) e cair para frio (`anvil_cli.py:37,46-56`), e os pings abandonados viram "client gone" no worker (188 no log).

**O que fazer (onda 1):**
1. `scripts/build.py` = `anvil_worker.py stop` -> `dotnet build src/Anvil.Cli -c Release -o .local/cli` -> `start`; `AGENTS.md:17-20` cita SO esse comando; `GuideTests` recusa `anvil_worker.py restart` e `dotnet build src/Anvil.Cli` solto no guia.
2. `tests/Anvil.Tests/xunit.runner.json` `{"parallelizeTestCollections": false}` (+ `CopyToOutputDirectory`); medir a suite (2m35s hoje).
3. Estender `FiveRunsOfTheSameJobGiveTheSameModule`: `released` com `undoHistory==1, aggregator>=1, close==1, locks>=1`; delta de `ModelHost.LoadedModules().Count` == 0 por run; heap apos GC completo (ultimo - primeiro) < 16 MB; excluir `Validation.Sample` e `TopObjectTypes` da assinatura se se acrescentar `aggregate-full`.
4. `Program.cs` ping: `commands` separado de `served` (pings nao contam).

**Aceitacao:** suite verde com o teste estendido (< 10 s); `python scripts/build.py` com worker de pe termina com pid novo `via worker` no comando seguinte.
**Esforco:** 4 h. **Risco:** serializar colecoes alonga a suite (medir). **Deterministica:** sim para o build.

---

## Onda 2: checagens e contratos (75 h)

### 03. `maxNewMessages` mascara warnings

**Diagnostico: confirmado.** Juiz inteiro (`JobTests.cs:34,40-42`); `details` so strings (`ModelHost.cs:113-127`); 17 jobs com teto > 0 em `tests/jobs`, 7 (nao 6) com 42 em jobs-cold; `expectValid` nunca lido. Regra dura "Unused* em criado = falha" partiria 16/17 jobs legitimos (inputs de handlers de eventos, `AGENTS.md:187`). Correcoes adotadas: identidade = a do Studio (`MessageId + ObjectIdentifier.GetObjectKey() + PropertyNames + MessageParameters`) lida do `espace.Verify()` que `Describe` ja consome (uma leitura por fase, sem multiconjunto); `Message` da V1 e o titulo generico; cortar `_created`/`createdByJob` da 1a entrega; compostos nao herdam `expectedMessages` das partes. Decisao do dono na implementacao: as partes MANTEM suas listas para testes isolados; o composto usa exclusivamente a propria lista.

**O que fazer:**
1. `Kernel/Messages.cs`: `record MessageInfo(Id, Type, Key, Path, Detail)` e `MessageDelta.Compute(before, after)` -> `{New, Fixed, Preexisting}` (puro).
2. `ModelHost.Messages(espace)`: projecao do `espace.Verify()` (no adaptador, ADR-004); `Describe` e `ValidationDetails` derivam da mesma lista.
3. `Kernel/MessageExpectations.cs`: `Parse(job["expectedMessages"])` valida `{id, element, why}` (id existe em `catalog/verify-messages-*.json`; `why` obrigatorio; `element` = sufixo do `PathOf` com >= 2 niveis; empate = falha com candidatos); recusa `maxNewMessages` com "campo removido: use expectedMessages [{id, element, why}]".
4. `JobRunner.Run`: `before` apos Load, `after` apos Apply; devolve `validation: {new, fixed, preexisting, unexpected, missingExpected}`; `details` = novas primeiro; salva o OML mesmo com `unexpected` (politica e do chamador); valida o esquema das partes, mas nao herda suas expectativas (decisao do dono; substitui a recusa originalmente prevista).
5. `JobTests.cs:34,40-42` -> `Assert.Empty(unexpected)` e `Assert.Empty(missingExpected)`; `run_job.py` exit 1 com as frases; `proof_merge.py` gate antes do merge.
6. Migrar 17 jobs (9 a mao com ids/caminhos do run frio; tickets-01..08 por `gen_tickets.py:43,844` sem modo `--record`; `UiGallery.cs:146` gera do Verify do bloco); os 7 jobs-cold com 42: `why` honesto ("inputs nao consumidos pela logic spec") e `PROVAS.md:7-10` corrigido no mesmo commit.
7. `tests/jobs-negative/undeclared-warning.json` e `stale-expected.json` + `MessageExpectationTests`; teste de delta sobre `mobile-ui.oml` (6 pre-existentes, job vazio -> new=0).
8. `AGENTS.md:11,25,187-188`; ADR `mensagens-do-verify` (decide tambem `messages`/`diff` do ADR-003).

**Aceitacao:** `grep maxNewMessages tests/ scripts/` = 0; suite verde; `undeclared-warning.json` -> `unexpected` com `UnusedUserAction` e frase "corrija ou declare em expectedMessages com why"; `stale-expected.json` -> `missingExpected`=1; job com `maxNewMessages` falha antes de tocar no modelo.
**Esforco:** 12 h (duas entregas: mecanismo + 17 jobs; depois jobs-cold). **Risco:** `element` por sufixo ambiguo com Labels sem Name. **Deterministica:** sim.

### 16b. TrueChange em delta

**Diagnostico: confirmado, com achado novo.** `get_errors` devolve o modulo inteiro cortado (`Reads.cs:41-55`); JobTests julga por contagem. Chaves sobrevivem ao merge por defeito (`Match.CreateObject` reusa `key.Duplicate()`, `Framework:27686-27688`; provado nos logs :736-746). Verifiquei o achado do cetico: `base.084203` = 0 msgs/11.816 objetos; `foreign.084203` = 212 warnings, valido, 25.516 objetos; snapshot pos-merge `base.084358` = 222 msgs, `IsValid=false`, 25.460 objetos. O merge introduziu 2 erros + 10 warnings e perdeu 56 objetos face ao foreign (item 17).

**O que fazer:** (a) delta antes/depois DENTRO de `MergeHandler.Run` em torno do `CompareAndMerge` (`:102`), devolvendo `new/fixed/preexisting` com a identidade de 03 - e o caminho principal, porque foi o merge que introduziu erros; (b) `JobRunner` ja tem antes/depois por 03; (c) `proof_merge.py:83-86` le `merge['new']`, exit != 0 com `newErrors > 0`; (d) sem `.messages.json` nem parametro `base` em `get_errors` ate haver caso (P3); (e) Fact dedicado com a fixture real `tickets-02-helpers` (apaga 2 `UnusedElement`, cria 7: contagem 5, identidade 7/2).
**Aceitacao:** `proof_merge.py --module Headless_UI --job tests/jobs-cold/virtual-game-store-ui-home-catalog-detail.json` imprime `novas=0 corrigidas=0 pre-existentes=218`; um job com 1 `UnusedElement` novo imprime exatamente essa linha apesar das 218.
**Esforco:** 6 h (+ rebuild/restart/login da bridge). **Risco:** rename no mesmo job aparece como corrigida+nova. **Deterministica:** sim.

### 17 (novo). Fidelidade do merge

Investigar antes de fechar 07: por que o merge automatico de `foreign.084203` (valido, 212 warnings) deixou o Studio com 2 erros, 10 warnings a mais e 56 objetos a menos. Passos: diff headless `foreign.084203` vs `base.084358` (`find`/`dump` por tipo), ler o `.matchtree.txt` de 08:42 (2,1 MB), reproduzir no lab com o mesmo par. Saida: nota em `docs/mapa/` e item proprio. **Esforco:** 4 h. O delta de 16b apanha isto de imediato em qualquer entrega futura.

### 04. Inputs declarados e nao usados (spec `logic`)

**Diagnostico: confirmado com correcao.** `LogicExpander.Expand:48-62` nao valida uso; o Studio marca `UnusedElement` (Warning) em input/var/output (`Framework:444380, 444761, 461427`); 42/42 paridade no corpus frio. Correcao dos ceticos que adoto: `max`, `start` e `sort[0]` sao `IExpression` (ISQLNode.MaxRecords, IAggregate.StartIndex, ISort.Attribute) e o expander ja os escreve como texto (`LogicExpander.cs:184,187-188,210-211`); um input usado so ai e legitimo e o scan proposto o recusaria. Decisao entre "scan na compilacao" e "promover UnusedElement no JobRunner": fico com o scan na compilacao (erro antes de tocar no modelo, mensagem com o nome) PORQUE o item 03 e a rede: se o scan disser "usado" e o Verify discordar, o `UnusedElement` vira mensagem nova nao declarada e o job falha na mesma. A uniao e fail-closed.

**O que fazer:** `ActionCompiler` guarda inputs/outputs/vars e acumula os textos de `where[]`, `sort[]`, `max`, `start`, `params.*.value`, `assign` (chave e valor), `args` (valores), `record/id`, `if`, `foreach`, `message`; `CheckUnused()` branqueia strings (regex do `ExpressionCheck.cs:15-16`), casa `(?<![\w.])Nome(?![\w])` OrdinalIgnoreCase (resolucao do Studio e case-insensitive, `Framework:18448`); nao conta identificador igual ao nome da entidade-fonte/alias do mesmo `get` (sombreamento). Mensagem: `logic: action Game_Search: inputs declared and never used: GenreId, PlatformId, Page, PageSize (vars: ...; outputs never assigned: ...). Use them in where/sort/max/start/if/assign/args/record/id/message/foreach/params.value or remove them`. Testes offline em `LogicSpecTests` (input so em `max`, so em `start`, so em `sort`, dentro de string, nunca usado) + teste com juiz Verify gated por `StudioAvailable` (spec-fixture sobre `blank-service.oml`, flag interna para desligar o scan, conjunto recusado == conjunto de `UnusedElement` do Verify) + `tests/jobs-negative/logic-unused-input.json`; `AGENTS.md` 2.1 e 4. Sem escape `unused:true` ate decisao do dono.
**Aceitacao:** spec da sonda lanca com `B` e `V` e sem `A`/`Ok`; specs com input so em max/start/sort passam; `logic-spec-services.json` continua a expandir; paridade com o Verify verde.
**Esforco:** 6 h. **Risco:** campo novo na spec sem entrar na lista (mitigado por 03). **Deterministica:** sim.

### 06b. SQL: parametros, `where/sort/start` com sql, `X = X`, erro do `set`

**Diagnostico: 1/3 certo, corrigido.** `ISQLNode.MaxRecords` existe e funciona; `StartIndex` nao existe em `ISQLNode` e o expander emite-o (`LogicExpander.cs:211`); `@X` sem parametro e Error com Detail (06a resolve o nome); `X = X` e silencioso (sem id no catalogo). Correcoes adotadas: NAO saltar `@@` (regex do Studio e `\@\w+`, `Framework:21517`; `@@ROWCOUNT` e erro no Verify); limpar comentarios `--`/`/* */` e literais com `''`; rejeitar tambem `where`/`sort` com `sql:true` (hoje ignorados em silencio, `:192-213`); teste do v6 offline (o `Apply` muta op a op, `Verbs.cs:44-63`, nao ha "antes de tocar" num job por verbos).

**O que fazer:** `LogicExpander.SqlGet`: extrair `@\w+` do statement limpo, exigir igualdade OrdinalIgnoreCase com as chaves de `params` (erro lista os dois lados); rejeitar `where`, `sort`, `start` com `sql:true` ("pagine/filtre/ordene no statement"). `LogicExpander.Assign`: rejeitar `Trim(key)==Trim(value)`. `Verbs.Set:193`: mensagem com os tres caminhos aceites (gravaveis + so-leitura `IExpression` + `Set<X>`), 4 parecidas por distancia propria (nao `FunctionCatalog.Closest`: a pool inclui built-ins, `FunctionCatalog.cs:99-100`) e `see anvil api --name IDropdown`; mesmo padrao em `Link:228`. Facts offline em `LogicSpecTests` (6 casos do tokenizador + `SqlWhereOrSortIsRejected` + `SelfAssignIsRejected` com o step `LoadSqlRecord1` extraido do v6) + 1 job negativo com Studio (`sql-unknown-param.json`) para o Detail; `AGENTS.md` 2.1 passa a documentar a forma SQL do `get` (chaves `sql`, `statement`, `params {type,value}`, `max`).
**Aceitacao:** os Facts; `sql-input-output.json` continua com 1 mensagem e 0 hints; o step do v6 lanca "does nothing".
**Esforco:** 6 h. **Risco:** SQL "Unrecognized" muda a leitura do Studio (por isso o scan e so de compilacao da spec, nunca hint sobre verbos). **Deterministica:** sim na spec.

### 05. Jobs monoliticos e correcao de uma action

**Diagnostico: refutado na causa, mantido no mecanismo.** v2..v5 = reexecucoes falhadas (gap 06), v6/v7 = segunda tarefa (04/07); o monolito de 68 actions nasceu na criacao (14:23) porque o guia mostra N actions num op e nada diz sobre dividir. Regras escondidas provadas pelos ceticos e confirmadas no codigo: (a) um op `logic` nao pode chamar irma do mesmo op (`tryRef` resolve contra o modelo ANTES de aplicar, `Verbs.cs:104-110`); (b) `logic`/`create` com nome existente e renomeado em silencio (`NameClash`, `Framework:54834`, ja usado por `Rename` em `Verbs.cs:706`); (c) delete+create do mesmo nome religa consumidores no mesmo comando (`Framework:53230` -> `229528-229536`, `PreviousActionValue`). Logo NAO ha cirurgia in-place.

**O que fazer:**
1. `Verbs.Logic`/`Verbs.Create`: pre-check de nome existente por `Resolve("IServerAction|IServiceAction|IClientAction:X")` ANTES de mutar; sem `replace` -> erro `action 'X' already exists in this module; to rewrite its body keeping consumers use "replace": true; otherwise pick another name`.
2. `replace:true` (chave nova em `ActionKeys`, `LogicExpander.cs:29`): guardar `Consumers(target)` (`Verbs.cs:641-651`), `target.Delete()`, aplicar os MESMOS ops do expander (puro, `SameSpecSameOps` intacto), verificar que `Consumers` da action nova contem as mesmas chaves (senao lancar: a transacao aborta); devolver `replaced:true, healedConsumers:n`.
3. `LogicExpander`: o `tryRef` passado por `Verbs.Logic` reconhece nomes declarados na MESMA spec; o expander ordena as actions por dependencia (topologica; ciclo = erro com o ciclo). Isto torna a divisao por camada desnecessaria e deterministica, e substitui o "hint N=12" (sem evidencia).
4. `tests/jobs/logic-spec-replace.json` (base `job:logic-spec-services`; alvo com consumidor real, ex. `Ticket_Get` <- `Tickets_Get`; `usages` antes/depois com a MESMA chave do `IExecuteServerActionNode`) e `tests/jobs-negative/logic-duplicate-action.json`; teste offline "replace nao muda os ops".
5. Regra de nome: a de 09 (regex ancorada; nunca `\d` solto, `tickets-01..08` sao legitimos).
6. `AGENTS.md` 1 ("Refatorar"): corrigir "brokenConsumers 0 = seguro" para "consumidores religam por nome se a action renascer com o mesmo nome no MESMO job; `replace:true` faz e verifica"; 2.1: uma spec pode chamar actions da mesma spec (o expander ordena). ADR `compiladores-de-acucar`.
7. Prova viva: `proof_merge.py` de `logic-spec-replace` num modulo do lab onde a action ja tem consumidores; TrueChange 0; `usages` igual.

**Aceitacao:** suite verde com os 2 jobs; `logic` sem `replace` sobre nome existente falha antes de mutar; prova viva registada.
**Esforco:** 9 h. **Risco:** merge de 3 vias com a action recriada (chave nova) - `game-set-publishers-sql` ja mergeou assim com TrueChange 0, mas com `brokenConsumers=0`; a prova viva e o criterio. **Deterministica:** sim.

### 15b. Contratos nao ditos: `Hint Current`, erro do `reference`

**Diagnostico: confirmado nos factos, corrigido no remedio.** (a) fecha em 15a (Detail); (b) fecha em 06b (erro do `set` lista propriedades: `IDropdown` tem `EmptyValue`, nao `Prompt`); (c) `reference` de static nao Public falha sem receita (`Verbs.cs:314`) e a FK traz so o tipo `X Identifier`.

**O que fazer:** (1) `Hint Current` (novo em `ExpressionCheck`): para cada `ExpressionUnknownObject` cujo Detail nomeia `'X'` e cujo texto contem `<A>.<B>.Current.X` ou `<A>.List.Current.X`, resolver `A` no dono (IDataAction/IScreenAggregate/IAggregateNode/variavel) pela API publica (`IParameter.DataType` ou `IAggregate.Type` -> `Types.IListType.ElementType` -> `IRecordType.Attributes`) e imprimir `Hint Current: 'LoadGames.Games' is Game List; Current has: Id, Title, Price... (the '.Game.' wrapper only exists in aggregates)` / `'GetUsers' is an aggregate; Current has: User` - cobre data action, aggregate com e sem group by e structures sem regex de nomes; nunca bloqueia; orcamento proprio (06a). (2) `Verbs.Reference:314`: mensagem com receita (`"public": true` na spec ou `set $Status Public true`, re-snapshot, `IStaticEntity:Status` em `elements`; ou comparar dentro de uma server action publica do produtor); campo `implicit` opcional (nenhum consumidor le `referenceElements`). (3) Jobs: negativos `dropdown-prompt` (Assert.Throws), `dataaction-list-scope`, `aggregate-list-scope`, `reference-static-not-public` (+ produtor); positivos `data-action-entity-list-reactive` e `consume-reference-static` (produtor tambem citado no AGENTS.md). (4) `AGENTS.md:54,55,62,114,165,200`; `docs/architecture/2026-09-04-modelo-de-verbos.md:25`. Sem aceite sobre o job frio (depende de `.local/producers`, recusado por 02).
**Aceitacao:** os 4 negativos com os textos; os 2 positivos verdes; GuideTests verde.
**Esforco:** 4 h. **Risco:** `ElementType` nao expor o record por interface publica em algum tipo (registar e cair para so o Detail). **Deterministica:** sim (mensagens), o hint e complemento.

### 13b. Prevenir o dialogo de referencias no `open_module`

**Diagnostico: corrigido.** `Presenter:20047` (`aggregatorFor.ServerSilentMode = wk.ServerSilentMode`) esta em `prs#itxraaxj`, caminho de abrir OML, NAO no de `OpenESpace(name)` (`Presenter:113039` -> `DownloadAndOpen.ExecuteCreatingNewAggregatorAsync` -> `GetAggregatorFor`, sem copia). O check le a flag do AGGREGATOR novo (`Presenter:104824`). Logo a flag no `ServerPagePresenter` nao previne nada. `OpenESpace` devolve o `IAggregatorPresenter` de forma sincrona (`:113039-113090`, verifiquei).

**O que fazer:** `OpenHandler.cs:38`: `var agg = page.OpenESpace(...)`; no mesmo `InvokeAsync`, `agg.ServerSilentMode = true` e `agg.ExecuteInContext(() => agg.ResetServerSilentMode(), executeSynchronously:false, executeWhenTopLevelIsIdle:true)` (fila do aggregator ja tem o open). Provar ao vivo a ordem FIFO; se nao for garantida, usar a forma do proprio Studio (`GetAggregatorFor` -> flag -> `ExecuteInContext { try DownloadAndOpen.ExecuteSync(ref agg,...) finally Reset }`, `Presenter:188415-188424`, tudo publico). Nunca deixar a flag ligada (salta check de conflito de versao no publish, `Presenter:104978`): assert vivo `agg.ServerSilentMode == false` apos open e apos timeout forcado. Sinal `referencesOutdated` por `ReferencesManager.HasIncompatibleReferences(agg, es, silent:true, false, out cancelled)` (`Presenter:227722`, cria e dispoe o seu manager no finally) chamado em `agg.ExecuteInContext(executeSynchronously:true)` com timeout, nunca na UI thread; `referencesCheck:"skipped"` se nao concluir. `scripts/proof_open_dialogs.py` reproduz a condicao (publicar alteracao publica no `Headless_CS`, restart, login).
**Aceitacao:** `open_module Headless_UI` com referencias desatualizadas devolve em < 20 s `{opened:true, referencesOutdated:true}`, `windows` sem `DialogWindow`, flag a false depois; com `silent:false` devolve `blockedBy` em <= 5 s.
**Esforco:** 6 h. **Risco:** ordem da fila nao provada; janela de corrida entre flag e check. **Deterministica:** sim se a prova FIFO passar; senao a variante `ExecuteSync` e.

### 01b. Worker: fila, auto-arranque, reciclagem

**O que fazer:** `Program.Serve` (`:176-221`): thread de accept + `BlockingCollection` consumida por UMA thread de trabalho; a thread de accept responde `ping` sempre com `{busy, currentCommand, runningMs, queued}`; `busy` vira facto e "pendurado" = ping sem resposta com listener vivo. `anvil_cli.py`: busy -> liga e espera (envelope traz `queuedMs`); ping sem resposta em 3 s -> matar pid do ultimo ping e re-arrancar; ECONNREFUSED -> auto-start com lock `.local/worker-<porta>.lock` (O_EXCL) e re-ping se o filho morrer (porta em uso pelo outro cliente = sucesso); `ANVIL_WORKER=0` unico opt-out; sem Studio 4516 na maquina, cair para frio com a MESMA mensagem do frio. Reciclagem por `ANVIL_WORKER_MAX_COMMANDS` (omissao 5000, comandos nao-ping) + heap > 2 GB em dois pedidos consecutivos; log com rotacao por pid. ADR `worker-residente` declara que o worker serve o mesmo Dispatch (incluindo comandos de servidor com `--credentials` por ficheiro; nada em log, P6). `worker_soak.py --rounds 2 --filter service-action` como fecho.
**Aceitacao:** dois clientes em simultaneo terminam ambos `via worker`; `ANVIL_WORKER_MAX_COMMANDS=5` numa porta de teste recicla no 6o comando e o 7o corre em pid novo; 0 "client gone" novos no log; linha em PROVAS.
**Esforco:** 8 h. **Risco:** auto-start em maquina sem Studio pendurar 60 s (tratado). **Deterministica:** sim (estado observavel, sem queda silenciosa).

### 07. Entrega unica: enforcement na bridge + `deliver` fino

**Diagnostico: corrigido.** `proof_merge.py` ja usa base = snapshot (`:55,61`); nao ha verbo `deliver` nem cliente TCP no CLI; a bridge nao compara Key (`MergeHandler.cs:40-41`, `CompareAndMerge` so `ESpaceType`). Correcao importante: Apply e merge JA sao atomicos em memoria - `Command.SafeExecute` faz `UndoManager.RollbackCommand` em QUALQUER excecao de comando nao read-only (`Framework:839553-839561`, `11664-11698`; verifiquei). Buracos reais: `producer` livre (02 fecha), `merge_from_oml` aceita qualquer base, delta ausente (16b), `proof_merge` recusa em vez de ativar a aba quando ha 2 modulos abertos (`open_module` ativa, `OpenHandler.cs:25-29`).

**O que fazer:** (1) Bridge: `snapshot_module` devolve `snapshot_id` e regista em memoria da sessao `{key, sha256, mensagens do Verify}`; `merge_from_oml` recusa `base_path` cujos bytes nao sejam um snapshot registado do modulo LOCAL (`base X is not a snapshot of this module taken in this session: use snapshot_module`), com `allow_foreign_base` so para o merge inverso de `proof_cycles.py`; recusa `foreign.Key != local.Key` apos `ESpace.Load` (:66-74) depois de provar no lab que um foreign de outro modulo mescla mesmo (senao e so mensagem melhor); `get_errors since=<snapshot_id>` devolve o delta (usa 16b). (2) CLI: `src/Anvil.Core/Adapters.SS11/BridgeClient.cs` (~60 linhas, JSON-lines, sem credenciais) e `Delivery.Run` em `Anvil.Core/Delivery` (nao em Kernel, ADR-004): `open_module` -> checar ativo -> `snapshot(id)` -> `JobRunner.Run(snapshot, job, foreign)` (recusa merge se `!isValid` ou `unexpected`) -> `merge_from_oml(auto, base=snapshot)` UMA vez (sem preview) -> `get_errors since` -> `find`; exit 0 so com `merged` e `newErrors==0`; sem `--base`, sem `--publish`; reconhece "Matches cannot be set already" e "blockedBy" e para. (3) Comando `deliver` no Dispatch (worker herda); `proof_merge.py` vira `anvil deliver` (apagar depois). (4) `DeliverTests` com bridge FALSA (TcpListener efemero) para 6 casos. (5) ADR `entrega-e-enforcement-na-bridge`; PROVAS.

**Aceitacao:** offline: DeliverTests; vivo (Headless_CS, porque Headless_UI depende de 12 estar fechado): `anvil deliver --module Headless_CS --job tests/jobs/tickets-all.json` -> `merged=true, newErrors=0`, 1 unica linha `merge_from_oml` no log, Ctrl+Z desfaz; `merge_from_oml` a mao com base de outro snapshot -> recusa.
**Esforco:** 14 h (+ rebuild/restart/login). **Risco:** um worker residente a falar com outra bridge residente; soak com `deliver`. **Deterministica:** sim (base diferente do snapshot deixa de existir na bridge, mesmo chamada a mao).

---

## Onda 3: spec de telas por arquetipo (40 h)

### 10. Telas cruas sem blocos do OutSystems UI

**Diagnostico: confirmado no essencial, corrigido no desenho.** O guia so diz COMO instanciar (`AGENTS.md:178-193`) e a tabela aponta jobs crus (:62-64); o job frio tem 343 ops e 0 `source`. As pecas existem (`UiCatalog`, `UiGallery.Instance/BindInput/AutoConfig`). Correcoes que adoto: o contrato do bloco vem da assinatura referenciada no proprio modulo - `IBlockSignature` expoe `InputParameters`, `Events`, `Widgets` (verifiquei com `anvil api --name IBlockSignature`), com `IPlaceholderWidgetSignature.Widgets` = defaults; cai o catalogo por caminho, o `UiCatalog.Locate`, a alteracao do JobRunner, o risco de versao errada e o conflito com P6 (o JSON fica para docs/galeria; tem 54 KB de CSS por bloco, 0 JS inline). `<Agg>.Count` e valido no escopo da tela (sonda do cetico). Sem prova visual no v0 (sem `CssClasses`, sem URL de runtime).

**O que fazer:** `Kernel/ScreenExpander.cs` puro: `Expand(data, tryRef, contract, runtime)` com esquema fechado (`screens[]: name, kind cards|table|detail|form|dashboard, title, inputs, source {entity|action}, search, filters, card, columns, tabs, fields, actions`); passada A cria todas as telas + layout + inputs (fecha a ordem do item 14 por construcao), passada B conteudo; formas por kind sobre `Block(name, inputs, placeholders)` e `Handler(event, steps)`; paginacao fixa: vars `StartIndex/MaxRecords`, `TotalCount = <Agg>.Count`, handler `OnNavigate` = Assign + `IRefreshDataNode` + layout; Gallery/Carousel ligam o `IList` que ja trazem; caminho de leitura por tipo de fonte (aggregate `<As>.List.Current.<Ent>.<Attr>`; data action `<As>.<Out>.Current.<Attr>`, fecha 15); checagens pre-Verify (input de tela nao usado = erro; evento obrigatorio sempre com handler; `filters.from` static existente). `Verbs.cs:69-79`: `"screen" => Screen(op)` com `contract` = `Resolve("IMobileBlock:X")` (fallback `*Signature`, `:407-408`) lido por `IBlockSignature`. 6 jobs de ouro (`screen-spec-{cards,table,detail-tabs,form,dashboard}-reactive.json`, `screen-spec-cards-mobile.json`) com dados por `spec` no proprio job sobre fixtures (P7); negativo `screen-unknown-kind.json`; `ScreenSpecTests` (contract fake como `tryRef` fake em `LogicSpecTests.cs:62`); `AGENTS.md` 3.4 + tabela; ADR `compiladores-de-acucar` antes de somar o terceiro compilador (P3); PROVAS por arquetipo.
**Aceitacao:** offline: suite verde com os 6 jobs (isValid, 0 mensagens novas) e `find` devolvendo `IMobileBlockInstanceWidget` com `SourceBlock` CardSectioned/Pagination/Search/Tabs/Rating; vivo: `anvil deliver --module Headless_UI --job tests/jobs/screen-spec-cards-reactive.json --checks Catalog,GetGames,Pagination1,CardSectioned1` com TrueChange 0; frio: LLM externa refaz Home/Catalog/GameDetail so com 3.4 em <= 2 execucoes e 0 `IList` crus.
**Esforco:** 40 h. **Risco:** crescimento do esquema ("um verbo por coisa"); Traditional fora do v0. **Deterministica:** sim (esquema fechado; mesma spec = mesmos ops).

---

## Onda 4: superficie por comandos (12 h)

### 08. `recipe`, `where-can`, `verify-message`, `explain`

**Diagnostico: corrigido.** Nenhum comando existe (`Program.cs:128-170`). Mas: `hintOrigin` = 299 "frase do texto da mensagem", 112 curada, 57 quick-fix (verifiquei; `UnusedElement` e quick-fix) - 299 hints repetem o Detail que 15a ja imprime; o mapa esta desatualizado por CONTEUDO (2092 probes vs 2147 Creatables, verifiquei) e o campo `catalog` aponta o mesmo nome de ficheiro; `explain` nao reduz leituras (a instrucao e "leia AGENTS.md inteiro"); a maioria das 18 leituras da sessao de telas (jobs de exemplo, bridge C#) nao e coberta por nenhum comando - fecha com 10 e com regra de sessao.

**Decisao do dono que bloqueia esta onda:** os comandos leem o DLL instalado em runtime (como `FunctionCatalog.Extract`) ou servem um JSON estatico com texto da OutSystems no repo (P6)? Proposta: runtime local.

**O que fazer:** (1) `verify-message --name|--find`: ids dos campos `public static` de `VerifyMessageId` e textos do recurso embebido via `ResourceManager(VerifyMessageId.ResourcesBaseName, assembly)` (API .NET publica); repo guarda so `catalog/verify-hints-<ver>.json` com os 112 curados + 57 quick-fix; teste "todo id do ficheiro existe no Studio e vice-versa" (molde `FunctionCatalogTests:19-37`); hint inline em `ValidationDetails` so para esses 169. (2) `where-can --name <Tipo>` sobre `docs/mapa/criar-*.json` DEPOIS de regenerar (`anvil prove` x4; `ProofGenerator.cs:125` grava `catalogCreatables` + hash; teste de frescura por contagem); "no-parent" = "pai nao alcancavel ate profundidade 4 neste fixture", pais possiveis por `Creatables`; "Library: sem fixture, sem prova". (3) `recipe --find` como ponteiro (row da tabela + caminho + description + contagem de ops; `--ops` exige `--max`); preencher as 5 descriptions vazias. (4) `api --op logic|spec|screen`: esquema gerado das listas fechadas (`LogicExpander.cs:29-40`). Sem `explain`. `AGENTS.md` 1, 4, 6 ("se precisou de abrir src/ e bug da superficie"). ADR `superficie-por-comandos`.
**Aceitacao:** `SurfaceTests` offline; `verify-message --name RequiredConnector_Out` -> Error + hint; `where-can --name IServiceAction` -> not-allowed nos 3 UI; mapa com `rows == Creatables`; rodada fria com contagem de ficheiros por causa (reativa vs preventiva).
**Esforco:** 12 h. **Risco:** promover prosa a artefacto consultado (P4/P10) - mitigado pelo recipe apontar sempre para job testado. **Deterministica:** parcial (fecha as leituras reativas; as preventivas so com politica de sessao).

---

## Certezas e incertezas (item a item)

| # | Provado no codigo/descompilado (por mim) | Ainda hipotese |
|---|---|---|
| 01 | `FiveRuns` existe (`FunctionCatalogTests.cs:59-74`); `_served++` conta pings (`Program.cs:214`); DLLs bloqueados com worker vivo (pid 52176); sem `xunit.runner.json`/`[Collection]` | Custo da suite serializada; ordem FIFO de dois clientes na fila nova |
| 02 | 11 bases `.local/jobs` em jobs-cold; `consume-reference-screens.json:9`; `ResolveProducer:117` no-op; `%TEMP%` partilhado; `Run` nunca le `base` | Aumento de tempo da suite com cadeias `job:` |
| 03 | Juiz inteiro (`JobTests.cs:34,42`); `Describe` ja itera `espace.Verify()`; `Detail` na V1; 7 jobs-cold com 42; 17 com teto | `PropertyNames`/`MessageParameters` estaveis entre load do snapshot e modulo vivo (chave textual) |
| 04 | `max/start/sort` viram texto de `IExpression` (`LogicExpander.cs:184-188,210-211`); regras do Studio em `Framework:444380/444761/461427` | Sombreamento entidade/input raro; escape `unused:true` (decisao) |
| 05 | `tryRef` resolve contra o modelo antes de aplicar (`Verbs.cs:104-110`); `NameClash` (`Framework:54834`, `Verbs.cs:706`); `ReplaceReferences`/`PreviousActionValue` (`Framework:53230, 229528-229536, 228717`) | Merge de 3 vias com action recriada e consumidores (prova viva) |
| 06 | `ISQLNode` sem `StartIndex`; `parameterRegex = \@\w+` (`Framework:21517`); `Get` testa `IObjectSignature` antes de `IExpression` (`Verbs.cs:368-369`) | Origem do "MaxRecords" do levantamento (sem rasto nos logs) |
| 07 | `SafeExecute` faz rollback em qualquer excecao (`Framework:839553-839561`); `proof_merge.py:55,61` usa snapshot como base; sem `deliver`/TcpClient no CLI | Foreign de outro modulo realmente mescla (a provar antes de `expect_key`) |
| 08 | `hintOrigin` 299/112/57; Creatables 2147 vs probes 2092; `CssClasses` vazios | Leitura dos recursos por `ResourceManager` na versao instalada (nome do recurso) |
| 09 | jobs-cold rastreada nas rodadas 1-2 e promovida por rename (`git log`); nenhum job atual casa com a regex | Nenhuma |
| 10 | `IBlockSignature` expoe `Events/InputParameters/Widgets`; catalogo sem `CssClasses` | `<Agg>.Count` em `IScreenAggregate` (sonda do cetico, a fixar no 1o job de ouro) |
| 11 | `GetFullPath` no processo do Studio (`MergeHandler.cs:27`); `-WorkingDirectory` (`open_ss4.ps1:66`); `proof_merge.py:45` nao resolve `--login` | Nenhuma |
| 12 | `AddRoot` exige match null (`Framework:28845`); ctor de `ReferencesManager` sem init (`Presenter:226256-226264`); `HasIncompatible` nao le hash local (`Presenter:227681-227719`); log :793 open preso 180 s | Elemento exato que disparou o dialogo (CompatibilitySignatureHash) |
| 13 | `Presenter:20047` e do caminho OML; `OpenESpace` devolve aggregator sincrono (`:113039`); check le flag do aggregator (`:104824`) | Ordem FIFO de `ExecuteInContext`; visibilidade CDP do `DialogWindow` de referencias |
| 14 | `ErrorEnvelope` desce a raiz (`Program.cs:52-53`); `Resolve` (`Verbs.cs:401-415`); fail-fast (`Verbs.cs:55-56`) | Nenhuma |
| 15 | `ValidationDetails` imprime so `Message` (`ModelHost.cs:120`); `IValidationMessage.Detail`; `IDropdown` sem `Prompt` | `ElementType` expor o record em todos os tipos de lista |
| 16 | Corte DFS sem ordem (`ModelHost.cs:119`); base 084203 = 0 msgs, foreign = 212 valido, pos-merge = 222 invalido e 56 objetos a menos | Causa da perda de fidelidade do merge (item 17) |

Regra de fecho para todos: teste offline verde + prova viva em `docs/PROVAS.md` + linha do mapa gerada (P9); ADR por decisao (P10); nenhum codigo copiado do descompilado (P6, ADR-002).
### Notas da etapa 15

- 178/178 testes em 2 m 41 s (`current-hints.trx`); nove testes especificos incluem entidade, structure, aggregate e group by.
- Hint Current consulta tipos publicos no escopo dono, apenas para ExpressionUnknownObject; budget proprio, falha de
  introspeccao conserva o Detail original. Verbs.Reference ensina Public + rebuild/snapshot + elements ou action publica.
- Prova viva Headless_UI: Games/GetGames/CurrentGame presentes; merge 2.009 ms, E2E 8.921 ms, 0 novas/0 corrigidas/14 preexistentes.
- Proximo: passo 16 (modo silencioso temporario ao abrir modulo, com restauracao garantida).

### Notas da etapa 16

- Open usa ServerSilentMode no aggregator retornado por OpenESpace; callback FIFO restaura, e finally cobre timeout,
  bloqueio e excecao. SilentModeLease garante um reset mesmo com callback atrasado. HasIncompatibleReferences corre
  fora da UI no contexto do aggregator; timeout de 3 s produz referencesCheck:skipped, sem resultado falso.
- Prova real Davitest_UI publicado com referencia velha ao Davitest_CS: abertura nova 5.799 ms e, na bridge final,
  `proof_open_dialogs.py --module Davitest_UI --mode silent` 7.527 ms; referencesOutdated:true, flag false, sem dialogo.
  silent:false: ManageDependencies em 4.559 ms. timeout:0: falha imediata, todas as flags false; Cancel conserva as referencias.
- close_module adicionado para reproduzir abrir/fechar com seguranca: recusa edicoes, aberturas pendentes, dialogos e
  nomes duplicados. IsModified agora usa a API publica WasModifiedSinceLastSave; open prefere a unica aba editada.
- Corrigido falso bloqueio de DialogWindow com titulo Progress; o carregamento pode durar mais que os 4,5 s do detector.
- A copia AnvilSilentProbe_UI foi publicada apenas na app Davitest para investigar o caso; o clone nao conservou o mesmo
  resultado do check e nao conta como aceite. O aceite e o consumidor original Davitest_UI. A copia de teste permanece no lab.
- Restauracao apos os restarts: Davitest_UI, Headless_CS e KKRTimeEntry_UI ja eram iguais aos snapshots; Headless_UI recebeu
  seu snapshot de volta por merge local. Os quatro deram hasNoDifferences:true, newErrors:0. Evidencia local em
  `.local/lane-ss5/silent-open-restore/results.json`; Headless_UI ativo, 14 avisos preexistentes, nenhum erro.

- Fecho da etapa 16: **182/182 testes em 2 m 36 s**, `silent-open-final.trx`. Proximo: **17, fila/auto-arranque/reciclagem do worker**.

### Notas da etapa 17

- WorkerServer (Hosting): accept/leitura concorrentes, uma thread Dispatch, ping fora da fila; queuedMs e
  busy/currentCommand/runningMs/queued/commands/served. Metricas do modelo copiadas no fim do comando, sem leitura concorrente.
- Auto-arranque com lock O_EXCL, PID + identidade de criacao no ultimo ping; queda depois de submissao nunca provoca replay.
  Limite 5000 configuravel e dois heaps consecutivos >2 GB: drena, recusa pendentes com executed:false e reinicia no cliente.
- Dois clientes reais: ambos via worker/accepted, 0 e 3711 ms de fila, 38 pings busy, maxQueued=1; 0 modulos retidos.
  Prova isolada porta 56057: arranque concorrente num PID, quinto comando drena, sexto/setimo no novo PID; suspensao real
  desse worker recuperada automaticamente. O worker de teste foi encerrado; SS4 intacto.
- `worker_soak.py --rounds 2 --filter service-action`: 2 jobs, frio 12 s, rodadas 1/2 de 1 s; assinaturas identicas,
  zero erros novos, heap pos-GC 8 MB. Logs por PID sem client gone. Sem Studio: erro frio em 2,094 s, sem espera de 60 s.
- Testes Python: 13/13 incluindo os 5 do proof_merge e os 8 do cliente. ADR-010 documenta fila, reciclagem e replay.

- Fecho da etapa 17: **185/185 .NET em 2 m 43 s** (`worker-queue.trx`) e **13/13 Python**. Proximo: **18, deliver e snapshots registrados**.

### Notas da etapa 18

- Registry guarda id/key/sha256/Verify na sessao. Bridge recusa base sem proveniencia e foreign de outra chave; a prova
  headless confirmou que o MatchTree sozinho misturava modulos (196 objetos, valido, sem conflito). Excecao explicita
  allow_foreign_base so para provas inversas; get_errors since checa sessao e modulo.
- Deliver: active/snapshot/apply/um merge auto/delta/checks; gates antes e depois, nao publica nem desfaz. Falha devolve
  stage/error/result.json. No-op e delivered:true/unchanged:true; wrapper Python nao faz snapshot/preview/merge por fora.
- 199/199 .NET em 2 m 55 s (`deliver.trx`), 11/11 Python (orquestracao saiu dos 5 testes Python antigos para 11 cenarios C# TCP).
- SS5 Headless_CS: tickets-all 3.131 ops, delivered:true, 1 chamada merge_from_oml, E2E 27.596 ms, merge 4.181 ms,
  0 erros novos, 1 aviso declarado, Ticket/Ticket_Create/TicketStatus encontrados. Nao publicado; ficou no Studio.
  No-op subsequente: 3.265 ms, zero novas, uma preexistente. Recusas vivas de snapshot registado de outro modulo e Key estrangeira.
- As abas Headless_CS/UI/KKRTimeEntry_UI recuperaram iguais aos snapshots. Davitest_UI mudou referencias durante a
  recuperacao; o dono confirmou que nao mexia nesses modulos. Restaurado o snapshot anterior, paridade true inclusive
  depois de repetir o check de referencias. Headless_UI voltou a ficar ativo, com 14 avisos preexistentes e zero erros.
- Proximo: **19, compilador screen e seis arquetipos de ouro**; depois **20, comandos de superficie**.

### Notas da etapa 19

- ScreenExpander fechado e puro: cards/table/detail/form/dashboard, duas passadas para destinos, contratos lidos de
  assinaturas no modulo (sem catalogo CSS/JS), inputs sem uso recusados. Gallery/Carousel mantem a List original e removem
  apenas defaults por interface publica NRWidgets. Form usa labels ligados, Mandatory, validacao e If Form1.Valid antes do save.
- Seis goldens sobre fixture, todos validos e zero mensagens novas (Mobile conserva os 6 avisos do fixture). Dashboard
  inclui data action com lista de entidade e tambem fonte paginada: Offset/Limit entram no server aggregate e Count volta
  por Total. O caminho Current e o de uma lista de entidade, sem wrapper. Negative screen-unknown-kind ensina os 5 kinds.
- Suite atual 228/228 em 3 m 15 s (`screen-spec.trx`), incluindo testes da outra sessao Hire/EntityIndex que nao entram
  neste commit. Artefatos .NET isolados com --artifacts-path .local/lane-ss5/test-build; JobTests/NegativeJobTests tambem
  gravam saidas na faixa SS5. Isto evita os DLLs de teste ocupados pela sessao SS4; nenhum processo dela foi parado.
- Headless_UI ja tinha Catalog/GameDetail: tentativa foi recusada antes de merge. Prova usa ScreenSpecCatalog e
  ScreenSpecGameDetail, preservando os originais. Cards+detail: 12.345 ms, 0 novas/0 corrigidas/14 preexistentes.
  Table/form/dashboard/data action: 10.858 ms, mesmo delta; nomes ScreenSpec* encontrados. Nao publicado.
- A secao 3.4 e um contrato autocontido com exemplo completo. A prova fria que dependia de autorizacao para
  subagente sem historico foi autorizada e executada em 05/09 no SS5; ver o fecho conjunto abaixo.

### Notas da etapa 20

- verify-message le 468 IDs publicos e recursos da DLL 11.55.73.64880: comparacao local com o catalogo anterior deu
  468/468 identicos em ID, severidade bruta, titulo e detail. ResourcesBaseName nao e publico: usa-se o manifesto
  publico da assembly e ResourceManager; formato de 13 campos verificado. Nenhum codigo do fornecedor copiado.
- No repo ficam o manifesto somente de IDs (expectedMessages offline e compatibilidade do worker SS4) e os 169 hints
  curados (112 + 57 quick-fix). Os 299 que repetiam o texto sairam; ValidationDetails mostra hints curados distintos,
  ate 20, sem consumir o limite de erros. A bridge fora do repo funciona sem esse arquivo opcional.
- ProofGenerator agora libera o ESpace, preserva nomes completos, encontra pais de plugins, corta ciclos de pais
  e guarda falhas por profundidade. Duas sondas de investigacao ficaram paradas antes dessa correcao e seus workers
  SS5 foram encerrados; nenhum modulo do Studio foi alterado. Quatro mapas regenerados: 2147 pares cada, hash do
  catalogo normalizado para LF, versao do Studio e limite 4. Worker voltou a loadedModules:0.
- IServiceAction: created-needs-config no Service; not-allowed em Reactive/Mobile/Traditional. Library sem fixture,
  sem prova. where-can recusa mapa antigo/parcial; no-parent nao e uma proibicao do runtime.
- recipe aponta para a tabela e jobs testados; consulta por nome exato devolve so esse job. tickets-all = 3131 ops;
  --ops --max 3 devolve tres; sem --max falha. As cinco descriptions vazias foram preenchidas. api --op projeta as
  listas usadas por logic/spec/screen; spec passou a rejeitar chaves silenciosamente ignoradas (records aceitam
  atributos extras declarados na static). ADR-012 fixa a fronteira de conhecimento em servico e OML local.
- Suite completa: 235/235 em 3 m 14 s (surface.trx), incluindo oito testes Hire/EntityIndex da outra sessao, fora
  deste commit. A ultima alteracao normaliza CRLF/LF apenas no hash; 8/8 SurfaceTests finais em 601 ms apos
  regenerar os mapas (surface-final.trx).
  Consultas SS5: verify exato 587 ms, where-can 244 ms, recipe 81 ms, api --op 5-17 ms; prova local em
  .local/lane-ss5/surface-proofs/commands.json. SS4 nao foi reconstruido nem reiniciado.
- A avaliacao fria por outra LLM e a contagem de leituras foram autorizadas em 05/09 e executadas exclusivamente
  no SS5. A verificacao independente e seu resultado constam no fecho conjunto abaixo.

### Fecho conjunto 19-20: avaliacao independente (2026-09-05)

- O dono autorizou um subagente sem historico e reiterou SS5. A unica documentacao lida foi a secao 3.4 (extrato
  identico ao AGENTS antes da prova). Home dashboard+carousel, Catalog busca/filtro/paginacao, GameDetail com input
  filtrado e tabs; navegacao entre as tres. Nenhum IList, widget ou handler escrito manualmente.
- Primeira tentativa aceita: 2 ops declaradas (spec/screen), 12.013 objetos, Verify 0 mensagens; delta new/fixed/
  preexisting/unexpected/missingExpected/ambiguous todos 0. Apply 7.601 ms, parede 9.449 ms via worker SS5. Nenhuma
  correcao de job ou expectedMessages. O job foi promovido byte a byte para tests/jobs/screen-spec-store-reactive.json.
- Leituras: 1 preventiva (guia), 0 reativas, 0 src/exemplos. Nenhuma consulta para criar. Depois da validacao,
  5 consultas de verificacao do passo 20: api --op screen/spec, where-can IServiceAction, verify-message
  RequiredConnector_Out, recipe tickets-all --ops --max 3; todas ok. Nao contamos essas cinco como leituras evitadas.
- A prova fria encontrou uma friccao pequena: recipe repetia uma row quando tickets-all era citado duas vezes
  nessa linha. Correcao deduplica rows e teste a cobre; consulta SS5 posterior retornou 1 row/3 ops/3131 total.
  --max limita ops, nao bytes: a primeira spec pode ser grande. Isso ficou explicito no guia.
- Limites: modelo de Game sintetico sem registros persistidos semeados; Genre tem 3 records. Destaques = ordenacao
  por Rating; dashboard usa a mesma fonte para total e carousel. Verify estrutural, sem browser/visual nesta rodada.
  As provas vivas dos arquetipos ja tinham sido aprovadas no passo 19; nao repetimos merge sobre telas homonimas.
- Relatorio versionado: docs/proofs/2026-09-05-cold-screens.json; saidas brutas locais em
  .local/lane-ss5/cold-screen-*.stdout.*. Nenhum processo, modulo ou worker SS4 foi alterado.

- A suite no checkout compartilhado terminou 237/238 em 5 m 12 s. A unica falha pertence ao arquivo ainda nao
  versionado tests/jobs/hire-business-actions.json da outra sessao: op #279, Candidate_MergeDuplicates declara
  o alias Collision0 duas vezes. Nenhuma alteracao foi feita nesse job. O fechamento usa uma copia de git archive
  de 3402449 com apenas as mudancas desta tarefa, sem os arquivos Hire/EntityIndex em desenvolvimento.

- Fecho: **229/229 testes verdes em 4 m 7 s** na copia isolada (cold-screen-isolated.trx), incluindo o app promovido
  e a regressao de recipe. Os passos 19 e 20 estao concluidos; todos os passos 11-20 pedidos pelo dono estao fechados.
  A divergencia 237/238 do checkout compartilhado continua documentada acima e pertence ao trabalho Hire nao versionado.
