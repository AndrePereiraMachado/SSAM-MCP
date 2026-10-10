# LayoutSmartphone_Chicago

RichWidgets  | Traditional | UI flow **LayoutsSmartphone** | publico | 14 widgets internos

Default layout for Chicago Smartphone

## Inputs

Nenhum.

## Placeholders

- **Title**
- **MainContent**
- **Footer**
- **Menu**
- **Header**

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LayoutSmartphone_Chicago1","source":"IWebBlock:LayoutSmartphone_Chicago","as":"$b"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
{"op":"create","parent":"$b/MainContent","type":"IExpressionWidget","as":"$eMainContent"}
{"op":"create","parent":"$b/Footer","type":"IExpressionWidget","as":"$eFooter"}
{"op":"create","parent":"$b/Menu","type":"IExpressionWidget","as":"$eMenu"}
```
