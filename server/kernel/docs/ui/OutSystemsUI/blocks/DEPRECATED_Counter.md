# DEPRECATED_Counter

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Numbers** | publico | 6 widgets internos

Use counters to give feedback about the current count of several elements, very useful on dashboards or summary pages.

Add content to the number and label placeholders, then, set up the color and size of the Web Block.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| BackgroundColor | DEPRECATED_Color Identifier | nao | Entities.DEPRECATED_Color.PrimaryColor | Background color of the Block |
| Height | Integer | nao |  | Height of the block, use Pixel units |
| IsHorizontal | Boolean | nao | False | If True show Counter in Horizontal. Default Value: False |

Valores possiveis (static entities):

- **Entities.DEPRECATED_Color**: Violet, None, Blue, Black, Red, Grey, Orange, Green, White, PrimaryColor

## Placeholders

- **Number**: Insert number (em `content/content`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Label**: Insert label (em `content/content`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Counter1","source":"IMobileBlock:DEPRECATED_Counter","empty":true,"as":"$b"}
```
