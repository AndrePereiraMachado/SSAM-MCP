# Wizard

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 13 widgets internos

Used to split larger tasks into more manageable steps. Usually supported by explicit button navigation to move forward and backward.

Drag as many WizardItems in the Content placeholder as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsVertical | Boolean | nao | False | Set the orientation. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Content**: Add Wizard Items to this placeholder | nasce com: WebBlockInstance:WizardItem, WebBlockInstance:WizardItem, WebBlockInstance:WizardItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: WizardItem

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Wizard1","source":"IMobileBlock:Wizard","empty":true,"as":"$b"}
```
