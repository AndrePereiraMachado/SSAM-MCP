# Iframe

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Utilities** | publico | 6 widgets internos

Display additional information in one view.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| SourceURL | Text | sim |  | The target URL to load on the Iframe. |
| Title | Text | nao |  | Title for the iframe element. |
| Height | Text | nao | "100%" | Iframe height, default is 100%. |
| Width | Text | nao | "100%" | Iframe width, default is 100%. |

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Iframe1","source":"IWebBlock:Iframe","as":"$b"}
{"op":"set","target":"$b/SourceURL","prop":"Value","value":"<Text>"}
```
