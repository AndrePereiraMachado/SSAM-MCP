# IconBadge

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Numbers** | publico | 7 widgets internos

Icon with a badge on top of it.

Add an icon to the content placeholder, then, set up the color and choose if want to apply the light theme.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Number | Integer | nao | 0 | Number that will appear inside the badge over the icon. |
| Color | Color Identifier | nao | Entities.Color.Primary | Color of the badge over the icon. |
| IsLight | Boolean | nao | False | Use the lightest color version for the background and the darker color version for the text. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Color**: Yellow, Neutral0, Indigo, Neutral7, Neutral8, Primary, Grape, Neutral10, Blue, Orange, Green, Lime, Neutral5, Secondary, Neutral6, Violet, Cyan, Pink, Red, Neutral1, Teal, Neutral3, Neutral4, Neutral2, Transparent, Neutral9

## Placeholders

- **Icon**: Drag the Icon widget to this placeholder. (em `IconBadgeWrapper`) | nasce com: WebBlockInstance:Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Icon, Badge

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"IconBadge1","source":"IWebBlock:IconBadge","empty":true,"as":"$b"}
```
