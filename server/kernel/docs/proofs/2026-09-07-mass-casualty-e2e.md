# Mass-Casualty (CSV): análise e E2E comparado

**O fluxo principal de criação funciona; a equivalência completa ainda não está aprovada.** A página publicada recebeu CSVs sintéticos pelo Chrome, executou as chamadas reais e criou os rascunhos esperados. Permanecem problemas de integração dos campos, responsividade e tratamento de erros.

Teste de 7 de setembro de 2026 no módulo `DCIPS_Migration_PoC_UI`, ambiente EC2 do DCIPS, comparado com o legado local. Snapshot de leitura no SS4. Não houve alteração do app, merge ou publicação nesta análise.

## Resultados executados

| Cenário | Legado | OutSystems |
|---|---|---|
| CSV vazio, sem cabeçalho obrigatório ou apenas cabeçalho | Envio bloqueado | Igual |
| Cabeçalhos com espaços e diferenças de maiúsculas | Aceitos | Igual |
| Vírgula entre aspas e aspas escapadas | Interpretadas corretamente | Igual |
| Coluna desconhecida | Ignorada | Igual |
| Linha sem campo obrigatório junto de linha válida | Erro por linha; apenas a válida elegível | Igual |
| Prévia de 200 e 201 linhas | 200 habilita; 201 bloqueia | Igual; não foram gravadas 200 linhas |
| Upload por seletor de arquivo | Carrega a prévia | Igual |
| Download do template | Arquivo com cabeçalho e três exemplos | Conteúdo idêntico |
| Arrastar arquivo para a área do CSV | Carrega a prévia | **Não carrega** |
| Campo CSV entre aspas contendo quebra de linha | Divide incorretamente em duas linhas | Mesma limitação |
| Local obrigatório vazio | Botão desabilitado | Igual |
| Data futura, envio real | Recusa explicando a data inválida | Recusa, mas apresenta erro genérico de repetição |
| Duas linhas com `gender` maior que dois caracteres | Zero criações; erros por linha | Igual |
| Duas linhas válidas | Dois rascunhos e duas pessoas | Igual, confirmado na base |
| Dois cliques disparados no mesmo ciclo | Uma requisição | Uma requisição |
| Repetição da requisição com a mesma chave | Devolve resultado anterior | Igual; sem novos registros |
| Lote com uma linha válida e uma inválida no servidor | Apenas a válida criada | Igual na persistência independente |
| Clear | Limpa CSV e mantém metadados do incidente | Igual |
| Single-casualty form | Abre formulário individual | Abre `NewCasualtyReport`, carregamento confirmado |
| Cancel | Vai para Cases | Vai para Dashboard: diferença de navegação |

O lote misto do OutSystems foi gravado, mas a captura de sua resposta foi interrompida por um erro do cliente de teste ao preparar o replay HTTP/2. A leitura independente confirmou a criação da linha C e a ausência da linha D inválida. O replay nativo foi depois executado pela sessão do navegador e retornou os mesmos IDs do primeiro lote. Isso não é tratado como prova de concorrência entre usuários.

## Persistência e preservação

- OutSystems: **três pessoas e três rascunhos novos**, relatórios `CR-2026-00048`, `CR-2026-00049` e `CR-2026-00050`; pessoas 58–60. Os dois primeiros compartilham o mesmo `IncidentGroupId`; o terceiro pertence ao lote misto.
- Legado: **três pessoas e três rascunhos novos**, relatórios `CR-2026-00026` a `CR-2026-00028`.
- Massa identificada por `TRN-MC-E2E-0907`, nomes `TRN-MC-E2E-A/B/C` e EDIPI sintéticos `990907101..990907104`. A linha D foi recusada. Os três rascunhos de cada ambiente permanecem identificados como evidência, sem colocá-los na fila de aprovação.
- Comparação integral antes/depois: todos os registros preexistentes de pessoas e relatórios permaneceram iguais nos dois ambientes. No OutSystems, também foram preservadas todas as auditorias anteriores; houve três novas auditorias de lote.
- Conferidos 28 valores de identidade nos dois sistemas, além de data, país, tipo, status, lesão e observações dos dois relatórios válidos. Vírgulas e aspas nas observações foram preservadas.
- Data de nascimento sintética: envelope `demo-v1` presente quando informado, ausente quando omitido, conforme a simulação autorizada para a PoC. Não foi testada a decifragem de retorno nem se afirma proteção de produção.

