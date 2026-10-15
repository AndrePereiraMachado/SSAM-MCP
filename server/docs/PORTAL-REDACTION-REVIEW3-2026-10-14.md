# Portal redaction: revisão 3 — 14/10/2026

Ramo: `fix/portal-redaction`. Base desta rodada: `217505da`.
Autor: Andre Machado <andre_c_machado@hotmail.com>.

## Commits e arquivos

- `23b182fd`: corrige N1. Altera o registro de credenciais, os testes de retenção e os testes/worker de performance. Quatro arquivos.
- `d6ac16f8`: corrige C1-J. Altera fachada, catálogo, plano, aprovação, descoberta, acesso e testes A2A. Sete arquivos.
- O commit de documentação acrescenta este relatório e atualiza o README do Portal.

São commits novos. Não houve amend, squash, push, publicação ou acesso ao Portal ao vivo.
Não houve rede, MCP ou Studio. Não houve alteração na bridge C#.
Somente valores sintéticos foram usados. Nenhuma credencial foi impressa ou gravada como evidência.
O scratch ficou em `os.tmpdir()`, fora de `C:\t`, e foi removido após a conferência.
Não houve escrita em outras worktrees, árvores do servidor ou pastas de provas.

## N1: ativos vivos não entram no descarte

O conjunto do processo agora é a união dos ativos vivos com os retirados retidos.
Os **4.096 valores** limitam somente os retirados.
Ativos de registros vivos não têm esse teto. O total pode passar de 4.096.

Cada valor mantém seus donos vivos. Ele só se torna retirado quando o último dono o libera.
`observeCredentials(registro)` recompõe os ativos desse registro no conjunto.
Repetir um valor retirado o move para o fim da fila.
O descarte retira o mais antigo da fila de retirados.

Cada nome de cookie possui seu valor atual e as partes CSRF decodificadas correspondentes.
Uma rotação retira o valor anterior somente quando nenhum token, outro cookie ou outro registro ainda o possui.
Tokens, códigos e cookies de outros nomes permanecem ativos até `reset()` ou `dispose()`.
O limite de 128 ativos foi removido. O histórico local de retirados continua limitado a 128.
O limite global de retirados continua sendo 4.096.

O resumo conta ativos pelos donos vivos, sem depender da fila de retirados.
Os registros usam referências fracas e finalização. A liberação explícita continua disponível.
O snapshot e o casador continuam em cache. Movimentos que preservam o conjunto de valores não exigem recompilação.
Identidades, escopo, datas, paginação e confirmação de escrita continuam sendo validados antes da máscara.

### Testes que falharam primeiro

Comando principal: `node --test platforms/odc/portal/tests/active-credential-retention.test.mjs`.
Os seis primeiros casos foram executados antes da mudança de produção: **0 aprovados, 6 falhas por asserção** no `217505da`.
O teste de repetição foi acrescentado depois e também falhou no código antigo, carregado por `git show` em memória.
Não houve falha de importação. Os dois controles de propriedade compartilhada passaram nas duas versões.
Resultado atual do arquivo: **9 aprovados, 0 falhas**.

| Teste | `217505da` | Novo código |
|---|---|---|
| A: refresh token após 228 sessões de timer liberadas | Eco cru; falha de asserção | Mascarado; ativo contado |
| B: refresh token após 4.095 respostas com rotação de cookie | Eco cru; falha de asserção | Mascarado; ativo contado |
| C: segredo de OAuthClient vivo após 228 sessões | Eco cru; falha de asserção | Mascarado; ativo contado |
| D: repetição e observação do valor durante pressão de outros registros | Eco cru; falha de asserção | Mascarado; ativo contado |
| 10.000 valores de outro registro e 10.000 rotações de outro cookie no mesmo broker | Falha de asserção | Ativo preservado; retirados até 4.096 |
| Token com 300 nomes distintos de cookie | Apenas 128 ativos | 301 ativos |
| Valor retirado repetido antes de mais 100 retiradas | Valor descartado | Valor retido no fim da fila |
| Cookies, token direto e CSRF decodificado com dono compartilhado | Controle positivo | Aprovado |
| Dois registros com o mesmo valor | Controle positivo | Aprovado |

Os cenários A–D usam `registerAccessTools → OdcAccess.portalRead → PortalReadAdapter → Odc3PortalBroker`.
O login e a leitura passam pelo broker real. Somente o transporte de rede é falso.
O teste de FIFO foi corrigido: ele agora descarta apenas valores retirados.

