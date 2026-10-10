# DEPRECATED_UserAvatar

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 6 widgets internos

Display the picture or initials of a user.

Bind the name and picture of the user to the input parameters of the Block. If no picture exists, the user initials will be used by default.

Ideal to display information of the currently logged user.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Name | Text | nao |  | Name of the user |
| Image | Binary Data | nao |  | Image of the user |
| BackgroundColor | DEPRECATED_Color Identifier | nao | Entities.DEPRECATED_Color.PrimaryColor | Background color of the Block |

Valores possiveis (static entities):

- **Entities.DEPRECATED_Color**: Violet, None, Blue, Black, Red, Grey, Orange, Green, White, PrimaryColor

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_UserAvatar1","source":"IMobileBlock:DEPRECATED_UserAvatar","as":"$b"}
```
