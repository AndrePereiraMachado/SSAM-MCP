# Animate

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 1 widgets internos

Use this Block to emphasise elements as they come on screen or while the screen is loading.

Drag content inside the placeholder and configure the animation type of the Block. 

You can also define the amount of wait time before an animation starts and define how long the animation lasts.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| AnimationType | AnimationType Identifier | sim |  | Kind of animation to be used on this Block |
| Delay | Integer | nao | 0 | Time to wait before animation starts, in miliseconds |
| Speed | Speed Identifier | nao |  | Time necessary for the animation reach the end. |

Valores possiveis (static entities):

- **Entities.AnimationType**: BottomToTop, ScaleDown, Scale, FadeIn, RightToLeft, LeftToRight, Bounce, TopToBottom, Spinner
- **Entities.Speed**: Fast, Slow, Normal

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Animate1","source":"IMobileBlock:Animate","as":"$b"}
{"op":"set","target":"$b/AnimationType","prop":"Value","value":"<AnimationType Identifier>"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```
