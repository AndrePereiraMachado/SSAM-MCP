# Portal redaction: revisão 4 — 14/10/2026

Base: `ff1a0a55`. Ramo: `fix/portal-redaction`.
Worktree: `C:\Users\andre\SSAM-Hybrid-integracao-wt\portal-redact`.
Autor: Andre Machado <andre_c_machado@hotmail.com>.

## Commits e arquivos

| Commit | Correção | Arquivos |
|---|---|---|
| `f38b7aac` | R4-1 e R4-3 | `portal/runtime/auth.mjs`, `portal/runtime/credential-registry.mjs`, `portal/tests/oauth-cookie-lifecycle.test.mjs` |
| `aed8ae90` | R4-2 | `portal/runtime/errors.mjs`, `portal/tests/a2a-discovery-plan-regression.test.mjs` |
| `4356a636` | R4-4 | `portal/tests/redaction-performance.test.mjs`, `portal/tests/fixtures/redaction-performance-worker.mjs` |
| Commit de documentação desta entrega | Política e evidências | `platforms/odc/portal/README.md` e este relatório |

Os caminhos abreviados de código e testes partem de `platforms/odc/`.
São commits novos, sem amend ou squash. Não houve push.
Nenhum C# foi alterado. Não houve rede, Portal ao vivo, MCP ou Studio.
Os testes usaram valores sintéticos. Nenhuma credencial foi impressa ou gravada em evidências.
O scratch ficou em `os.tmpdir()`, fora de `C:\t`, e foi removido após a conferência.
As revisões e os reprodutores em `C:\t` foram somente lidos.
Não houve escrita em outras worktrees, no servidor ou em pastas de provas.

## R4-1: renovações OAuth com ativos limitados

O segredo do API Client e os até 16 valores de `knownTokens` permanecem ativos.
Quando um token sai dessa janela, sua origem direta é retirada do registro.
Ele passa ao histórico de retirados, cujo teto global continua sendo 4.096.
O histórico local continua limitado a 128 retirados.

A retirada não elimina outros donos do mesmo valor.
Cookies do mesmo registro e outros registros vivos continuam protegidos.
Se um token tiver o mesmo valor do segredo do cliente, a saída da janela não retira o segredo.
O token atual, o segredo e tokens recentemente retirados continuam mascarados na borda.
O mais antigo sai quando a fila de retirados ultrapassa o limite.

Os testes de crescimento voltaram a exigir um teto.
Foram removidas as expectativas de 1.020 ativos globais e 1.001 valores locais do OAuth.
Agora o acréscimo de ativos devido ao OAuth é no máximo 17.
O registro local do OAuth admite até 145 valores: 17 ativos e 128 retirados.

| Teste | `ff1a0a55`, antes da correção | Novo código |
|---|---|---|
| 10.000 renovações com fetch falso | Falha por asserção: ativos sem teto | Até 17 ativos; até 4.096 retirados globais |
| Segredo, token atual e token recém-retirado na borda | A verificação do teto falhava antes da projeção | Todos mascarados |
| Token mais antigo após 10.000 renovações | Continuava ativo | Fora da fila limitada |
| Teste de crescimento com teto restaurado | Falha por asserção | Aprovado |
| Token igual ao segredo; donos compartilhados | Controles adicionais | Aprovados |

O teste original de 10.000 renovações falhou por asserção antes de alterar a produção.
Depois, o mesmo teste passou. Ele também foi reforçado com verificações de retirada recente e descarte antigo.
Os valores desse teste são sintéticos no formato UUID, com mais de 16 caracteres.
Ele prova a política de contagem e máscara. Não mede o consumo de um casador com 4.096 JWTs longos.

## R4-2: marca explícita em usuário de URL

Na projeção, o usuário passa a ser `[REDACTED]` e a senha é apagada.
O objeto `URL` serializa o usuário como `%5BREDACTED%5D@`.
Isso preserva uma marca detectável no cartão exibido.
A regra existente de C1-J recusa essa cópia com `A2A_CARD_REDACTED_COPY`.

