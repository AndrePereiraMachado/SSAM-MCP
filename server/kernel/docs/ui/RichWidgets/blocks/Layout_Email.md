# Layout_Email

RichWidgets  | Traditional | UI flow **LayoutsOther** | publico | 8 widgets internos

## Inputs

Nenhum.

## Placeholders

- **Title**
- **MainContent**

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Layout_Email1","source":"IWebBlock:Layout_Email","as":"$b"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
{"op":"create","parent":"$b/MainContent","type":"IExpressionWidget","as":"$eMainContent"}
```
