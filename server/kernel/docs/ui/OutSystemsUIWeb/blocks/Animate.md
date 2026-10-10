# Animate

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Utilities** | publico | 2 widgets internos

Create animations on elements inside the placeholder of this Block.

Drag the content inside the placeholder and configure the animation type of the Block. It's also possible to change the ammount of time to wait before the animation start and how long will it take to end.

Used to easily add default animations to emphasise elements as they come on screen.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| EnterAnimation | EnterAnimation Identifier | nao | Entities.EnterAnimation.EnterFade | Set the enter animation. |
| LeaveAnimation | LeaveAnimation Identifier | nao | Entities.LeaveAnimation.LeaveFade | Set the leave animation. |
| Speed | Speed Identifier | nao |  | Time necessary for the animation reach the end. |
| Delay | Integer | nao | 0 | Time to wait before animation starts, in miliseconds |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.EnterAnimation**: EnterFade, EnterScale, EnterTop, EnterRight, EnterBottom, EnterLeft
- **Entities.LeaveAnimation**: LeaveBottom, LeaveScale, LeaveFade, LeaveLeft, LeaveTop, LeaveRight
- **Entities.Speed**: Normal, Fast, Slow

## Placeholders

- **Content**: Drag elements to be animated

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Animate1","source":"IWebBlock:Animate","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
