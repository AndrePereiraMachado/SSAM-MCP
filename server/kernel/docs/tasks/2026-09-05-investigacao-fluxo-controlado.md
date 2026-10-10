# Investigação: transformar a entrega do Hybrid em um fluxo controlado

Data: 2026-09-05. Estado: investigação concluída; alteração de produto ainda não implementada.
Escopo: entradas de escrita, contrato original, recuperação e primeiro marco de dados.
Referência: [plano de implementação](2026-09-05-plano-fluxo-controlado.md).

## Conclusão

O Hybrid já tem compilação, validação e merge suficientes para executar o caso de dados. Falta uma autoridade
única sobre a tarefa: hoje quem escolhe o percurso, as obrigações verificadas e o significado de uma nova tentativa
é a LLM. O código controla uma execução de job, não a continuidade do pedido do usuário.

A mudança deve evoluir `Delivery`, substituir sua entrada livre no modo de app e retirar acessos alternativos
dessa sessão. Criar outra skill, outra receita ou outro comando opcional mantém o problema. Para dados, a mesma
spec declarativa pode ser o contrato congelado e a entrada do compilador; a LLM não precisa escrever uma segunda
implementação em verbos crus. A conferência deve ler o modelo contra esse contrato, independentemente dos verbos
que o compilador conseguiu emitir.

Há dois erros do verificador confirmados nos arquivos reais: índices presentes não eram encontrados pela bridge,
e listas semanticamente idênticas eram rejeitadas por terem outra chave interna. Corrigi-los é pré-requisito:
um percurso obrigatório com um juiz errado apenas torna o bloqueio inevitável.

## 1. Evidência verificada

Foram lidos código, testes, quatro recibos históricos e três snapshots locais. As consultas aos snapshots usaram
somente `get` e `find`, em processos frios separados com o runtime do SS5. Os OMLs de entrada mantiveram seus hashes.
Não houve chamada à bridge viva, publicação, build ou alteração de Incidents_CS.

Dados reproduzíveis, hashes e linhas do código estão em
[prova da investigação](../proofs/2026-09-05-fluxo-controlado-investigacao.json).
Os detalhes de inspeção ficam em `.local/control-flow-investigation/`; OMLs de cliente não viraram fixtures.

| Evidência histórica | O que aconteceu | Consequência |
|---|---|---|
| Recibo `a0b7d44688a44c62842f3af690f622f7` | Em 5.396 ms: `merged=true`, 361 verificações locais, falha no nome `IX_Incident_StatusId`; a prova de conteúdo posterior não rodou | O módulo já estava alterado, apesar de `delivered=false` |
| Snapshot inicial da tentativa seguinte, `b53b1cd48c9449df9eb05d099b72323a/base.oml` | A inspeção encontrou esse índice em `Incident`, `Unique=false`, atributos `[StatusId]` | A ausência relatada pela busca não significava ausência no modelo |
| Recibo `b53b1cd48c9449df9eb05d099b72323a` | A criação foi reaplicada sobre o estado já alterado; rejeitada antes do segundo merge | O gate evitou entregar duplicatas, mas não evitou o retrabalho |
| Recibo `916cbec5fc0441cfa1260637d08bfd0c` | Job de verificação vazio, zero obrigações de dados, `no differences`, `delivered=true` | Sucesso dessa execução vazia não comprova as 361 obrigações anteriores |
| Recibo `1141cd9976ad4dd09175ebd1e471967a` | `merged=true`; 93 verificações, duas divergências em tipos de lista | A inspeção abaixo confirmou dois falsos positivos |

Nas listas `IncidentDetail.Comments` e `IncidentDetail.History`, antes/depois do merge:

- O atributo conserva sua identidade.
- O tipo continua sendo `IListType`.
- O elemento continua sendo a mesma entidade, inclusive a mesma chave global: `IncidentComment` ou `IncidentHistory`.
- A chave local da lista muda. A chave global da lista também permaneceu igual neste caso.

