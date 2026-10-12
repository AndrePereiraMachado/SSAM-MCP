# FarmaVirtual: prototipo navegavel O11 Reactive

Abra `index.html` diretamente no navegador. Nao exige instalacao ou servidor.
Os dados ficticios ficam no localStorage do navegador, sob a chave
`farmavirtual-prototype-v1`.

O seletor de conta no cabecalho alterna entre Marina Costa e Lucas Oliveira
(FarmaVirtual_Cliente), Rafael Lima (FarmaVirtual_Admin) e Visitante. Trata-se
de simulacao de sessao para avaliar os perfis; nao e autenticacao real.

## Telas

| Tela O11 | URL do prototipo | Comportamento |
| --- | --- | --- |
| Catalogo | index.html#catalogo | Busca, categoria, disponibilidade, ordenacao, detalhes em modal e adicionar ao carrinho |
| Carrinho | index.html#carrinho | Quantidade, remocao, totais, dados de entrega e pedido simulado |
| MeusPedidos | index.html#meus-pedidos | Pedidos do usuario atual e filtro por status |
| PedidoDetalhe | index.html#pedido/1003 | Itens, precos historicos, entrega, observacao, status e total |
| GestaoProdutos | index.html#gestao-produtos | Criar, editar, estoque, preco, categoria, imagem, destaque e ativacao |
| GestaoPedidos | index.html#gestao-pedidos | Todos os pedidos, filtro por status e transicoes administrativas |

## Fidelidade ao modelo

`model.js` implementa as seis entidades propostas: Categoria, Produto,
CarrinhoItem, Pedido, PedidoItem e StatusPedido. Os nomes dos campos sao
identicos ao modelo. `Users` representa a tabela de usuarios de sistema,
sem criar uma entidade de dominio adicional.

As quatro structures sao representadas pelos objetos de filtro, itens,
resumo e entrega. As doze Service Actions aparecem com os mesmos nomes no
modelo JavaScript. `Categorias` e `Status` simulam aggregates read-only para
as listas de referencia. O filtro Ativo da gestao e um filtro de tela.

Os seis blocks visuais correspondem a `HeaderLoja`, `FiltrosCatalogo`,
`ProdutoCard`, `ProdutoDetalhe`, `ResumoCarrinho` e `StatusPedidoBadge`.

O pedido usa preco atual do catalogo, grava NomeProduto e PrecoUnitario em
PedidoItem, baixa estoque e limpa o carrinho. A mudanca e persistida como
uma unica atualizacao local. Cancelamento administrativo devolve estoque
uma unica vez. Transicoes: Recebido -> EmSeparacao ou Cancelado;
EmSeparacao -> Concluido ou Cancelado; os demais sao terminais.

O prototipo nao inclui desconto, cupom, frete, pagamento, receita medica,
avaliacao ou exclusao de produto, pois nao pertencem ao modelo definido.
O cliente nao cancela pedidos; a action AlterarStatusPedido e administrativa.

## Limites e implementacao O11

Este e um prototipo HTML/CSS/JavaScript local. As verificacoes aqui executam
no navegador para demonstrar comportamento, sem backend OutSystems.
Na implementacao O11, permissoes, usuario da sessao, precos, transacoes,
controle concorrente de estoque e idempotencia devem ser validados no servidor.
Os valores monetarios sao calculados em centavos neste prototipo.

Fotografias ficticias geradas para o catalogo; nao representam produtos
comercializados. A imagem `products.png` tem oito packshots em grade 4x2,
referenciados por `ImagemUrl=assets/products.png#tile=N`.
Os icones Lucide sao distribuidos localmente com a respectiva licenca.
As fontes web sao opcionais; ha fallback para fontes de sistema.

## Validacao

```powershell
node --test prototypes/farmavirtual/tests/model.test.cjs
```

O script `tests/browser.cjs` verifica os fluxos reais com Playwright e gera
capturas de todas as telas em desktop e mobile. Necessita o pacote Playwright.
As capturas usam dados reinicializados somente em contexto isolado de teste.

Para voltar aos dados iniciais no seu navegador, remova apenas a chave
`farmavirtual-prototype-v1` do armazenamento local desta pagina e recarregue.
