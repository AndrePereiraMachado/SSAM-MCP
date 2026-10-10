# Migração de Casualty Report View

## Escopo e evidência

Análise solicitada do detalhe aberto por **View** em Approvals. Fonte observada: `http://localhost:5173/casualty-report/cr_mtq6qm2m9josit`. Esse identificador corresponde ao **CR-2026-00025**, Initial / Submitted. O registro nativo correspondente é **CasualtyReport.Id=25**, com o mesmo LegacyId.

A página foi aberta no Chrome; detalhe e histórico de notificações responderam HTTP 200. Foram lidos `client/src/pages/CasualtyReportView.tsx`, suas chamadas, testes existentes e as rotas de `server/routes/casualtyReports.js`. Também foi aberto o detalhe nativo do mesmo registro e consultados seus dados persistidos, a implementação de GetCore e assinaturas de blocks existentes. Esta etapa não implementa a migração e não executou Add remark nem Authoritative lookup.

## O que realmente precisa ser migrado

O layout tem cabeçalho com número/tipo/status e ações, coluna principal flexível e barra lateral de 320px em desktop. Os campos usam até três colunas; em telas menores o conteúdo deve se reorganizar sem cortes. Os valores são texto de leitura, não inputs desabilitados. Ausência é exibida como travessão; datas nulas nativas não podem aparecer como 1900 ou horário `0:0`.

O código contém **148 pares de rótulo/valor** e **23 grupos condicionais**, além de narrativas, metadados de ciclo de vida, relações, notificações e consulta de fontes. Isso não significa 148 tabelas nem que todos os campos devam aparecer em todo relatório.

Os 23 grupos condicionais são: Time, place & context; Line of duty & investigation; Records management; Memorial & recognition; LOD board & investigating officer; Witness & statements; Treatment & evacuation; Medical & death event; Mortuary & transport; Disposition (extended); Awards & decorations; Administrative & classification; Reporting organization; Notification routing; Awards detail; Report timestamps; AFMES jurisdiction; Mortuary & burial disposition; Notification status; Duty status; Medical examiner & identification; Injury & hospital status; Cause of death narrative & remarks.

Inventário completo de rótulos e mapeamentos em `docs/specs/casualty-report-view-inventory.json`.

### Interações e condições

| Recurso | Condição/comportamento do legado |
|---|---|
| Back | Retorna à navegação anterior; definir fallback para abertura direta |
| DD-1300 PDF | Download autenticado para quem pode ler o relatório; não aprovado deve ser marcado NOT CERTIFIED |
| Review & Decide | Submitted/In Review e supervisor/administrador; navega para Approvals com o relatório em foco |
| Compose Interim | Initial aprovado; navega para composer de atualização |
| Compose Final | Initial ou Interim aprovado; navega para composer Final |
| Compose Correction | Final aprovado; navega para composer de correção |
| Duplicidades potenciais | Banner apenas enquanto pendente; candidatos vinculados por ID; decisão continua em Approvals |
| Relatório anterior | Banner com link quando há parent_report |
| Report chain | Cronologia lateral quando há mais de um relatório da mesma pessoa; destaca o atual |
| Add remark | Reporter, case manager, supervisor ou administrador; texto não vazio; permitido em diferentes estados; servidor acrescenta autor/data preservando texto anterior |
| Histórico de e-mails | Carga independente; expandir destinatário para ver assunto/corpo; estados pending/sent/delivered/failed/bounced; também inclui e-mails dos casos da pessoa |
| Authoritative lookup | Perfis de autoria; requer EDIPI ou SSN-last4 + sobrenome; mostra origem, data, divergências e condição degradada/sintética |

As ações Compose são destinos de outras telas. Mostrar um botão não implementa esses composers. Sua disponibilidade e navegação devem ser provadas antes de declará-las cobertas.

## Estado atual do OutSystems

Existe `MainFlow/CasualtyReportDetail`, com parâmetro nativo ReportId e data action LoadReport. Ela já abre o registro 25, porém apresenta uma composição simplificada com seções Report overview, Service member, Incident, Narrative e Notifications. Na página observada não há as ações e os cards laterais equivalentes ao legado.

**O problema central é o contrato de leitura, além do layout.** `CasualtyReport_GetCore` desserializa PayloadJson e repõe apenas parte dos campos usando CasualtyReport/CasualtyPerson. No registro 25, PayloadJson está vazio. A consulta independente confirmou:

