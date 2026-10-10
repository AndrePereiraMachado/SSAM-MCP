# NavigationBarSubItem

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 1 widgets internos

Used within the NavigationBarItem Pattern. Should be placed inside the NavigationBarItem placeholder.

Drag into the NavigationBarItem Block as many items as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsActive | Boolean | nao | False | Set IsActive to true, to define as the selected element. |

## Placeholders

- **Content**: Drag your content to this placeholder.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"NavigationBarSubItem1","source":"IWebBlock:NavigationBarSubItem","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
