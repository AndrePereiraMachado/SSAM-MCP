# Revisão da implementação de telas e das afirmações da entrega

Base revisada: commit `5004e59690cdce41751dd30c52c2eb2e6653615e`, mais o recibo de entrega
`62f8fc591d9f443fa40fc36f3f68e1e7` e a versão publicada do Incidents_UI.
Trabalho isolado em `codex/dashboard-review`; as alterações não commitadas de outras sessões no checkout principal não foram incorporadas.

## Afirmações confrontadas com evidência

| Afirmação | Resultado da revisão |
|---|---|
| Nada foi entregue; existem apenas provas headless | Era um estado anterior. O recibo confirma merge, seis checks e 20.561 ms. A API do ambiente confirma a versão 4901 publicada em 05/09/2026 às 23:56:14 -03:00. A URL já contém o Dashboard HTML compilado. |
| `deliver` conclui a publicação | Incorreto. O recibo demonstra merge no Studio. A publicação é um passo separado, comprovado nesta revisão pela leitura do ambiente. |
| Os quatro avisos eram de Anonymous | Confirmado: `Warning / CustomObjectWarning`, detalhe específico sobre acesso público sem autenticação. Não são quatro erros de compilação. |
| Tolerância a Anonymous já implementada | Não estava no código revisado. `MessageExpectations.Evaluate` ainda classificava todo aviso novo sem expectativa como inesperado. A correção desta revisão mantém esses avisos em `tolerated`. |
| HTML/CSS completo com comportamento preservado | Parcial. Existe compilação nativa real e CSS no tema. Os testes não demonstravam equivalência visual nem todos os comportamentos no navegador. Há defeitos reproduzíveis abaixo. |
| Mesma identidade após atualizar a tela | Comprovado para chave da tela e variáveis declaradas compatíveis. Não significa preservação das chaves dos widgets, screen actions, aggregates ou data actions, que são reconstruídos. |
| Merge sem conflitos comprova preservação funcional | Não. A ausência de conflitos e Verify válido não demonstra que cada botão, filtro, estado de erro ou regra de negócio segue correto. |

## Defeitos reproduzidos no código

1. `Derived()` atribuía `OnAfterFetch.Destination` a cada derivação. Duas derivações da mesma fonte deixavam somente a última ligada. Corrigido agrupando as derivações no mesmo handler, em sequência.
2. Busca e filtro de prioridade chamavam `RefreshAction` sem restringir as fontes: quatro leituras no Dashboard, embora somente `LoadRecent` consuma essas variáveis. Corrigido selecionando fontes consumidoras. A atualização explícita continua cobrindo todas.
3. O parser aceitava condições CSS aninhadas, mas guardava somente a mais interna; ao reemitir perdia, por exemplo, o `@media` ao redor de `@supports`. Corrigido preservando a pilha de condições. At-rules de declaração ainda não suportadas são recusadas, em vez de gerar seletores inválidos.
4. O compilador sempre inseria o título do layout mesmo quando o HTML já continha `h1`. Corrigido para não duplicar o título autorado.
5. A limpeza de tela excluía toda a lógica sem conferir referências em widgets preservados fora do conteúdo substituído. Acrescentada verificação dos consumidores antes da exclusão. Um consumidor preservado impede a substituição e é identificado no diagnóstico.
6. A limpeza começava antes da expansão/validação do novo HTML. A expansão agora precede a limpeza.

Risco adicional ainda não corrigido: `Scripts()` procura uma client action pelo nome no módulo inteiro e emite delete/create quando a encontra. O delete normal protege consumidores conhecidos, mas não comprova que uma action existente sem consumidores pertence a esta página. Falta delimitar a propriedade dessas funções; nomes coincidentes não devem autorizar substituição de lógica alheia.

Os quatro primeiros problemas receberam testes que falharam contra o código original antes da correção.

## Dashboard publicado

Inspecionado no navegador com sessão anônima e com o usuário autenticado já autorizado para este ambiente.