## C1-J: cópia mascarada é recusada

Cartões explícitos são percorridos antes do planejamento.
Qualquer texto com `[REDACTED]`, `%5BREDACTED%5D` ou `[INVALID URL]` causa `A2A_CARD_REDACTED_COPY`.
A comparação aceita diferenças de caixa, inclusive nos escapes percentuais.
Uma única recusa inclui todos os caminhos em `markedFields` e manda usar `discoveryOperationUuid`.
Isso vale nos modos URL e JSON.

Quando a aprovação cita a descoberta e o cartão JSON difere do recibo, a recusa é `A2A_DISCOVERY_CARD_MISMATCH`.
Ela ocorre antes da reserva e do envio do teste nativo.
O plano com recibo continua usando a fonte bruta confirmada. Os hashes permanecem vinculados a essa fonte.

A descoberta confirmada devolve a continuação `odc_a2a_connection_plan`.
Seus argumentos são `discoveryOperationUuid`, `name`, `agentUrl` e `stage`, sem `card`.
A pessoa/agente ainda informa `portfolioKey` e o modo desejado.
O estágio vem da leitura validada, com somente os campos aceitos pelo contrato.
O recibo e a repetição da descoberta devolvem a mesma continuação. A repetição não envia outra chamada.
A descrição da ferramenta, o catálogo e o README foram atualizados.

### Testes que falharam primeiro

Comando: `node --test --test-name-pattern=C1-J platforms/odc/portal/tests/a2a-discovery-plan-regression.test.mjs`.
Os seis primeiros casos foram executados antes da mudança de produção: **0 aprovados, 6 falhas por asserção**.
Depois foi acrescentado o caso de aprovação da cópia mascarada.
Os sete casos atuais foram executados novamente com a produção do `217505da`, carregada por `git show`: **0 aprovados, 7 falhas por asserção**.
No código novo: **7 aprovados, 0 falhas**. Não houve falha de importação.

| Teste | `217505da` | Novo código |
|---|---|---|
| Copiar cartão exibido com texto Bearer para o plano JSON sem recibo | Plano aceito | `A2A_CARD_REDACTED_COPY`; nenhum teste enviado |
| Copiar cartão exibido com URL assinada de exemplo | Plano aceito | `A2A_CARD_REDACTED_COPY`; nenhum teste enviado |
| Copiar cartão exibido com URL de porta inválida | Plano aceito | `A2A_CARD_REDACTED_COPY`; nenhum teste enviado |
| Vários caminhos marcados, inclusive arrays e texto extra, nos dois modos | Sem recusa agregada | Uma recusa com todos os caminhos |
| Continuação sem cartão na descoberta, recibo e replay | Ausente | Presente e igual nas três respostas |
| Aprovação com recibo e cartão diferente sem marcas | Código genérico | `A2A_DISCOVERY_CARD_MISMATCH`; nenhum envio |
| Aprovação com recibo e cópia mascarada | Código genérico | `A2A_DISCOVERY_CARD_MISMATCH`; nenhum envio |

Os dez casos anteriores de C1 continuam aprovados.
O fluxo descoberta → plano com recibo → aprovação → teste continua funcionando em URL e JSON.
No modo JSON, `AgentCardJson` enviado continua igual ao cartão bruto do recibo.

## Tempos de C2

Trace sintético de **1.000 spans e 973.644 bytes**. Usa `PortalReadAdapter.execute` real.
Não são medições de tenant. Os resultados variam com carga, tamanho dos valores e estado do cache.

### Reprodutores originais

`rev2/verify-1/c2-repro.mjs` foi lido e executado sem alteração.
O código do `217505da` foi carregado em memória por um loader temporário.
O script usa a mesma forma de trace nas duas execuções. Não grava credenciais.

| Valores | `217505da`: tempo / pausa máxima | Novo: tempo / pausa máxima |
|---|---:|---:|
| 0 | 96 / 97 ms | 55 / 55 ms |
| 108 | 139 / 139 ms | 102 / 102 ms |
| 1.008 | 211 / 211 ms | 194 / 194 ms |

`rev3/review/verify-c2/c2-cap.mjs` também foi executado somente para leitura, com 228 logins simulados.
No código antigo, havia 4.096 valores totais. No novo, havia 4.104: 18 ativos e 4.086 retirados.
Esse aumento é esperado. O teto agora não descarta ativos.

