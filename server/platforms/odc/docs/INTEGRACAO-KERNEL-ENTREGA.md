# Jobs do kernel e entrega ODC

Atualizado em 2026-09-18. Esta rodada fecha a entrada pública dos problemas 18 e 19 de
`FRICCAO-QUOTES-REFACTOR.md`: candidato externo sem manifesto e inspect sem caminho com `--budget`.
Também corrige o `spawn EINVAL` da entrada `ssam` no Windows: a fachada ODC passa a ser chamada pelo Node,
com argumentos separados, sem executar um `.cmd` por `execFile`.

## Um job até o preview ou merge

```powershell
.\ssam deliver minha-mudanca --lane odc --job C:\trabalho\mudanca.json --module MeuModulo --owners '["MinhaTela"]' --changes '["Atualizar a tela"]' --until preview
```

O equivalente no MCP é `studio_deliver` com `feature`, `job`, `module`, `owners`, `changes` e `until`.
Sem `job`, a ferramenta mantém o caminho das features C# registradas.

O caminho do job é absoluto ou relativo à raiz **SSAM-Hybrid-ODC**. O caminho do `ssam_job` continua relativo ao
Anvil, como antes. A opção `--feature` também é aceita no lugar do primeiro argumento posicional.

O ciclo é snapshot → apply do kernel → validação e manifesto → check-base → preview → merge.
`--until snapshot|build|check-base|preview|merge` determina onde parar; o padrão é `merge`.
Não execute novamente o job depois de revisar um preview: use o `manifest` retornado em `studio_merge`,
que verifica novamente a base. O ciclo nunca publica.

O kernel usado é `ANVIL_ROOT/.local/lane-odc/cli/anvil-odc.dll`. A aplicação roda em processo próprio com
`ANVIL_DEVELOPER_ID` vindo do snapshot; não altera nem reinicia os workers residentes. Essa escolha evita
reutilizar um worker com identidade de outra sessão, mas paga o custo do carregamento do runtime.
`accepted=true` e `isValid=true` são obrigatórios: jobs negativos com `expectValid=false` não são entregáveis.
Não há override de tenant; a identidade sempre vem do snapshot. Na versão candidata de aquisição de dependências,
produtores nomeados em operações `reference` do job raiz são capturados pelo bridge antes do build.
Contrato, limites e estado de liberação: [AQUISICAO-DEPENDENCIAS.md](AQUISICAO-DEPENDENCIAS.md).

Cada tentativa tem uma pasta nova em `lab/` (ou `--output`), `kernel-result.json`, `delivery/manifest.json`,
o candidato copiado, o recibo da validação e `deliver-result.json`. Recusas param a cadeia. Conflitos e ausência
de mudanças impedem merge. Falha de transporte durante merge é resultado incerto, sem repetição automática.
Antes de outra tentativa, ler os recibos do bridge e o journal. Uma pasta existente é recusada.

## Preparar um candidato já existente

```powershell
.\odc manifest --base C:\trabalho\base.oml --candidate C:\trabalho\candidate.oml --output C:\trabalho\nova-entrega --feature minha-mudanca --owners '["MinhaTela"]' --changes '["Atualizar a tela"]'
```

No MCP: `studio_manifest` com `base`, `candidate`, `output`, `feature`, `owners` e `changes`.
Exige o `.oml.json` do snapshot. Não consulta o catálogo para adivinhar identidade nem inventa horário de captura.
Confere hash, data, módulo/chave e delta de erros/avisos; verifica que o candidato muda algo em relação à captura,
lido dos dois modelos elemento a elemento (novos, removidos, propriedades diferentes: um valor padrão ou uma descrição
num atributo existente não carimba nada e continua sendo mudança; um candidato igual à captura é recusado como
`NO_CHANGE`) e, quando carimba elementos, que um carimbo é do autor do snapshot (outro autor: reconstruir); copia o
candidato para uma pasta nova e usa a mesma classe `Manifest` do bridge.
O manifesto não contém autorização de publicação/criação. Depois vêm `studio_check_base`, `studio_preview`
e `studio_merge`, com os mesmos gates nativos de sempre.

Um candidato produzido por um worker com autor diferente deve ser reconstruído com a identidade correta.
O caminho preferido para trabalho novo é `studio_deliver` com `job`.

## Inspeção e provas

O parser agora consome as opções por posição, incluindo `--budget`, sem confundir seus valores com um caminho.
Opções desconhecidas, sem valor ou mais de um caminho são recusadas com diagnóstico.

`node --test facade/tests/*.test.mjs` cobre MCP real, kernel e builder headless sobre fixture local, metadados
ausentes, base adulterada/antiga, identidade incorreta, reutilização de pasta e recusas/interrupções em cada etapa.
O teste headless depende do fixture ODC do Anvil e do CLI compilado; é explicitamente pulado se faltarem.
O fixture usa metadados sintéticos, somente em disco; não passa por preview/merge no Studio.
O fluxo de merge é testado com respostas simuladas do bridge. A prova de entrega viva desta entrada permanece
pendente de uma entrega real autorizada; testes headless não equivalem a essa prova.

Verificação desta rodada: builder compilado sem erros/avisos; 98 testes passaram em
`node --test portal/tests/*.test.mjs facade/tests/*.test.mjs`, sem skips. Depois do ajuste final para preservar
`outcome=uncertain` devolvido pelo bridge, os 13 testes de `kernel-delivery.test.mjs` passaram, incluindo o caso
novo. `git diff --check` passou. Os testes atuais usam diretórios temporários e os removem ao terminar.
Três pastas `lab/integration-*` de execuções anteriores desta rodada ficaram no disco porque a revisão
automática bloqueou sua remoção; não são entregas ao Studio.

## Um repositório ou dois

Recomendação: convergir para um repositório, mantendo kernel, adaptadores O11/ODC, fachada e testes separados
em pastas/projetos. Isso permite um único commit e uma única revisão para alterações no contrato de integração.
Dois repositórios continuam justificáveis se o Anvil tiver versão, distribuição e consumidores independentes;
nesse caso a integração precisa fixar uma versão compatível do kernel, em vez de depender de uma pasta mutável.

A consolidação é uma migração separada: preservar os históricos, inventariar caminhos absolutos e configurações
de MCP/workers, ajustar a descoberta da raiz, rodar as provas das duas faixas e só então trocar a entrada da sessão.
`lab`, snapshots, credenciais, bibliotecas do fabricante e resultados de build continuam fora do Git.
Esta rodada não move pastas nem altera o repositório Anvil.
