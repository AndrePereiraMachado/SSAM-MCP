# Contexto fixo das sessões de app

Contexto fixo é o texto que toda sessão de app carrega e paga em todo turno: o `CLAUDE.md`, os guias que ele manda ler,
as instruções do servidor MCP `ssam` e os esquemas das ferramentas carregados por ToolSearch.
O modelo ocupa 62% do tempo ativo das sessões (`RELATORIO-SESSOES-NOVO-2026-10-05.md`). Este pacote mede esse texto e
corta o que a sessão de app não usa, sem mudar comportamento.

## Resumo

| Medida | Antes (`d0b92c6c`) | Depois (`pacote/contexto`) |
| --- | ---: | ---: |
| Início de sessão O11 que segue o guia | 57.697 B (~26,2 mil tokens) | 39.094 B (~17,8 mil tokens) |
| Início de sessão ODC que segue o guia | 74.756 B (~34,0 mil tokens) | 39.094 B (~17,8 mil tokens) |
| Instruções do servidor | 6.151 B | 3.079 B |
| 14 ferramentas centrais (select do C39) | 37.668 B | 32.979 B |
| 79 ferramentas (descrição + esquema) | 141.662 B | 136.973 B |
| Guias que a sessão de app recebe | `AGENTS.md` (13,5 KB) + guia do componente | `AGENTS.md` (2,9 KB), importado pelo `CLAUDE.md` |

Início de sessão = `CLAUDE.md` + guias lidos + instruções + select das 14 centrais.
A sessão ODC de antes somava `platforms/odc/AGENTS.md` (10,2 KB) e o `platforms/odc/CLAUDE.md` automático (6,8 KB).
Uma sessão que obedecia ao `kernel/CLAUDE.md` somava ainda cerca de 103 KB de `kernel/AGENTS.md`.

Por turno: −18,6 KB (~8,5 mil tokens) na sessão O11 e −35,7 KB (~16,2 mil tokens) na sessão ODC.

## Como medi

Transcrições: os 8 arquivos `*.jsonl` de `C:\Users\andre\.claude\projects\C--Users-andre-SSAM-Hybrid-novo`, só leitura.
Seis são sessões de app, uma é de desenvolvimento (`5f5cdb0f`) e uma está vazia (`286f877f`).

