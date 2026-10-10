# StackedIcon

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Utilities** | publico | 7 widgets internos

Use this pattern to be able to stack two RichWidget Icons on top of each other.

Select both icons to be displayed and their colors. You can also set which is in front and swap their sizes.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IconFront | IconName Identifier | nao | Entities.IconName.camera | The icon to display in front of the other. |
| IconBack | IconName Identifier | nao | Entities.IconName.ban | The icon to display behind the other. |
| IconFrontColor | Color Identifier | nao | Entities.Color.Neutral10 | Front icon color. |
| IconBackColor | Color Identifier | nao | Entities.Color.Neutral10 | Back Icon color. |
| IconSize | IconSize Identifier | nao |  | Set the size. |
| InvertSize | Boolean | nao |  | Set to True to swap the icon sizes. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Color**: Yellow, Neutral0, Indigo, Neutral7, Neutral8, Primary, Grape, Neutral10, Blue, Orange, Green, Lime, Neutral5, Secondary, Neutral6, Violet, Cyan, Pink, Red, Neutral1, Teal, Neutral3, Neutral4, Neutral2, Transparent, Neutral9

## Placeholders

Nenhum.

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"StackedIcon1","source":"IWebBlock:StackedIcon","as":"$b"}
```
