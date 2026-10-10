# DEPRECATED_Wizard

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 10 widgets internos

Container for WizardItem Blocks that create a visual indication of the progress of a given set of tasks.

Add this Block to the screen and then drag WizardItem Blocks inside the placeholder.
Items can be configured the change their status.

Used to split larger tasks into more manageable steps.

## Inputs

Nenhum.

## Placeholders

- **WizardItems**: Add Wizard Items to this placeholder | nasce com: WebBlockInstance:DEPRECATED_WizardItem, WebBlockInstance:DEPRECATED_WizardItem, WebBlockInstance:DEPRECATED_WizardItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: DEPRECATED_WizardItem

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Wizard1","source":"IMobileBlock:DEPRECATED_Wizard","empty":true,"as":"$b"}
```
