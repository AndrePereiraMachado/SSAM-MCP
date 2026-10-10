# DEPRECATED_ProgressBar

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Numbers** | publico | 4 widgets internos

Animated progress bar.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Progress | Integer | sim |  | Progress percentage. Usually a number from from 0 to 100. |
| BackgroundColor | DEPRECATED_Color Identifier | nao | Entities.DEPRECATED_Color.PrimaryColor | The background color of the progress bar |
| Height | Integer | nao | 12 | Height, in pixels. |
| AnimateInitialProgress | Boolean | nao | True | When True, the progress circle will show an animation going from zero to its initial progress. |
| Text | Text | nao |  | Text to be displayed, if not text is defined, the progress percentage is shown |

Valores possiveis (static entities):

- **Entities.DEPRECATED_Color**: Violet, None, Blue, Black, Red, Grey, Orange, Green, White, PrimaryColor

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnReady -> OnReady
- Actions do bloco: OnReady

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_ProgressBar1","source":"IMobileBlock:DEPRECATED_ProgressBar","as":"$b"}
{"op":"set","target":"$b/Progress","prop":"Value","value":"<Integer>"}
```
