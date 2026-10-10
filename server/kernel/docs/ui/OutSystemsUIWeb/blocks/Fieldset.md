# Fieldset

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Utilities** | publico | 4 widgets internos

Group thematically related elements, such as controls and labels.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Title | Text | sim |  | The title that will be the legend of the Fieldset |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Content**: Drag your Input widgets to this placeholder. (em `FieldsetWrapper`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Fieldset1","source":"IWebBlock:Fieldset","as":"$b"}
{"op":"set","target":"$b/Title","prop":"Value","value":"<Text>"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
