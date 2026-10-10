# AlignCenter

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Structure** | publico | 1 widgets internos

Align multiple elements with different heights or widths.

Add two or more elements inside the placeholder and they will be centered according to the selected orientation.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Orientation | Orientation Identifier | nao | Entities.Orientation.Horizontal | Set the orientation of the content inside. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Orientation**: Horizontal, Vertical

## Placeholders

- **Content**: Content that will appear inside AlignCenter

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"AlignCenter1","source":"IWebBlock:AlignCenter","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
