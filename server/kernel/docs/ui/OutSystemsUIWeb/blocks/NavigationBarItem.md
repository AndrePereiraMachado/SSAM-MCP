# NavigationBarItem

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 3 widgets internos

Used within the NavigationBar Pattern. Should be placed inside the NavigationBar placeholder.

Drag into the NavigationBar Block as many items as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsActive | Boolean | nao | False | Set IsActive to true, to define as the selected element. |
| IsOpen | Boolean | nao | False | If true, when rendering the NavigationBarItem is open. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Title**: Use this placeholder to set your title.
- **Content**: Drag NavigationBarSubItem blocks to this placeholder.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"NavigationBarItem1","source":"IWebBlock:NavigationBarItem","as":"$b"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
