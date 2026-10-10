# ButtonGroup

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 13 widgets internos

A row of buttons grouped in a single element.

This is an effective way to toggle between filters.

Add ButtonGroupItems to the Content placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsJustified | Boolean | nao | False | The Items are evenly distributed in the space available. |

## Placeholders

- **Content**: Drag a ButtonGroupItem to this placeholder. | nasce com: WebBlockInstance:ButtonGroupItem, WebBlockInstance:ButtonGroupItem, WebBlockInstance:ButtonGroupItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: ButtonGroupItem

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ButtonGroup1","source":"IWebBlock:ButtonGroup","empty":true,"as":"$b"}
```
