# LayoutSmartphone_Detroit

RichWidgets  | Traditional | UI flow **LayoutsSmartphone** | publico | 12 widgets internos

## Inputs

Nenhum.

## Placeholders

- **MainContent**
- **Footer**
- **Menu**
- **Title**

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Feedback_Message, MobileScripts, Feedback_AjaxWait

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LayoutSmartphone_Detroit1","source":"IWebBlock:LayoutSmartphone_Detroit","as":"$b"}
{"op":"create","parent":"$b/MainContent","type":"IExpressionWidget","as":"$eMainContent"}
{"op":"create","parent":"$b/Footer","type":"IExpressionWidget","as":"$eFooter"}
{"op":"create","parent":"$b/Menu","type":"IExpressionWidget","as":"$eMenu"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
```
