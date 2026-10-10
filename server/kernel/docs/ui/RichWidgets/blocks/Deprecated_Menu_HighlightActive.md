# Deprecated_Menu_HighlightActive

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 5 widgets internos

DEPRECATED: Use the Menu_GetStyle action instead.

Widget used to highlight the selected menu. If SetActive is set to true it will append the Active to the style of the previous element.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| SetActive | Boolean | sim |  |  |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Deprecated_Menu_HighlightActive1","source":"IWebBlock:Deprecated_Menu_HighlightActive","as":"$b"}
{"op":"set","target":"$b/SetActive","prop":"Value","value":"<Boolean>"}
```