| Teste | `ff1a0a55`, antes da correção | Novo código |
|---|---|---|
| Texto com `https://u:p@host/x` | Falha: usuário e senha eram apagados sem marca | Marca no usuário; senha removida |
| Texto com `https://u@host/x` | Falha: usuário era apagado sem marca | Marca no usuário |
| Cópia do cartão exibido, JSON e URL, nas duas formas | Quatro falhas por asserção: plano aceito | `A2A_CARD_REDACTED_COPY`; nenhum teste enviado |
| `a2aTest` montado à mão sem recibo, nas duas formas | Duas falhas por asserção: teste enviado | `A2A_CARD_REDACTED_COPY`; nenhum envio |
| Plano e envio com recibo, URL e JSON | Controles adicionais | Cartão bruto e hashes preservados |

Os oito testes novos falharam por asserção antes da mudança em `errors.mjs`.
Depois, os oito passaram.
Quatro controles adicionais preservam o fluxo com recibo e o cartão bruto enviado.
O arquivo completo de descoberta e plano A2A passou com 29 testes.

## R4-3: cookies por nome, domínio e caminho

A identidade agora usa `key`, `domain` e `path` do cookie salvo pelo jar.
O jar já fornece domínio e caminho normalizados.
Para fixtures que não fornecem esses campos, os defaults são o host recebido e `/`.

Rotacionar uma identidade não retira o cookie de outra identidade.
O controle de donos continua valendo para valores compartilhados.
O resumo público continua mostrando somente nomes e contagens, nunca os valores.

| Teste | `ff1a0a55`, antes da correção | Novo código |
|---|---|---|
| Mesmo nome em `/apps` e `/monitoring`, com 4.096 retiradas de outros registros | Falha por asserção: eco cru | Jar continua enviando o primeiro; eco mascarado |
| Mesmo nome com domínio do tenant e domínio pai, com a mesma pressão | Falha por asserção: eco cru | Cookie anterior permanece ativo e mascarado |

Os dois testes reproduzem `rev4/review/leaks/cookie-path.mjs` no repositório.
Usam broker, jar, fachada, `OdcAccess` e adapter reais. Somente a rede é falsa.
Os dois falharam antes da mudança e passaram depois.
O arquivo `oauth-cookie-lifecycle.test.mjs` passou com cinco testes: três regressões e dois controles.
Os nove testes N1 continuam aprovados.

## R4-4: compilação separada da leitura no teto

Para N=4.096, o worker compila o casador antes da leitura e antes da sonda do event loop.
Um valor conhecido confirma que o casador está pronto.
O worker informa `compileMs`, `matcherReadyBeforeRead` e `measurementMode`.
A leitura aquecida e sua pausa máxima continuam limitadas a um segundo.

N=0, 108 e 1.008 continuam medindo a primeira leitura, incluindo a compilação.
Seus limites de um segundo não foram alterados.
O caso de 5.000 ativos também continua medindo a primeira leitura.
O limite de dois segundos para 8 MiB foi mantido.

| Teste | `ff1a0a55`, antes da correção | Novo código |
|---|---|---|
| Contrato do teste N=4.096: casador pronto e compilação informada à parte | Falha por asserção: campo de confirmação ausente | Aprovado |
| Leitura aquecida N=4.096, abaixo de um segundo | Não era medida separadamente | Aprovada nas duas execuções completas |
| Primeira leitura N=0, 108 e 1.008, abaixo de um segundo | Controles preservados | Aprovados nas duas execuções |

O teste do novo contrato falhou antes da alteração do worker, por asserção, sem erro de importação.
Naquela execução local, a leitura fria antiga levou 836,9 ms.
Não foi reproduzida ali a falha de duração vista pelo revisor entre 1.020 e 1.717 ms.
A falha determinística registrada foi a ausência da medição separada, não uma alegação de lentidão nesse host.
A compilação continua tendo custo. Este ajuste não resolve N3 nem garante primeira leitura no teto abaixo de um segundo.

## Tempos das duas execuções completas

