# DEPRECATED_ButtonLoading

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Utilities** | publico | 6 widgets internos

This pattern is DEPRECATED. Consider using OutSystems UI's ButtonLoading instead. 
Get more information about changes at https://outsystemsui.outsystems.com/OutSystemsUIWebsite/MigrationPath?PatternName=ButtonLoading

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsLoading | Boolean | sim |  | When true, the button shows the loading state. |
| ShowLoadingAndLabel | Boolean | nao | False | If true, the loading spinner will appear side by side with the label. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Button**: Drag a Button or a link to this placeholder | nasce com: Button (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnParametersChanged -> OnReady; OnReady -> OnReady
- Actions do bloco: OnReady

## JavaScript

`OnReady` / no `DisableKeypressOnLoading`:

```js
var buttonWrapper = document.getElementById($parameters.WidgetId);
var button = buttonWrapper.querySelector('button');

var onButtonKeypress = function(e){
    
    if((e.keyCode == "13" || e.keyCode == "32") && $parameters.IsLoading) {
      e.preventDefault();
    } else {
        button.removeEventListener('keydown', onButtonKeypress); 
        return true;
    }

};

button.addEventListener('keydown', onButtonKeypress); 


```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_ButtonLoading1","source":"IMobileBlock:DEPRECATED_ButtonLoading","empty":true,"as":"$b"}
{"op":"set","target":"$b/IsLoading","prop":"Value","value":"<Boolean>"}
```
