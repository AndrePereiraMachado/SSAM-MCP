# BlankSlate

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 6 widgets internos

A simple box that presents an empty state to the user and provides directions. Has placeholder for an Icon, text and an action button. Works great for user onboarding.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| FullHeight | Boolean | nao | True | Display a larger BlankSlate, taking over full page height. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Icon**: Drag an Icon to this placeholder (em `BlankState/content/content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Content**: Add the Blank Slate content to this placeholder (em `BlankState/content/content`)
- **Actions**: Drag Buttons to this placeholder (em `BlankState/content/content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"BlankSlate1","source":"IMobileBlock:BlankSlate","empty":true,"as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
{"op":"create","parent":"$b/Actions","type":"IExpression","as":"$eActions"}
```
