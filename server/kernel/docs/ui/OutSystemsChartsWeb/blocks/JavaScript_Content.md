# JavaScript_Content

OutSystemsChartsWeb 2.0.0 | Traditional | UI flow **Utils** | privado | 6 widgets internos

Helps to identify in-line javascript usage in design time.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Content | Text | sim |  | JavaScript content, e.g.:  <script>    outsystems.internal.$(function() {      outsystems.internal.$("#dialog").dialog();   });    </script> |

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"JavaScript_Content1","source":"IWebBlock:JavaScript_Content","as":"$b"}
{"op":"set","target":"$b/Content","prop":"Value","value":"<Text>"}
```
