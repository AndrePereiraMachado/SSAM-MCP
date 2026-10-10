# FakeNotifyWidget

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 4 widgets internos

Use this widget to call a screen action from JavaScript:
1. Name this widget, edit its JavaScript and add the following call: OsNotifyWidget('<WebBlockWidgetName>.Id', '<message>').
2. Use the 'NotifyWidgetGetMessage()' built-in function in the flow of the 'FakeOnNotify' screen action to get the <message> value.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Actions do bloco: FakeOnNotify
- Chama actions do modulo: Deprecated_Notify (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"FakeNotifyWidget1","source":"IWebBlock:FakeNotifyWidget","as":"$b"}
```
