# Controle excepcional C# em actions nativas

Estado em 2026-09-08: emissores de `try/catch/finally`, filtros, frames capturados e busca/unwind integrados ao compilador, com transporte ABI3 de identidades de excecao. A prova nativa do corpus original passou por Verify, recarga e merge; execucao publicada e entrada padrao sem contexto ainda sao gates separados. Isso nao registra conclusao de Logic.

A primeira execucao publicada, versao5035 em ZZExceptionControl_CS pessoal, teve7/12 casos aceitos pelo SDK e5falhas de fechamento do grafo, embora os valores nativos fossem corretos. A reproducao com armazenamento compartilhado de listas gerou os mesmos5casos; a correcao congela as contagens de identidades originais antes da chamada, em todas as arenas. A suite completa do frontend passou921+6skips e tres fixtures nativos passaram Verify/recarga/merge apos a correcao. A versao5036 confirmou12/12 casos ao vivo pelo SDK estrito, preservando estado/identidade e recusando autenticacao invalida;51arquivos de runtime permaneceram iguais desde o build unico. A5035 permanece evidencia de falha, sem afrouxar o SDK ou alterar fonte/expectativas. Isso comprova execucao staged deste corpus, nao a ativacao padrao ou uso cego.

## Invariantes da linguagem

A busca percorre handlers ativos e avalia filtros antes de executar os `finally` atravessados. Um filtro que falha equivale a falso, preservando seus efeitos anteriores. A expressao de retorno e avaliada antes do `finally`; uma nova falha no `finally` substitui a transferencia pendente. `throw;` usa a excecao originalmente capturada, mesmo quando a variavel do catch foi reatribuida. Referencia: [especificacao C#, try statement](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/statements#1311-the-try-statement).

Isso exclui uma traducao que execute todos os `finally` ao simplesmente receber `Completion.Kind = 2` de uma chamada. Nesse momento, um filtro do caller ja deveria ter observado o estado anterior ao `finally` do callee.

## Estado verificado

- Construir uma excecao aloca sua identidade; `throw e` e `throw;` preservam o handle apropriado. A busca de filtros ocorre no ponto da falha antes dos `finally` suspensos. Catches aceitam os tipos BCL representados, inclusive recebidos por parametros e nao construidos na fonte.
- O controle tem 17 provas CLR/probe, dois diagnosticos explicitos e seis adversariais independentes. O SDK ABI3 tem 77 testes; a ligacao compilador/SDK/probe tem 24 casos de identidade, listas/arrays, payloads e rejeicao antes de efeitos. Gate frontend integrado: 877 aprovados, 6 skips antigos. Esses numeros nao medem cobertura percentual.
- Helpers de instancia e recursao passaram no modelo nativo sem alterar a fonte: 10129 assercoes para InstanceMethods e 5195 para ExceptionValues; gate root de recursao/binding/replacement/construcao: 58/58. O Core declara assinaturas de um componente recursivo antes dos corpos; nao reescreve recursao em interpretacao.
- A fonte original ExceptionControlFlow gerou 11 endpoints ABI3, com 47140 assercoes independentes, Verify sem mensagens, recarga, merge e repeticao sem delta. ExceptionGraph gerou 3 endpoints, 4566 assercoes e os mesmos gates. Os 12 casos originais tambem passaram por CLR e SDK/entrada gerada/probe, mais um caso de tipo de excecao recebido externamente. Retorno, estado e identidade coincidem; origem fisica em linha e comprovada somente pelo CLR. Execucao publicada permanece separada.
- O gate completo do Core em `.local/data-logic-translator/candidate-core-scheduling-frozen-20260908-0407` terminou com 1032 aprovados e uma falha de assinatura sintetizada no Hire. A causa foi corrigida e o job original mais os testes focados passaram; uma nova suite completa do candidato atual continua pendente. Nao equivale a instalacao ou publicacao do compilador atual.

## Representacao compilada

Sao usados registros, listas, condicoes e chamadas nativas. Nenhum texto de expressao, AST, assembly autoral ou programa de opcodes e executado por um interpretador em runtime.

1. **Objeto de excecao.** Construcao aloca uma identidade no pool de excecoes. Campos, variaveis, argumentos e catch locals carregam esse handle. Lancar o objeto usa a identidade existente; lancar um guard sintetico ainda cria uma identidade nova. Tipo, payload e origem do lancamento sao dados, nao instrucoes. A hierarquia de tipos usada por catches sera derivada dos simbolos resolvidos pelo compilador.
2. **Frame tipado.** Cada metodo/regiao possui os slots necessarios para capturas, retorno pendente e contexto de catch. Toda leitura/escrita de um simbolo capturado usa seu frame; nao existe copia local paralela capaz de ficar desatualizada quando um filtro executa enquanto o caller aguarda o callee.
3. **Regiao ativa.** Um registro identifica a regiao compilada, sua ativacao/frame, ancestral e estado: try, catch, finally ou barreira de filtro. Duas chamadas recursivas da mesma regiao possuem ativacoes distintas.
4. **Transferencia interna.** Um resultado privado distingue continuacao normal, retorno, falha ja selecionada, break e continue, incluindo o alvo lexical quando necessario. O valor retornado fica num slot do tipo original. Esse controle interno nao sera exposto como um formato que a LLM deva escrever.

O inventario de regioes/capturas antecede a emissao de corpos. Identidades de helpers derivam de simbolos e locais de fonte; nao podem renomear endpoints existentes pela simples adicao de um helper.

## Busca sincronizada no lancamento

O ponto de lancamento inicia a busca sem executar cleanup. O dispatcher percorre regioes ativas da mais interna para a externa. Comparacoes de tipo e ordem de catch sao conhecidas na compilacao. Cada filtro e uma action privada com corpo traduzido para widgets, chamada por um ramo estatico do dispatcher.

O filtro recebe a ativacao correta e devolve o contexto atualizado. A busca registra o handler escolhido ou a saida sem handler. Esse resultado acompanha a falha durante o unwind; callers nao repetem a busca sobre a mesma ocorrencia.

Uma avaliacao de filtro instala uma barreira propria. Falhas em chamadas feitas pelo filtro podem usar seus handlers internos normalmente. Se escaparem ate a barreira, o unwind executa apenas os cleanups dessas chamadas, o filtro resulta falso e a busca original continua. O handle da excecao original e preservado separadamente da falha temporaria. Efeitos do filtro e de seus cleanups permanecem visiveis.

## Unwind por regioes

Corpos de try/catch/finally podem ser emitidos como helpers privados com transferencia estruturada. O wrapper executa somente os `finally` das regioes atravessadas. O `finally` do try cujo catch foi selecionado executa depois desse catch.

- Retorno: avaliar/converter uma vez e armazenar antes do unwind. Mudancas posteriores num objeto retornado continuam visiveis por identidade; o escalar ja calculado nao e reavaliado.
- Break/continue: traduzir `IBranchOperation.Target` para alvo lexical. Consumir a transferencia no loop correspondente, respeitando os cleanups intermediarios. Continue de for executa o incremento uma vez; break nao o executa.
- Rethrow: usar `CaughtExceptionRef` da ativacao do catch, separado da variavel que a fonte pode reatribuir. Lancar outra referencia e uma nova ocorrencia de lancamento.
- Finally com falha: desativar a propria regiao antes de executa-lo. Uma nova falha inicia outra busca a partir daquela posicao e substitui a transferencia anterior, sem inventar `InnerException`.

A pilha de chamadas nativas pode continuar ativa durante a busca sincronizada. Nao e necessario serializar toda a execucao do metodo em um programa interpretado.

## Pontos de integracao

- `ReferenceModel` inventaria tipos de excecao, componentes com controle excepcional, frames e regioes antes dos corpos.
- `LogicModel` registra os helpers privados de regiao/filtro antes de resolver as chamadas, inclusive referencias adiantadas.
- `MethodCompiler.Statement/Throw/Loop/Enumerate` distinguem fallthrough estatico da transferencia dinamica. O bool atual nao sera sobrecarregado com todos os estados.
- `MethodExpressions` e os acessos a locals/params usam os slots capturados quando a regiao exigir.
- `FinishReference`, `PropagateReferenceCall` e os emissores de guard encaminham ocorrencias com a regiao e origem do ponto correto. O passe tardio `NormalizeReferenceRaises` hoje perde essa informacao lexical; sua substituicao deve ocorrer no emissor ou preservar metadata interna suficiente ate o lowering.
- Efeitos opacos, incluindo SQL e primitives, precisam de uma fronteira que converta a falha nativa em falha representada no ponto correto. Um handler global envolvendo o metodo inteiro chegaria tarde demais e nao comprova preservacao de contexto.

## Transporte, transacoes e limites que continuam abertos

Excecoes em campos/argumentos/resultados exigem identidade compartilhada com a excecao efetivamente lancada no caller. O transporte ABI3 integrado usa a arena `Exceptions` como parte do mesmo grafo e usa sua identidade em `Completion.ExceptionRef`; o SDK reconcilia o estado antes de lancar exatamente essa instancia. `AvGraphAbiIn/AvGraphAbiOut` negociam versao3 antes do corpo. O codec ABI2 e os metadados congelados antigos permanecem legiveis sem mudar seu contrato. A ativacao pela entrada padrao do controlador continua pendente. O contrato completo e os limites estao em [exception graph ABI](2026-09-08-exception-graph-abi.md).

Origem logica em source map e frame CLR fisicamente executado sao evidencias diferentes. O alvo executa widgets traduzidos. Uma comparacao de `originLine` precisa indicar se observa metadata de origem ou stack real, sem apresentar uma como prova da outra.

Falha nao tratada em uma requisicao e rollback de banco tambem sao contratos separados. O throw CLR depois de uma resposta HTTP nao desfaz uma transacao ja concluida no servidor. A fronteira correta de rollback depende do owner da requisicao/transacao; helpers locais e filtros nao podem iniciar rollbacks prematuros. Ainda nao existe prova de write-then-throw com rollback para o caminho de grafo.

Construtores de exceptions definidos pela fonte, payloads personalizados, dispatch virtual/heranca de objetos, structs como receivers e chamadas entre modulos/servicos com filtros sao requisitos adicionais a mapear. Diagnostico explicito preserva o contrato enquanto o lowering correspondente estiver ausente; nao constitui conclusao da cobertura.

## Aceitacao

As fontes e expectativas em `tests/csharp/exception-control-flow` (12casos) permanecem imutaveis. O corpus independente `tests/csharp/exception-search` acrescenta seis casos, com expectativas congeladas antes do primeiro run;6/6passaram no CLR sem ajustes. Nenhuma dessas provas CLR estabelece traducao nativa.

Os novos casos distinguem a arquitetura correta: filtro do caller antes do finally do callee; alteracao de local escalar capturado; nova busca causada por falha de finally; filtro que falha atraves de helper com finally; reatribuicao do catch local seguida de throw sem operando; ativacoes recursivas da mesma regiao.

A leitura das fontes adicionais tambem identifica dependencias reais de autoria: funcoes locais, closures/delegates (`Action cleanup`) e colecoes de observacao como `Dictionary`. Esses recursos nao podem ser tratados como ja implementados por termos aprovado a ordem de eventos no CLR. O driver console e parte do harness; sua execucao nao substitui a traducao do corpo observado. O recorte da prova nativa e qualquer adapter de teste devem ser explicitos, mantendo as fontes e expectativas congeladas intactas.

Cada fonte deve passar, sem reescrita para acomodar o tradutor, pelo oraculo CLR, probe de semantica emitida, Verify/recarga/inspecao independente/merge e execucao publicada de laboratorio. Testes de transporte e persistencia devem cobrir as respectivas fronteiras. A prova de uso por agente sem contexto atraves da entrada publica continua sendo um gate separado.