Trace sintético de 1.000 spans, 973.644 bytes, pelo `PortalReadAdapter.execute` real.
Concorrência padrão do runner. Valores em milissegundos.
As suítes completas foram executadas sequencialmente.

| Valores | Medição | Compilação: exec. 1 / 2 | Leitura: exec. 1 / 2 | Pausa máxima: exec. 1 / 2 |
|---|---|---|---|---|
| 0 | Primeira leitura | Incluída na leitura | 154,2 / 163,1 | 155,0 / 163,2 |
| 108 | Primeira leitura | Incluída na leitura | 203,1 / 218,0 | 203,2 / 218,2 |
| 1008 | Primeira leitura | Incluída na leitura | 356,5 / 430,0 | 356,6 / 430,6 |
| 4096 | Leitura aquecida | 923,8 / 845,8 | 256,5 / 145,2 | 256,8 / 146,4 |
| 5000 | Primeira leitura | Incluída na leitura | 302,6 / 301,5 | 302,8 / 302,2 |

A compilação em N=4.096 não está escondida no tempo da leitura aquecida.
Ela é informada separadamente na tabela. Não há limite novo para essa compilação.
O caso de 5.000 ativos usa valores de 40 caracteres; não representa 5.000 JWTs longos.

Texto de 8 MiB com 1.000 valores, execuções 1 / 2:

- `redactValues`: 328,7 / 437,0 ms.
- `redact`: 219,1 / 258,9 ms.

Ambas as saídas permaneceram mascaradas e abaixo do limite de dois segundos.

O teste de crescimento com 1.000 eventos de cada tipo terminou, nas duas execuções, com:

| Etapa | Ativos globais | Retirados globais | Total |
|---|---:|---:|---:|
| Logins | 18 | 4.096 | 4.114 |
| Rotação de cookies | 19 | 4.096 | 4.115 |
| Liberação de brokers | 19 | 4.096 | 4.115 |
| OAuth | 36 | 4.096 | 4.132 |

Os 36 ativos finais são 19 dos demais registros e até 17 do OAuth.
O registro local do OAuth terminou com 145 valores, incluindo seus 128 retirados locais.
O conjunto `knownTokens` ficou em 16.

`spurious-recompile.mjs` foi repetido, sem alterar o script.
Primeira compilação: 587 ms. Chamada em cache: 0 ms.
Registro vazio, registro com valor conhecido, reset, dispose e finalização: **0 ms cada**.
As três verificações de mudança de chaves deram `false`.

## Suítes e preservação

| Execução | Resultado |
|---|---|
| Portal completo, primeira execução final | 1.089 aprovados; 0 falhas |
| Portal completo, segunda execução final | 1.089 aprovados; 0 falhas |
| Fachada, os mesmos 38 arquivos | 347 aprovados; 6 falhas; 73 pulados |
| `bridge-agreement` | 10/10 aprovados |

As duas execuções finais do Portal ocorreram depois do reforço das verificações de tokens retirados.
Comando: `node --test platforms/odc/portal/tests/*.test.mjs`, sem limitar a concorrência.
A fachada recebeu exatamente 38 caminhos. Nenhuma lista vazia foi usada.
Os nomes das seis falhas foram comparados com `rev4/review/suites/facade-ff1a0a55.tap`.
São as mesmas falhas preexistentes de descoberta e CLI O11 não compilado.

A revisão 4 registrou 1.071 aprovados e uma falha de N=4.096 no `ff1a0a55`, em duas execuções no host do revisor.
A execução anterior desta worktree tinha 1.072 aprovados.
A diferença de duração foi reconhecida e tratada por R4-4, sem alterar os limites dos perfis menores.

Os testes novos foram executados primeiro contra a produção de `ff1a0a55`.
R4-1 e R4-3: três falhas por asserção. R4-2: oito falhas por asserção.
R4-4: falha por asserção no contrato da medição separada.
O teste de crescimento com o teto OAuth restaurado também falhou por asserção na base.
Não houve falha de importação usada como prova.

Os reprodutores foram executados somente para leitura contra esta worktree:

