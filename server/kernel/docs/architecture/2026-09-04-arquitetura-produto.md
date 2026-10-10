# Arquitetura do produto (rascunho inicial, 2026-09-04)

Ponto de partida: as provas de 2026-09-03 (headless cria app/modulo/modelo/logica; Studio recebe por
merge de 3 vias com Ctrl+Z; spec inteira em 7 min). Objetivo: produto comercializavel sem perder o IP.

## 1. IP e risco juridico (pede advogado)

- Nunca distribuir binarios da OutSystems. O produto carrega as DLLs do Studio instalado e licenciado
  do cliente, na maquina dele (APP_CONTEXT_BASE_DIRECTORY + AssemblyLoadContext.Resolving).
- O decompilado NUNCA entra no repositorio do produto. Codigo do produto referencia so nomes de assembly,
  a API OutSystems.Model.V1 e reflexao por nome. Anotacoes de pesquisa ficam num repo privado separado,
  fora de qualquer build.
- Ler a EULA do Service Studio (engenharia reversa, automacao) com alguem do direito antes de vender.

## 2. O que e o IP e como proteger

| Ativo | Protecao |
|---|---|
| Linguagem de spec + compilador spec->modelo | nucleo fechado, ofuscado, so binario |
| Base de convencoes do Studio (as "armadilhas") como regras executaveis com testes | nucleo fechado |
| Protocolo snapshot/worker/merge | nucleo fechado |
| Adaptadores por build do Studio + matriz de builds testada | nucleo fechado |

Distribuicao: on-prem, binario protegido com licenca por chave; CLI/SDK finos; telemetria opcional que
nunca carrega OML nem credencial; nuvem so para licenca e atualizacao. SaaS com compilador na nuvem
protege mais o IP mas exporta o OML do cliente: descartado por padrao.

## 2b. Documentos irmaos

- docs/MANIFESTO.md: principios inegociaveis.
- docs/architecture/2026-09-04-modelo-de-verbos.md: os 17 verbos, catalogo e convencoes.
- docs/architecture/2026-09-04-plano-production-grade.md: fases, entregas e criterio de pronto.
- docs/architecture/2026-09-04-mapa-de-capacidades-plano.md: como o mapa e gerado.

## 3. Camadas

1. Adaptadores do Studio (um por build): prologo, presenter mock, load/save, merge. Unica camada que toca
   internals; cada build com bateria de provas no lab.
2. Kernel do modelo: ModelBuilder, FlowLayout, validacao com nomes, referencias. Funcoes puras sobre o Model API.
3. Spec e compilador: linguagem declarativa versionada (entidades, logica, telas) -> kernel. Absorve o Logic IR.
4. Worker e orquestracao: processos headless, base/foreign, paralelismo, journal/receipts.
5. Bridge no Studio (minimo): snapshot, merge, publish, preview.
6. Interfaces: CLI, SDK Python, servidor MCP (o cliente principal e um agente).

## 4. Estrutura de repositorio

Monorepo privado, um pacote por camada: `studio-adapters/`, `kernel/`, `spec/`, `compiler/`, `worker/`,
`bridge/`, `cli/`, `sdk-python/`, `mcp-server/`, `tests/` (offline sobre OMLs de fixture; integracao no
lab; e2e), `docs/` (ADRs, manifesto, diretrizes, runbooks). Pesquisa/decompilado em repo separado.
`GitSSAM-lab` e a semente, nao o produto.

## 5. Governanca

Manifesto (principios curtos): headless escreve, Studio recebe por merge; validar antes de gravar; todo
caminho provado vira funcao com teste; nunca distribuir nem logar o que e da OutSystems ou credencial;
nenhum internal sem adaptador e prova; um no por celula, nada na diagonal.
Diretrizes: ADR por decisao; "pronto" = teste offline + prova viva no lab + doc; matriz de builds.

## 6. Primeiras duas semanas

1. ADRs do que foi decidido em 2026-09-03: arquitetura hibrida, protocolo de merge, politica de
   adaptadores, politica de distribuicao.
2. Fundar o repo do produto nas camadas acima, com CI dos testes offline.
3. Spec v0 a partir de docs/specs/casas-temporada-data-model.md; compilador cobrindo dados e logica,
   escrito por cima do ModelBuilder. NAO hospedar os verbos do SSAM no worker (decidido 2026-09-04).
4. Depois: telas, conflito com editor de merge, ODC.

## 7. Politica de sala limpa em relacao ao SSAM (decidida com o dono, 2026-09-04)

Do SSAM nao vem codigo; vem prova. O que entra: (a) os cenarios ja construidos (KKR Time Entry, GameStore,
hospital, DCIPS, Temporada) como testes de aceitacao do produto novo; (b) os logs de friccao e a lista de
armadilhas como requisitos e casos de teste; (c) os formatos de spec que funcionaram (spec de negocio de 15
linhas, Logic IR) como candidatos a linguagem, reescritos sobre o ModelBuilder; (d) os padroes (journal,
receipt, prova por publish + HTTP, alvo por ambiente), reimplementados pequenos e com teste. O que fica para
tras: SSModelHandler/bridge de 69k linhas, ModelMirror, ModelCatalogV2, BatchModify, taxonomia de leitura,
emissor de clipboard. Regra: toda funcao comeca lendo a API, nao o SSAM, e termina com teste julgado pelo
Verify. Vontade de "copiar a parte que ja funciona" = celula do mapa ainda nao lida na fonte. O bridge antigo
serve o SSAM antigo ate ser desligado; o novo (MergeHandler, ~300 linhas) nao depende dele.
