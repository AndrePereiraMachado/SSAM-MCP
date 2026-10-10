# Deprecated_Input_SetPrompt

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 6 widgets internos

DEPRECATED: Use the Prompt property of the Input widget instead.

Sets a prompt gray text of the specified Input when it is empty (e.g. 'Type here the customer name to search for').

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| InputWidgetId | Text | sim |  | The Id of the Input widget. |
| Prompt | Text | sim |  | The prompt to appear when the widget is empty. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
function RichWidgets_SetInputPrompt_bootstrap(inputId, prompt) {
    outsystems.internal.$(function($){
        if(outsystems.internal.$('#'+inputId).length == 0){
            try {
                window.OsHandleException(new Error("Invalid use of RichWidgets\\Input_SetPrompt: Please specify the runtime Id property of an Input widget."), outsystems.osErrorCodes.SystemJavascriptError, 'Input_SetPrompt');
            } catch(e) {}
            return;
        }
        OsInputPrompt_Bootstrap(inputId, prompt);
    });
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Deprecated_Input_SetPrompt1","source":"IWebBlock:Deprecated_Input_SetPrompt","as":"$b"}
{"op":"set","target":"$b/InputWidgetId","prop":"Value","value":"<Text>"}
{"op":"set","target":"$b/Prompt","prop":"Value","value":"<Text>"}
```
