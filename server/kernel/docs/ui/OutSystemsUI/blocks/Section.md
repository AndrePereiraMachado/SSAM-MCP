# Section

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 3 widgets internos

Use it to segment and arrange blocks of content on a page. It also allows to create a Section index if you are using both patterns in the same page.

Fill in the title, actions and content placeholders. It is possible to configure a label to use with the SectionIndex pattern.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| UsePadding | Boolean | nao | True | True by default, applies padding to the Content area. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Title**: Section Title (em `content`)
- **Content**: Add content to this placeholder (em `content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS


```css


```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Section1","source":"IMobileBlock:Section","as":"$b"}
{"op":"create","parent":"$b/Title","type":"IExpression","as":"$eTitle"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```
