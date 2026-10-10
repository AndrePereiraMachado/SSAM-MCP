# TabsContentItem

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 1 widgets internos

Item for placeholder Content in the Tabs Block. Drag as many items as you need.

Use the DataTab parameter to give a custom value, which must correspond to the DataTab given in the respective TabsHeaderItem. Drag your content to the placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| DataTab | Text | sim |  | Value that will connect with the TabsHeaderItem.  Should be the same as the paired TabsHeaderItem and unique. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Content**: Drag your content to this placeholder.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"TabsContentItem1","source":"IWebBlock:TabsContentItem","as":"$b"}
{"op":"set","target":"$b/DataTab","prop":"Value","value":"<Text>"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
