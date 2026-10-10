# Os 151 testes vermelhos do `anvil`: o que são e o que fazer com cada grupo

Medidos em `anvil` `3f6fba6` (`dotnet test tests/Anvil.Tests -c Release`: 1207 testes, 151 falhas, 24 min). São os
**mesmos 151** desde antes da unificação: nenhum WS os criou, e a regra 1.8 do plano de unificação ("verde = mesmas
falhas do `anvil`, nenhuma nova") existe por causa deles. Este documento é o inventário com a causa colada e a
decisão proposta, para que a limpeza seja uma escolha e não uma faxina.

| Grupo | Falhas | Causa (mensagem do próprio teste) |
|---|---|---|
| A. `JobTests.JobAppliesAndVerifies` sobre o corpus `incidents-*` | 90 | base em `.local\work\deliver\<hash>\foreign.oml` (arquivo que outra corrida reescreve), produtor `Incidents_CS` não vinculado (`not bound: use --producer`), ou a fixture `outsystems-ui.oml` ausente |
| B. `ScreenCoverageTests.EveryMatrixRowHas...` | 52 | `producer OML not found: tests\fixtures\outsystems-ui.oml` / `outsystems-ui-web.oml` |
| C. `GuideTests` (3) | 3 | 96 jobs `incidents-*`/`inspect-*` sem citação no `AGENTS.md`; um job citado que não existe (`data-contract-incidents`); 3 jobs apontando para OML mutável |
| D. Catálogos e provas C# (6) | 6 | `FunctionCatalogTests.CatalogInRepoMatchesTheStudio` e `SurfaceTests.VerifyIdsAndHints...` (catálogo do repo × Studio instalado), `NativeCSharpExceptionFoundationTests` (2), `NativeTemporalGraphTests`, `CSharpTemporalTests` |

## A + C: o corpus `incidents-*` (93 das 151)

São 96 dos 171 jobs de `tests\jobs` (89 `incidents-*` e 7 `inspect-*`), de uma entrega passada, gravados como histórico do
trabalho, não como provas reexecutáveis: a base de muitos é um arquivo de trabalho (`.local\work\deliver\...`) que
não existe numa máquina limpa, e outros precisam de um snapshot do produtor que o repositório não guarda.

**Proposta (uma linha de decisão do dono).** Mover `tests\jobs\incidents-*.json` e `tests\jobs\inspect-*.json` para
`tests\jobs-archive\`, que `JobTests` e `GuideTests` não varrem, e escrever no `AGENTS.md` uma linha a dizer o que
essa pasta é. Isso apaga 93 vermelhos **sem enfraquecer prova nenhuma**, porque nenhum deles passa hoje nem passaria
noutra máquina. Alternativa honesta se o corpus ainda for para reexecutar: vincular cada base a uma fixture e
guardar os snapshots dos produtores no repositório (é trabalho por job, e cresce o repositório em OMLs).

## B: as duas fixtures do OutSystems UI (52)

`tests\fixtures\outsystems-ui.oml` e `outsystems-ui-web.oml` estão **explicitamente ignorados** no `.gitignore`
(linhas `/tests/fixtures/outsystems-ui.oml` e `/tests/fixtures/outsystems-ui-web.oml`, ao lado da exceção
`!tests/**/fixtures/*.oml`): foi uma decisão anterior de não versionar esses produtores. O teste, porém, **falha**
em vez de dizer que a fixture não veio, e é isso que confunde qualquer sessão nova.

**Proposta.** Duas coisas pequenas: (1) o teste passa a ser ignorado com motivo quando a fixture não existe (o
mesmo padrão que `JobTests` já usa quando não há Service Studio instalado), em vez de falhar; (2) `AGENTS.md` ganha
o passo de bootstrap que traz as fixtures para a máquina (`anvil download --module OutSystemsUI --out tests\fixtures\...`
contra o ambiente ligado). Quem tiver as fixtures continua a ter os 52 testes a correr de verdade.

## D: catálogos e provas C# (6)

- `FunctionCatalogTests` e `SurfaceTests`: o catálogo gravado no repositório é de um Service Studio mais antigo do
  que o instalado (11.55.87). Regerar o catálogo é um comando (`anvil functions --out catalog\...`) e uma revisão do
  diff; enquanto não for regerado, os dois testes ficam vermelhos por desenho.
- `NativeCSharpExceptionFoundationTests` (2), `NativeTemporalGraphTests`, `CSharpTemporalTests`: provas de C#
  gerenciado que dependem de fixtures e de um ambiente que a máquina atual não tem ligado.

## Ordem sugerida

1. Decidir A+C (arquivar ou vincular): tira 93 dos 151 e é a única com consequência de produto.
2. B: transformar falha em "ignorado com motivo" + o passo de bootstrap documentado (tira 52 do vermelho).
3. D: regerar o catálogo de funções quando o Studio instalado for o de referência.

Depois de 1 e 2, "suíte verde" volta a significar verde, e a regra 1.8 do plano de unificação deixa de ser precisa.
