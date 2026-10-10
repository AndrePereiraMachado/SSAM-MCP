# CharacterCount

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Utilities** | publico | 9 widgets internos

Displays the characters left in a target input field.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| InputWidgetId | Text | sim |  | Input Element Name that will trigger the count. |
| Limit | Integer | sim |  | The character count limit. This value should be the same as the Max Length property in the input. |
| IsDescending | Boolean | nao | True | When set to false, the count will go from 0 to the limit that has been chosen on the Limit parameter. |

## Placeholders

- **Content**: Drag your content to this area.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var textCounter = function() { 
    var widget;
    var numberBox;
    var maxValue;
    var isDesc;
    var currValue;
    var enteredText;
    var lineBreaks;
    var characterCount;

    var start = function(widgetIdParam, containerId, limit, isDescending) {
        widget = document.getElementById(widgetIdParam);
        numberBox = document.getElementById(containerId);
        maxValue = limit;
        isDesc = (isDescending === "True");
        currValue = isDesc ? maxValue : 0;
        
        if(widget) {
            widget.addEventListener('keyup', setValue);
            
            // set number value for the first time, removing the 500 placeholder that we have there
            setValue();
        }
    }   

    function setValue() {
        enteredText = widget.value;
        lineBreaks = (enteredText.match(/\n/g)||[]).length;
        
        // count of linbreaks and characters
        characterCount = enteredText.length + lineBreaks;
        
        if(isDesc) {
            currValue = maxValue - characterCount;
            numberBox.innerText = currValue; 
        } else {
            // this verification is done as a safeguard in case if the user forgets to set the max length on the input
            if(characterCount <= maxValue) {
                numberBox.innerText = characterCount; 
            }
        }
    }

    return {
        init: function(widgetIdParam, containerId, limit, isDescending) {
            start(widgetIdParam, containerId, limit, isDescending);
        }
    }
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"CharacterCount1","source":"IWebBlock:CharacterCount","as":"$b"}
{"op":"set","target":"$b/InputWidgetId","prop":"Value","value":"<Text>"}
{"op":"set","target":"$b/Limit","prop":"Value","value":"<Integer>"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
