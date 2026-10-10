# Counter

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Numbers** | publico | 8 widgets internos

Use counters to give feedback about the current count of several elements.

Very useful on dashboards or summary pages.

Add content to the placeholder, then, set up the orientation and Height of the Block.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Orientation | Orientation Identifier | nao | Entities.Orientation.Horizontal | Set the orientation. |
| Height | Text | nao | "100" | Height of the block, use Pixel units. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Orientation**: Horizontal, Vertical

## Placeholders

- **Content**: Drag your content to this placeholder. (em `CounterWrapper`) | nasce com: Container, Container, Container (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Icon

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Counter1","source":"IWebBlock:Counter","empty":true,"as":"$b"}
```