`DataAssertions.Normal` (`src/Anvil.Core/Kernel/DataAssertions.cs:43`) compara referências de modelo somente por
`ObjectKey`. Isso explica exatamente as duas divergências. Trocar uma lista por uma contagem para passar nesse
verificador seria reduzir o pedido para acomodar um erro da ferramenta.

A leitura headless inclui índices nativos em `EntityIndexes.IncludeNative`
(`src/Anvil.Core/Adapters.SS11/EntityIndexes.cs:42`). A busca da bridge
(`src/Anvil.Bridge/Reads.cs:72`) percorre apenas a coleção da Model API. Essa diferença explica o índice ausente
na busca. A inspeção confirma sua presença no snapshot posterior; não certifica o estado atual da sessão do usuário.

## 2. Mapa das entradas e dos bloqueios necessários

| Entrada atual | Efeito real | Proteção atual | Destino no fluxo controlado |
|---|---|---|---|
| `deliver` / `proof_merge.py` | Snapshot, apply headless, merge e conferência | Job válido, identidade do módulo, hashes e mensagens | Uma única implementação em `Delivery`, vinculada a tarefa e revisão |
| `apply`, `run_job.py`, receitas, `prove`, `relayout` | Altera/salva cópias locais; isoladamente não altera o Studio | Preflight e Verify conforme o comando | Motor interno e laboratório. Seu resultado não autoriza merge nem conclui tarefa |
| `merge_from_oml` direto | Altera o módulo vivo em `auto`; `dialog` pode aplicar por decisão no diálogo; `preview` compara | Base registrada por padrão, mesma chave de módulo, diálogo pendente | Apenas executor autorizado; operação vinculada a contrato, revisão e bytes exatos |
| `publish` da bridge e `proof_merge.py --publish` | Publicação real | Verify e ausência de operação de servidor em curso; restrição a laboratório é documental | Fora da entrega normal. Laboratório/publicação exigem autorização própria do host |
| `create-app`, `add-modules`, `create-module`, `update-app` | Cria/atualiza recursos no servidor; criação pode publicar | Credenciais e `HeadlessSession.RequireWrite` | Provisionamento autorizado como escopo próprio; nunca saída alternativa de uma falha de dados |
| `edit-smoke`, `publish-smoke`, `set-user-provider`, `refresh-refs --publish`, `delete-app` | Mutações/publicações no servidor | Regras locais, como read-only e prefixo ZZ para delete-app | Ferramentas de manutenção/laboratório não expostas à sessão de app |
| `open_module`, `login`, `close_module`, `close_dialog` | Muda contexto da UI; fechar diálogo pode cancelar trabalho pendente | Alguns gates de alterações não salvas/diálogos | Executor controla alvo; não fecha diálogos indiscriminadamente para avançar |
| Consultas, catálogos, export/snapshot | Leitura e eventualmente gravação de arquivos locais | Dependem do comando | Continuam disponíveis de forma proporcional, com caminhos controlados e sem emitir conclusão de entrega |

Pontos concretos:

1. `src/Anvil.Cli/Program.cs:128` despacha as mesmas capacidades no CLI frio e no worker. Não existe perfil de app
   que as limite. `ANVIL_WORKER=0` apenas muda o transporte; não pode mudar a autorização.
2. `src/Anvil.Bridge/Server.cs:37` escuta em loopback e aceita clientes concorrentes. Loopback não identifica uma
   tarefa nem autentica quem pode executar uma escrita. `Dispatch.cs:9` não faz essa verificação.
3. `src/Anvil.Bridge/MergeHandler.cs:71` aceita `allow_foreign_base=true`, que desliga `RequireBase`. A checagem da
   identidade do foreign continua existindo; o escape é especificamente da proveniência da base.
4. O único uso encontrado desse escape em `src/` e `scripts/` é `scripts/proof_cycles.py:88`. O script já registra
   o snapshot usado como base imediatamente antes. Proposta: remover o argumento e o escape, validando o ciclo
   inverso no laboratório, em vez de criar uma nova exceção de manutenção para uma necessidade não demonstrada.
