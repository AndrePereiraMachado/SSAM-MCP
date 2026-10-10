# Layout_Chicago

RichWidgets  | Traditional | UI flow **Layouts** | publico | 18 widgets internos

## Inputs

Nenhum.

## Placeholders

- **Header**
- **Menu**
- **Title**
- **Actions**
- **MainContent**
- **Footer**

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Feedback_Message, Feedback_AjaxWait

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Layout_Chicago1","source":"IWebBlock:Layout_Chicago","as":"$b"}
{"op":"create","parent":"$b/Header","type":"IExpressionWidget","as":"$eHeader"}
{"op":"create","parent":"$b/Menu","type":"IExpressionWidget","as":"$eMenu"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
{"op":"create","parent":"$b/Actions","type":"IExpressionWidget","as":"$eActions"}
```
