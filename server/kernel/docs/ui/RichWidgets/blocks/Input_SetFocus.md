# Input_SetFocus

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 6 widgets internos

Sets the focus on the specified Input or Input Password widget when the screen loads.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| InputWidgetId | Text | sim |  | The Id of the Input or Input Password widget. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
function RichWidgets_Input_SetFocus_init(widgetId)
{
  outsystems.internal.$(function($){
    var widget = document.getElementById(widgetId);
    if (widget == null)
    {
        try {
            window.OsHandleException(new Error("Invalid use of RichWidgets\\Input_SetFocus: Please specify the runtime Id property of an Input or Input Password widget."), outsystems.osErrorCodes.SystemJavascriptError, 'Input_SetFocus');
        } catch(e) {}
        return;
    }
    if (widget.tagName != "INPUT" && widget.tagName != "TEXTAREA")
    {
        try {
            window.OsHandleException(new Error("Invalid use of RichWidgets\\Input_SetFocus: Only Input and Input Password widgets are supported."), outsystems.osErrorCodes.SystemJavascriptError, 'Input_SetFocus');
        } catch(e) {}
        return;
    }
    widget.focus();
    widget = null;
  });
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Input_SetFocus1","source":"IWebBlock:Input_SetFocus","as":"$b"}
{"op":"set","target":"$b/InputWidgetId","prop":"Value","value":"<Text>"}
```
