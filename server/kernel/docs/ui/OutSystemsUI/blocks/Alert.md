# Alert

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 16 widgets internos

Alert box with a placeholder for custom content, supports Success, Danger, Warning and Info messages.

To disable the focus feature, use the class 'disable-alert-focus' on the ExtendedClass parameter.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| AlertType | Alert Identifier | nao | Entities.Alert.Info | Type of the alert message |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Alert**: Info, Error, Success, Warning

## Placeholders

- **MessageText**: Type your message to be displayed (em `Alert/content`)

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnParametersChanged -> FocusAlert; OnReady -> FocusAlert
- Actions do bloco: FocusAlert
- Chama actions do modulo: SetFocus (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.Accessibility.SetFocus`

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Alert1","source":"IMobileBlock:Alert","as":"$b"}
{"op":"create","parent":"$b/MessageText","type":"IExpression","as":"$eMessageText"}
```
