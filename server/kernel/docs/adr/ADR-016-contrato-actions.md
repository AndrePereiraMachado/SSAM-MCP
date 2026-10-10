# ADR-016: cobertura declarativa de actions na mesma entrega

Data: 2026-09-05. Estado: implementado e validado no SS5; matriz nativa e prova viva registradas.

## Problema

O contrato controlado cobria dados. Um Verify verde não detectava a remoção de uma autorização, a troca de lista
por contagem ou a mudança da ordem de um commit. Permitir um job alternativo para corrigir isso devolveria à LLM
a escolha do caminho operacional.

## Decisão

Ampliar o contrato existente para `data`, `roles`, `exceptions` e `logic`. A ferramenta de proposta passa a chamar
`propose`, mantendo quatro ferramentas. Dados antigos são normalizados sem modificar o pedido persistido nem o
identificador da tarefa. O mesmo Delivery executa preparação, prova, merge e retomada.

`ModuleSpecification` valida o contrato e expande políticas de acesso para os passos existentes de logic. Não
foram criados verbos do kernel. Server actions públicas e service actions exigem autenticação explícita. As
políticas de parâmetro e de consulta usam o usuário corrente, roles declaradas e valores padrão restritos.

`LogicRequirements` constrói as obrigações a partir da declaração e percorre o grafo real do módulo. Não deriva a
prova dos ops emitidos pelo compilador. Compara parâmetros e tipos semânticos, expressões, chamadas, atribuições,
consultas e conexões. Reconhece junções e retornos de ciclos; recusa passos desconectados ou executáveis extras.
Comentários nativos, como o comentário criado pelo Studio em service actions, ficam fora do grafo executável.

`ModuleModel` planeja sobre o snapshot: reaproveita dados/roles/exceptions e só usa replace nas actions divergentes.
Inspeciona o conjunto de actions uma única vez, reutilizando o catálogo de símbolos e tipos durante a prova. Isso
evita reconstruir o catálogo para cada action em módulos grandes. A implementação e a prova usam os mesmos verbos
anteriores, sem um segundo mecanismo de entrega.

## Ampliação exigida pelo usuário

A amostra inicial de três actions foi recusada como critério de cobertura. A aceitação passou a exigir os widgets
concretos de action do catálogo, tipos simples/identificadores/registros/listas/estruturas aninhadas, inputs,
outputs, variáveis e chamadas entre actions server/service/client, nos contextos nativos pertinentes.

Os 13 widgets adicionais usam uma única tabela fechada (`LogicNodes`), sem expor verbos, chamadas arbitrárias à
API ou caminhos de mutação. Switch, handlers e comentários integram o mesmo compilador de fluxo. A conferência
continua lendo o grafo real independentemente dos ops. Screen actions e preparações apontam para owners existentes.

A matriz em `tests/contracts/action-coverage` é gerada por `scripts/gen_action_coverage.py`. Cada caso positivo
exige Verify, salvar/recarregar, merge nativo, prova independente, idempotência e uma alteração que continue válida
para Verify mas seja rejeitada pelo contrato. Rejeições de contexto não contam como suporte positivo.
`scripts/action_coverage_report.py` gera o mapa a partir da suíte e recusa caso ausente, falha, evidência incompleta
ou widget concreto sem prova. A interface base e o nó de decisão BPT são identificados à parte.

A investigação encontrou restrições nativas que o Verify anterior ao merge não mostrava: Public de client entity
e StartIndex de Refresh Data não sobrevivem ao merge deste build. O contrato os recusa antes da preparação.
A seleção de chamadas de lista usa as assinaturas de cliente quando cabível; handlers terminam em End separado.

408 testes .NET e 8 Python passaram. No SS5, 46 actions nos quatro tipos de módulo passaram por 3.978 verificações,
com um merge por contrato e retomada sem duplicação. Os 26 widgets concretos estão no mapa gerado.

Os números finais e recibos ficam no [comprovante](../proofs/2026-09-05-cobertura-actions.json) e no mapa gerado.
A amostra antiga fica como histórico, sem ser apresentada como aceitação da cobertura ampliada.

## Limites e próximos passos

A declaração inicial continua sendo uma interpretação. O certificado de fluxo não certifica toda a intenção de
negócio. Transições, efeitos obrigatórios e limites de transação precisam de contratos e testes próprios. Os
predicados sintéticos não substituem execução no servidor. A conferência de chamada/ordem de commit não prova
atomicidade entre actions remotas. SQL aceita conferência da declaração; escopo de proprietário automático em SQL
não é suportado. Entradas anônimas e autorização de servidor em client action são recusadas explicitamente.

O perfil opcional e a skill foram atualizados. A confiança dos hooks e a aceitação por conversa real com LLM
continuam pendentes; nenhuma confiança foi fabricada. O SS4 e os módulos Incidents do usuário foram preservados.
