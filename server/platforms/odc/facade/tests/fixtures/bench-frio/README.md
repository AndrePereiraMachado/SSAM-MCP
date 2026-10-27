# Corpora do bench a frio (R8)

Textos `ssam-ddl/1` e `ssam-flow/1` tirados uma vez, em 24/10/2026, dos jobs que o laboratório
`C:\Users\andre\SSAM-Hybrid-batch-lab` (branch `lab/batch-speed`) mandou ao kernel. Nenhum texto foi reescrito: cada
`spec.data.ddl` virou `dados.ddl`, cada ação de `logic.data.flow` entrou em `logica.flow` (uma linha em branco entre ações,
fim de linha `\n`), e os ops crus (exceções, roles) foram para `ops.json`. Os `.batch` do lab usam o `ssam-batch/1`, que não
foi integrado: o que vale aqui é a expansão `ssam-ddl/1` que o compilador do lab gerou deles e mandou ao kernel.
Uso e números: `docs/BENCH-FRIO.md`. Caminhos de job relativos à raiz do lab; sha256 do arquivo do job.

| Pasta | Corpus | Job(s) de origem no lab | sha256 | Diagnóstico | No lab |
|---|---|---|---|---|---|
| `portuario` | Portuário, 100 actions, 10 entidades, role e exceção | `kernel/.local/jobs/inline/3cb4477c-40f4-4c12-b5b2-bdd8042c5851.json` (fonte `.local/port-100.batch`) | `594ad44f…ade70f7` | `docs/diagnosticos/2026-10-17-portuario-100-actions.md` | entregue na 1ª submissão; flow 205.709 B, igual ao "fluxo expandido" do diagnóstico |
| `naval-2` | Naval 2º corpus, 100 actions novas, sobre as 100 entidades + 20 domínios do ensaio de dados | `622a6e38-758a-4adf-a4ea-da97bf594170.json` (dados) + `04051da1-3454-4c52-9874-daf30a4390b7.json` (2º corpus) | `6c63bb7d…b4795a`, `10726080…b861e2` | `docs/diagnosticos/2026-10-18-cem-actions-entidades.md` | entregue na 1ª submissão (o módulo já tinha os dados) |
| `hx` | Logística humanitária Hx, 100 actions, 11 entidades, exceção | `0cfb2d03-9ac9-4c7b-a61d-1b1b7ffa69dd.json` (a 1ª submissão, a recusada) | `832d15b4…9bee1f` | `docs/PROVA-100-LOGISTICA-2026-10-18.md` | recusado no build nativo: 133 `assign X=v`; aceito depois por patch (job `831bfa9a`) |
| `museum-model` | Museus, 100 entidades + 5 domínios | `3f190cc1-66f0-417a-a548-978887f90c18.json` (expansão de `museum-model-cold.batch`) | `91fb7330…bb3dc5` | `docs/PLANO-COMPILADOR-GERAL-BATCH-LAB.md`, ensaio museológico de 19/10 | entregue na 1ª submissão |

Notas de conversão:

- `naval-2/dados.ddl` é o DDL do ensaio de dados (o módulo do lab já o tinha quando o 2º corpus foi entregue) e
  `naval-2/ops.json` é a exceção `NvRuleViolation`, criada pelo 1º corpus (job `f5700bed-a8c3-492e-8f1a-c33aee736a87.json`).
  Contra uma captura vazia, os três juntos são o que o 2º corpus precisava encontrar no módulo.
- Hx no lab foi o lote recusado: este corpus é o texto como a LLM o mandou, antes do patch.
- O Museus que o lab recusou várias vezes (100 actions, 17/10, `docs/diagnosticos/2026-10-17-museus-100-actions.md`) não
  entrou: as recusas locais dele (rótulos repetidos, ids de mais de 32 caracteres) eram do compilador `ssam-batch/1`, que
  não existe aqui, e a nativa (mapa de identidade na Description acima de 2.000 caracteres) é da "identidade em Description"
  que o plano deixou fora (R5). O corpus de mesmo porte do mesmo domínio é o de 100 entidades acima.