5. `HeadlessSession.RequireWrite` (`src/Anvil.Core/Adapters.SS11/HeadlessSession.cs:33`) verifica apenas read-only.
   Não vincula uma publicação ao pedido, módulo ou tarefa autorizada.

A fila do worker (`src/Anvil.Core/Hosting/WorkerServer.cs:15,129`) é útil para o runtime, mas serializa apenas um
processo. Não impede duas faixas ou um CLI frio de concorrer pelo mesmo módulo. Tampouco impede edição humana.

## 3. O contrato atual não representa o pedido original

`JobRunner` obtém `session.DataContract()` depois de executar os ops (`src/Anvil.Core/Kernel/JobRunner.cs:52`).
Esse mecanismo detecta divergências nas propriedades que foram efetivamente declaradas/aplicadas. Ele não detecta
um campo que a LLM nunca declarou. `Delivery.cs:54` usa essa lista, ou uma lista vazia quando ela não existe.
`DeliveryReceipt.Check` (`DeliveryReceipt.cs:38`) verifica o recibo e os hashes de arquivos; não conhece o pedido
original nem a tarefa que se pretendia concluir. Hash não é autorização e um recibo editável não é fonte de autoridade.

Modelo mínimo proposto:

- **Pedido:** texto/anexos originais e identidade do evento do usuário, capturados pelo host. A LLM não escolhe
  qual mensagem substitui a original. Nova chamada com o mesmo evento retoma a mesma tarefa.
- **Contrato de dados:** a spec existente, normalizada, com requisitos identificáveis e valores/defaults explícitos.
  Referências a tipos externos incluem origem. Reusar `SpecExpander.Schema`, catálogo e `DataPreflight`; não criar
  uma segunda linguagem equivalente. Campos de rastreabilidade ficam no envelope da tarefa, não nos verbos.
- **Revisão de implementação:** pacote imutável gerado pelo controlador, versão do compilador/catálogo,
  produtores e snapshots. O contrato aceito não muda porque o compilador ou a revisão mudou.
- **Prova:** leitura independente do modelo contra todas as obrigações do contrato, incluindo as omitidas por
  defeito do compilador. As asserções por operação continuam úteis como diagnóstico de fidelidade interna.

Para o primeiro marco de dados, gerar o job a partir do contrato elimina a segunda escrita livre pela LLM.
O controlador pode organizar tipos e FKs com `SpecExpander.Expand` (`SpecExpander.cs:42`), que já declara os tipos
antes dos campos. Não é preciso uma entrega parcial para cada grupo de entidades.

Regras de conteúdo do primeiro marco:

| Parte | Obrigação verificável |
|---|---|
| Entidade/static/structure | Tipo, nome, origem e cardinalidade sem renomeação silenciosa; propriedades públicas conforme contrato |
| Atributo | Tipo semântico, identidade da FK, tamanho, obrigatoriedade e default quando especificados |
| Identificador | Atributo identificador, tipo e AutoNumber conforme a convenção explicitada |
| Static records | Registros e valores pedidos; IDs gerados preservados quando já vinculados |
| Índice | Entidade dona, unicidade, ordem dos atributos e nome quando exigido |
| Escopo | Só alterações autorizadas; elementos preexistentes fora do escopo preservados no delta semântico |
| Mensagens | Zero erros novos e política fixa de avisos; declarar qualquer warning novo no job não equivale a autorizar ignorá-lo |

A autorização de escopo compara primeiro base -> foreign, identificando as mudanças do compilador e os elementos
derivados legítimos mantidos pelo Studio. Depois do merge, confere local imediatamente anterior -> resultado,
preservando edições humanas fora do pedido. Comparar tudo apenas contra a base antiga atribuiria à tarefa mudanças
do humano e criaria novos falsos positivos. Nomes/aliases sozinhos não resolvem a identidade de elementos existentes.