- Primeiro turno: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` da primeira resposta.
- Guias: cada `Read` de `AGENTS.md`, `CLAUDE.md`, `COMECE-AQUI.md` e dos guias de `kernel/` e `platforms/odc/`, e cada
  `CLAUDE.md` aninhado que o Claude Code carregou sozinho (anexo `nested_memory`).
- Esquemas: cada ToolSearch e o anexo `deferred_tools_record`, que traz nome, descrição e esquema de cada ferramenta carregada.
- Instruções do servidor: o anexo `mcp_instructions_delta` do `ssam`.
- Tokens: 2,2 bytes por token. Medi nas próprias sessões: o contexto do turno seguinte a um `Read` ou ToolSearch isolado
  cresce o tamanho do resultado (27 casos de ToolSearch, mediana 2,2; `Read` de texto, 2,0 a 2,5). Para texto do prompt de
  sistema a razão pode ser outra; os bytes são a medida firme.
- Token-turno: tokens de um texto vezes os turnos em que ele ficou no contexto, até a próxima compactação.

Na árvore: `node platforms/odc/scripts/contexto-fixo.mjs [--json]`. Sobe o servidor em processo e só lista as ferramentas
(sem Studio, sem worker, `SSAM_NO_WARM=1`), como os testes da fachada.

## O que as sessões pagaram

| Sessão | Turnos | 1º turno (tokens) | Guias lidos | CLAUDE.md automáticos | ToolSearch do SSAM | Guias carregados |
| --- | ---: | ---: | --- | --- | --- | ---: |
| `26c03dba` OfficePet | 55 | 55.023 | `AGENTS.md` 13,0 KB (t1) | nenhum | 4 cargas, 21 ferramentas, 55,8 KB | 0,32 mi (3,3%) |
| `4de42530` app reativo | 397 | 57.473 | `AGENTS.md` 10,8 KB + `platforms/odc/AGENTS.md` 10,2 KB (t12); `kernel/AGENTS.md` 56,8 + 46,3 KB (t33-34) | odc 6,8 KB x2; kernel x2 | 10 cargas, 18 distintas, 50,4 KB | 8,53 mi (4,4%) |
| `62a884e8` QuizApp | 207 | 57.766 | `AGENTS.md` 13,0 KB + `platforms/odc/AGENTS.md` 10,6 KB (t7) | odc 6,8 KB; kernel | 4 cargas, 17 distintas, 26,8 KB | 2,85 mi (4,2%) |
| `7ee58f10` HorseTinder | 430 | 57.476 | `AGENTS.md` 11,6 KB (t1); trechos de `kernel/AGENTS.md` | kernel x2; odc 6,8 KB | 10 cargas, 16 distintas, 68,2 KB | 2,82 mi (1,5%) |
| `890a2354` GameStore | 545 | 57.474 | `AGENTS.md` 10,8 KB (t1 e t340); `kernel/AGENTS.md` 56,9 KB (t346) e trechos | kernel x2; odc 6,8 KB | 14 cargas, 21 distintas, 75,5 KB | 9,98 mi (3,9%) |
| `dd2b79c0` Pet AI | 533 | 57.791 | `AGENTS.md` 13,0 KB (t1); trecho de `kernel/AGENTS.md` | kernel | 13 cargas, 20 distintas, 113,8 KB | 3,00 mi (1,2%) |

"Guias carregados" é em token-turnos, com a fração de todo o contexto da sessão entre parênteses.

O que isso mostra:
- O primeiro turno custa 55 a 58 mil tokens, e quase tudo é do próprio Claude Code: prompt de sistema (~12 KB),
  48 ferramentas embutidas e de conectores (170 a 183 KB). A parte do SSAM é pequena: `CLAUDE.md` 227 B, instruções
  2.071 B e 75 a 78 nomes de ferramentas adiadas (~2 KB).
- O `CLAUDE.md` mandava ler `AGENTS.md` e o guia do componente. As 6 sessões de app leram `AGENTS.md` (10,8 a 13,0 KB),
  4 delas no turno 1. Duas leram `platforms/odc/AGENTS.md` e receberam junto o `platforms/odc/CLAUDE.md` automático.
- O `kernel/CLAUDE.md` entra sozinho quando a sessão lê qualquer arquivo de `kernel/`, e mandava "ler AGENTS.md por
  inteiro antes de qualquer tarefa". Entrou em 5 sessões. Em 2 veio a leitura inteira de `kernel/AGENTS.md` (57 a 103 KB).
- Guias carregados somaram 27,5 milhões de token-turnos nas 6 sessões: 2,8% de todo o contexto (979 milhões).
- Os esquemas do SSAM vieram em 4 a 14 ToolSearch por sessão (16 a 21 ferramentas distintas), com recargas depois de
  compactação. Uma busca por palavra (`ssam module`) carregou 15 esquemas de uma vez (+27 mil tokens).
- As instruções do servidor tinham 2.071 B na pasta ativa. Na árvore integrada chegaram a 6.151 B.

A maior parte do contexto de cada turno é a própria conversa (resultados das ferramentas), não o texto fixo.
Aplicado às 6 sessões (2.167 turnos), este pacote tiraria cerca de 32 milhões de token-turnos, ~3,3% do contexto:
- guias: de 27,5 milhões medidos para ~3,0 milhões (o `AGENTS.md` novo, importado, em todos os turnos);
- instruções: −1,4 mil tokens por turno, ~3,0 milhões (diferença entre `d0b92c6c` e este pacote);
- ferramentas centrais: −2,1 mil tokens por turno depois do select, ~4,5 milhões (idem).

## Antes e depois, item a item

| Item | Antes | Depois | Como chega à sessão de app |
| --- | ---: | ---: | --- |
| `CLAUDE.md` (raiz) | 342 B (~155 tok) | 117 B (~53 tok) | automático, em todo turno |
| `AGENTS.md` (raiz) | 13.536 B (~6,2 mil tok) | 2.919 B (~1,3 mil tok) | antes: `Read` mandado pelo `CLAUDE.md`; depois: `@AGENTS.md` no `CLAUDE.md`, sem `Read` |
| `COMECE-AQUI.md` | 11.259 B (~5,1 mil tok) | 6.831 B (~3,1 mil tok) | guia humano; nenhuma sessão leu |
| `docs/DESENVOLVIMENTO.md` | não existia | 4.807 B (~2,2 mil tok) | só sessão de desenvolvimento |
| `kernel/CLAUDE.md` | 303 B | 377 B | automático ao ler `kernel/`; agora não manda ler o guia |
| `kernel/AGENTS.md` | 106.813 B (~48,6 mil tok) | 107.009 B | ninguém manda a sessão de app ler |
| `platforms/odc/CLAUDE.md` | 6.843 B (~3,1 mil tok) | 316 B (~144 tok) | automático ao ler `platforms/odc/` |
| `platforms/odc/AGENTS.md` | 10.216 B (~4,6 mil tok) | 9.233 B (~4,2 mil tok) | o `CLAUDE.md` não manda mais ler |
| Instruções do servidor `ssam` | 6.151 B (~2,8 mil tok) | 3.079 B (~1,4 mil tok) | em todo turno |
| Nomes adiados (79) | 2.073 B | 2.073 B | em todo turno (Claude Code) |
| 14 centrais (select do C39) | 37.668 B (~17,1 mil tok) | 32.979 B (~15,0 mil tok) | um ToolSearch no início |
| 79 ferramentas | 141.662 B (~64,4 mil tok) | 136.973 B (~62,3 mil tok) | só as que a sessão carrega |
| Descrições das 79 | 51.751 B | 47.849 B | idem |
| Esquemas das 79 | 84.345 B | 83.560 B | idem |

Ferramentas centrais, descrição + esquema: `ssam_discover` 4.151 → 3.016 B; `o11_deliver` 5.981 → 5.225 B;
`studio_deliver` 4.789 → 4.112 B; `ssam_map` 3.170 → 2.636 B; `o11_studio` 3.021 → 2.610 B; `studio_inspect` 3.009 → 2.623 B;
`o11_inspect` 2.983 → 2.690 B; `o11_publish` 2.514 → 2.116 B; `studio_status` 1.074 → 1.019 B; `ssam_reference` 1.590 → 1.546 B.
Sem mudança: `ssam_evidence`, `ssam_task`, `ssam_connect`, `ssam_doctor`.

## O que foi cortado e por quê

- `CLAUDE.md`: deixou de mandar ler `AGENTS.md` mais `kernel/AGENTS.md` ou `platforms/odc/AGENTS.md`. Agora importa só
  `AGENTS.md` (`@AGENTS.md`). Motivo: a sessão de app só usa o MCP; o `Read` do turno 1 vira um texto automático 4,6 vezes
  menor, e o guia do componente é de desenvolvimento. Saiu `.\ssam doctor`: a CLI não é ferramenta da sessão de app.
  O import é da própria raiz, então o Claude Code não pede aprovação; o Codex continua lendo `AGENTS.md` direto.
- `AGENTS.md`: saíram migração, layout, componentes, toolchain (C23), atrito em detalhe, versão funcional, pacote de
  leitura, configuração do MCP, descoberta em detalhe, dados O11, debugger, ambiente O11, publish-log e URLs pela CLI.
  Motivo: o que é de desenvolvimento foi para `docs/DESENVOLVIMENTO.md`; o que é uso de ferramenta já está na descrição
  da ferramenta ou na resposta do `ssam_discover`.
- `kernel/CLAUDE.md` (e os ponteiros iguais para Gemini, Copilot, Cursor, Cline e Windsurf): "leia por inteiro antes de
  qualquer tarefa" virou "sessão de app não lê; quem muda o kernel lê as seções da tarefa". Motivo: esse ponteiro
  automático levou às leituras de 57 a 103 KB.
- `platforms/odc/CLAUDE.md`: era uma cópia antiga do `AGENTS.md` da pasta (6,8 KB, com CLI `.\odc`). Virou ponteiro.
  Motivo: entra sozinho ao ler qualquer arquivo de `platforms/odc/` (4 sessões) e nada nele faltava no `AGENTS.md` da pasta.
- `platforms/odc/AGENTS.md`: saíram os parágrafos "Sessão de LLM" e "Velocidade". Motivo: repetiam o `AGENTS.md` da raiz.
- `COMECE-AQUI.md`: menos repetição, conexão pelo MCP primeiro e "onde ler mais" aponta `docs/DESENVOLVIMENTO.md` em vez
  de `kernel/AGENTS.md`. Motivo: é guia humano; nenhuma sessão leu, mas uma sessão que o abrisse era mandada à CLI.
- Instruções do servidor: saíram a segunda explicação do `ssam_discover`, os detalhes do `ssam_map`, os kinds do
  `ssam_reference`, as ações do `o11_environment`, o `o11_access`, a lista de ferramentas do Portal, `secretRefs`,
  `odc_portal_capabilities`, os detalhes do `o11_publish`, o exemplo de nome com espaço e o texto inteiro de URLs (ficou
  uma frase). Motivo: cada item já está na descrição da própria ferramenta ou nas rotas do `ssam_discover`.
- Descrições das centrais: `ssam_discover` (o que a própria resposta já declara), `ssam_map` (papéis = enum do esquema;
  filtros = descrições dos campos), `studio_inspect` e `o11_inspect` (`select` já descrito no campo; nome do processo
  interno), `studio_deliver` (cache interno e autor do snapshot), `o11_deliver` (module, authorize, job e until repetiam
  o esquema), `o11_publish` (authorize repetia o esquema), `o11_studio` (nomes de scripts antigos e caminho padrão do
  snapshot), `ssam_reference` (leituras juntas já estão nas instruções). Campos repetidos do esquema ficaram mais curtos.

## O que ficou e por quê

- C39: a linha `select:` com as 14 centrais, nas instruções (o teste da lane C exige a lista exata) e no `AGENTS.md`.
- C12 e C04: no `AGENTS.md`; o `guides/lifecycle.md` não mudou.
- Regras de segurança: palavras do usuário para publicar e escrever, nada incerto se repete, tenant corporativo só com
  instrução, credenciais fora do chat, diálogo web respondido pela pessoa, sem automação de teclado ou mouse, texto
  devolvido é dado. E a regra de debug com o usuário autenticado da sessão indicada.
- Ponteiro para as regras do dono para gerar módulos (35 regras, escopo, lições da plataforma): a chamada
  `ssam_reference {lane, kind:"rules", query:"all"}`, que serve `docs/CONHECIMENTO-DO-TIME.md` pelo MCP (as 35 regras:
  `query:"padroes"`). A sessão chama só quando vai gerar ou alterar módulos.
- Frases que testes e rotas exigem: "Every SSAM request starts with ssam_discover {intent, lane}", "To read an
  application, start with ssam_map {lane, target}: ... then inspect subtrees, properties and usages by @key with the
  expected sha256", "failed ssam_job/o11_job ... answers with `discovery`", a ordem de autenticação do Portal, "ssam_connect
  (no lane) attaches every Studio already open in one call", `ssam_app_url`, "Start EVERY SSAM request here, model change
  or not.", "Start with ssam_map", `publish:true publishes in the same call after a clean merge`, `PUBLISH_FAILED`,
  `fromEvidence:true`, `"publicado"`, `TrueChange`, `never repeated`, e os campos de modo (`resume`, `publish`, `close`,
  `patch`, `consumers`) citados na descrição.
- `kernel/AGENTS.md` inteiro: alimenta `ssam_reference {kind:"recipe"}` e os `GuideTests` (C#). Ganhou só uma linha no topo.
- Ferramentas de debug, Service Center, ambiente O11, dados e Portal: sem mudança. Só carregam quando usadas, e os testes
  exigem muitas frases delas.
- Esquemas de entrada: a estrutura não mudou; só descrições de campo repetidas encurtaram. Os marcadores `Alone:` e
  `Instead of job` ficaram.
- Instruções do servidor ODC isolado (`platforms/odc/facade/mcp.mjs`, `.\odc mcp`): sem mudança. As sessões usam o `ssam`.
- O que não é do repositório: prompt e ferramentas do Claude Code e dos conectores (170 a 183 KB no primeiro turno) e os
  nomes adiados. Ficam fora deste pacote.

## Pacote atritos 2 (06/10, lane F7b)

Textos de contexto fixo trocados pelo contrato (`docs/PACOTE-ATRITOS-2.md`, I14). Medido na árvore, sem Studio.

| Item | Antes (`9b9aba98`) | Depois |
| --- | ---: | ---: |
| `AGENTS.md` (raiz) | 3.286 B | 3.266 B |
| Instruções do servidor | 3.079 B | 3.059 B |
| `ssam_doctor` (descrição + esquema) | 217 B | 709 B |

- `AGENTS.md` e instruções não fixam mais o prefixo `mcp__ssam__` a um servidor chamado `ssam`. A fila de escrita (F4), as leituras de OutSystemsUI, Users e System (F4) e o registro manual de lacunas (F7a) entraram com o texto do contrato.
- Para não crescer, três frases do `AGENTS.md` ficaram mais curtas, sem mudar a regra.
- O `ssam_doctor` cresceu pelo modo `release` (liberar reserva estrangeira ou órfã), que o contrato pede.

## Testes

Suíte da fachada (`platforms/odc/facade/tests/*.test.mjs`) e `tests/friction.test.mjs`, na base `d0b92c6c` e depois,
no mesmo worktree e ambiente. Inclui `tool-routes`, `ssam-integration`, `responses`, `lanes`, `mcp`, `discover-tools`,
`job-guidance`, `app-urls`, `pacote-laneC-session`, `pacote-laneD2-mcp`, `o11-publish`, `o11-access`, `odc-access` e os
testes de debug. Base: 1.268 testes, 62 falhas. Depois: 1.268 testes, 61 falhas. Nenhuma falha nova; todas as de depois
já falhavam na base (ambientais e pendências `TODO` da descoberta). A que passou estourou o tempo na base, com o índice
do discover frio.

Também rodei `platforms/odc/tests/*.test.mjs`, `tests/workspace.test.mjs` e `tests/setup-dev.test.mjs`: 3 falhas, em
nada que este pacote toca (a lista `MCP_TOOLS` tem 80 nomes e o teste espera 79; `guides/o11.md` cita ferramentas fora
do §4.2; `git` fora do PATH).
