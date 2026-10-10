# LayoutSmartphone_London

RichWidgets  | Traditional | UI flow **LayoutsSmartphone** | publico | 15 widgets internos

Layout for London Smartphone

## Inputs

Nenhum.

## Placeholders

- **Footer**
- **Menu**
- **Header**
- **Title**
- **MainContent**

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LayoutSmartphone_London1","source":"IWebBlock:LayoutSmartphone_London","as":"$b"}
{"op":"create","parent":"$b/Footer","type":"IExpressionWidget","as":"$eFooter"}
{"op":"create","parent":"$b/Menu","type":"IExpressionWidget","as":"$eMenu"}
{"op":"create","parent":"$b/Header","type":"IExpressionWidget","as":"$eHeader"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
```