| Medida do reprodutor no teto | `217505da` | Novo |
|---|---:|---:|
| Primeira compilação do casador | 547 ms | 523 ms |
| Heap adicional do casador | 297,9 MiB | 299,0 MiB |
| Trace com casador pronto | 140 ms | 90 ms |
| Maior pausa nessa leitura | 140 ms | 90 ms |

### Suíte final, concorrência padrão

Esta execução inclui a primeira compilação em cada worker.
Os limites de um segundo para trace e dois segundos para 8 MiB não foram relaxados.

| Valores totais | Ativos | Retirados | Tempo | Pausa máxima |
|---|---:|---:|---:|---:|
| 0 | 0 | 0 | 139,5 ms | 139,6 ms |
| 108 | 18 | 90 | 223,7 ms | 223,8 ms |
| 1008 | 18 | 990 | 411,7 ms | 411,8 ms |
| 4096 | 10 | 4086 | 924,7 ms | 924,9 ms |
| 5000 | 5000 | 0 | 278,3 ms | 278,4 ms |

O caso de 5.000 ativos usa valores de 40 caracteres.
Ele verifica explicitamente que o total pode passar de 4.096 sem perder ativos.
Não equivale a 5.000 refresh tokens longos.

Texto de 8 MiB com 1.000 valores: `redactValues` 364,0 ms; `redact` 224,8 ms.
O caso aninhado de 1 MiB e 1.000 valores sobrepostos levou 365,2 ms.
A saída foi igual à substituição anterior por maior valor primeiro.

Após 1.000 logins, 1.000 rotações de cookie, 1.000 brokers liberados e 1.000 renovações OAuth:

| Etapa | Ativos | Retirados | Total |
|---|---:|---:|---:|
| Logins | 18 | 4.096 | 4.114 |
| Cookies | 19 | 4.096 | 4.115 |
| Liberações de broker | 19 | 4.096 | 4.115 |
| OAuth vivo | 1.020 | 4.096 | 5.116 |

As liberações mantêm a contagem de registros vivos em 2 → 2 nessa etapa.
O cache público de tokens OAuth continua limitado a 16.
Os tokens do registro vivo ficam ativos até reset ou dispose, como solicitado.

## Suítes e verificação

| Suíte | `217505da`, revisão anterior conferida | Novo código |
|---|---:|---:|
| Portal completo, concorrência padrão | 1.054 aprovados; 0 falhas | 1.072 aprovados; 0 falhas |
| Fachada, mesmos 38 arquivos | 347 aprovados; 6 falhas; 73 pulados | 347 aprovados; 6 falhas; 73 pulados |

Portal: `node --test platforms/odc/portal/tests/*.test.mjs`, sem `--test-concurrency=1`.
Fachada: os mesmos 38 caminhos da rodada anterior, com `node --test`.
Os nomes das seis falhas são iguais aos de `rev3/review/suites/facade-217505da.tap`.
São as falhas preexistentes de descoberta relacionadas ao CLI O11 não compilado.
O marcador `.ssam-workspace.json` está presente para os testes de importação MCP.

O primeiro teste completo da fachada detectou um texto `when` acima do limite de 240 caracteres.
O texto foi encurtado para 204 caracteres. O teste do catálogo e os 38 arquivos foram repetidos.
O resultado final é o da tabela. Nenhuma expectativa de teste foi enfraquecida.

`bridge-agreement`: 10/10 aprovados. Nenhum C# foi alterado.
A1, M1–M5 e as nove regressões do `664fa878` continuam aprovados.
Os reprodutores e1–e4 e e6 foram executados somente para leitura contra esta worktree.
Não houve vazamento nos casos testados. E6 incluiu o prazo real de 29 segundos e a retomada com a mesma chamada.
Todos os arquivos alterados são UTF-8 sem BOM. O JSON do catálogo e `git diff --check` passaram.

## Mapa para o servidor

Destino lido, sem escrita: `servidor/fase4-24`, ref `a415531d2591bdc0c80400fc7d20b179f9653ed3`.
Nenhum arquivo foi copiado. A integração continua pendente.
O mapa é cumulativo desde `6b5f9636`. Inclui os arquivos necessários das três rodadas anteriores.
Ele informa existência no destino, não garante ausência de conflito no merge.

