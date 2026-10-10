# DEPRECATED_IconBadge

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Numbers** | publico | 4 widgets internos

Icon with a Badge stacked on top of it.

Drag an Icon and Badge to their placeholders.

Used to display notifications with numbers.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Number | Long Integer | sim |  | Number to be displayed |
| BackgroundColor | DEPRECATED_Color Identifier | nao | Entities.DEPRECATED_Color.PrimaryColor | Background color of the Block |

Valores possiveis (static entities):

- **Entities.DEPRECATED_Color**: Violet, None, Blue, Black, Red, Grey, Orange, Green, White, PrimaryColor

## Placeholders

- **Icon**: Icon (em `content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: DEPRECATED_Badge

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_IconBadge1","source":"IMobileBlock:DEPRECATED_IconBadge","empty":true,"as":"$b"}
{"op":"set","target":"$b/Number","prop":"Value","value":"<Long Integer>"}
```