- `evict-verify.mjs`: A-228, B-4.095, C-228 e D permanecem mascarados.
- `evict-in-use.mjs`: nenhum vazamento nos casos A, B e C.
- `cookie-path.mjs`: modos path e domain preservam o valor que o jar ainda envia.
- `repro-c1j.mjs`: seis variantes; nenhuma cópia mascarada enviada silenciosamente.
- e1–e4: sem novo vazamento nos casos cobertos.
- e6: leitura juntada e retomada após o prazo real de 29 segundos continuam mascaradas.
- e5: resultado preservado. As formas bruta e duplamente codificada são mascaradas. Decodificada, percentual em outra caixa, JSON Unicode, base64, divisão entre strings e valor curto continuam nas lacunas de L1/V1.

A1, M1–M5, N1, C1-J e as nove regressões do `664fa878` continuam aprovados.
Nenhuma máscara foi movida para antes da validação.
Os arquivos alterados são UTF-8 sem BOM. O `git diff --check` passou.
Os TAPs temporários e os arquivos de mensagem de commit foram removidos após registrar os resultados aqui.

## Mapa para servidor/fase4-24

Ref lida, sem escrita: `a415531d2591bdc0c80400fc7d20b179f9653ed3`.
Nenhum arquivo foi copiado. A integração segue pendente.
O mapa é cumulativo desde `6b5f9636`, incluindo as dependências das rodadas anteriores.
Existência no destino não significa ausência de conflitos de merge.

| Caminho relativo na origem e no destino | Situação no destino |
|---|---|
| `docs/PORTAL-REDACTION-REVIEW-20261013.md` | Novo; adicionar |
| `docs/PORTAL-REDACTION-REVIEW2-20261014.md` | Novo; adicionar |
| `docs/PORTAL-REDACTION-REVIEW3-2026-10-14.md` | Novo; adicionar |
| `docs/PORTAL-REDACTION-REVIEW4-2026-10-14.md` | Novo; adicionar |
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
| `platforms/odc/portal/tests/oauth-cookie-lifecycle.test.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/odc3-context.test.mjs` | Existe; integrar |
| `platforms/odc/portal/tests/portal-redaction.test.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/portal-session-redaction.test.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/redaction-before-truncation.test.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/redaction-performance.test.mjs` | Novo; adicionar |
| `platforms/odc/portal/tests/security.test.mjs` | Existe; integrar |
| `platforms/odc/portal/tests/studio-portal.test.mjs` | Existe; integrar |
| `platforms/odc/portal/tests/trace-result.test.mjs` | Existe; integrar |

## Lacunas

- **N2:** o plano com recibo ainda pode expor cartão bruto e corpo de teste fora da borda. A exceção continua documentada no README. Não foi alterada nesta rodada.
- **N3:** a trie e seu custo de memória/compilação continuam. O teto é por quantidade de retirados, não por bytes ou caracteres. Muitos tokens longos podem custar mais que o perfil de aproximadamente 300 MiB já medido. R4-4 mede esse custo separadamente; não o elimina.
- **V1:** credenciais divididas entre strings continuam podendo expor fragmentos. O corte de prefixo permanece restrito a campos realmente truncados, para preservar C3.
- **V8:** tokens do Studio passados como lista continuam sem dono vivo no registro. Podem sair da fila após 4.096 retiradas. R4-1 trata o OAuthClient; não muda esse caminho do Studio/debugger.
- **L1 e V2–V11:** continuam as formas codificadas adicionais, valores de 8–15 caracteres, registro de usuário/senha, guardas de idioma/consentimento, fragmentos tipados, base64 do Studio headless, erros lançados, chaves/números e sobreposições artificiais, variantes adicionais de Bearer/URL e campos extras do cartão. R4-2 fecha somente a limpeza sem marca de userinfo descrita nesta rodada. C4 também continua aberto.

Não houve prova ao vivo nem integração no servidor.
Os resultados demonstram o comportamento dos testes e reprodutores sintéticos, não a frequência desses casos em um tenant real.