Não basta comparar nomes para provar tipos: `List(Entity(A))` difere de `Entity(A)`, `Identifier(A)`,
`List(Entity(B))` e de outra entidade homônima em outro produtor. Identidade do elemento e formato recursivo do
tipo precisam compor a comparação. Uma propriedade de tipo desconhecido falha explicitamente, sem cair em
comparação permissiva por texto. Propriedades de referências não relacionadas a tipo mantêm suas próprias regras.

**Limite da linguagem natural:** congelar uma tradução errada só preserva o erro. Se o usuário já forneceu uma
spec aprovada, ela deve ser usada sem nova confirmação. Na entrada por texto livre, a normalização precisa mostrar
cobertura das cláusulas e resolver ambiguidades reais antes de congelar. Nenhum hash ou parser prova sozinho que
uma LLM entendeu toda intenção humana. Uma alteração de requisito exige um novo evento autorizado do usuário,
não `approved=true` escrito pela LLM. Essa integração de origem/autorização pertence ao host, fora do pacote editável.

## 4. Estado persistente e recuperação

Hoje `Delivery.cs:17` cria um GUID novo a cada chamada e grava `result.json` somente no `finally` (`:108`). O JSON
não é um diário de execução: uma queda pode deixá-lo ausente/incompleto. Mesmo sem queda, uma resposta de erro
posterior não se transforma em uma retomada do mesmo pedido.

Há uma janela adicional na bridge: `MergeHandler.cs:142` aplica o comando; `:146` roda Verify antes de devolver
sucesso ao cliente. Uma exceção nessa leitura pode produzir resposta de falha depois de o merge ter ocorrido.
Salvar o recibo apenas no CLI, depois da resposta, não fecha essa janela.

Usar dois fatos separados no registro da tarefa:

- **Etapa:** contrato, preparação, validação, merge, conferência, concluída, bloqueada ou cancelada.
- **Operação de escrita:** não enviada, intenção persistida, em execução, aplicada, sem mudança, recusada antes
  de executar, ou resultado desconhecido. O histórico de uma operação aplicada é imutável.

O estado de conferência pode falhar sem negar o fato de que houve escrita. Uma reparação produz outra revisão e
outra operação sob o mesmo contrato; não apaga a primeira operação.

| Situação ao retomar | Próximo passo permitido |
|---|---|
| Preparação inválida; nenhuma escrita enviada | Corrigir a implementação ou diagnosticar capacidade ausente sob o mesmo contrato |
| Pacote validado, operação ainda não enviada | Conferir alvo/base e iniciar a operação autorizada |
| Mesmo operationId já em execução | Acompanhar; não iniciar outra execução |
| Merge aplicado; resposta perdida ou conferência falhou | Recuperar recibo e fazer snapshot/conferência; nenhuma reaplicação inicial |
| Resultado desconhecido | Reconciliar diário da bridge e estado atual; nunca reenviar a escrita por timeout |
| Conteúdo correto já existia | Conferir todas as obrigações e registrar conclusão sem mudança, sem atribuir uma criação que não ocorreu |
| Drift real depois do merge, Ctrl+Z ou edição humana | Mostrar delta; gerar reparação somente dentro do escopo autorizado e a partir de base atual |
| Conflito, identidade incorreta ou ambiguidade de recuperação | Bloqueio específico; não trocar automaticamente de módulo, contrato ou faixa |
| Cancelamento após escrita aplicada | Parar novos passos; manter a indicação da escrita. Cancelar não desfaz nem conclui |

### Protocolo mínimo de escrita

1. O controlador reserva o par **ambiente + chave de módulo** entre tarefas/faixas. O slot operacional da bridge
   também serializa acesso ao contexto do Studio. Registrar revisão e número de sequência; adquirir a reserva
   não pode bloquear o trabalho humano indefinidamente nem fingir que ele está travado.
