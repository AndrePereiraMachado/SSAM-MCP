# DEPRECATED_Accordion

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 10 widgets internos

Arrange the content by having vertically stacked tabs that expand when clicked. This is an effective way to display additional information.

Add the Accordion Web Block on your Screen and as many AccordionItems as you need inside the Accordion.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| MultipleItems | Boolean | nao | False | Allows multiple Accordion Items to be opened having the effect of Section Expandables. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Content**: Drag AccordionItem blocks to this placeholder. | nasce com: WebBlockInstance:DEPRECATED_AccordionItem, WebBlockInstance:DEPRECATED_AccordionItem, WebBlockInstance:DEPRECATED_AccordionItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: DEPRECATED_AccordionItem
- Ciclo de vida: OnParametersChanged -> OnParametersChanged; OnReady -> OnReady
- Actions do bloco: OnReady, OnParametersChanged
- Chama actions do modulo: DEPRECATED_UpdateAccordion (contratos em [actions.md](../actions.md))

## JavaScript

`OnReady` / no `CloseAllItems`:

```js
var accordion = document.getElementById($parameters.WidgetId);
var checkAccordionElements = accordion.querySelectorAll(':scope > div > .section-expandable.is--open');

// Close All but first, if user has multipleItems as false, but more than one section-expandable as Expanded 
if($parameters.MultipleItems === false){
    for(var i = 0; i < checkAccordionElements.length; i++) {
        if(i !== 0) {
            checkAccordionElements[i].CollapseItem();
        }
    }
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Accordion1","source":"IMobileBlock:DEPRECATED_Accordion","empty":true,"as":"$b"}
```
