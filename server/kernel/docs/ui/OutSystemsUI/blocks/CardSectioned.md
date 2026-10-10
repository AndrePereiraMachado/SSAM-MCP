# CardSectioned

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 6 widgets internos

Card with placeholders for Title, Content and Footer. Title and Footer placeholders are not displayed if they are empty.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| UsePadding | Boolean | nao | True | When true, content has padding |
| IsVertical | Boolean | nao | True | Set the orientation. |
| ImagePadding | Boolean | nao | True | When true, image has 24px of padding. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Image** (em `content`)
- **Title**: Add title to this placeholder (em `content/content`)
- **Content**: Add content to this placeholder (em `content/content`)
- **Footer**: Add footer content to this placeholder (em `content/content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"CardSectioned1","source":"IMobileBlock:CardSectioned","as":"$b"}
{"op":"create","parent":"$b/Image","type":"IExpression","as":"$eImage"}
{"op":"create","parent":"$b/Title","type":"IExpression","as":"$eTitle"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
{"op":"create","parent":"$b/Footer","type":"IExpression","as":"$eFooter"}
```