2. Persistir o pacote validado e a intenção: taskId, contractHash, revision, operationId, leaseEpoch, ambiente,
   moduleKey, bridgeSessionId, snapshotId, baseHash e foreignHash. A execução lê bytes privados desse pacote;
   não relê caminhos mutáveis entregues pela LLM depois da validação.
3. A bridge autentica o executor e valida a autorização para esses valores exatos. A operação é consumida uma
   vez; operationId repetido com conteúdo diferente é erro, com o mesmo conteúdo devolve estado/recibo.
4. Resolver o alvo por identidade, revalidar ambiente/instância e executar na fila/contexto do presenter capturado.
   Ler módulo ativo antes e executar depois com outro contexto não é suficiente. Não mover o merge para a UI
   thread: a API atual o recusa; usar sua execução no contexto do presenter e checagens junto à execução.
5. Persistir o resultado do comando **antes** de Verify/checks posteriores. Se houver conflito ou cancelamento,
   guardar a classificação real. `mode=dialog` não pode responder `dispatched` como conclusão da escrita.
6. Obter snapshot posterior identificado, avaliar mensagens e obrigações independentes, registrar tudo e só então
   emitir o comprovante da tarefa. Reusar um snapshot para as conferências reduz leituras do módulo ativo.

Não existe transação atômica entre o arquivo do diário e o comando do Studio. Ainda pode haver queda entre a
mutação e o registro do resultado. A garantia implementável é: não repetir cegamente e não certificar sem prova.
Se não for possível determinar o que ocorreu, o resultado continua desconhecido. A presença dos objetos pode provar
que requisitos estão satisfeitos; não prova, sozinha, quem os criou ou se houve uma única execução histórica.

Na retomada após reiniciar o Studio, `SnapshotRegistry` perdeu seu dicionário em memória (`SnapshotRegistry.cs:9`).
Guardar baseline de mensagens e identidade/bytes no armazenamento protegido permite refazer a conferência contra
um novo snapshot. Um snapshot histórico não volta a ser uma autorização irrestrita de merge; reparações recebem
uma nova base registrada. Resposta/recibo histórico também não certifica alterações humanas posteriores.

A reserva entre faixas precisa de epoch validado pelo executor: o vencimento de um prazo não pode liberar uma
segunda escrita enquanto a primeira ainda pode estar rodando. Para o primeiro marco, reserva expirada com escrita
incerta bloqueia até reconciliação. Processos frios e reinícios usam o mesmo registro, não uma segunda fila independente.

## 5. Isolamento que torna a restrição efetiva

Separar duas garantias, sem chamar a primeira de proteção completa:

1. **Integridade do fluxo:** `Delivery`, contratos e recibos impedem conclusão indevida pelas APIs do produto.
2. **Restrição de ferramentas:** a sessão de app não consegue invocar outro executor, ler credenciais de escrita,
   trocar DLLs, editar o armazenamento autoritativo, chamar a bridge livremente ou abrir um canal de manutenção.

Um token salvo no mesmo diretório gravável pela LLM, uma variável `MODE=app` ou um argumento `--maintenance`
selecionável por ela não estabelecem essa separação. As chaves, política de sessão e armazenamento do controlador
precisam ficar fora de suas permissões. A bridge deve rejeitar chamadas de escrita não autenticadas. Ferramentas
com acesso a shell/rede/arquivos do host precisam ser limitadas na sessão de entrega, não apenas omitidas do guia.

Recomendação de integração: um único executor local confiável atende o cliente de app e usa internamente o worker
residente e a bridge existentes. O cliente recebe apenas contrato/proposta, estado, diagnósticos e evidência; as
etapas operacionais ficam com `Delivery`. O executor pode usar o binário atual com um modo de serviço restrito;
não é necessário outro compilador. Expor isso por ferramenta/connector é transporte, não o mecanismo de segurança.