## Problemas a corrigir

1. **Contrato entre importação e aprovação.** Os relatórios criados contêm `IncidentTypeText = Training simulation`, mas `IncidentType` está vazio. O SQL `Approval_GetContext / ReadDetails`, confirmado no snapshot do CS, lê `r.[IncidentType]`. A importação também preenche `IncidentGroupId`, mas deixa `MultiCasualtyIncident` vazio, justamente o campo lido pelo detalhe. O dado do grupo não se perdeu; os produtores e consumidores usam campos diferentes. Corrigir o mapeamento comum e provar o detalhe com um relatório criado por CSV. Esta conclusão combina persistência real e leitura do consumidor; não foi executada aprovação desses rascunhos.
2. **Mobile.** Em 390 CSS px, o título chega a aproximadamente 418 px na horizontal e ultrapassa o contêiner. O cabeçalho global e o botão Upload CSV também ficam cortados. O legado quebra o título e os botões em linhas. O conteúdo nativo usa rolagem interna; conferir apenas `document.scrollWidth` não detecta todos esses cortes.
3. **Erro de validação apresentado como falha transitória.** Uma data futura resulta em “Unable to confirm the submission. Please retry the same batch…”. Repetir não resolve uma data inválida. Preservar a mensagem de validação do servidor e reservar o texto de resposta incerta para falhas de transporte.
4. **Drag-and-drop ausente.** A mesma ação de soltar o arquivo carrega o CSV no legado e deixa a entrada vazia no OutSystems. O seletor de upload funciona.
5. **Acessibilidade do resultado.** O legado possui região `aria-live="polite"` para anunciar o resultado; nenhuma região `aria-live` foi encontrada na página nativa nos estados inspecionados. Testar anúncio de sucesso/erro e teclado ao corrigir os componentes.
6. **Navegação e identificação.** Cancel aponta para Dashboard em vez de Cases. O cabeçalho nativo mostra “PoC User / Reporter” apesar da sessão administrativa usada no teste. A identidade persistida foi o usuário nativo 24; o texto do cabeçalho não prova o perfil efetivo no servidor.

No desktop, a composição principal está próxima do legado. Diferem alturas, espaçamentos e cabeçalho. Os rótulos adicionais detectados na leitura textual estão ocultos visualmente: **não constituem duplicação visual confirmada**. Também não se concluiu que o resultado está visualmente quebrado apenas por seu texto concatenado no DOM; a comparação do estado de sucesso merece captura própria na correção.

Há limitações compartilhadas com o legado: CSV multilinha não é interpretado corretamente, a prévia aceita qualquer texto não vazio em `service_branch`, e o legado afirma que rascunhos já estão na fila de aprovação. A aceitação de ramo desconhecido pelo servidor não foi exercitada; rascunho criado não equivale a relatório submetido.

## Evidências e limites

[Prova estruturada](2026-09-07-mass-casualty-e2e.json) contém resultados, IDs, comparações e hashes dos artefatos locais. Capturas com larguras CSS equivalentes, compensando o zoom diferente por origem:

- [Desktop OutSystems](mass-casualty-e2e-2026-09-07/native-1440.png) e [desktop legado](mass-casualty-e2e-2026-09-07/legacy-1440.png).
- [Mobile OutSystems](mass-casualty-e2e-2026-09-07/native-390.png), [área de upload mobile](mass-casualty-e2e-2026-09-07/native-mobile-bottom.png) e [mobile legado](mass-casualty-e2e-2026-09-07/legacy-390.png).

Executores e evidências brutas em `.local/mass-casualty-e2e/`: `browser.cjs matrix`, `submit.cjs valid`, `extra.cjs`, `recover.cjs`, `visual.cjs`, `persistence.py before|final` e `make-proof.py`. Contêm operações de criação sintética; não são uma suíte para repetição cega sobre qualquer ambiente.

Não foram provados: inserção efetiva de 200 linhas, concorrência multiusuário, rollback sob falha de banco induzida, todos os perfis, retenção/auditoria em todos os cenários, nem o ciclo posterior de aprovação. A tentativa adicional em contexto anônimo não produziu uma página utilizável devido à navegação/certificado e foi considerada inconclusiva. O teste realizado cobre o fluxo principal e os cenários acima, sem afirmar cobertura universal.
