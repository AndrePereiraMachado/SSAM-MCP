# Popup_Editor_WithToken

RichWidgets  | Traditional | UI flow **RichWidgets** | privado | 14 widgets internos

Opens the specified link on a modal pop-up that can have editable screens.
Actions PopUpEditor_Close and PopUpEditor_Notify can be used to send information to the parent screen.
If WidthPx and HeightPx are not specified the popup will auto-resize to contents. 
Refresh the pop-up whenever the link is refreshed to keep them working accordingly.
Not supported in mobile devices.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| LinkOrButtonWidgetId | Text | sim |  | The link or button id to open in the pop-up. |
| Title | Text | nao | " " | Title for the pop-up window. |
| WidthPx | Integer | nao | -1 | The width of the pop-up window. When not set it will automatically resize to fit contents. |
| HeightPx | Integer | nao | -1 | The height of the pop-up window. When not set it will automatically resize to fit contents. |
| AutoResize | Boolean | nao | True | When set to True, the popup will be resized after each Ajax refresh. The default is True. |
| RecenterOnResize | Boolean | nao | False | When set to True, the popup will be recentered when it is resized after an Ajax refresh. The default is False. |
| HideCloseButton | Boolean | nao | False |  |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: RichWidgetsjQueryUI
- Actions do bloco: GenerateUploadToken, FakeOnNotify
- Chama actions do modulo: Feedback_Message, CreateUploadToken, Deprecated_Notify (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Popup_Editor_WithToken1","source":"IWebBlock:Popup_Editor_WithToken","as":"$b"}
{"op":"set","target":"$b/LinkOrButtonWidgetId","prop":"Value","value":"<Text>"}
```