A política que autoriza uma sessão de manutenção deve vir do host/usuário. Não pode ser modificada por uma falha
no job. O provisionamento em lote já implementado pode ser preservado como operação autorizada própria; não é
preciso voltar à criação sequencial nem publicar automaticamente mudanças de conteúdo.

Com o acesso atual de manutenção por PowerShell ao repositório, só implementar gates no CLI não permitiria afirmar
que a LLM está confinada. A ativação do modo de app depende também dessa restrição no host. Isso é condição de
aceitação do produto, não uma promessa de que o código controla todo texto que a LLM possa escrever.

## 6. Reuso, alterações e remoções

| Componente | Alteração proposta |
|---|---|
| `Delivery.cs` | Transformar o mesmo fluxo em etapas retomáveis; armazenar fatos antes/depois da escrita; agregar resultados independentes |
| `DeliveryReceipt.cs` | Projetar comprovante a partir da tarefa/contrato; verificar integridade do pacote. Recibos legados ficam como evidência histórica |
| `SnapshotRegistry.cs`, `MergeHandler.cs` | Identidade de sessão/ambiente/alvo, operação autorizada, diário e reconciliação; remover escape de base |
| `DataAssertions.cs` | Corrigir tipos semânticos; manter diagnóstico por operação, acrescentar conferência orientada pelo contrato |
| `EntityIndexes.cs`, `Reads.cs` | Compartilhar a mesma leitura de índices e selecionar alvos por identidade |
| `SpecExpander`, `DataPreflight`, `JobRunner`, `ModelSession`, `ModelHost`, `MessageExpectations` | Reusar compilação, convenções, Verify/delta e carregamento/libertação; nenhum executor paralelo novo |
| `Program.cs`, `WorkerServer`, clientes Python | Entrada de app exige contexto de tarefa; CLI frio e worker obedecem à mesma autoridade |
| `proof_merge.py`, `proof_cycles.py` | Compatibilidade/laboratório; retirar o escape e o papel de alternativa livre na entrega de app |
| `HeadlessSession` e portas da bridge | Exigir capacidade autorizada para escrita; credenciais/manutenção fora do cliente de app |
| `AGENTS.md`, skill | Documentar a entrada já restringida; não funcionar como a única barreira |

Os conceitos novos indispensáveis são o registro de tarefa/contrato, armazenamento transacional com reservas,
a identidade semântica de tipos e o contexto de autorização da operação. Isso não requer uma plataforma genérica
de workflows, um novo conjunto de verbos por artefato ou mais scripts que conduzam caminhos equivalentes.

O armazenamento deve ser local e protegido, com gravação durável, atualização condicional por sequência e recuperação
após queda. Preferir um único armazenamento transacional para tarefa/reservas, com artefatos por hash; não manter
JSON autoritativo independente por cliente. A biblioteca/formato e o isolamento do serviço devem ser escolhidos e
provados no primeiro incremento técnico. O protocolo não depende de uma marca de banco de dados.

Retirar da interface de app, quando migrada: `--checks` que reduz obrigações, `deliver` livre sem tarefa, merge cru,
publicação de prova e possibilidade de usar `check-delivery` de outra execução como conclusão. `ops:[]` continua
legítimo no laboratório; na tarefa só pode significar conferência de **todas** as obrigações originais.
A regra de sufixo de nome de job não vira autorização: trocar `-v2` por `server-ops` hoje passa por ela
(`JobRunner.cs:100`), mas nenhum nome de arquivo deve definir a identidade futura da tarefa.

## 7. Incrementos e critérios de aceitação

