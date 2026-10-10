# CardItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 7 widgets internos

Card with placeholders for Title, Text, Left side and Right side.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Left**: Add left content to this placeholder (em `content`)
- **Right**: Add right content to this placeholder (em `content`) | nasce com: Icon:Icon2 (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Title**: Add title to this placeholder (em `content/content`)
- **Content**: Add content to this placeholder (em `content/content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"CardItem1","source":"IMobileBlock:CardItem","empty":true,"as":"$b"}
{"op":"create","parent":"$b/Left","type":"IExpression","as":"$eLeft"}
{"op":"create","parent":"$b/Title","type":"IExpression","as":"$eTitle"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```
