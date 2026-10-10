# Mass-Casualty: relatórios acessíveis e correções entregues

## Causa da percepção de perda

O teste E2E gravou `CR-2026-00048`, `CR-2026-00049` e `CR-2026-00050` como rascunhos. A aprovação filtra apenas relatórios submetidos/em revisão. O menu Casualty Reporting abre um formulário novo, e a tela CSV não oferecia uma lista persistente nem links no resultado. Abrir diretamente `CasualtyReportDetail?ReportId=48` retornou HTTP 200 e exibiu o número, identidade e dados do incidente gravados.

## Entrega nativa no SS4

- **CS:** `MassCasualty_ListMyImports` consulta os últimos 50 relatórios de CSV do usuário autenticado, ordenados por criação/ID. Exige sessão e restringe por `ReporterUserId`; não confia em um ID de usuário enviado pelo cliente. A identidade apresentada vem do registro nativo de usuário.
- **UI:** lista “My imported reports”, status, links nativos por ReportId, atualização após envio confirmado, botão Refresh e mensagem própria se a leitura falhar. O resultado do lote também contém links para os rascunhos. A lista volta a consultar o servidor ao reabrir a tela.
- **Fluxo:** criação permanece Draft, sem aprovação/submissão automática. O texto explica a diferença. Como Cases ainda não é uma tela implementada neste módulo, o antigo Cancel agora é “Back to my reports” e leva à lista existente na própria página, sem um endereço fictício.
- **Dados:** a criação preenche `IncidentType`, `LegacyIncidentDate`, `MultiCasualtyIncident`, `MultiCasualtyId` e `MultiCasualtyIncidentName` junto dos campos anteriores, na mesma gravação do relatório. O detalhe da aprovação passa a receber os campos que efetivamente lê.
- **Erros:** validação de data futura mostra instrução específica de correção; mensagens conhecidas de obrigatoriedade/limite são preservadas. Falhas desconhecidas mantêm orientação de repetir a mesma chave. Falha ao recarregar a lista é tratada separadamente, preservando o resultado do envio.
- **CSV:** leitura respeita campos multilinha entre aspas, aspas escapadas e BOM; aspas não fechadas bloqueiam o envio. Drag-and-drop usa o evento nativo CsvChanged, com um listener por instância do bloco e remoção no OnDestroy.
- **Visual/acessibilidade:** layout de celular quebra título e botões; cabeçalho reduz grupos de desktop; resultado recebe região aria-live; links têm foco visível. CSS temporário no Chrome comprovou título e controles contidos em 390 CSS px.

## Reconciliação dos registros existentes

Foram preenchidos somente campos vazios de cinco relatórios que já tinham IncidentGroupId: IDs 20, 21, 48, 49 e 50. Tipo e data só foram copiados quando havia valor de origem. A releitura confirmou as alterações esperadas e igualdade de todos os demais campos/registros. A contagem permaneceu 50; nenhum relatório foi criado ou apagado pela reconciliação.

Plano, entradas, backup e comparação: `.local/mass-casualty-e2e/import-field-repair-*.json` e `CasualtyReport-before-field-repair.json` / `CasualtyReport-after-field-repair.json`.

## Provas e publicação pendente

- CS: recibo `a832f8715f8e4e76b3ca874f0fc8af66`, delivered=true, Verify sem erros, 18 checks de dados aceitos. Warning preexistente de outra estrutura mantido.
- UI: recibo `3421d56206054d58b5dfdf0c1bb2c0c6`, delivered=true, Verify sem erros; checks de MassCasualty, GetMyImports, ImportedReports, OpenSavedReport e MC_ApplyDroppedCsv. Warning de Anonymous Role visível/tolerado conforme política; a action de leitura exige sessão no servidor.
- Ambos os recibos passaram em check-delivery com hashes atuais.
- `node tests/browser/dcips-masscasualty-contract.cjs`: parser, limites e ciclo de vida do handler de drop. Esses testes não substituem o navegador publicado.
- Abertura real do relatório 48 comprovada na versão previamente publicada; a nova listagem ainda depende de publicação. Preview CSS não é prova de código publicado.

**Próximo passo obrigatório:** publicar primeiro `DCIPS_Migration_PoC_CS`, depois atualizar a referência no UI se o Studio solicitar e publicar `DCIPS_Migration_PoC_UI`. Depois executar E2E do novo upload → resultado → abrir relatório → voltar/recarregar lista, erro de data, drag-and-drop e mobile. Não declarar esses cenários finais concluídos antes dessa prova.

O gerador `scripts/gen_dcips_masscasualty_fixes.py` produz patches sobre identidades inspecionadas. Os jobs de criação não devem ser reaplicados cegamente sobre uma base que já contém seus novos objetos; para continuação, ler o recibo e o estado entregue.
