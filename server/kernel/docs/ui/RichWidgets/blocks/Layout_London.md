# Layout_London

RichWidgets  | Traditional | UI flow **Layouts** | publico | 28 widgets internos

## Inputs

Nenhum.

## Placeholders

- **Header**
- **Menu**
- **MainContent**
- **Title**
- **Actions**
- **Footer**

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: MenuSlider, Feedback_Message, ResponsiveTableRecords, Feedback_AjaxWait, AllowAddToIOSHome
- Chama actions do modulo: AddMetaTag (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Layout_London1","source":"IWebBlock:Layout_London","as":"$b"}
{"op":"create","parent":"$b/Header","type":"IExpressionWidget","as":"$eHeader"}
{"op":"create","parent":"$b/Menu","type":"IExpressionWidget","as":"$eMenu"}
{"op":"create","parent":"$b/MainContent","type":"IExpressionWidget","as":"$eMainContent"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
```
