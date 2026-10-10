# Mapa de capacidades: plano (2026-09-04)

Regra numero um: nenhuma celula do mapa e preenchida por tentativa e erro. Cada celula comeca lendo a API
(OutSystems.Model.V1 instalada, comandos do Studio quando a API nao cobre) e termina com um teste cujo juiz e
o Verify do proprio Studio. E a diferenca entre hoje e a era do Harmony.

## A matriz

Linhas (familias): Data (entidade, atributo, static com records, structure, indice, site property); Logic
(server/client/service actions, os 39 tipos de no, aggregate com join/sort/group/calculado, SQL, exceptions,
roles, timers); Process (processo, atividades, gatilhos); Screens (UI flow, tela, bloco, ~40 widgets,
placeholders, eventos, data actions, tema, JS); Integracao e referencias (REST consumir/expor, SOAP,
extensao, add/refresh de dependencia).
Colunas (operacoes): criar, ler, editar, apagar, refatorar (rename com religacao, extrair, mover, inline,
converter), diagnosticar (mensagens com explicacao, usages, diff).
Estados por celula: PROVADA (teste offline + prova viva), API-EXISTE (nao provada), ADAPTADOR (so comando do
Studio). Estado em 2026-09-04: Data e Logic com "criar" provado; "editar" coberto pelo merge; resto vazio.

## Ordem de preenchimento

1. Catalogo mecanico da API: comando que reflete sobre OutSystems.Model.V1.dll (instalada, nao decompilada)
   e gera JSON com interfaces, membros, Create*, tipos de no, widgets. Regeneravel por build. ~0,5 dia.
2. Leitura de tudo: leitor generico modulo -> JSON pela API, rodado nos 306 OMLs do ambiente, com round-trip
   load/save/reload. Prova a coluna "ler" inteira com corpus real. ~1 dia.
3. Criacao por familia no ModelBuilder: Logic (nos que faltam, aggregates completos), Process, Screens.
   Teste offline com Verify zerado por familia + prova viva semanal (merge + publish no lab).
4. Refatoracao por delegacao aos comandos do Studio (rename, usages, replace, conversoes) com adaptador e
   teste; extrair action/patch JS migram do SSAM.
5. Diagnostico: VerifyMessageId -> catalogo com explicacao e correcao; referers -> "quem usa". Semente: a
   lista de armadilhas de 2026-09-03 e os logs de friccao do SSAM (como requisitos, nunca como codigo).

Estimativa no ritmo atual: Data+Logic 1 semana, Process 2 dias, Screens 1 semana, integracao/referencias
3 dias, diagnostico em paralelo. O mapa e um arquivo unico gerado dos testes: documentacao viva do produto.
