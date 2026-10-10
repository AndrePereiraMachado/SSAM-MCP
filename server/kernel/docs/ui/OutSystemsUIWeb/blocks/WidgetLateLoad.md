# WidgetLateLoad

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Private** | privado | 7 widgets internos

Runs the OnNotify action on first screen load. 
Useful to call an action to populate TableRecord widgets.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Actions do bloco: FakeOnNotify
- Chama actions do modulo: RunJavaScript, Deprecated_Notify (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"WidgetLateLoad1","source":"IWebBlock:WidgetLateLoad","as":"$b"}
```