| Incremento | Resultado concreto | Gate |
|---|---|---|
| A — juiz correto | Tipos semânticos, índices comuns e coleta completa dos checks | Listas equivalentes passam; lista versus contador, FK/entidade diferente e índice incorreto falham |
| B — continuidade | Registro durável integrado ao `Delivery`; merge registrado na bridge antes de Verify; retomada por taskId | Injetar falha após merge e terminar a mesma tarefa sem novo apply/merge de criação |
| C — contrato de dados | Spec congelada gera implementação e prova independente; snapshots/pacotes imutáveis | Omitir campo, reduzir tamanho, remover índice ou trocar tarefa/recibo não conclui o pedido |
| D — entrada efetivamente fechada | Executor autenticado, perfil de app sem rotas alternativas, reservas entre faixas | Tentativas diretas e concorrentes são recusadas antes da mutação; mesmo pedido retoma a mesma tarefa |
| E — aceitação completa | Prova controlada ao vivo e avaliação com LLM sem contexto | Pedido até conteúdo conferido, com evidência de tempo, sem redução de escopo |

A–C são progresso funcional, mas ainda não constituem um túnel fechado sem D. O primeiro marco de dados só pode
ser anunciado como concluído depois de A–E. Trabalhar internamente em incrementos não autoriza manter duas rotas
equivalentes na experiência final.

Casos obrigatórios de teste:

- Falha antes do envio, após envio, após mutação, após recibo e durante conferência; queda/reinício de cliente,
  executor e bridge. Diferenciar execução recusada de resultado desconhecido.
- Mesmo operationId repetido simultaneamente; outro payload com o mesmo ID; duas faixas e CLI frio para o mesmo
  módulo; reserva vencida com operação ainda em voo.
- Troca de aba, ambiente ou módulo entre snapshot e merge; edição humana concorrente; Ctrl+Z depois do recibo.
- Índice nominal não encontrado não impede salvar a prova de tipos/tamanhos; failure de um checker não apaga os demais.
- Job/producer editado após validação; recibo adulterado; tentativa de diminuir política de avisos, contrato ou checks.
- Job vazio ou renomeado depois de merge aplicado; nova tarefa com o mesmo evento original; leitura sem escrita que
  satisfaz o contrato deve ser aceita como conferência, sem inventar uma criação.
- Nenhuma publicação, exclusão, fechamento indiscriminado de diálogo ou acesso à manutenção como recuperação de app.

Os testes atuais de `DeliveryTests` cobrem o percurso feliz e interrupção em várias etapas com bridge simulada.
`DataContractTests` cobre propriedades, reload, alteração de fonte e falha de prova. Eles não cobrem retomada durável,
permissões ou os dois falsos positivos reais. Expandir esses conjuntos e criar fixtures sintéticos mínimos para
listas/índices; não copiar o módulo de cliente para a suíte.

Para velocidade, medir do recebimento até a conferência final, separando LLM, compilação, fila, snapshot/merge e
retrabalho. Os recibos acima levam segundos; não explicam sozinhos dez minutos de interação. Eliminar escolhas
operacionais e repetições é parte central da melhoria. A meta das seis tabelas permanece 1–2 minutos; o ensaio local
anterior de aproximadamente 97 segundos não comprova esse tempo ao vivo. Medir repetições e variantes sem receita
idêntica, preservando conteúdo e validação. Não prometer tempo de actions com base no ensaio de dados.

## 8. O que já está decidido e o que ainda precisa de prova

Há evidência suficiente para começar A–D sem outra rodada ampla de investigação. Estão identificados o fluxo a
refatorar, as entradas a restringir, os erros a corrigir, a autoridade do contrato e o protocolo de retomada.

Ainda são provas de implementação, não pontos a presumir resolvidos: integração do host para origem/autorização e
permissões; armazenamento durável sob falha; execução vinculada ao presenter com troca de contexto; recuperação no
intervalo entre mutação e diário. A restrição de ferramentas precisa ser verificada no ambiente real de entrega.

Actions continuam sendo o marco seguinte. Autorizações por role/registro/campo, transações, efeitos e semântica de
consultas exigem contrato e testes próprios. Não certificar esses comportamentos com Verify nem com busca textual
por `CheckRole`; capacidade não suportada deve bloquear explicitamente esse escopo. O fluxo de dados não pode
emitir conclusão de uma tarefa maior que também exige actions ainda não comprovadas.