| Informação | Persistida no OutSystems | Detalhe atual |
|---|---|---|
| Data/hora | LegacyIncidentDate=2026-09-06; IncidentTime=16:00 | Data vazia / hora 0:0 |
| País | International Waters | Vazio |
| Local | Persian Gulf — operational area | Vazio |
| Circunstâncias | 12346 | Vazio |
| Coordenadas | 26.5 / 51 | Sem apresentação equivalente |
| Componente | AC | Vazio |

Não recriar esses dados nem copiar exemplos para o front-end. Corrigir a leitura das fontes persistidas. Também há diferença de horário exibido no Submitted: deve haver uma política única de UTC/conversão local, sem converter duas vezes ou interpretar texto legado sem fuso silenciosamente.

O levantamento encontrou **165 propriedades de report referenciadas no componente**, das quais **157 têm mapeamento no dicionário existente para atributos presentes no modelo inspecionado**. As oito restantes envolvem derivados/joins/decifragem: approver_name, date_of_birth, duplicate_of_report_number, military_affiliation_label, personnel_category_label, reporter_email, reporter_name e unit_uic. Contagem de mapeamentos não prova fidelidade dos valores de todos os registros.

As tabelas centrais já existem: CasualtyReport, CasualtyPerson, LegacyUser, EmailNotifications, CasualtyCase, NextOfKin, CasualtySecondaryData, FieldProvenance, AuditEntry e catálogos. DCIPSUserLink também aparece nos contratos de acesso já implementados; sua ausência no inventário antigo em cache não significa ausência no módulo. Não foi identificada necessidade de criar outra tabela central de relatório. Validar relações e cobertura das estruturas de saída antes de qualquer extensão de esquema.

## Componentes nativos e autoria

Manter HTML/CSS/JS como fonte de composição e comportamento de UI, compilada em screens/blocks nativos. Definir campos e grupos uma vez, preservando classes, estados e identidade dos elementos. Não criar uma implementação distinta para cada um dos 23 grupos nem uma nova lista de relatórios nesta tela.

| Composição | Base existente / adaptação |
|---|---|
| Shell e navegação | Layout_DCIPS; identidade real do usuário em vez do exemplo Alex Morgan |
| Card de seção e campos de leitura | CW_SectionCard e CW_ReadOnlyField, assinaturas inspecionadas: Label/Value/EmptyText; adaptar grid, mono, quebra e datas |
| Branch/status | CW_BranchBadge(ServiceBranchId/FallbackLabel), CW_StatusBadge(Label/Tone) |
| Cabeçalho do viewer | Block específico com número, badges, capacidades e eventos de navegação |
| Duplicidades | Reutilizar apresentação/contratos de ApprovalDuplicates quando adequados; viewer usa ViewRequested, sem decidir duplicidade nessa tela |
| Ciclo de vida | Card específico: reporter, submitted, decisor e data de decisão |
| Parent/chain | Composições com links nativos e IDs, estado atual destacado |
| Observações | Block de leitura + editor de acréscimo e erro; nenhum save genérico de Form |
| Histórico de e-mails | Card/lista expansível com estados independentes |
| Fontes oficiais | Card próprio para consulta, resultados, divergências e proveniência |

A existência de um block não prova sua fidelidade visual. Adaptar o componente uma vez e verificar seus consumidores; evitar CSS global que altere outras telas.

## Contratos de servidor propostos

Os nomes abaixo são proposta de implementação, não actions já entregues:

1. **CasualtyReport_GetView**: relatório normalizado, labels, capacidades, ciclo de vida, parent, chain e duplicidades. Consolidar mapeamento com GetCore para que a tela de edição e o viewer não mantenham duas verdades. PayloadJson pode complementar campos históricos, mas não pode suprimir valores persistidos por estar vazio.
2. **CasualtyReport_GetEmailHistory**: e-mails vinculados ao relatório e aos casos da pessoa, ordenação por envio/criação, conteúdo para expansão e auditoria de leitura. Não reenvia mensagens.
3. **CasualtyReport_AddRemark**: valida papel/escopo, texto e comprimento; autor e timestamp obtidos no servidor; append atômico e auditoria. Preservar histórico e evitar perda sob duas inclusões concorrentes.
4. **CasualtyReport_AuthoritativeLookup**: identificação, adaptador da fonte, proveniência e auditoria. O legado pode usar fontes sintéticas em condição degradada; reproduzir essa identificação explícita na PoC, sem afirmar conectividade real com DEERS/DMDC/MILPDS/NSIPS sem prova. O exemplo atual sem EDIPI/SSN deve obter a validação de identificação, não dados fictícios apresentados como consulta bem-sucedida.
5. **CasualtyReport_RenderDD1300**: documento autenticado com dados autorizados e relações necessárias; certificação somente se aprovado. Verificar gerador/adaptador disponível, cobertura de campos e formato do PDF como entrega independente; botão de download não basta.

