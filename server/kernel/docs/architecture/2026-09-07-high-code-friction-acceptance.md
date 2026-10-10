# Aceitacao de autoria high code com pouca friccao

Cobertura nativa e comportamento correto sao necessarios, mas nao suficientes. A LLM escreve a regra na linguagem que conhece; o Hybrid assume representacao nativa, identidade, referencias, bindings, entrega e retomada. Uma sessao sem historico precisa conseguir usar a entrada publica com pouca orientacao.

## Duas provas distintas

- Regressao semantica independente: comparar fonte C# executada, traducao e resultado nativo. O autor dos casos pode auditar o codigo. Isso testa o compilador; nao prova facilidade de uso.
- Uso cego: outra sessao recebe somente o pedido de negocio, alvo autorizado e documentacao publica minima. Nao recebe conversa, contratos intermediarios, receitas do caso, dicas sobre arquivos internos ou instrucoes para contornar lacunas. Usa as ferramentas publicas normais.

O corpus `tests/csharp/cold-data-materialization` pertence ao primeiro grupo. Seu autor entrou sem historico, mas investigou a implementacao antes de escrever os casos. Os treze resultados CLR e a compilacao desse corpus nao devem ser apresentados como aprovacao do segundo grupo.

## O percurso do teste cego

Criar entidades relacionadas, enums e logica; alterar uma regra; diagnosticar e corrigir um defeito; refatorar um elemento com consumidores; consumir outro modulo sem escrever bindings; retomar uma falha operacional; entregar e verificar o comportamento publicado no laboratorio. A fonte e os criterios de negocio ficam congelados antes da primeira tentativa. Nao reduzir o caso depois para produzir um sucesso aparente.

A publicacao de laboratorio deve estar autorizada na preparacao. Uma aprovacao operacional previamente exigida nao conta como falha de autoria.

## Medidas por tentativa

Registrar sucesso funcional e de entrega, defeitos, intervencoes do coordenador, informacao extra solicitada ao humano, alteracoes da fonte motivadas por limitacoes da ferramenta, chamadas de ferramentas, tokens medidos quando disponiveis, documentacao lida e tempo. Separar autoria, ferramentas, servidor e retrabalho. Testes aprovados nao sao percentual de cobertura nem medida de friccao.

Intervencoes em jobs, bindings, bridge, DLLs ou codigo interno para fazer o caso funcionar sao falhas do caminho publico. Uma nova tentativa pode validar uma correcao do produto, mas preserva o registro da falha anterior. Nao orientar o agente cego a escrever para uma representacao interna.

## Definicao de pronto

Exigir a prova semantica/nativa/publicada e a prova cega pela entrada publica. Zero intervencoes sobre mecanismos internos e nenhuma autoria obrigatoria de jobs/bindings sao criterios obrigatorios. Mostrar o custo observado de uso; limites numericos de tempo/tokens devem ser definidos antes da rodada, nunca retroativamente.

Enquanto SourceAbi, controlador e consumidores estiverem em integracao, provas por entradas internas permanecem identificadas como tais. Elas nao liberam a experiencia completa de autoria.

## Meta de desempenho proposta para trinta actions

Para um modulo existente, fonte correta de trinta actions complexas e ambiente disponivel: de um a dois minutos entre fonte pronta e traducao/verificacao/merge revisavel no Studio. Se a autoria demorou cinco minutos, a meta total e seis a sete minutos. Com publicacao e testes de negocio definidos para o caso, a meta proposta e ate dez minutos no total.

Essa e uma meta de aceitacao, nao uma capacidade ja demonstrada. Congelar o caso completo (consultas, listas, ramos, excecoes, referencias e testes) antes da medicao; registrar primeira sessao e processo aquecido separadamente, sem esconder dependencias ou retrabalho. A falha de infraestrutura deve aparecer no tempo observado e ser identificada, nao apagada do historico.

O lote independente de treze metodos/25 actions geradas em 2026-09-07 levou 311075ms so em apply; Verify e recarga passaram, mas a prova independente identificou quatro diferencas causadas por dois nomes internos truncados. Esse resultado nao atende a meta. Correcoes de tamanho de nomes pertencem ao compilador; nao se exige renomeacao da fonte pelo autor. A causa do custo de apply precisa ser medida antes de otimizar.

A correcao de nomes passou a prova completa; em seguida, a reutilizacao de valores constantes de erros internos reduziu os nos sem remover guards. A prova otimizada levou 500302ms em fixture (214948ms apply, 249012ms merge), com 32825 assertions de contrato e nove de assinatura. No modulo vivo ZZColdData_CS, versao5024, os treze casos passaram executando SQL e comparando todas as linhas persistidas com o oraculo congelado. Essa entrega levou 157990ms em apply e 232432ms em merge; o cliente sofreu timeout aos120s e a retomada reconciliou a mesma operacao sem repetir a escrita. Sucesso funcional desse recorte, desempenho ainda acima da meta e uso cego ainda pendente. Os tempos de retomada isolados no recibo nao substituem o tempo total observado.
