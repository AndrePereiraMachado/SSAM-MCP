# TabsHeaderItem

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 1 widgets internos

Item for placeholder Header in the Tabs Block. Drag as many items as you need.

The headers can have rich information like counters, badges or icons.

Use the DataTab parameter to give a custom value, which must correspond to the DataTab given in the respective TabsContentItem. Drag your content to the placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| DataTab | Text | sim |  | Value that will connect with the TabsContentItem.  Should be the same as the paired TabsContentItem and unique. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Title**: Use this placeholder to set your title.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"TabsHeaderItem1","source":"IWebBlock:TabsHeaderItem","as":"$b"}
{"op":"set","target":"$b/DataTab","prop":"Value","value":"<Text>"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
```