Reutilizar o núcleo de auditoria, os catálogos e a criptografia de demonstração autorizada quando aplicável. A consulta de data de nascimento deve reconhecer o envelope existente e não usar a data nativa nula como se fosse um valor real. Não voltar a exigir configuração de variáveis de servidor rejeitada na PoC.

### Acesso e decisões

Aplicar autorização no servidor a cada relatório e a cada vínculo devolvido, inclusive parent, chain, candidatos e e-mails. A regra do viewer precisa atender leitores autorizados e autores; não usar automaticamente um resolvedor exclusivo de supervisor para todas as leituras.

No snapshot de código inspecionado, a guarda de sessão de `CasualtyReport_Get` contém `False //GetUserId() = NullIdentifier()`. Ela precisa ser revista/reativada no contrato de leitura final, com verificação do estado corrente do módulo. Isso é achado de inspeção; não foi executado teste anônimo de exposição de dados.

Não duplicar Approve/Reject/Mark as Duplicate no viewer. `Review & Decide` deve passar um FocusReportId para Approvals, carregar o relatório permitido e selecionar a linha correta, inclusive quando filtros/paginação impedirem que ela esteja na primeira página. As regras e ações de decisão existentes continuam responsáveis pela transição.

## Sequência de implementação

1. Fechar o dicionário por campo: fonte, fallback, tipo, nulidade, label e visibilidade. Corrigir a leitura e provar o registro 25 com comparação banco → contrato → tela.
2. Implementar/reutilizar os contratos de servidor e suas estruturas. Testar autorização, datas, decriptação PoC, relações e erros independentemente do visual.
3. Compor a tela fiel ao legado com blocks nativos e fonte HTML/CSS/JS. Primeiro o mesmo registro 25, sem dados hardcoded, depois fixtures com todos os grupos condicionais.
4. Conectar observações, e-mails, PDF e lookup; cada integração com estado de erro/loading/vazio e prova própria. Conectar os composers já existentes; declarar faltas concretas se algum destino ainda não existir.
5. Completar o percurso Approvals → View → Back / Review & Decide, mantendo contexto e seleção; testar links de parent, chain e candidatos.
6. Entregar por merge, publicar pelo fluxo humano do projeto e provar E2E. Nenhuma etapa é encerrada apenas por Verify verde.

## Critérios de aceite

- Mesmo registro 25: país, local, data/hora, circunstâncias, componente, branch e contexto iguais às fontes, inclusive quando PayloadJson estiver vazio.
- Fixtures para Initial, Interim, Final, Final Corrected e estados Draft/Submitted/In Review/Approved/Rejected/Canceled, cobrindo as condições das ações.
- Todos os 23 grupos: preenchido, ausente e valores longos; datas nulas e texto com quebras; 390/768/1440 CSS px, sem corte/overflow.
- Observação vazia recusada; append com autoria do servidor; concorrência sem perda; falha preserva texto digitado; nenhum envio automático de e-mail.
- Histórico de e-mails vazio, expandido, múltiplos estados, e-mail de caso sem report_id e falha de carga.
- PDF real: download e conteúdo; documento pendente/rejeitado/cancelado sem certificação de aprovação.
- Lookup sem identificação, encontrado, não encontrado, degradado e falha; diferenças/proveniência visíveis; não sobrescrever o relatório silenciosamente.
- IDs inválidos ou fora do escopo não vazam registros nem relações; papéis com capacidades diferentes.
- Navegação, foco por teclado e retorno para o relatório correto em Approvals; PDF/Compose/Review não aparecem como funcionalidades completas sem seus destinos testados.

Evidências brutas desta análise em `.local/casualty-view-analysis/`. Chamadas GET podem gerar as auditorias normais de leitura do próprio legado. Não houve postagem de observações, consulta de fontes, alteração de relatório ou publicação nesta etapa. A pendência anterior de publicação/E2E do CSV permanece separada.
