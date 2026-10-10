# Timeline

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 5 widgets internos

Used to create a sequence of chronologically related events.

Drag as many TimelineItems to the Content placeholder as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Content**: Drag TimelineItem blocks into this placeholder | nasce com: WebBlockInstance:TimelineItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: TimelineItem

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Timeline1","source":"IWebBlock:Timeline","empty":true,"as":"$b"}
```
