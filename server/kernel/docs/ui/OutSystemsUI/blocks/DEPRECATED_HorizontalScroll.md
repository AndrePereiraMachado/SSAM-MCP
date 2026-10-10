# DEPRECATED_HorizontalScroll

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 1 widgets internos

Simple horizontally scrollable Block with a placeholder for content.

Ideal to display multiple elements in a single, scrollable row.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Content**: Add content to this placeholder

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_HorizontalScroll1","source":"IMobileBlock:DEPRECATED_HorizontalScroll","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```
