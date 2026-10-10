# ButtonGroupItem

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 3 widgets internos

A row of buttons grouped in a single element.

This is an effective way to toggle between filters.

Add a label to the placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| RadioButtonId | Text | nao |  | Use this parameter to bind the Id of the radio-button inside, to the For attribute on the label. This is necessary for accessibility compliance. |

## Placeholders

- **Label**: Drag the Label widget to this placeholder. | nasce com: RadioButton, Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ButtonGroupItem1","source":"IWebBlock:ButtonGroupItem","empty":true,"as":"$b"}
```