- Há dois cabeçalhos (nativo e autorado), título repetido e campos de data com borda/padding tanto no wrapper DatePicker quanto no input. O candidato remove o cabeçalho autorado redundante e corrige título, espaçamento e borda.
- O rodapé mostrava nomes internos de actions. Removido do candidato.
- A cor de prioridade comparava rótulos em português; a resposta real traz `Low`, `Medium`, `High`, `Critical`. O fixture usava rótulos diferentes do produtor e mascarava essa diferença.
- A sessão anônima recebe uma exceção de autorização, mas o painel continua exibindo zeros e listas vazias. Isso não equivale a dados válidos. Tolerar o aviso do Studio não corrige o estado de erro da página nem substitui a autorização do backend.
- O link “Ver incidentes abertos” passa apenas as datas. A própria documentação anterior já identificava a ausência de `OnlyOpen` em `IncidentList`. O comportamento prometido não está implementado.
  A interação autenticada confirmou a URL somente com `StartDate`/`EndDate` e o seletor em “Todos os status”. A busca também confirmou chamadas às quatro data actions, embora somente a lista de recentes use o texto.
- O link sob “Resolvidos hoje” passa `StatusId=Resolved` e o período atual; não expressa um filtro por data de resolução de hoje. Não se deve assumir equivalência.
- As tabelas não têm paginação funcional, apesar de a fonte retornar um total e limitar as linhas. Esse caso precisa ser provado com dados suficientes.

## Limites da capacidade

Esta implementação não é um tradutor geral de HTML/CSS/JS. O esquema recusa explicitamente formulários, textarea, imagens, SVG, diálogos e scripts inline. JavaScript é limitado às funções declaradas pelo manifesto. Layout/tema OutSystems e wrappers nativos ainda alteram o resultado. São limites de escopo que precisam aparecer na descrição da capacidade; não devem ser apresentados como cobertura universal ou fidelidade Figma comprovada.

Os testes de fixture usam stand-ins das actions de negócio. Demonstram compilação/recarga/merge, não a execução das actions reais no servidor com cenários preenchidos, autorização e erros.

## Evidências e estado

Artefatos privados de diagnóstico em `.local/review` (não versionar sessões/cookies/credenciais): downloads somente leitura do UI/CS, recibos da versão publicada, capturas desktop/mobile, testes e respostas das interações. O servidor não recebeu alterações nesta revisão.

A bridge SS4 respondeu ao ping, mas recusou as operações autenticadas com `Bridge operation requires the trusted Hybrid controller`; SS5 não estava ouvindo. A revisão prossegue por compilação e prova em arquivos, sem contornar a autenticação e sem reiniciar o Studio com alterações de outra sessão.

O candidato foi aplicado sobre o download da versão publicada 4901 com produtor Incidents_CS atual: `accepted=true`, `isValid=true`, 17.009 objetos, load 1.271 ms e apply 8.607 ms. Os quatro avisos novos de Anonymous aparecem em `validation.tolerated`; o restante dos avisos é preexistente. Esta prova é em arquivo, não entrega viva. O uso de `LoadDashboard.IsDataFetched` também foi aceito em uma prova separada, mas o tratamento de loading/erro ainda não foi integrado à página.

Merge de três vias do candidato: 17.009 objetos local/foreign, Verify válido, zero erros e nenhum conflito. Regressão ampla: 445/447; as duas falhas eram expectativas da página que ainda exigiam o cabeçalho/binding removidos. Corrigidas essas expectativas, a execução final de HTML, delta nativo e contrato de mensagens passou 54/54, incluindo o novo cenário de consumidor preservado. Não foi repetida toda a matriz de actions após alterações apenas nas expectativas desses testes.

**Aprovação da entrega completa permanece pendente**: falta resolver os comportamentos de navegação/estados/dados acima, validar no navegador o resultado compilado com dados representativos e entregar pelo controlador autenticado. Não confundir as correções locais desta revisão com instalação nas faixas ou nova publicação do produto.
