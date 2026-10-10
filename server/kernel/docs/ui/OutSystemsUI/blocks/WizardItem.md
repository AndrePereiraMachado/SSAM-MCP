# WizardItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 4 widgets internos

Step item to add in the Wizard pattern.

Drag the icon you want in the Icon placeholder and define the correspondent label in the Label placeholder. 
Use the Status parameter to define it's status (Past, Active, Next) and the LabelPosition to set it above (true) or alongside (false).

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Status | Steps Identifier | sim |  | The UI of this step, it can be Active, Next or Past |
| UseTopLabel | Boolean | nao | False | If true, label is placed above the icon. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Steps**: Next, Active, Past

## Placeholders

- **Label**: Drag your content to this placeholder. (em `WizardWrapperItem/content`)
- **Icon**: Set a number or leave it empty to show a circle icon. (em `WizardWrapperItem/content/content`)

## Eventos

- **OnClick**(): Event triggered after clicking on the WizardItem.

## Composicao interna

- Ciclo de vida: OnReady -> OnReady
- Actions do bloco: OnReady, TriggerClick, WizardItemOnKeypress

## JavaScript

`OnReady` / no `SetAriaLabel`:

```js
// Set wizard elements
var wizardWrapperItem = document.getElementById($parameters.WidgetId);
var wizardItemLabel = wizardWrapperItem.querySelector('.wizard-item-label').textContent;

// Set aria-label to wizard item wrapper
wizardWrapperItem.setAttribute('aria-label', wizardItemLabel);
```

`WizardItemOnKeypress` / no `OnKeyPress_CheckEnter`:

```js
if (event.keyCode === 13) {
    $actions.TriggerClick()
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"WizardItem1","source":"IMobileBlock:WizardItem","as":"$b"}
{"op":"set","target":"$b/Status","prop":"Value","value":"<Steps Identifier>"}
{"op":"create","parent":"$b/Label","type":"IExpression","as":"$eLabel"}
{"op":"create","parent":"$b/Icon","type":"IExpression","as":"$eIcon"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnClick` resolve o IEventHandler pelo nome do evento e `$b/OnClick/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"WizardItem1_OnClick","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnClick","prop":"Handler","value":"$h"}
```
