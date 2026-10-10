# Plano production-grade: criar / editar / refatorar / diagnosticar (2026-09-04)

Escopo: Data, Logic, Process e Screens, para Reactive, Traditional e Mobile (O11). ODC depois.
Base: manifesto (docs/MANIFESTO.md), modelo de verbos (modelo-de-verbos.md), arquitetura (arquitetura-produto.md).

## Definicao de pronto (vale para toda celula)

1. Teste offline verde: cria num fixture, Verify zero, salva, recarrega igual (chave, objetos, mensagens).
2. Prova viva no lab (SS3 + personal): merge automatico no Studio e publish sem erro. Semanal por familia.
3. Linha gerada no mapa de capacidades (familia x operacao x runtime), com link para o teste.

## Fase 0: Fundacao (semana 1)

| Entrega | Criterio |
|---|---|
| ADRs 001-006: hibrido+merge, sala limpa, verbos, adaptadores por build, distribuicao/IP, corpus | aprovados |
| Repo do produto nas camadas (adapters, kernel, spec, compiler, worker, bridge, cli, sdk, mcp, tests, docs) | CI rodando os testes offline |
| Extrator de catalogo (OutSystems.Model.V1.dll instalada -> JSON por build) | interfaces, propriedades, Create*, genericos, enums; diff entre builds |
| Runtime generico: Create/Set/Link/Move/Duplicate/Delete + Get/Find | dirigido pelo catalogo; erro em propriedade/tipo invalido |
| Gerador de provas: 1 exemplar por tipo criavel num fixture, Verify, save, reload | relatorio = mapa de capacidades v0 |
| Fixtures: 15 modulos oficiais (medidos por cobertura) + 1 fixture proprio por familia | versionados fora do pacote |
| Camada de convencoes com as regras ja conhecidas | testes |

## Fase 1: Data (semana 2)

Runtimes: o modelo de dados e comum; Mobile acrescenta Local Storage (client entities) e Reactive/Mobile client variables.

| Operacao | Escopo | Como |
|---|---|---|
| Criar | entidade, atributo, static com records, structure, indice, site property, session/client variable, local storage entity | catalogo + convencoes; indice via Framework se a API nao expuser |
| Editar | tipo, tamanho, obrigatoriedade, default, ordem, descricao, mover para folder | Set/Move |
| Refatorar | rename com religacao (testar se Set(Name) religa expressoes e SQL), trocar tipo com usages, apagar com verificacao de usages | Usages + Set/Delete |
| Diagnosticar | mensagens com explicacao, usages, diff de entidade | Messages/Usages/Diff |
| Aceite | spec Temporada (9 entidades, 3 static, structure) do zero e por edicao; local storage num fixture Mobile | |

## Fase 2: Logic (semanas 3-4)

| Operacao | Escopo | Como |
|---|---|---|
| Criar | server/client/service/screen actions; os 39 tipos de no por runtime (server: aggregate, SQL, if, switch, foreach, assign, raise, handler, run action, send email, excel, json; client: js, refresh data, execute client/server action, message, destination, download; traditional: ajax refresh, preparation); aggregate completo (join, sort, group, calculado); exceptions e handlers; roles; timers com schedule; emails; REST/SOAP consumir e expor; service actions | catalogo + convencoes + FlowLayout |
| Editar | qualquer propriedade de no; inserir/remover no no meio do fluxo religando; trocar argumento | Set/Link/Move |
| Refatorar | rename com religacao; extrair para action (Duplicate+Delete ou reparent, conforme a API); inline; mover trecho; converter tipo de action | Duplicate/Delete/Link + adaptadores |
| Diagnosticar | mensagens, usages, diff de fluxo, "explain error" com correcao sugerida | catalogo de VerifyMessageId |
| Aceite | 10 actions da Temporada por spec; cenarios do SSAM (KKR Time Entry, GameStore, hospital) reconstruidos por spec; publish + chamada HTTP das actions expostas | |

## Fase 3: Process / BPT (semana 5, 3 dias)

Criar: processo, start/conditional start, human activity (com tela), automatic activity, wait, decision, send email,
execute process, callbacks e triggers de entidade. Editar/Link como em Logic. Aceite: processo de aprovacao de
reserva no fixture, publicado, instancia disparada por Create de entidade.

## Fase 4: Screens por runtime (semanas 5-8)

| Runtime | Escopo |
|---|---|
| Reactive | UI flow, screen, block, ~40 widgets, placeholders, layout do template, tema, eventos e handlers, data actions e aggregates de tela, client actions, roles na tela, OutSystems UI patterns (lista, formulario, dropdown, tabela paginada) |
| Mobile | o mesmo + local storage e padroes de sync; plugins nativos fora de escopo |
| Traditional | web flow, web screen, preparation, screen actions, web block, RichWidgets, ajax refresh, layout London/Dublin |

Operacoes: criar tela inteira por spec; editar (inserir widget num placeholder, trocar propriedade, religar evento);
refatorar (extrair para bloco, trocar widget preservando filhos, mover widget); diagnosticar (mensagens, usages,
preview por Chrome CDP com screenshot e comparacao, reimplementado pequeno). Convencoes de tela vem dos
templates oficiais (arvore, placeholders, nomes). Aceite: UI da Temporada (busca, detalhe, reserva, carteira,
admin) por spec, publicada e verificada visualmente; equivalente minimo em Mobile e Traditional.

## Fase 5: Refatoracao e diagnostico transversais (semana 9)

Adaptadores do Studio com teste: rename/replace/usages/conversoes; merge em modo dialog para conflito real;
catalogo de mensagens com explicacao e correcao; lint (convencoes como regras antes de gravar); Diff em JSON.

## Fase 6: Spec e compilador (semanas 10-11)

Spec v0 (data+logic) e v1 (+screens), versionada, com schema; compilador spec -> verbos; teste reverso
modulo -> spec -> modulo nos 15 fixtures; ferramentas MCP e SDK geradas do catalogo; journal e receipt por job;
laco publish + prova HTTP.

## Fase 7: Endurecimento (semanas 12-13)

Matriz de builds do Studio (11.55.x e o proximo), corpus de regressao (leitor nos 2.000 OMLs a cada build),
desempenho (teto: maior modulo em menos de 10 s), licenca e ofuscacao, telemetria opt-in sem OML/credencial,
revisao de seguranca e juridica (EULA), docs de usuario. ODC: adaptador proprio, fase seguinte.

## Riscos e respostas

| Risco | Resposta |
|---|---|
| Build novo do Studio quebra adaptador | matriz de builds + leitor no corpus a cada build; adaptador por build |
| API nao expoe algo (indice, reparent) | Framework direto atras de adaptador, com teste; nunca reflexao solta no produto |
| Convencao de tela "valida mas feia" | fixtures oficiais + lint + preview visual |
| Modulo gigante (150k objetos) | teto medido: load 9,5 s; worker por modulo; paralelismo por modulo |
| SSO / ODC | export pela sessao do Studio (feito); OpenID headless e ODC em fase propria |
| Juridico | nada da OutSystems no pacote; leitura da EULA antes de vender |

## Ritmo

No ritmo de 2026-09-03 (uma pessoa + agente), cerca de 13 semanas para o escopo inteiro; telas sao metade disso.
Cada fase termina com a linha do mapa gerada e a prova viva no lab.
