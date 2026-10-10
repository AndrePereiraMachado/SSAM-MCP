# Recursao de chamadas nativas de actions

O contrato de `logic` aceita chamadas a propria action e chamadas mutuamente recursivas entre actions declaradas. Nao ha opcao de autoria, sintaxe adicional ou limite especial escolhido pelo compilador. As chamadas continuam sendo nos nativos `ExecuteServerAction` ou `ExecuteClientAction`, com assinatura, argumentos e outputs nativos.

`LogicOrder` calcula componentes fortemente conexos do grafo de chamadas declaradas, incluindo chamadas dentro de ramos, loops e handlers. Componentes sao emitidos em ordem de dependencias; dentro de um componente recursivo, a ordem da declaracao original desempata. Cada componente declara todas as actions e seus parametros/variaveis antes de compilar os corpos. Assim o binding de `Action` encontra todos os inputs e outputs e o runtime pode materializar os argumentos completos. Componentes aciclicos unitarios mantem a sequencia de operacoes anterior.

Todo o plano ainda e compilado e validado antes de qualquer mutacao nativa. As barreiras entre trechos de construcao e expressoes permanecem; as operacoes passam pelos mesmos verbos, na mesma transacao. Nenhuma verificacao nativa, guard, regra de acesso ou identidade de fonte e removida. O ciclo de chamadas nao cria assinaturas para destinos ausentes: referencias externas, tipos e parametros ainda precisam resolver.

As regras de execucao e owner continuam vigentes: server/data/Traditional nao chamam client; screen calls pertencem ao mesmo owner Reactive/Mobile; Traditional screen actions sao destinos de eventos; preparation e data action nao sao assinaturas chamaveis. Ciclos de jobs, composicao e referencias de produtores continuam sendo erros independentes.

Replacement continua usando o mecanismo existente. A prova verifica as keys `Action` e `Parameter` de cada chamada recursiva apos reload e merge, alem de preservar a identidade e a expressao de um consumidor externo. A contagem de consumidores preservados sozinha nao prova os bindings internos recriados.

`LogicRecursionTests` cobre self e mutual recursion com condicao de parada `N <= 0` e passo `N - 1`, listas de estruturas declaradas adiante, defaults de inputs, replacement, Verify, recarga, prova independente do contrato, merge e idempotencia. Tambem cobre ordem aciclica, uso unico dos ordinais de construcao e rejeicao de destino/tipo/kind invalido. Os antigos negativos que proibiam qualquer ciclo de actions passam a verificar assinaturas e bindings recursivos; os negativos independentes de owner, kind e ciclos de jobs sao preservados.

Essas provas de modelo nao executam as actions no servidor, nao provam terminacao de programas arbitrarios nem autorizam publicacao. Recursao estruturada remove a restricao de ordenacao no Core; nao implementa, por si, filtros, busca/unwind de excecoes ou qualquer frontend adicional.
