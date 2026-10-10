# DEPRECATED_FlipContent

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 10 widgets internos

This pattern is DEPRECATED. Consider using OutSystems UI's FlipContent instead. 
Get more information about changes at https://outsystemsui.outsystems.com/OutSystemsUIWebsite/MigrationPath?PatternName=FlipContent

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsFlipped | Boolean | nao | False | Boolean variable to handle the state of the Block. Use it to set the default state and/or handle it with your own actions.  It is recommended to set FlipSelf to false when using this variable. |
| FlipSelf | Boolean | nao | True | Click on the Block flips itself. Set to False if you want to use you own action to flip the Block. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **CardFront**: Add content to the Flip Content front side (em `FlipWrapper/content/FlipContainer/content`)
- **CardBack**: Add content to the Flip Content back (em `FlipWrapper/content/FlipContainer/content/ServiceStudioPreview`)

## Eventos

- **OnFlip**(IsFlipped: Boolean): Event fired after the content is flipped

## Composicao interna

- Ciclo de vida: OnReady -> OnReady
- Actions do bloco: OnReady, ToggleFlip

## JavaScript

`OnReady` / no `addEventListener`:

```js
var flipWrapper = document.getElementById($parameters.WrappperId);
var elemId = document.getElementById($parameters.ElemId);
var isExpanded;

var onKeyDownPress = function(e){
    isExpanded = elemId.getAttribute('data-flipped');
    
    //If esc, Close AccordionItem
    if(isExpanded === "True" && e.keyCode == "27") {
        $actions.ToggleFlip();
        e.preventDefault();
        e.stopPropagation();
    }
    
    //If enter or space use the onAccordionClick to validate
    if (e.keyCode == "32" || e.keyCode == "13") {
        $actions.ToggleFlip();
        e.preventDefault();
        e.stopPropagation();
    }
};

flipWrapper.addEventListener('keydown', onKeyDownPress);

```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_FlipContent1","source":"IMobileBlock:DEPRECATED_FlipContent","as":"$b"}
{"op":"create","parent":"$b/CardFront","type":"IExpression","as":"$eCardFront"}
{"op":"create","parent":"$b/CardBack","type":"IExpression","as":"$eCardBack"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnFlip` resolve o IEventHandler pelo nome do evento e `$b/OnFlip/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_FlipContent1_OnFlip","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsFlipped","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnFlip","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnFlip/IsFlipped","prop":"Value","value":"IsFlipped"}
```
