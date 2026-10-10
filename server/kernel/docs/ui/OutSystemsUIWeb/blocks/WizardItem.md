# WizardItem

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 4 widgets internos

Step item to add in the Wizard pattern.

Drag the icon you want in the Icon placeholder and define the correspondent label in the Label placeholder. 
Use the Status parameter to define it's status (Past, Active, Next) and the LabelPosition to set it above (true) or alongside (false).

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Step | Step Identifier | sim |  | Set the step. |
| UseTopLabel | Boolean | nao | False | If true, label is placed above the icon. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Step**: Past, Next, Active

## Placeholders

- **Label**: Drag the Label widget to this placeholder. (em `WizardItemWrapper`)
- **Icon**: Drag the Icon widget to this placeholder. (em `WizardItemWrapper`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"WizardItem1","source":"IWebBlock:WizardItem","as":"$b"}
{"op":"set","target":"$b/Step","prop":"Value","value":"<Step Identifier>"}
{"op":"create","parent":"$b/Label","type":"IExpressionWidget","as":"$eLabel"}
{"op":"create","parent":"$b/Icon","type":"IExpressionWidget","as":"$eIcon"}
```