| Caminho relativo na origem e no destino | Situação no destino |
|---|---|
| `docs/PORTAL-REDACTION-REVIEW-20261013.md` | Novo; adicionar |
| `docs/PORTAL-REDACTION-REVIEW2-20261014.md` | Novo; adicionar |
| `docs/PORTAL-REDACTION-REVIEW3-2026-10-14.md` | Novo; adicionar |
| `platforms/odc/facade/catalog/tools.json` | Existe; integrar |
| `platforms/odc/facade/debug-odc-background-instance.mjs` | Existe; integrar |
| `platforms/odc/facade/debug-odc-native-background-run.mjs` | Existe; integrar |
| `platforms/odc/facade/debug-odc-portal.mjs` | Existe; integrar |
| `platforms/odc/facade/debug-run.mjs` | Existe; integrar |
| `platforms/odc/facade/debug-runtime.mjs` | Existe; integrar |
| `platforms/odc/facade/odc-access.mjs` | Existe; integrar |
| `platforms/odc/facade/tests/debug-odc-background-instance.test.mjs` | Existe; integrar |
| `platforms/odc/facade/tests/debug-odc-portal-session.test.mjs` | Existe; integrar |
| `platforms/odc/facade/tests/sc-portal-regressions.test.mjs` | Existe; integrar |
| `platforms/odc/portal/README.md` | Existe; integrar |
| `platforms/odc/portal/runtime/a2a-connection-approval.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/a2a-connection-plan.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/a2a-discovery.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/access.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/agent-projection-policy.mjs` | Novo; adicionar |
| `platforms/odc/portal/runtime/agent-projection.mjs` | Novo; adicionar |
| `platforms/odc/portal/runtime/auth.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/bridge.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/credential-matcher.mjs` | Novo; adicionar |
| `platforms/odc/portal/runtime/credential-registry.mjs` | Novo; adicionar |
| `platforms/odc/portal/runtime/errors.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/odc3-context.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/odc3-host.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/pagination-diagnostic.mjs` | Novo; adicionar |
| `platforms/odc/portal/runtime/portal-read.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/portal-routes.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/projection-context.mjs` | Novo; adicionar |
| `platforms/odc/portal/runtime/server.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/studio-portal.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/trace-metadata-result.mjs` | Existe; integrar |
| `platforms/odc/portal/runtime/trace-result.mjs` | Existe; integrar |
| `platforms/odc/portal/tests/a2a-discovery-plan-regression.test.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/active-credential-retention.test.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/agent-contract-regression.test.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/bridge-agreement.test.mjs` | Existe; integrar |
| `platforms/odc/portal/tests/fixtures/redaction-performance-worker.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/log-text.test.mjs` | Existe; integrar |
| `platforms/odc/portal/tests/odc3-context.test.mjs` | Existe; integrar |
| `platforms/odc/portal/tests/portal-redaction.test.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/portal-session-redaction.test.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/redaction-before-truncation.test.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/redaction-performance.test.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/security.test.mjs` | Existe; integrar |
| `platforms/odc/portal/tests/studio-portal.test.mjs` | Existe; integrar |
| `platforms/odc/portal/tests/trace-result.test.mjs` | Existe; integrar |

## Lacunas

- **N2:** o plano com recibo continua fora da borda e pode devolver o cartão bruto com um valor registrado. A exceção agora está explícita no README. A separação entre cartão mostrado e cartão enviado continua pendente.
- **N3:** o casador continua ocupando cerca de 300 MiB no perfil de 4.096 valores longos. Alterar o conjunto ainda exige recompilação. A união agora pode ser maior por conter todos os ativos vivos. Movimentos sem mudança de valores evitam recompilações desnecessárias; a trie compacta e limites de custo para volumes arbitrários continuam pendentes.
- **V1:** fragmentos de uma credencial divididos entre strings continuam podendo aparecer. O corte de prefixo só vale para campos realmente truncados, para preservar C3. Não há nova regra entre linhas.
- **L1:** formas adicionais decodificadas, percentuais em outra caixa, HTML, JSON e base64; máscara de palavras de 8–15 caracteres; registro de senha do Portal; e exposição dos resumos nas ferramentas públicas continuam pendentes.
- **Demais lows da revisão 2:** V2–V11 e C4 continuam fora desta correção. Incluem usuário/senha, idioma/consentimento e suas guardas, fragmentos em campos tipados, valores iguais ao host, base64 do Studio headless, erros lançados, tokens do Studio/debugger, chaves/números e sobreposições artificiais, outras formas de Bearer/URL e campos extras do cartão. A situação de verificação permanece a das revisões. Não há alegação nova de prova ao vivo.

Não foi executada prova ao vivo nem integração no servidor.
Com o dono, ainda é necessário contar ativos e retirados após cada login e medir um trace grande depois de vários logins.
Os diagnósticos devem mostrar somente contagens e nomes de cookie, nunca seus valores.
