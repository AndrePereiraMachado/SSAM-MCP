# DEPRECATED_Tag

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 1 widgets internos

Display text highlighting its importance.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| BackgroundColor | DEPRECATED_Color Identifier | nao | Entities.DEPRECATED_Color.PrimaryColor | Background color of the Block |

Valores possiveis (static entities):

- **Entities.DEPRECATED_Color**: Violet, None, Blue, Black, Red, Grey, Orange, Green, White, PrimaryColor

## Placeholders

- **Tag**: Text

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Tag1","source":"IMobileBlock:DEPRECATED_Tag","as":"$b"}
{"op":"create","parent":"$b/Tag","type":"IExpression","as":"$eTag"}
```
